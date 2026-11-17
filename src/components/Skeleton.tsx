import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, View, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

type Props = {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: ViewStyle;
};

/** 加载占位：低频呼吸，避免闪白和布局跳动 */
export function Skeleton({ width = '100%', height = 14, radius = 8, style }: Props) {
  const { theme } = useTheme();
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 780, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulse, { toValue: 0.45, duration: 780, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== 'web' }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: theme.colors.surfaceAlt, opacity: pulse },
        style,
      ]}
    />
  );
}

/** 常用组合：图片区 + 两行文字的骨架 */
export function CardSkeleton({ height = 240, cornerRadius = 20 }: { height?: number; cornerRadius?: number }) {
  const { theme } = useTheme();
  return (
    <View style={[styles.card, { borderColor: theme.colors.border, borderRadius: cornerRadius }]}>
      <Skeleton height={height} radius={cornerRadius - 8} />
      <View style={styles.lines}>
        <Skeleton width="46%" height={12} />
        <Skeleton width="72%" height={10} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 8, gap: 10 },
  lines: { paddingHorizontal: 4, paddingBottom: 6, gap: 8 },
});
