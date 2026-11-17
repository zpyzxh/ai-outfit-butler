import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/icons';
import { OutfitCard } from '@/components/OutfitCard';
import { CardSkeleton } from '@/components/Skeleton';
import { StyleProfileSheet } from '@/components/StyleProfileSheet';
import { WeatherChip } from '@/components/WeatherChip';
import { loadFavorites, toggleLookFavorite, type Favorites } from '@/lib/favorites';
import { toUserMessage } from '@/lib/errors';
import { buildOutfits, pickTopOutfits, weatherHint, type Outfit } from '@/lib/outfits';
import {
  DEFAULT_PROFILE,
  GENDER_OPTIONS,
  OCCASION_OPTIONS,
  VIBE_OPTIONS,
  loadStyleProfile,
  profileSummary,
  saveStyleProfile,
  type StyleProfile,
} from '@/lib/styleProfile';
import { fetchGarments, type Garment } from '@/lib/supabase';
import { fetchWeather, type WeatherInfo } from '@/lib/weather';
import { useTheme, type Theme } from '@/theme';

function todayLabel() {
  const now = new Date();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${week}`;
}

export default function OutfitsScreen() {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const router = useRouter();
  const { nav } = theme;

  const [garments, setGarments] = useState<Garment[]>([]);
  const [weather, setWeather] = useState<WeatherInfo | null>(null);
  const [profile, setProfile] = useState<StyleProfile | null>(null);
  const [favorites, setFavorites] = useState<Favorites>({ garments: [], looks: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState(7);
  const [sheetOpen, setSheetOpen] = useState(false);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextGarments, nextProfile, nextFavorites] = await Promise.all([
        fetchGarments(),
        loadStyleProfile(),
        loadFavorites(),
      ]);
      if (!aliveRef.current) return;
      setGarments(nextGarments);
      setProfile(nextProfile);
      setFavorites(nextFavorites);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(toUserMessage(err, '衣橱读取失败，请稍后重试'));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      aliveRef.current = true;
      void load();
      void fetchWeather()
        .then((value) => {
          if (aliveRef.current) setWeather(value);
        })
        .catch(() => {
          if (aliveRef.current) setWeather(null);
        });
      return () => {
        aliveRef.current = false;
      };
    }, [load]),
  );

  const activeProfile = profile ?? DEFAULT_PROFILE;

  const outfits = useMemo(() => {
    const all = buildOutfits(garments, {
      tempC: weather?.tempC ?? null,
      vibes: activeProfile.vibes,
      occasions: activeProfile.occasions,
      seed,
    });
    return pickTopOutfits(all, 3);
  }, [garments, weather?.tempC, activeProfile.vibes, activeProfile.occasions, seed]);

  const handleSaveOutfit = async (outfit: Outfit) => {
    const next = await toggleLookFavorite(outfit.id);
    setFavorites(next);
  };

  const handleProfileSave = async (next: StyleProfile) => {
    const saved = await saveStyleProfile(next);
    setProfile(saved);
    setSheetOpen(false);
    setSeed((value) => value + 3);
  };

  const openTryon = (outfit: Outfit, autoVideo = false) => {
    router.push({
      pathname: '/tryon',
      params: {
        look: outfit.pieces.map((piece) => piece.garment.id).join(','),
        lookTitle: outfit.title,
        // autoVideo=1 时，试衣页串行跑完整套后直接接着生成视频，用户只按一次
        ...(autoVideo ? { autoVideo: '1' } : {}),
      },
    } as never);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 96 + (nav.floating ? nav.height : 0) }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={theme.colors.muted} />}
      >
        <View style={styles.header}>
          <Text style={styles.eyebrow}>STYLE EDITOR</Text>
          <Text style={styles.title}>今日搭配</Text>
          <View style={styles.headerMeta}>
            <Text style={styles.date}>{todayLabel()}</Text>
            <WeatherChip />
          </View>
        </View>

        <Pressable style={styles.profileStrip} onPress={() => setSheetOpen(true)} accessibilityRole="button">
          <View style={styles.profileLeft}>
            <Text style={styles.stripLabel}>风格档案</Text>
            <Text style={styles.stripValue}>{profileSummary(activeProfile)}</Text>
          </View>
          <View style={styles.stripAction}>
            <Text style={styles.stripActionText}>调整</Text>
            <AppIcon name="chevronRight" size={14} color={theme.colors.muted} />
          </View>
        </Pressable>

        {loading ? (
          <View style={styles.list}>
            <CardSkeleton height={236} />
            <CardSkeleton height={236} />
          </View>
        ) : error ? (
          <View style={styles.stateBox}>
            <AppIcon name="offline" size={26} color={theme.colors.muted} />
            <Text style={styles.stateTitle}>衣橱暂时读取失败</Text>
            <Text style={styles.stateText}>{error}</Text>
            <Pressable style={styles.retry} onPress={() => void load()}>
              <Text style={styles.retryText}>重新加载</Text>
            </Pressable>
          </View>
        ) : outfits.length === 0 ? (
          <View style={styles.stateBox}>
            <AppIcon name="grid" size={26} color={theme.colors.muted} />
            <Text style={styles.stateTitle}>还没有可搭配的单品</Text>
            <Text style={styles.stateText}>去发布页上传衣服，或在管理页添加单品后这里会自动生成搭配。</Text>
          </View>
        ) : (
          <>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>为你挑了 {outfits.length} 套</Text>
              <Pressable style={styles.shuffle} onPress={() => setSeed((value) => value + 5)} hitSlop={8}>
                <AppIcon name="shuffle" size={14} color={theme.colors.text} />
                <Text style={styles.shuffleText}>换一批</Text>
              </Pressable>
            </View>

            <Text style={styles.hint}>{weatherHint(weather?.tempC ?? null)}</Text>

            <View style={styles.list}>
              {outfits.map((outfit, index) => (
                <OutfitCard
                  key={outfit.id}
                  outfit={outfit}
                  index={index}
                  saved={favorites.looks.includes(outfit.id)}
                  onToggleSave={() => void handleSaveOutfit(outfit)}
                  onTryon={() => openTryon(outfit)}
                  onVideo={() => openTryon(outfit, true)}
                />
              ))}
            </View>

            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>单品精选</Text>
              <Text style={styles.sectionAside}>{garments.length} 件</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
              {garments.map((garment) => (
                <Pressable
                  key={garment.id}
                  style={styles.railCard}
                  onPress={() => router.push({ pathname: '/tryon', params: { garmentId: garment.id } } as never)}
                >
                  <Image
                    source={{ uri: garment.model_image_url || garment.flat_image_url }}
                    style={styles.railImage}
                    resizeMode="cover"
                  />
                  <Text style={styles.railName} numberOfLines={1}>
                    {garment.name}
                  </Text>
                  <Text style={styles.railMeta} numberOfLines={1}>
                    {[garment.category, garment.color].filter(Boolean).join(' · ')}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <Pressable style={styles.stylistLink} onPress={() => router.push('/chat' as never)}>
              <View style={styles.stylistLeft}>
                <AppIcon name="stylist" size={16} color={theme.colors.text} />
                <Text style={styles.stylistText}>拿不定主意？问问搭配师</Text>
              </View>
              <AppIcon name="arrowRight" size={14} color={theme.colors.muted} />
            </Pressable>
          </>
        )}
      </ScrollView>

      <StyleProfileSheet
        visible={sheetOpen}
        initial={activeProfile}
        onClose={() => setSheetOpen(false)}
        onSave={(next) => void handleProfileSave(next)}
      />
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, type, button, nav } = theme;
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    content: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, gap: spacing.md },
    header: { gap: 6, paddingTop: spacing.xs },
    eyebrow: { ...type.label, color: colors.muted, letterSpacing: 1.6 },
    title: { ...type.display, fontSize: 30, lineHeight: 36 },
    headerMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 },
    date: { ...type.caption, color: colors.muted },

    profileStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderTopWidth: 1,
      borderBottomWidth: 1,
      borderColor: colors.border,
      paddingVertical: spacing.sm + 2,
    },
    profileLeft: { gap: 3 },
    stripLabel: { ...type.label, color: colors.muted, letterSpacing: 1.2 },
    stripValue: { ...type.body, color: colors.text, fontSize: 13 },
    stripAction: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    stripActionText: { ...type.caption, color: colors.muted },

    sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: spacing.xs },
    sectionTitle: { ...type.title, fontSize: 16 },
    sectionAside: { ...type.label, color: colors.muted },
    shuffle: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    shuffleText: { ...type.label, color: colors.text, letterSpacing: 0.4 },
    hint: { ...type.caption, color: colors.muted, marginTop: -6 },

    list: { gap: spacing.md },

    stateBox: {
      alignItems: 'center',
      gap: 8,
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.lg,
      backgroundColor: colors.surface,
    },
    stateTitle: { ...type.title, fontSize: 15 },
    stateText: { ...type.caption, color: colors.muted, textAlign: 'center', lineHeight: 18 },
    retry: {
      marginTop: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: 9,
      borderRadius: radius.pill,
      backgroundColor: button.background,
    },
    retryText: { ...type.label, color: colors.onImage },

    rail: { gap: 10, paddingRight: spacing.md },
    railCard: { width: 116, gap: 5 },
    railImage: { width: 116, height: 152, borderRadius: radius.md, backgroundColor: colors.surfaceAlt },
    railName: { ...type.caption, color: colors.text, fontSize: 12 },
    railMeta: { ...type.label, color: colors.muted, fontSize: 9 },

    stylistLink: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderTopWidth: 1,
      borderColor: colors.border,
      paddingTop: spacing.md,
      marginTop: spacing.xs,
    },
    stylistLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    stylistText: { ...type.body, fontSize: 13 },

    sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim },
    sheetDismiss: { flex: 1 },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg + 8,
      borderTopRightRadius: radius.lg + 8,
      maxHeight: '82%',
      paddingBottom: nav.height + 16,
    },
    sheetGrabber: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginTop: 10,
    },
    sheetContent: { paddingHorizontal: spacing.md, paddingTop: spacing.md, gap: 10 },
    sheetEyebrow: { ...type.label, color: colors.muted, letterSpacing: 1.6 },
    sheetTitle: { ...type.display, fontSize: 24 },
    sheetNote: { ...type.caption, color: colors.muted },
    fieldLabel: { ...type.label, color: colors.muted, marginTop: 10, letterSpacing: 0.8 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipText: { ...type.caption, color: colors.text },
    chipTextActive: { color: colors.onImage },
    sheetSave: {
      marginTop: spacing.md,
      minHeight: 50,
      borderRadius: button.radius,
      backgroundColor: button.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetSaveText: { ...type.label, color: colors.onImage, fontSize: 12, letterSpacing: 1.2 },
  });
};
