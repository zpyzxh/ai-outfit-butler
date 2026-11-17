import { AppIcon } from '@/components/icons';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  PHONE_AUTH_ENABLED,
  isEmailLike,
  normalizeEmail,
  sendEmailCode,
  shortUserId,
  signOut,
  useAuth,
  verifyEmailCode,
  type EmailCodeMode,
} from '@/lib/auth';
import { useTheme, useThemedStyles, type Theme } from '@/theme';

// 「我的」页账号区（Operate 模式，只做清晰与可靠，不抢页面主视觉）：
//   无 session / 匿名账户 → 邮箱验证码登录入口；匿名账户验证后原地升级，UUID 与记录不变
//   正式账户 → 邮箱 + 短 ID + 退出登录
// 所有颜色 / 圆角 / 字号都取自主题 token，跟随四套主题切换。
export function AccountSection() {
  const { ready, profile, refresh } = useAuth();
  const styles = useThemedStyles(makeStyles);
  const { colors, button } = useTheme().theme;

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<EmailCodeMode>('signin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [focused, setFocused] = useState<'email' | 'code' | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  // 上次升级流程发出了验证码但没验证完：恢复到输码步骤，不必重发一封（会触发邮件频率限制）
  useEffect(() => {
    if (profile?.isAnonymous && profile.pendingEmail) {
      setEmail(profile.pendingEmail);
      setMode('upgrade');
      setStep('code');
    }
  }, [profile?.isAnonymous, profile?.pendingEmail]);

  const requestCode = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const nextMode = await sendEmailCode(email);
      if (!aliveRef.current) return;
      setMode(nextMode);
      setStep('code');
      setCode('');
      setCooldown(60);
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : '验证码发送失败，请稍后重试');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const submitCode = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifyEmailCode(email, code, mode);
      await refresh();
      if (!aliveRef.current) return;
      setStep('email');
      setCode('');
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : '验证码校验失败，请重新获取');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const performSignOut = () => {
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await signOut();
        await refresh();
      } catch (err) {
        if (aliveRef.current) setError(err instanceof Error ? err.message : '退出失败，请重试');
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    })();
  };

  const confirmSignOut = () => {
    const message = '退出后需要重新用邮箱验证码登录。';
    // react-native-web 的 Alert.alert 是空实现，Web 端必须走 window.confirm
    if (Platform.OS === 'web') {
      if (window.confirm(`退出登录\n${message}`)) performSignOut();
      return;
    }
    Alert.alert('退出登录', message, [
      { text: '取消', style: 'cancel' },
      { text: '退出', style: 'destructive', onPress: performSignOut },
    ]);
  };

  if (!ready) {
    return (
      <View style={styles.card}>
        <View style={styles.row}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.muted}>正在准备账号…</Text>
        </View>
      </View>
    );
  }

  if (profile && !profile.isAnonymous) {
    return (
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.avatar}>
            <AppIcon name="checkmark" size={16} color={colors.accent} />
          </View>
          <View style={styles.rowCopy}>
            <Text style={styles.email} numberOfLines={1} ellipsizeMode="middle">{profile.email ?? '已登录'}</Text>
            <Text style={styles.idText}>ID {shortUserId(profile.userId)}</Text>
          </View>
          <Pressable
            onPress={confirmSignOut}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="退出登录"
            style={({ pressed }) => [styles.ghostButton, busy && styles.disabled, pressed && !busy && styles.pressed]}
          >
            {busy
              ? <ActivityIndicator size="small" color={colors.muted} />
              : <Text style={styles.ghostText}>退出登录</Text>}
          </Pressable>
        </View>
        <Text style={[styles.message, error ? styles.error : null]} numberOfLines={2}>
          {error ?? '账号已绑定邮箱，试穿记录与作品都归在这个 ID 下'}
        </Text>
      </View>
    );
  }

  const canSend = isEmailLike(email) && !busy && cooldown === 0;
  const canSubmit = /^\d{6}$/.test(code) && !busy;

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.avatar}>
          <AppIcon
            name={profile?.isAnonymous ? 'person-add-outline' : 'mail-outline'}
            size={16}
            color={colors.accent}
          />
        </View>
        <View style={styles.rowCopy}>
          <Text style={styles.title}>{profile?.isAnonymous ? '匿名账户' : '登录 / 注册'}</Text>
          <Text style={styles.muted} numberOfLines={2}>
            {profile?.isAnonymous
              ? `ID ${shortUserId(profile.userId)} · 验证邮箱后升级，原有记录不丢`
              : '用邮箱验证码登录，无需密码'}
          </Text>
        </View>
        {profile?.isAnonymous ? (
          <View style={styles.badge}><Text style={styles.badgeText}>未验证</Text></View>
        ) : null}
      </View>

      {step === 'email' ? (
        <>
          <TextInput
            value={email}
            onChangeText={(value) => { setEmail(value); setError(null); }}
            onFocus={() => setFocused('email')}
            onBlur={() => setFocused(null)}
            onSubmitEditing={() => { if (canSend) void requestCode(); }}
            placeholder="you@example.com"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            keyboardType="email-address"
            inputMode="email"
            returnKeyType="send"
            editable={!busy}
            selectionColor={colors.accent}
            style={[styles.input, focused === 'email' && styles.inputFocused]}
          />
          <Pressable
            onPress={() => void requestCode()}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSend, busy }}
            style={({ pressed }) => [
              styles.primaryButton,
              !canSend && styles.disabled,
              pressed && canSend && styles.pressed,
            ]}
          >
            {busy
              ? <ActivityIndicator size="small" color={button.color} />
              : <Text style={styles.primaryText}>发送验证码</Text>}
          </Pressable>
        </>
      ) : (
        <>
          <View style={styles.sentRow}>
            <Text style={styles.muted} numberOfLines={1} ellipsizeMode="middle">
              验证码已发送至 <Text style={styles.sentEmail}>{normalizeEmail(email)}</Text>
            </Text>
            <Pressable
              onPress={() => { setStep('email'); setCode(''); setError(null); }}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text style={styles.link}>更换</Text>
            </Pressable>
          </View>
          <TextInput
            value={code}
            onChangeText={(value) => { setCode(value.replace(/[^\d]/g, '').slice(0, 6)); setError(null); }}
            onFocus={() => setFocused('code')}
            onBlur={() => setFocused(null)}
            onSubmitEditing={() => { if (canSubmit) void submitCode(); }}
            placeholder="6 位验证码"
            placeholderTextColor={colors.muted}
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={6}
            editable={!busy}
            selectionColor={colors.accent}
            style={[styles.input, styles.codeInput, focused === 'code' && styles.inputFocused]}
          />
          <Pressable
            onPress={() => void submitCode()}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit, busy }}
            style={({ pressed }) => [
              styles.primaryButton,
              !canSubmit && styles.disabled,
              pressed && canSubmit && styles.pressed,
            ]}
          >
            {busy
              ? <ActivityIndicator size="small" color={button.color} />
              : <Text style={styles.primaryText}>登录</Text>}
          </Pressable>
          <Pressable
            onPress={() => void requestCode()}
            disabled={busy || cooldown > 0}
            accessibilityRole="button"
            style={styles.resendRow}
          >
            <Text style={[styles.link, (busy || cooldown > 0) && styles.linkDisabled]}>
              {cooldown > 0 ? `${cooldown} 秒后可重新发送` : '没收到？重新发送'}
            </Text>
          </Pressable>
        </>
      )}

      <Text style={[styles.message, error ? styles.error : null]} numberOfLines={2}>
        {error ?? (step === 'code' ? '验证码会过期，失效后点「重新发送」' : '')}
      </Text>
      <Text style={styles.footnote}>
        {PHONE_AUTH_ENABLED ? '也支持手机号验证码登录' : '手机号登录待接入短信服务商后开放'}
      </Text>
    </View>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, type, button, chip } = theme;

  return StyleSheet.create({
    card: {
      padding: spacing.md,
      borderRadius: radius.lg,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      gap: spacing.sm,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    rowCopy: { flex: 1, gap: 2 },
    avatar: {
      width: 32,
      height: 32,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accentSoft,
      borderWidth: 1,
      borderColor: colors.border,
    },
    title: { ...type.section, color: colors.text },
    email: { ...type.body, fontWeight: '600', color: colors.text },
    idText: { ...type.caption, color: colors.muted, fontVariant: ['tabular-nums'] },
    muted: { ...type.caption, color: colors.muted },
    badge: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: chip.radius,
      backgroundColor: colors.accentSoft,
      borderWidth: 1,
      borderColor: colors.border,
    },
    badgeText: { ...type.caption, color: colors.accent },
    message: { ...type.caption, color: colors.muted, minHeight: (type.caption.lineHeight ?? 16) * 2 },
    error: { color: colors.danger },
    footnote: { ...type.caption, color: colors.muted },
    sentRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    sentEmail: { color: colors.text },
    input: {
      ...type.body,
      color: colors.text,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    inputFocused: { borderColor: colors.accent },
    codeInput: { letterSpacing: 6, textAlign: 'center' },
    primaryButton: {
      minHeight: button.minHeight,
      borderRadius: button.radius,
      backgroundColor: button.background,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: button.borderWidth,
      borderColor: button.borderColor,
    },
    primaryText: {
      ...type.label,
      color: button.color,
      letterSpacing: button.letterSpacing,
    },
    ghostButton: {
      minHeight: 36,
      paddingHorizontal: spacing.sm,
      borderRadius: chip.radius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: chip.background,
      borderWidth: 1,
      borderColor: chip.borderColor,
    },
    ghostText: { ...type.caption, color: chip.color },
    resendRow: { alignItems: 'center', paddingVertical: spacing.xs },
    link: { ...type.caption, color: colors.accent },
    linkDisabled: { color: colors.muted },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.82 },
  });
};
