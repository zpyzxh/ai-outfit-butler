import { Image, StyleSheet, Text, View } from 'react-native';

import type { Garment } from '@/lib/supabase';
import { useThemedStyles, type Theme } from '@/theme';

type Props = {
  garment: Garment;
};

export function GarmentCard({ garment }: Props) {
  const styles = useThemedStyles(makeStyles);
  const uri = garment.model_image_url || garment.flat_image_url;

  return (
    <View style={styles.card}>
      <Image
        source={{ uri }}
        style={styles.image}
        resizeMode="cover"
      />
      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {garment.name}
        </Text>
        <View style={styles.tags}>
          <Text style={styles.tag}>{garment.category}</Text>
          {garment.color ? <Text style={styles.tagMuted}>{garment.color}</Text> : null}
        </View>
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, card, type } = theme;
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: card.radius,
      borderWidth: card.borderWidth,
      borderColor: card.borderColor,
      padding: card.inset,
      overflow: 'hidden',
    },
    image: {
      width: '100%',
      aspectRatio: 3 / 4,
      borderRadius: card.imageRadius,
      backgroundColor: colors.surfaceAlt,
    },
    meta: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      gap: spacing.xs,
      backgroundColor: card.metaBackground,
    },
    name: {
      ...type.body,
      fontWeight: '600',
      color: colors.text,
    },
    tags: {
      flexDirection: 'row',
      gap: spacing.xs,
    },
    tag: {
      ...type.label,
      color: colors.accent,
      backgroundColor: colors.accentSoft,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radius.sm,
      overflow: 'hidden',
    },
    tagMuted: {
      ...type.label,
      color: colors.muted,
      backgroundColor: colors.surfaceAlt,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radius.sm,
      overflow: 'hidden',
    },
  });
};
