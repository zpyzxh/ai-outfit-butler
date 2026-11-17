import { AppIcon } from '@/components/icons';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useEffect } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import type { HomeInspiration } from '@/lib/supabase';
import { useTheme, useThemedStyles, type Theme } from '@/theme';

// Web 用真正的 CSS 线性渐变；原生没有渐变库，退化为同强度的纯色遮罩
function scrimStyle(scrim: string): ViewStyle {
  if (Platform.OS === 'web') {
    return {
      backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0) 0%, ${scrim} 82%, ${scrim} 100%)`,
    } as unknown as ViewStyle;
  }
  return { backgroundColor: scrim };
}

type Props = {
  item: HomeInspiration;
  active: boolean;
  height: number;
  index?: number;
  total?: number;
  saved?: boolean;
  onTryon: () => void;
  onToggleSave?: () => void;
};

export function FeedMediaCard({ item, active, height, index, total, saved, onTryon, onToggleSave }: Props) {
  const { theme } = useTheme();
  const { card, colors, type } = theme;
  const styles = useThemedStyles(makeStyles);
  const stacked = card.layout === 'stacked';
  const hasTryon = Boolean(item.garmentId);

  const ctaBackground = theme.button.background === 'transparent' ? colors.surface : theme.button.background;
  const ctaColor = theme.button.background === 'transparent' ? colors.text : theme.button.color;

  const media = item.kind === 'video' && item.videoUrl
    ? <FeedVideo uri={item.videoUrl} active={active} />
    : <Image source={{ uri: item.uri }} style={styles.media} resizeMode="cover" />;

  const badge = (
    <View style={styles.badgeRow} pointerEvents="box-none">
      <View style={styles.badgeGroup}>
        {item.kind === 'video' ? (
          <View style={[styles.badge, stacked && styles.badgeLight]}>
            <AppIcon name="video" size={12} color={stacked ? colors.text : colors.onImage} />
            <Text style={[styles.badgeText, { color: stacked ? colors.text : colors.onImage }]}>视频</Text>
          </View>
        ) : null}
        {typeof index === 'number' && total ? (
          <View style={[styles.badge, styles.counter]}>
            <Text style={[styles.badgeText, { color: colors.text }]}>
              {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
            </Text>
          </View>
        ) : null}
      </View>

      {onToggleSave ? (
        <Pressable
          onPress={onToggleSave}
          hitSlop={10}
          style={[styles.saveButton, stacked && styles.saveButtonLight]}
          accessibilityLabel={saved ? '取消收藏' : '收藏这张灵感'}
        >
          <AppIcon name="heart" size={16} color={saved ? colors.accent : stacked ? colors.text : colors.onImage} />
        </Pressable>
      ) : null}
    </View>
  );

  const copy = (
    <View style={styles.copy}>
      <Text style={[styles.kicker, { color: stacked ? colors.muted : colors.onImageMuted }]} numberOfLines={1}>
        {item.subtitle}
      </Text>
      <Text style={[styles.headline, { color: stacked ? colors.text : colors.onImage }]} numberOfLines={2}>
        {item.title}
      </Text>
    </View>
  );

  return (
    <View style={[styles.card, { height }]}>
      <View style={[styles.frame, stacked && styles.frameStacked]}>
        {media}
        {stacked ? null : <View pointerEvents="none" style={[styles.scrim, scrimStyle(colors.scrim)]} />}
        {badge}
        {stacked ? null : (
          <View style={styles.overlayContent}>
            {copy}
            {hasTryon ? (
              <Pressable
                onPress={onTryon}
                style={[
                  styles.overlayCta,
                  {
                    backgroundColor: ctaBackground,
                    borderRadius: theme.button.radius,
                    borderWidth: theme.button.borderWidth,
                    borderColor: theme.button.borderColor,
                  },
                ]}
              >
                <AppIcon name="tryon" size={15} color={ctaColor} />
                <Text style={[styles.overlayCtaText, { color: ctaColor, letterSpacing: theme.button.letterSpacing }]}>
                  试穿同款
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>

      {stacked ? (
        <View style={styles.metaRow}>
          {copy}
          {hasTryon ? (
            <Pressable
              onPress={onTryon}
              style={[
                styles.metaCta,
                {
                  backgroundColor: theme.button.background,
                  borderRadius: theme.button.radius,
                  borderWidth: theme.button.borderWidth,
                  borderColor: theme.button.borderColor,
                },
              ]}
            >
              <Text style={[styles.metaCtaText, { color: theme.button.color, letterSpacing: theme.button.letterSpacing }]}>
                试穿同款
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function FeedVideo({ uri, active }: { uri: string; active: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const player = useVideoPlayer(uri, (videoPlayer) => {
    videoPlayer.loop = true;
  });

  useEffect(() => {
    if (active) player.play();
    else player.pause();
  }, [active, player]);

  return <VideoView player={player} style={styles.media} contentFit="cover" nativeControls={false} />;
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, type, card } = theme;

  return StyleSheet.create({
    card: {
      width: '100%',
      overflow: 'hidden',
      backgroundColor: colors.surface,
      borderRadius: card.radius,
      borderWidth: card.borderWidth,
      borderColor: card.borderColor,
      ...(card.shadow ?? {}),
    },
    frame: {
      flex: 1,
      margin: card.inset,
      borderRadius: card.imageRadius,
      overflow: 'hidden',
      backgroundColor: colors.surfaceAlt,
    },
    frameStacked: { marginBottom: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
    media: { width: '100%', height: '100%' },

    scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '62%' },

    badgeRow: {
      position: 'absolute',
      top: spacing.sm + 4,
      left: spacing.sm + 4,
      right: spacing.sm + 4,
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
    },
    badgeGroup: { flexDirection: 'row', gap: 6 },
    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: 'rgba(17,17,19,0.42)',
    },
    badgeLight: { backgroundColor: 'rgba(255,255,255,0.9)' },
    badgeText: { fontSize: 10, fontWeight: '600', letterSpacing: 0.4 },
    counter: { backgroundColor: 'rgba(255,255,255,0.9)' },
    saveButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(17,17,19,0.42)',
    },
    saveButtonLight: { backgroundColor: 'rgba(255,255,255,0.9)' },

    overlayContent: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: spacing.lg, gap: spacing.sm },
    copy: { gap: 5, flexShrink: 1 },
    kicker: { ...type.label, letterSpacing: 1.4 },
    headline: { ...type.display, fontSize: 26, lineHeight: 32 },
    overlayCta: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    overlayCtaText: { fontSize: 12, fontWeight: '700' },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: card.metaBackground,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    metaCta: { paddingHorizontal: 14, paddingVertical: 9 },
    metaCtaText: { fontSize: 12, fontWeight: '700' },
  });
};
