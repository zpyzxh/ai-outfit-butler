import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/components/icons';
import type { Outfit } from '@/lib/outfits';
import { useTheme, type Theme } from '@/theme';

type Props = {
  outfit: Outfit;
  index?: number;
  mediaHeight?: number;
  saved?: boolean;
  onPress?: () => void;
  onToggleSave?: () => void;
  onTryon?: () => void;
  /** 一次性把整套串行试穿完再直接出视频 */
  onVideo?: () => void;
};

const ROLE_LABEL: Record<string, string> = {
  top: '上装',
  bottom: '下装',
  dress: '连衣裙',
  outer: '外套',
};

function pieceSummary(outfit: Outfit) {
  return outfit.pieces.map((piece) => piece.garment.name).join(' × ');
}

/**
 * 搭配卡片：图片墙 + 一句推荐理由 + 两个动作。
 * 图片用 flex 拼贴而不是固定宽高，1/2/3 件都能铺满同一块区域。
 */
export function OutfitCard({ outfit, index, mediaHeight = 236, saved, onPress, onToggleSave, onTryon, onVideo }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [leading, ...rest] = outfit.pieces;

  return (
    <View style={styles.card}>
      <Pressable onPress={onPress} style={styles.mediaWrap} accessibilityRole={onPress ? 'button' : undefined}>
        <View style={[styles.media, { height: mediaHeight }]}>
          {rest.length === 0 ? (
            <Image source={{ uri: imageUri(leading) }} style={styles.fill} resizeMode="cover" />
          ) : rest.length === 1 ? (
            <>
              <Image source={{ uri: imageUri(leading) }} style={styles.rowImage} resizeMode="cover" />
              <Image source={{ uri: imageUri(rest[0]) }} style={styles.rowImage} resizeMode="cover" />
            </>
          ) : (
            <>
              <Image source={{ uri: imageUri(leading) }} style={styles.leadImage} resizeMode="cover" />
              <View style={styles.stack}>
                <Image source={{ uri: imageUri(rest[0]) }} style={styles.stackImage} resizeMode="cover" />
                <Image source={{ uri: imageUri(rest[1]) }} style={styles.stackImage} resizeMode="cover" />
              </View>
            </>
          )}
        </View>

        {typeof index === 'number' ? (
          <View style={styles.indexPlate}>
            <Text style={styles.indexText}>{String(index + 1).padStart(2, '0')}</Text>
          </View>
        ) : null}

        <View style={styles.roleRow}>
          {outfit.pieces.map((piece) => (
            <Text key={piece.garment.id} style={styles.roleChip}>
              {ROLE_LABEL[piece.role] ?? '单品'}
            </Text>
          ))}
        </View>
      </Pressable>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {outfit.title}
          </Text>
          {onToggleSave ? (
            <Pressable onPress={onToggleSave} hitSlop={10} accessibilityLabel={saved ? '取消收藏' : '收藏这套搭配'}>
              <AppIcon name="heart" size={18} color={saved ? theme.colors.accent : theme.colors.muted} />
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.pieces} numberOfLines={2}>
          {pieceSummary(outfit)}
        </Text>
        <Text style={styles.reason} numberOfLines={3}>
          {outfit.reason}
        </Text>

        <View style={styles.footer}>
          <Text style={styles.tags} numberOfLines={1}>
            {outfit.tags.map((tag) => `# ${tag}`).join('   ')}
          </Text>
          {onVideo ? (
            <Pressable onPress={onVideo} style={styles.videoCta} accessibilityRole="button">
              <AppIcon name="video" size={13} color={theme.colors.text} />
              <Text style={styles.videoCtaText}>出视频</Text>
            </Pressable>
          ) : null}
          {onTryon ? (
            <Pressable onPress={onTryon} style={styles.cta} accessibilityRole="button">
              <Text style={styles.ctaText}>试穿这套</Text>
              <AppIcon name="arrowRight" size={14} color={theme.colors.onImage} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function imageUri(piece: Outfit['pieces'][number]) {
  return piece.garment.model_image_url || piece.garment.flat_image_url;
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, type, button } = theme;
  return StyleSheet.create({
    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.lg + 2,
      backgroundColor: colors.surface,
      overflow: 'hidden',
    },
    mediaWrap: { position: 'relative' },
    media: { flexDirection: 'row', gap: 2, backgroundColor: colors.surfaceAlt },
    fill: { width: '100%', height: '100%' },
    // 横向拼贴里不能用 width:'100%'（会挤掉后面的图），只用 flex 分配宽度
    rowImage: { flex: 1, height: '100%' },
    leadImage: { flex: 1.5, height: '100%' },
    stack: { flex: 1, gap: 2 },
    stackImage: { flex: 1, width: '100%' },
    indexPlate: {
      position: 'absolute',
      top: 10,
      left: 10,
      paddingHorizontal: 8,
      paddingVertical: 4,
      backgroundColor: 'rgba(255,255,255,0.92)',
      borderRadius: radius.pill,
    },
    indexText: { ...type.label, color: colors.text, fontSize: 10 },
    roleRow: { position: 'absolute', bottom: 10, left: 10, flexDirection: 'row', gap: 6 },
    roleChip: {
      ...type.label,
      fontSize: 9,
      color: colors.text,
      backgroundColor: 'rgba(255,255,255,0.92)',
      paddingHorizontal: 7,
      paddingVertical: 3,
      borderRadius: radius.pill,
      overflow: 'hidden',
    },
    body: { padding: spacing.sm + 2, gap: 5 },
    titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    title: { ...type.title, flex: 1 },
    pieces: { ...type.caption, color: colors.muted },
    reason: { ...type.body, fontSize: 12, lineHeight: 18, color: colors.text },
    footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, gap: 8 },
    tags: { ...type.label, color: colors.muted, flex: 1 },
    cta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: button.background,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: button.radius,
    },
    ctaText: { ...type.label, color: colors.onImage, fontSize: 11, letterSpacing: 0.5 },
    videoCta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 11,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    videoCtaText: { ...type.label, color: colors.text, fontSize: 10.5, letterSpacing: 0.4 },
  });
};
