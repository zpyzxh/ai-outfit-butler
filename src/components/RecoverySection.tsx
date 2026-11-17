import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppIcon } from '@/components/icons';
import { useAuth } from '@/lib/auth';
import { ensureRecoveryCode, formatRecoveryCode, normalizeRecoveryCode, redeemRecoveryCode } from '@/lib/recovery';
import { useTheme, useThemedStyles, type Theme } from '@/theme';

type Props = {
  /** 接回成功后通知外层重新拉取记录 */
  onRestored?: () => void;
};

/**
 * 恢复码区块。
 *
 * 存在的理由：身份只在本机，清缓存或换设备就等于换了一个人。
 * 这里把「换设备后怎么接回历史」显式地摆出来，而不是等用户发现记录没了才来问。
 */
export function RecoverySection({ onRestored }: Props) {
  const styles = useThemedStyles(makeStyles);
  const { theme } = useTheme();
  const { colors } = theme;
  const { profile } = useAuth();
  const [code, setCode] = useState<string | null>(null);
  // 服务端还没应用 020 时 register 会失败：这时把区块降级成一句说明，而不是一直「生成中…」
  const [codeState, setCodeState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [copied, setCopied] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setCodeState('loading');
      const next = await ensureRecoveryCode().catch(() => null);
      if (!alive) return;
      setCode(next);
      setCodeState(next ? 'ready' : 'unavailable');
    })();
    return () => {
      alive = false;
    };
  }, [profile?.userId]);

  const canSubmit = useMemo(() => normalizeRecoveryCode(input).length === 12 && !busy, [input, busy]);

  async function handleCopy() {
    if (!code) return;
    try {
      if (Platform.OS === 'web' && globalThis.navigator?.clipboard) {
        await globalThis.navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
        return;
      }
      setMessage('长按上面的恢复码即可复制');
    } catch {
      setMessage('复制失败，请长按恢复码手动复制');
    }
  }

  async function handleRedeem() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await redeemRecoveryCode(input);
      if (!result.ok) {
        setError(result.error ?? '接回失败，请稍后重试');
        return;
      }
      if (result.alreadyCurrent) {
        setMessage('这串码当前就在使用中，无需接回');
      } else {
        const moved = result.movedTasks ?? 0;
        const posts = result.movedPosts ?? 0;
        setMessage(`已接回 ${moved} 条试穿记录${posts ? `、${posts} 条发布` : ''}`);
      }
      setInput('');
      onRestored?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '接回失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <AppIcon name="bookmark" size={16} color={colors.text} />
        <Text style={styles.headText}>恢复码</Text>
      </View>

      <Text style={styles.note}>
        匿名身份只存在这台设备上。清缓存、换浏览器或重装 App 后，记录会跟着旧身份消失——把这串码
        截图保存，换设备时输入即可接回。
      </Text>

      {codeState === 'unavailable' ? (
        <Text style={styles.warn}>恢复码功能尚未在服务端启用，暂时无法生成。</Text>
      ) : (
        <Pressable onPress={() => void handleCopy()} style={styles.codeBox} accessibilityRole="button">
          <Text selectable style={styles.code}>
            {code ?? '生成中…'}
          </Text>
          <Text style={styles.copyHint}>{copied ? '已复制' : '点击复制'}</Text>
        </Pressable>
      )}

      <View style={styles.divider} />

      <Text style={styles.subhead}>换过设备？</Text>
      <View style={styles.redeemRow}>
        <TextInput
          value={input}
          onChangeText={(value) => {
            setInput(formatRecoveryCode(value));
            setError(null);
          }}
          placeholder="XXXX-XXXX-XXXX"
          placeholderTextColor={styles.placeholder.color}
          autoCapitalize="characters"
          autoCorrect={false}
          style={styles.input}
        />
        <Pressable
          onPress={() => void handleRedeem()}
          disabled={!canSubmit}
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>{busy ? '接回中…' : '接回'}</Text>
        </Pressable>
      </View>

      {message ? <Text style={styles.success}>{message}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, type, button, fonts } = theme;
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: spacing.xs,
    },
    head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    headText: { ...type.section, color: colors.text },
    note: { ...type.caption, color: colors.muted, lineHeight: 18, marginTop: 2 },
    codeBox: {
      marginTop: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    code: {
      ...type.title,
      fontFamily: fonts.body,
      fontSize: 19,
      letterSpacing: 2.4,
      color: colors.text,
    },
    copyHint: { ...type.label, color: colors.muted },
    divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
    subhead: { ...type.label, color: colors.muted },
    redeemRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
    input: {
      flex: 1,
      height: 44,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.sm,
      color: colors.text,
      fontFamily: fonts.body,
      fontSize: 14,
      letterSpacing: 1.6,
    },
    placeholder: { color: colors.muted },
    button: {
      minHeight: 44,
      minWidth: 84,
      paddingHorizontal: spacing.md,
      borderRadius: button.radius,
      borderWidth: button.borderWidth,
      borderColor: button.borderColor,
      backgroundColor: button.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonDisabled: { opacity: 0.35 },
    buttonText: { ...type.section, color: button.color, letterSpacing: button.letterSpacing },
    warn: { ...type.caption, color: colors.muted, marginTop: spacing.sm },
    success: { ...type.caption, color: colors.success, marginTop: spacing.xs },
    error: { ...type.caption, color: colors.danger, marginTop: spacing.xs },
  });
};
