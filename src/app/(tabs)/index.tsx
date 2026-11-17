import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeedMediaCard } from '@/components/FeedMediaCard';
import { AppIcon } from '@/components/icons';
import { Skeleton } from '@/components/Skeleton';
import { WeatherChip } from '@/components/WeatherChip';
import { toUserMessage } from '@/lib/errors';
import { loadFavorites, toggleGarmentFavorite } from '@/lib/favorites';
import { fetchHomeInspiration, type HomeInspiration } from '@/lib/supabase';
import { useTheme, useThemedStyles, type Theme } from '@/theme';

export default function HomeScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { nav } = theme;
  const { height } = useWindowDimensions();

  const [items, setItems] = useState<HomeInspiration[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [feedHeight, setFeedHeight] = useState(0);
  const [savedGarments, setSavedGarments] = useState<string[]>([]);
  // 只有「页面在前台 + 应用在前台 + 这条是当前条目」时才播放视频，
  // 否则切 tab / 退到后台后视频会继续外放声音。
  const [focused, setFocused] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');

  const aliveRef = useRef(true);
  const requestSeqRef = useRef(0);

  const loadFeed = useCallback(async () => {
    const seq = (requestSeqRef.current += 1);
    setError(null);
    try {
      const result = await fetchHomeInspiration();
      if (!aliveRef.current || seq !== requestSeqRef.current) return;
      setItems(result.items);
      setWarning(result.warning);
      // 不要重置到第 0 条：列表滚动位置没变，重置会让当前视频冻结、顶部那条在后台播
      setActiveIndex((current) => (current < result.items.length ? current : 0));
    } catch (err) {
      if (!aliveRef.current || seq !== requestSeqRef.current) return;
      setError(toUserMessage(err, '灵感流读取失败，请稍后重试'));
    } finally {
      if (aliveRef.current && seq === requestSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      aliveRef.current = true;
      setFocused(true);
      setLoading(true);
      void loadFeed();
      void loadFavorites()
        .then((favorites) => {
          if (aliveRef.current) setSavedGarments(favorites.garments);
        })
        .catch(() => undefined);
      return () => {
        aliveRef.current = false;
        setFocused(false);
      };
    }, [loadFeed]),
  );

  const onLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    if (Math.abs(next - feedHeight) > 1) setFeedHeight(next);
  };

  const navInset = nav.floating ? nav.height + 16 : 0;
  const rowHeight = Math.max(feedHeight || Math.max(height - 200, 460), 360);
  const cardHeight = Math.max(rowHeight - navInset - 10, 320);

  const openTryon = (garmentId: string) => {
    router.push({ pathname: '/tryon', params: { garmentId } } as never);
  };

  const handleToggleSave = async (item: HomeInspiration) => {
    if (!item.garmentId) return;
    const next = await toggleGarmentFavorite(item.garmentId);
    setSavedGarments(next.garments);
  };

  const renderEmpty = () => {
    if (loading) {
      return (
        <View style={styles.stateBox}>
          <Skeleton height={380} radius={20} />
          <Skeleton width="60%" height={16} style={{ marginTop: 18 }} />
          <Skeleton width="40%" height={12} />
        </View>
      );
    }

    if (error) {
      return (
        <View style={styles.stateBox}>
          <AppIcon name="offline" size={26} color={theme.colors.muted} />
          <Text style={styles.stateTitle}>灵感流暂时打不开</Text>
          <Text style={styles.stateText}>{error}</Text>
          <Pressable
            style={styles.stateButton}
            onPress={() => {
              setLoading(true);
              void loadFeed();
            }}
          >
            <Text style={styles.stateButtonText}>重新加载</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <View style={styles.stateBox}>
        <AppIcon name="grid" size={26} color={theme.colors.muted} />
        <Text style={styles.stateTitle}>还没有穿搭灵感</Text>
        <Text style={styles.stateText}>
          点底部「+ 发布」上传图片或视频，发布后会出现在这里；也可以先去「搭配」看看今天穿什么。
        </Text>
        <View style={styles.stateActions}>
          <Pressable style={styles.stateButton} onPress={() => router.push('/create' as never)}>
            <Text style={styles.stateButtonText}>去发布</Text>
          </Pressable>
          <Pressable style={styles.stateGhost} onPress={() => router.push('/outfits' as never)}>
            <Text style={styles.stateGhostText}>看搭配</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.eyebrow}>STYLE JOURNAL · AI 穿搭管家</Text>
          <Text style={styles.swipeHint}>上下滑动</Text>
        </View>
        <Text style={styles.title}>今日灵感</Text>
      </View>

      <View style={styles.metaRow}>
        <WeatherChip />
        {warning ? (
          <Text style={styles.warning} numberOfLines={2}>
            {warning}
          </Text>
        ) : (
          <Text style={styles.subtle} numberOfLines={1}>
            {items.length > 0 ? `共 ${items.length} 条灵感` : '社区与单品灵感'}
          </Text>
        )}
      </View>

      <View style={styles.feed} onLayout={onLayout}>
        {items.length === 0 ? (
          renderEmpty()
        ) : (
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            showsVerticalScrollIndicator={false}
            pagingEnabled={false}
            decelerationRate="fast"
            snapToInterval={rowHeight}
            snapToAlignment="start"
            disableIntervalMomentum
            initialNumToRender={1}
            maxToRenderPerBatch={2}
            windowSize={3}
            removeClippedSubviews
            getItemLayout={(_, index) => ({ length: rowHeight, offset: rowHeight * index, index })}
            onMomentumScrollEnd={(event) => {
              const next = Math.round(event.nativeEvent.contentOffset.y / rowHeight);
              setActiveIndex(Math.max(0, Math.min(next, items.length - 1)));
            }}
            renderItem={({ item, index }) => (
              <View style={{ height: rowHeight, paddingBottom: navInset + 10 }}>
                <FeedMediaCard
                  item={item}
                  index={index}
                  total={items.length}
                  active={focused && appActive && index === activeIndex}
                  height={cardHeight}
                  saved={item.garmentId ? savedGarments.includes(item.garmentId) : false}
                  onToggleSave={() => void handleToggleSave(item)}
                  onTryon={() => item.garmentId && openTryon(item.garmentId)}
                />
              </View>
            )}
          />
        )}
      </View>

      {loading && items.length > 0 ? (
        <View style={styles.loadingPill} pointerEvents="none">
          <ActivityIndicator size="small" color={theme.colors.muted} />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, type, button } = theme;
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, gap: 4 },
    headerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    eyebrow: { ...type.label, color: colors.muted, letterSpacing: 1.4, flex: 1 },
    swipeHint: { ...type.label, color: colors.muted, fontSize: 9 },
    title: { ...type.display, fontSize: 28, lineHeight: 34 },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: spacing.md,
      paddingTop: 8,
      paddingBottom: 10,
    },
    subtle: { ...type.caption, color: colors.muted, flex: 1 },
    warning: { ...type.caption, color: colors.muted, flex: 1, lineHeight: 15 },
    feed: { flex: 1, paddingHorizontal: spacing.md },

    stateBox: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      paddingHorizontal: spacing.md,
      paddingBottom: 90,
    },
    stateTitle: { ...type.title, fontSize: 17, textAlign: 'center' },
    stateText: { ...type.caption, color: colors.muted, textAlign: 'center', lineHeight: 19, maxWidth: 300 },
    stateActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
    stateButton: {
      paddingHorizontal: spacing.md,
      paddingVertical: 11,
      borderRadius: button.radius,
      backgroundColor: button.background,
    },
    stateButtonText: { ...type.label, color: colors.onImage, fontSize: 11, letterSpacing: 0.8 },
    stateGhost: {
      paddingHorizontal: spacing.md,
      paddingVertical: 11,
      borderRadius: button.radius,
      borderWidth: 1,
      borderColor: colors.border,
    },
    stateGhostText: { ...type.label, color: colors.text, fontSize: 11, letterSpacing: 0.8 },

    loadingPill: {
      position: 'absolute',
      top: 96,
      right: spacing.md,
      width: 26,
      height: 26,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceAlt,
    },
  });
};
