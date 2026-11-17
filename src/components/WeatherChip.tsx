import { AppIcon } from '@/components/icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { fetchWeather, type WeatherInfo } from '@/lib/weather';
import { useThemedStyles, type Theme } from '@/theme';

const ICONS: Record<WeatherInfo['icon'], import('@/components/icons').IconName> = {
  sunny: 'sun',
  cloud: 'cloud',
  rain: 'rain',
  snow: 'snow',
  thunder: 'thunder',
  fog: 'fog',
};

type State = { status: 'loading' } | { status: 'ready'; weather: WeatherInfo } | { status: 'unavailable' };

/** 首页天气小组件：失败只显示「天气不可用」，不向上抛错影响首页。 */
export function WeatherChip() {
  const styles = useThemedStyles(makeStyles);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    void fetchWeather()
      .then((weather) => {
        if (!alive) return;
        setState(weather ? { status: 'ready', weather } : { status: 'unavailable' });
      })
      .catch(() => {
        if (alive) setState({ status: 'unavailable' });
      });
    return () => { alive = false; };
  }, []);

  if (state.status === 'loading') {
    return (
      <View style={styles.chip} accessibilityLabel="正在获取天气">
        <ActivityIndicator size="small" />
      </View>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <View style={styles.chip}>
        <AppIcon name="cloud-offline-outline" size={13} />
        <Text style={styles.unavailable}>天气不可用</Text>
      </View>
    );
  }

  const { weather } = state;
  return (
    <View style={styles.chip} accessibilityLabel={`${weather.city ?? ''}${weather.text}，${weather.tempC} 度`}>
      <AppIcon name={ICONS[weather.icon]} size={14} />
      <Text style={styles.temp}>{weather.tempC}°</Text>
      <Text style={styles.text}>{weather.text}</Text>
    </View>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, type } = theme;
  return StyleSheet.create({
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceAlt,
    },
    temp: { ...type.caption, color: colors.text, fontWeight: '700', fontSize: 12 },
    text: { ...type.caption, color: colors.muted, fontSize: 11 },
    unavailable: { ...type.caption, color: colors.muted, fontSize: 11 },
  });
};
