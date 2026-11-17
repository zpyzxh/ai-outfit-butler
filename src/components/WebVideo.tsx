import { createElement } from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/theme';

type Props = { uri: string; poster?: string | null };

/**
 * 只在 Web 的弹层查看器里用的原生 <video>。
 *
 * 为什么不用 expo-video 的 VideoView：成片 mp4 的 moov 在文件尾部，
 * 元数据要等整段下完才拿得到（实测 networkState 一直是 2、readyState 停在 0），
 * 直接挂播放器会长时间黑屏 + 转圈，观感像坏了。
 * 用原生 <video> 可以给它 `poster`：封面立刻可见，控件就位，点播放再等加载。
 */
export function WebVideo({ uri, poster }: Props) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.wrap}>
      {createElement('video', {
        src: uri,
        poster: poster ?? undefined,
        controls: true,
        playsInline: true,
        preload: 'auto',
        // 深色底避免竖构图两侧出现刺眼白边
        style: { width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#0c0c0e' },
      })}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: { flex: 1, backgroundColor: theme.colors.surfaceAlt },
  });
