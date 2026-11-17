import { AppIcon } from '@/components/icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  PLAN_OPTIONS,
  createIdempotencyKey,
  createOrder,
  describePaymentError,
  formatCents,
  mockPay,
  queryPayments,
  type Entitlement,
  type PaymentOrder,
  type PlanId,
} from '@/lib/payment';
import { useTheme, useThemedStyles, type Theme } from '@/theme';

const benefits = [
  { icon: 'shirt-outline' as const, title: 'AI 虚拟试穿', description: '上传全身照，预览不同单品的上身效果' },
  { icon: 'videocam-outline' as const, title: '动态穿搭视频', description: '将试穿结果制作成短视频' },
  { icon: 'time-outline' as const, title: '作品记录', description: '在“我的”中查看已生成的试穿作品' },
];

function formatRemaining(seconds: number) {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function formatDate(iso: string | null) {
  if (!iso) return '长期有效';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '有效期未知';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function PlansScreen() {
  const { theme } = useTheme();
  const { colors } = theme;
  const styles = useThemedStyles(makeStyles);

  const [entitlements, setEntitlements] = useState<Entitlement[] | null>(null);
  const [loadingEntitlements, setLoadingEntitlements] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<PlanId>('tryon_10');
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [remainingSec, setRemainingSec] = useState(0);
  const [busy, setBusy] = useState<'order' | 'pay' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // 同一用户同一套餐复用同一个幂等键，避免重复下单；支付成功或订单过期后重置
  const idemKeysRef = useRef<Partial<Record<PlanId, string>>>({});
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const loadEntitlements = useCallback(async (silent = false) => {
    if (!silent) setLoadingEntitlements(true);
    try {
      const data = await queryPayments();
      if (aliveRef.current) setEntitlements(data.entitlements ?? []);
    } catch (err) {
      if (!aliveRef.current) return;
      setEntitlements((current) => current ?? []);
      setError(describePaymentError(err));
    } finally {
      if (aliveRef.current) setLoadingEntitlements(false);
    }
  }, []);

  useEffect(() => { void loadEntitlements(); }, [loadEntitlements]);

  // 订单倒计时：以服务端 expires_at 为准
  useEffect(() => {
    if (!order) { setRemainingSec(0); return; }
    const target = new Date(order.expires_at).getTime();
    const tick = () => setRemainingSec(Math.max(0, Math.ceil((target - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [order]);

  // 直接用服务端 expires_at 判断：remainingSec 初始为 0，用它判断会让订单刚创建时闪一下「已过期」
  const orderExpiresAt = order ? new Date(order.expires_at).getTime() : 0;
  const expired = Boolean(order) && orderExpiresAt <= Date.now();
  const activeEntitlements = (entitlements ?? []).filter((item) => {
    if (item.status !== 'active') return false;
    if (!item.valid_until) return true;
    return new Date(item.valid_until).getTime() > Date.now();
  });

  const handleCreateOrder = async () => {
    if (busy) return;
    setBusy('order'); setError(null); setMessage(null);
    try {
      const key = idemKeysRef.current[selectedPlan] ?? createIdempotencyKey();
      idemKeysRef.current[selectedPlan] = key;
      const created = await createOrder(selectedPlan, key);
      if (!aliveRef.current) return;
      setOrder(created);
      setMessage(created.reused ? '已复用这笔未完成订单，不会重复扣款' : '订单已创建，请在有效期内完成支付');
    } catch (err) {
      // 下单失败（含通道未开通）时丢弃幂等键，允许下次重新尝试
      delete idemKeysRef.current[selectedPlan];
      if (aliveRef.current) setError(describePaymentError(err));
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  const handleMockPay = async () => {
    if (!order || busy || expired) return;
    setBusy('pay'); setError(null); setMessage(null);
    try {
      const response = await mockPay(order.order_no);
      const status = response.result?.status;
      if (!aliveRef.current) return;
      if (status === 'paid') {
        // 只有服务端确认 paid 才视为成功
        setMessage('服务端已确认支付，权益已发放');
        delete idemKeysRef.current[selectedPlan];
        setOrder(null);
        await loadEntitlements(true);
      } else if (status === 'already_paid') {
        setMessage('该订单已经是已支付状态，未重复发放权益');
        delete idemKeysRef.current[selectedPlan];
        setOrder(null);
        await loadEntitlements(true);
      } else if (status === 'duplicate') {
        // 回调已处理过说明这单在服务端已经结束，清掉本地待支付态，避免一直卡在「待支付」
        setMessage('这笔支付回调已处理过，未重复发放权益');
        delete idemKeysRef.current[selectedPlan];
        setOrder(null);
        await loadEntitlements(true);
      } else {
        setError(`服务端返回未确认状态（${status ?? '空'}），没有视为支付成功`);
      }
    } catch (err) {
      if (aliveRef.current) setError(describePaymentError(err));
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  const handleExpiredRecreate = async () => {
    delete idemKeysRef.current[selectedPlan];
    setOrder(null);
    setMessage(null);
    setError(null);
    await handleCreateOrder();
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable onPress={() => router.back()} style={styles.back} accessibilityRole="button">
          <AppIcon name="chevron-back" size={20} color={colors.text} />
          <Text style={styles.backText}>返回</Text>
        </Pressable>
        <View style={styles.heroIcon}><AppIcon name="sparkles" size={28} color={colors.accent} /></View>
        <Text style={styles.eyebrow}>AI 穿搭管家</Text>
        <Text style={styles.title}>选择适合你的创作方案</Text>
        <Text style={styles.subtitle}>次数类套餐按次扣减，会员类套餐按有效期计算。</Text>

        <View style={styles.notice}>
          <AppIcon name="flask-outline" size={20} color={colors.accent} />
          <Text style={styles.noticeText}>当前使用测试支付通道，不会真实扣款；按钮会明确标注「模拟支付（测试）」。</Text>
        </View>

        {/* 当前权益 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>我的权益</Text>
          {loadingEntitlements ? (
            <View style={styles.loadingRow}><ActivityIndicator size="small" /><Text style={styles.loadingText}>正在查询权益…</Text></View>
          ) : activeEntitlements.length === 0 ? (
            <Text style={styles.emptyText}>还没有可用权益，选择下面的套餐即可开通。</Text>
          ) : (
            activeEntitlements.map((item) => {
              const plan = PLAN_OPTIONS.find((option) => option.id === item.plan_id);
              const remaining = item.quota_total == null ? '不限次数' : `剩余 ${Math.max(0, item.quota_total - item.quota_used)} 次`;
              return (
                <View key={item.id} style={styles.entitlementCard}>
                  <View style={styles.entitlementHead}>
                    <Text style={styles.entitlementName}>{plan?.name ?? item.plan_id}</Text>
                    <Text style={styles.entitlementRemaining}>{remaining}</Text>
                  </View>
                  <Text style={styles.entitlementMeta}>有效期至 {formatDate(item.valid_until)}</Text>
                </View>
              );
            })
          )}
        </View>

        {/* 套餐 */}
        <Text style={styles.sectionTitle}>选择套餐</Text>
        {PLAN_OPTIONS.map((plan) => {
          const selected = plan.id === selectedPlan;
          return (
            <Pressable
              key={plan.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => {
                if (busy) return;
                setSelectedPlan(plan.id);
                setOrder(null);
                setMessage(null);
                setError(null);
              }}
              style={[styles.planCard, selected && styles.featured]}
            >
              <View style={styles.planHead}>
                <View>
                  <Text style={styles.planName}>{plan.name}</Text>
                  <Text style={styles.price}>{formatCents(plan.amountCents)}</Text>
                </View>
                <AppIcon name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={colors.accent} />
              </View>
              <Text style={styles.planDescription}>{plan.description}</Text>
              <View style={styles.divider} />
              <View style={styles.benefit}>
                <AppIcon name="shirt-outline" size={17} color={colors.success} />
                <Text style={styles.benefitText}>{plan.quota == null ? '有效期内不限次数试穿' : `共 ${plan.quota} 次试穿机会`}</Text>
              </View>
              <View style={styles.benefit}>
                <AppIcon name="calendar-outline" size={17} color={colors.success} />
                <Text style={styles.benefitText}>{plan.validDays} 天有效</Text>
              </View>
            </Pressable>
          );
        })}

        {/* 订单区 */}
        {order ? (
          <View style={styles.orderCard}>
            <Text style={styles.orderTitle}>待支付订单</Text>
            <View style={styles.orderRow}><Text style={styles.orderLabel}>订单号</Text><Text style={styles.orderValue}>{order.order_no}</Text></View>
            <View style={styles.orderRow}><Text style={styles.orderLabel}>金额</Text><Text style={styles.orderValue}>{formatCents(order.amount_cents)}</Text></View>
            <View style={styles.orderRow}>
              <Text style={styles.orderLabel}>剩余时间</Text>
              <Text style={[styles.orderValue, expired && styles.orderExpired]}>{expired ? '已过期' : formatRemaining(remainingSec)}</Text>
            </View>
            {expired ? (
              <Pressable
                onPress={() => void handleExpiredRecreate()}
                disabled={busy !== null}
                style={[styles.button, styles.buttonOutline, busy !== null && styles.buttonDisabled]}
              >
                <Text style={styles.buttonOutlineText}>订单已过期，重新下单</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => void handleMockPay()}
                disabled={busy !== null}
                style={[styles.button, busy !== null && styles.buttonDisabled]}
              >
                {busy === 'pay' ? <ActivityIndicator size="small" color={theme.button.color} /> : <Text style={styles.buttonText}>模拟支付（测试）</Text>}
              </Pressable>
            )}
          </View>
        ) : (
          <Pressable
            onPress={() => void handleCreateOrder()}
            disabled={busy !== null}
            style={[styles.button, busy !== null && styles.buttonDisabled]}
          >
            {busy === 'order' ? <ActivityIndicator size="small" color={theme.button.color} /> : <Text style={styles.buttonText}>创建订单 · {formatCents(PLAN_OPTIONS.find((option) => option.id === selectedPlan)?.amountCents ?? 0)}</Text>}
          </Pressable>
        )}

        {message ? <Text style={styles.successText}>{message}</Text> : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.benefitsBlock}>
          {benefits.map((benefit) => (
            <View key={benefit.title} style={styles.benefitRow}>
              <AppIcon name={benefit.icon} size={18} color={colors.muted} />
              <View>
                <Text style={styles.benefitText}>{benefit.title}</Text>
                <Text style={styles.benefitDescription}>{benefit.description}</Text>
              </View>
            </View>
          ))}
        </View>

        <Text style={styles.footnote}>测试阶段仅支持模拟支付；正式收款前会补充价格、退款与发票说明。</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, type, button, card, nav } = theme;
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    content: {
      padding: spacing.md,
      paddingBottom: spacing.xl + (nav.floating ? nav.height + 16 : 0),
      gap: spacing.sm,
    },
    back: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingVertical: spacing.xs },
    backText: { color: colors.text, fontSize: 14 },
    heroIcon: {
      width: 58,
      height: 58,
      borderRadius: radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accentSoft,
      marginTop: spacing.md,
    },
    eyebrow: { ...type.label, color: colors.accent, marginTop: spacing.sm },
    title: { ...type.display, color: colors.text },
    subtitle: { ...type.body, color: colors.muted, marginBottom: spacing.sm },
    notice: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'center',
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.accentSoft,
      marginBottom: spacing.sm,
    },
    noticeText: { flex: 1, ...type.caption, color: colors.accent },
    section: { gap: spacing.sm, marginBottom: spacing.sm },
    sectionTitle: { ...type.title, color: colors.text },
    loadingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    loadingText: { ...type.caption, color: colors.muted },
    emptyText: { ...type.caption, color: colors.muted },
    entitlementCard: {
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      gap: spacing.xs,
    },
    entitlementHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    entitlementName: { ...type.label, color: colors.text },
    entitlementRemaining: { ...type.label, color: colors.accent },
    entitlementMeta: { ...type.caption, color: colors.muted },
    planCard: {
      backgroundColor: colors.surface,
      borderRadius: card.radius,
      borderWidth: card.borderWidth,
      borderColor: card.borderColor,
      padding: spacing.md,
      gap: spacing.sm,
      marginBottom: spacing.sm,
      ...(card.shadow ?? {}),
    },
    featured: { borderWidth: 1, borderColor: colors.accent, backgroundColor: colors.accentSoft },
    planHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    planName: { ...type.title, color: colors.text },
    price: { ...type.label, color: colors.accent, marginTop: spacing.xs },
    planDescription: { ...type.caption, color: colors.muted },
    divider: { height: 1, backgroundColor: colors.border },
    benefit: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    benefitText: { ...type.caption, color: colors.text },
    orderCard: {
      padding: spacing.md,
      borderRadius: card.radius,
      borderWidth: 1,
      borderColor: colors.accent,
      backgroundColor: colors.surface,
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    orderTitle: { ...type.title, color: colors.text },
    orderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    orderLabel: { ...type.caption, color: colors.muted },
    orderValue: { ...type.caption, color: colors.text, fontVariant: ['tabular-nums'] },
    orderExpired: { color: colors.danger },
    button: {
      minHeight: button.minHeight,
      borderRadius: button.radius,
      borderWidth: button.borderWidth,
      borderColor: button.borderColor,
      backgroundColor: button.background,
      paddingVertical: 10,
      marginTop: spacing.xs,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonText: {
      color: button.color,
      fontWeight: '700',
      fontSize: 14,
      letterSpacing: button.letterSpacing,
    },
    buttonOutline: { backgroundColor: 'transparent', borderColor: colors.accent },
    buttonOutlineText: { color: colors.accent, fontWeight: '700', fontSize: 14 },
    buttonDisabled: { opacity: 0.5 },
    successText: { ...type.caption, color: colors.success },
    errorText: { ...type.caption, color: colors.danger },
    benefitsBlock: { gap: spacing.md, marginTop: spacing.md },
    benefitRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
    benefitDescription: { ...type.caption, color: colors.muted },
    footnote: { ...type.caption, color: colors.muted, textAlign: 'center', marginTop: spacing.md },
  });
};
