import { VideoView, useVideoPlayer } from 'expo-video';
import { useEffect } from 'react';
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/theme';

type Props = { uri: string; style?: StyleProp<ViewStyle> };

/**
 * 浏览器的原生视频控件（右下角「更多选项」那个 ⋮ 菜单）由 UA 样式决定，
 * 在系统深色模式下会继承 color-scheme: dark，但弹层背景仍是浅色 →
 * 菜单项渲染成白字白底，看起来「全是空白」。
 *
 * 这里只做一件事：给页面注入一条 `video { color-scheme: light }`，
 * 让原生控件按浅色渲染，和 App 的浅色主题一致。只注入一次。
 */
const VIDEO_SCHEME_STYLE_ID = 'dsh-video-color-scheme';

function useWebVideoColorScheme() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    if (document.getElementById(VIDEO_SCHEME_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = VIDEO_SCHEME_STYLE_ID;
    style.textContent = 'video{color-scheme:light}';
    document.head.appendChild(style);
  }, []);
}

export function ResultVideo({ uri, style }: Props) {
  const player = useVideoPlayer(uri, (videoPlayer) => {
    videoPlayer.loop = false;
  });
  const styles = useThemedStyles(makeStyles);
  useWebVideoColorScheme();

  return <VideoView player={player} style={[styles.video, style]} nativeControls contentFit="contain" fullscreenOptions={{ enable: true }} />;
}

const makeStyles = (theme: Theme) => {
  const { colors, radius } = theme;
  return StyleSheet.create({
    video: { width: '100%', height: 420, borderRadius: radius.md, backgroundColor: colors.surfaceAlt },
  });
};
