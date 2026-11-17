import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountSection } from '@/components/AccountSection';
import { RecoverySection } from '@/components/RecoverySection';
import { AppIcon } from '@/components/icons';
import { ResultVideo } from '@/components/ResultVideo';
import { StyleProfileSheet } from '@/components/StyleProfileSheet';
import { ensureSession, useAuth } from '@/lib/auth';
import { DEMO_HISTORY, isDemoRecord, shouldUseDemoHistory } from '@/lib/demoRecords';
import { toUserMessage } from '@/lib/errors';
import { loadFavorites, toggleLookFavorite, type Favorites } from '@/lib/favorites';
import { buildOutfits, type Outfit } from '@/lib/outfits';
import {
  DEFAULT_PROFILE,
  loadStyleProfile,
  profileSummary,
  saveStyleProfile,
  type StyleProfile,
} from '@/lib/styleProfile';
import { deleteTryonTask, fetchGarments, fetchTryonHistory, type Garment, type TryonTask } from '@/lib/supabase';
import { THEME_LIST, useTheme, type Theme } from '@/theme';

type HistoryTask = TryonTask & { garment: { id: string; name: string; category: string } | null };

/** Web 上直接带 ?demo=1 重开页面；原生端演示模式靠构建期开关，这里给个兜底提示 */
function enterDemoMode() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('demo', '1');
  window.location.href = url.toString();
}

const STATUS_LABEL: Record<string, string> = {
  done: '已完成',
  failed: '未完成',
  timeout: '已超时',
};

/**
 * 「我的」页：账号是可选能力，所以放在最后；第一屏先给用户看自己的东西
 * （试穿记录 / 收藏 / 风格档案），符合「我的」这个 tab 的预期。
 */
export default function ProfileScreen() {
  const router = useRouter();
  const { theme, themeId, setTheme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { colors, nav } = theme;
  const { ready, profile } = useAuth();

  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [garments, setGarments] = useState<Garment[]>([]);
  const [favorites, setFavorites] = useState<Favorites>({ garments: [], looks: [] });
  const [styleProfile, setStyleProfile] = useState<StyleProfile>(DEFAULT_PROFILE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // 当前列表是不是「演示记录」，用来加标注并禁掉删除
  const [demoHistory, setDemoHistory] = useState(false);

  const aliveRef = useRef(true);
  const deletingLockRef = useRef(false);
  const userIdRef = useRef<string | undefined>(undefined);

  const loadHistory = useCallback(async () => {
    setError(null);
    try {
      // 014 之后 tryon_tasks 的策略是「只看自己的」，没有会话就一行都查不到。
      // 首装用户可能匿名登录还没走完，这里先确保会话就绪；失败不阻断下面展示。
      await ensureSession().catch(() => null);
      // 允许失败：远端不可用时仍然能把本机收藏与风格展示出来
      const [history, wardrobe] = await Promise.all([
        fetchTryonHistory().catch((err) => {
          setError(toUserMessage(err, '试穿记录读取失败，请稍后重试'));
          return [] as HistoryTask[];
        }),
        fetchGarments().catch(() => [] as Garment[]),
      ]);
      if (!aliveRef.current) return;
      // 演示模式 + 本机一条真实记录都没有：用预置的真实结果顶上，
      // 否则访客进「我的」只看得到空态（记录是按 owner 过滤的，种子数据写不进未知 uid）
      if (shouldUseDemoHistory(history.length)) {
        setTasks(DEMO_HISTORY as unknown as HistoryTask[]);
        setDemoHistory(true);
      } else {
        setTasks(history);
        setDemoHistory(false);
      }
      setGarments(wardrobe);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  // 换账号（或退出登录）时立刻清空上一账号的数据，避免删除时报「没有权限」
  useEffect(() => {
    if (userIdRef.current === profile?.userId) return;
    userIdRef.current = profile?.userId;
    setTasks([]);
    setError(null);
    setActionError(null);
  }, [profile?.userId]);

  useFocusEffect(
    useCallback(() => {
      aliveRef.current = true;
      if (!ready) return () => {};
      void loadHistory();
      void loadFavorites().then((value) => {
        if (aliveRef.current) setFavorites(value);
      });
      void loadStyleProfile().then((value) => {
        if (aliveRef.current) setStyleProfile(value);
      });
      return () => {
        aliveRef.current = false;
        setActionError(null);
      };
    }, [ready, loadHistory]),
  );

  const removeTask = useCallback(async (task: HistoryTask) => {
    if (deletingLockRef.current) return;
    deletingLockRef.current = true;
    setDeletingId(task.id);
    setActionError(null);
    try {
      const { warning } = await deleteTryonTask(task);
      if (!aliveRef.current) return;
      setTasks((current) => current.filter((item) => item.id !== task.id));
      if (warning) setActionError(warning);
    } catch (err) {
      if (aliveRef.current) setActionError(toUserMessage(err, '删除失败，请稍后重试'));
    } finally {
      deletingLockRef.current = false;
      if (aliveRef.current) setDeletingId(null);
    }
  }, []);

  const saveProfile = useCallback(async (next: StyleProfile) => {
    setStyleProfile(next);
    setSheetOpen(false);
    await saveStyleProfile(next);
  }, []);

  const savedGarments = useMemo(
    () => garments.filter((item) => favorites.garments.includes(item.id)),
    [garments, favorites.garments],
  );

  // 收藏的搭配只存了 id，靠同一套引擎重算才能还原成可点击的卡片
  const savedOutfits = useMemo<Outfit[]>(() => {
    if (!favorites.looks.length || !garments.length) return [];
    const all = buildOutfits(garments, {});
    return favorites.looks
      .map((id) => all.find((outfit) => outfit.id === id))
      .filter((outfit): outfit is Outfit => Boolean(outfit))
      .slice(0, 8);
  }, [garments, favorites.looks],
  );
  const removeSavedLook = useCallback(async (outfitId: string) => {
    try {
      const next = await toggleLookFavorite(outfitId);
      setFavorites(next);
    } catch {
      setActionError('取消收藏失败，请重试');
    }
  }, []);

  const doneCount = tasks.filter((task) => task.status === 'done').length;

  return (
    <SafeAreaView edges={['top']} style={styles.safe}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: nav.height + 40 }]}
      >
        <View style={styles.header}>
          <Text style={styles.eyebrow}>STYLE JOURNAL</Text>
          <Text style={styles.title}>我的</Text>
          <Text style={styles.subtitle}>试穿记录、收藏与界面偏好都在这里。</Text>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{doneCount}</Text>
            <Text style={styles.statLabel}>已完成试穿</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.stat}>
            <Text style={styles.statValue}>{savedGarments.length}</Text>
            <Text style={styles.statLabel}>收藏单品</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.stat}>
            <Text style={styles.statValue}>{favorites.looks.length}</Text>
            <Text style={styles.statLabel}>收藏搭配</Text>
          </View>
        </View>

        <Pressable style={styles.profileStrip} onPress={() => setSheetOpen(true)}>
          <View style={styles.profileLeft}>
            <Text style={styles.stripLabel}>风格档案</Text>
            <Text style={styles.stripValue}>{profileSummary(styleProfile)}</Text>
          </View>
          <View style={styles.stripAction}>
            <Text style={styles.stripActionText}>调整</Text>
            <AppIcon name="chevronRight" size={14} color={colors.muted} />
          </View>
        </Pressable>

        {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}

        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>试穿记录</Text>
          <Pressable onPress={() => void loadHistory()} style={styles.inlineAction}>
            <AppIcon name="refresh" size={13} color={colors.muted} />
            <Text style={styles.inlineActionText}>刷新</Text>
          </Pressable>
        </View>

        {demoHistory ? (
          <View style={styles.demoBanner}>
            <AppIcon name="info" size={13} color={colors.muted} />
            <Text style={styles.demoBannerText}>
              演示记录：这 3 条是项目真实跑出来的效果，放在这里让访客不用等生成也能看到结果；你自己的记录会实时出现在上方。
            </Text>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.state}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.stateText}>正在加载记录…</Text>
          </View>
        ) : error ? (
          <View style={styles.state}>
            <AppIcon name="offline" size={24} color={colors.muted} />
            <Text style={styles.stateText}>{error}</Text>
            <Pressable onPress={() => void loadHistory()} style={styles.retry}>
              <Text style={styles.retryText}>重新加载</Text>
            </Pressable>
          </View>
        ) : tasks.length === 0 ? (
          <View style={styles.state}>
            <AppIcon name="gallery" size={24} color={colors.muted} />
            <Text style={styles.stateTitle}>还没有试穿记录</Text>
            <Text style={styles.stateText}>挑一件单品试穿，结果会保存在这里。</Text>
            <Pressable onPress={() => router.push('/(tabs)/tryon' as never)} style={styles.retry}>
              <Text style={styles.retryText}>去试衣</Text>
            </Pressable>
            {Platform.OS === 'web' ? (
              <Pressable onPress={() => enterDemoMode()} hitSlop={8} style={styles.demoLink}>
                <Text style={styles.demoLinkText}>没有照片？先看演示效果 →</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={styles.list}>
            {tasks.map((task) => {
              const busy = deletingId === task.id;
              return (
                <View key={task.id} style={styles.taskCard}>
                  <View style={styles.taskThumb}>
                    <TaskThumb
                      theme={theme}
                      styles={styles}
                      task={task}
                      onOpen={() =>
                        router.push({
                          pathname: '/(tabs)/tryon',
                          params: {
                            ...(task.garment?.id ? { garmentId: task.garment.id } : {}),
                            ...(task.output_type === 'video' ? { autoVideo: '1' } : {}),
                          },
                        } as never)
                      }
                    />
                  </View>
                  <View style={styles.taskInfo}>
                    <Text style={styles.taskName} numberOfLines={1}>
                      {task.garment?.name || '试穿任务'}
                    </Text>
                    <Text style={styles.taskMeta}>
                      {task.garment?.category ? `${task.garment.category} · ` : ''}
                      {new Date(task.created_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                    </Text>
                    <View style={styles.taskBottom}>
                      <Text
                        style={[
                          styles.status,
                          task.status === 'done' ? styles.statusDone : styles.statusPending,
                        ]}
                      >
                        {STATUS_LABEL[task.status] ?? '处理中'}
                      </Text>
                      {isDemoRecord(task.id) ? (
                        // 演示记录不在库里，删不了；改为标注来源，避免点了报错
                        <Text style={styles.demoTag}>演示记录</Text>
                      ) : (
                      <Pressable
                        disabled={deletingId !== null}
                        onPress={() => void removeTask(task)}
                        hitSlop={10}
                        style={[styles.deleteButton, deletingId !== null && !busy && { opacity: 0.35 }]}
                      >
                        {busy ? (
                          <ActivityIndicator size="small" color={colors.danger} />
                        ) : (
                          <>
                            <AppIcon name="trash" size={15} color={colors.danger} />
                            <Text style={styles.deleteText}>删除</Text>
                          </>
                        )}
                      </Pressable>
                      )}
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {savedGarments.length ? (
          <>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>收藏的单品</Text>
              <Text style={styles.sectionAside}>{savedGarments.length} 件</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
              {savedGarments.map((item) => (
                <Pressable
                  key={item.id}
                  style={styles.railCard}
                  onPress={() => router.push({ pathname: '/(tabs)/tryon', params: { garmentId: item.id } } as never)}
                >
                  {item.flat_image_url ? (
                    <Image source={{ uri: item.flat_image_url }} style={styles.railImage} resizeMode="cover" />
                  ) : (
                    <View style={[styles.railImage, styles.thumbFallback]} />
                  )}
                  <Text style={styles.railName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.railMeta}>{item.category} · {item.color}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </>
        ) : null}

        {savedOutfits.length ? (
          <>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>收藏的搭配</Text>
              <Text style={styles.sectionAside}>{savedOutfits.length} 套</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
              {savedOutfits.map((outfit) => (
                <Pressable
                  key={outfit.id}
                  style={styles.railCard}
                  onPress={() =>
                    router.push({
                      pathname: '/(tabs)/tryon',
                      params: {
                        look: outfit.pieces.map((piece) => piece.garment.id).join(','),
                        lookTitle: outfit.title,
                      },
                    } as never)
                  }
                >
                  {outfit.pieces[0]?.garment.flat_image_url ? (
                    <Image
                      source={{ uri: outfit.pieces[0].garment.flat_image_url }}
                      style={styles.railImage}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={[styles.railImage, styles.thumbFallback]} />
                  )}
                  <Pressable
                    onPress={() => void removeSavedLook(outfit.id)}
                    hitSlop={10}
                    style={styles.railRemove}
                    accessibilityLabel={`取消收藏 ${outfit.title}`}
                  >
                    <AppIcon name="minus" size={12} color={colors.text} />
                  </Pressable>
                  <Text style={styles.railName} numberOfLines={1}>{outfit.title}</Text>
                  <Text style={styles.railMeta}>
                    {outfit.pieces.map((piece) => piece.garment.name).join(' × ')}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </>
        ) : null}

        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>界面风格</Text>
          <Text style={styles.sectionAside}>本机生效</Text>
        </View>
        <View style={styles.themeRow}>
          {THEME_LIST.map((option) => {
            const active = option.id === themeId;
            return (
              <Pressable
                key={option.id}
                onPress={() => setTheme(option.id)}
                style={[styles.themeCard, active && styles.themeCardActive]}
              >
                <View style={styles.themeSwatch}>
                  {option.swatch.map((color, swatchIndex) => (
                    <View key={`${option.id}-${swatchIndex}`} style={[styles.swatchCell, { backgroundColor: color }]} />
                  ))}
                  {active ? (
                    <View style={styles.swatchCheck}>
                      <AppIcon name="check" size={11} color={colors.onImage} />
                    </View>
                  ) : null}
                </View>
                <Text style={[styles.themeName, active && styles.themeNameActive]} numberOfLines={1}>
                  {option.name}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>更多</Text>
        </View>
        <View style={styles.menu}>
          <Pressable style={styles.menuItem} onPress={() => router.push('/(tabs)/chat' as never)}>
            <View style={styles.menuIcon}><AppIcon name="stylist" size={18} color={colors.text} /></View>
            <View style={styles.menuCopy}>
              <Text style={styles.menuTitle}>问问搭配师</Text>
              <Text style={styles.menuNote}>描述场合与天气，获取搭配建议</Text>
            </View>
            <AppIcon name="chevronRight" size={16} color={colors.muted} />
          </Pressable>
          <Pressable style={styles.menuItem} onPress={() => router.push('/(tabs)/plans' as never)}>
            <View style={styles.menuIcon}><AppIcon name="calendar" size={18} color={colors.text} /></View>
            <View style={styles.menuCopy}>
              <Text style={styles.menuTitle}>试穿套餐</Text>
              <Text style={styles.menuNote}>查看剩余次数与套餐方案</Text>
            </View>
            <AppIcon name="chevronRight" size={16} color={colors.muted} />
          </Pressable>
          <Pressable
            style={[styles.menuItem, styles.menuItemLast]}
            onPress={() => router.push('/admin' as never)}
          >
            <View style={styles.menuIcon}><AppIcon name="settings" size={18} color={colors.text} /></View>
            <View style={styles.menuCopy}>
              <Text style={styles.menuTitle}>衣服素材管理</Text>
              <Text style={styles.menuNote}>上传与管理可试穿的单品</Text>
            </View>
            <AppIcon name="chevronRight" size={16} color={colors.muted} />
          </Pressable>
        </View>

        <Text style={styles.privacyNote}>
          全身照只用于生成试穿结果，可在上方逐条删除；发布到社区的内容才会公开。
        </Text>

        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>账号</Text>
          <Text style={styles.sectionAside}>可选</Text>
        </View>
        <RecoverySection onRestored={() => void loadHistory()} />
        <View style={styles.sectionGap} />
        <AccountSection />
      </ScrollView>

      <StyleProfileSheet
        visible={sheetOpen}
        initial={styleProfile}
        onClose={() => setSheetOpen(false)}
        onSave={(next) => void saveProfile(next)}
      />
    </SafeAreaView>
  );
}

/** 记录缩略图：视频用播放器，图片失败时给一个带说明的占位，避免只剩一块灰 */
function TaskThumb({
  theme,
  styles,
  task,
  onOpen,
}: {
  theme: Theme;
  styles: ReturnType<typeof makeStyles>;
  task: TryonTask;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);

  // 列表里不放 <video>：72x96 的缩略图挂原生控件会弹出浏览器自带的「更多选项」菜单，
  // 而那个菜单的样式不受页面控制（实测在真机上整片空白）。这里只放封面 + 播放角标，
  // 点进试衣页才是真正的播放器。
  if (task.output_type === 'video' && task.result_url) {
    const poster = task.first_frame_url || task.user_photo_url || null;
    return (
      <Pressable onPress={onOpen} style={styles.thumbImage} accessibilityLabel="打开这条视频记录">
        {poster ? (
          <Image source={{ uri: poster }} style={styles.thumbImage} resizeMode="cover" />
        ) : (
          <View style={styles.thumbFallback}>
            <AppIcon name="gallery" size={18} color={theme.colors.muted} />
          </View>
        )}
        <View style={styles.playBadge}>
          <AppIcon name="play" size={10} color={theme.colors.onImage} />
        </View>
      </Pressable>
    );
  }

  const uri = task.result_url || task.first_frame_url || task.user_photo_url || null;
  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        style={styles.thumbImage}
        resizeMode="cover"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <View style={styles.thumbFallback}>
      <AppIcon name="gallery" size={18} color={theme.colors.muted} />
      <Text style={styles.thumbFallbackText}>
        {failed ? '图片已失效' : '暂无预览'}
      </Text>
    </View>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, type, button, fonts } = theme;
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    content: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, gap: spacing.md },

    header: { gap: 4, paddingTop: spacing.xs },
    eyebrow: { ...type.label, color: colors.muted, letterSpacing: 1.6 },
    title: { ...type.display, fontSize: 30, lineHeight: 36 },
    subtitle: { ...type.caption, color: colors.muted },

    statsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: 1,
      borderBottomWidth: 1,
      borderColor: colors.border,
      paddingVertical: spacing.sm + 2,
    },
    stat: { flex: 1, alignItems: 'center', gap: 2 },
    statValue: { ...type.title, fontFamily: fonts.body, fontSize: 20, fontWeight: '500', lineHeight: 24 },
    statLabel: { ...type.label, color: colors.muted, letterSpacing: 0.8 },
    statDivider: { width: 1, height: 22, backgroundColor: colors.border },

    profileStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surfaceAlt,
      paddingVertical: spacing.sm + 2,
      paddingHorizontal: spacing.sm + 2,
    },
    profileLeft: { gap: 3 },
    stripLabel: { ...type.label, color: colors.muted, letterSpacing: 1.2 },
    stripValue: { ...type.body, color: colors.text, fontSize: 13 },
    stripAction: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    stripActionText: { ...type.caption, color: colors.muted },

    sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: spacing.xs },
    sectionTitle: { ...type.title, fontSize: 16 },
    sectionAside: { ...type.label, color: colors.muted },
    inlineAction: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
    inlineActionText: { ...type.label, color: colors.muted },

    list: { gap: 10 },
    taskCard: {
      flexDirection: 'row',
      gap: spacing.sm,
      padding: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
    },
    taskThumb: { width: 72, height: 96, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.surfaceAlt },
    thumbImage: { width: '100%', height: '100%' },
    thumbFallback: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      backgroundColor: colors.surfaceAlt,
    },
    thumbFallbackText: { ...type.label, color: colors.muted, fontSize: 9, letterSpacing: 0.2 },
    playBadge: {
      position: 'absolute',
      right: 5,
      bottom: 5,
      width: 18,
      height: 18,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(17,17,19,0.72)',
    },
    taskInfo: { flex: 1, justifyContent: 'space-between', paddingVertical: 2 },
    taskName: { ...type.body, color: colors.text, fontSize: 14 },
    taskMeta: { ...type.caption, color: colors.muted },
    taskBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    status: { ...type.label, letterSpacing: 0.6 },
    statusDone: { color: colors.success },
    statusPending: { color: colors.muted },
    deleteButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      minHeight: 44,
      paddingHorizontal: 6,
    },
    demoBanner: {
      flexDirection: 'row',
      gap: 8,
      padding: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: colors.surfaceAlt,
      marginBottom: spacing.sm,
    },
    demoBannerText: { ...type.caption, color: colors.muted, flex: 1, lineHeight: 17 },
    demoTag: {
      ...type.caption,
      color: colors.muted,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceAlt,
      overflow: 'hidden',
    },
    demoLink: { marginTop: spacing.sm, paddingVertical: 6 },
    demoLinkText: { ...type.caption, color: colors.text, textDecorationLine: 'underline' },
    deleteText: { ...type.label, color: colors.danger },

    rail: { gap: 10, paddingRight: spacing.md },
    railCard: { width: 104, gap: 4 },
    railImage: { width: 104, height: 136, borderRadius: radius.md, backgroundColor: colors.surfaceAlt },
    railRemove: {
      position: 'absolute',
      top: 6,
      right: 6,
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.92)',
    },
    railName: { ...type.caption, color: colors.text, fontSize: 12 },
    railMeta: { ...type.label, color: colors.muted, fontSize: 9 },

    themeRow: { flexDirection: 'row', gap: 8 },
    themeCard: {
      flex: 1,
      alignItems: 'center',
      gap: 6,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.sm,
      backgroundColor: colors.surface,
    },
    themeCardActive: { borderColor: colors.accent },
    themeSwatch: {
      width: 30,
      height: 22,
      borderRadius: 5,
      overflow: 'hidden',
      flexDirection: 'row',
      borderWidth: 1,
      borderColor: colors.border,
    },
    swatchCell: { flex: 1, height: '100%' },
    swatchCheck: {
      position: 'absolute',
      right: 1,
      bottom: 1,
      width: 12,
      height: 12,
      borderRadius: 6,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    themeName: { ...type.label, color: colors.muted, fontSize: 9 },
    themeNameActive: { color: colors.text },

    menu: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      overflow: 'hidden',
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 14,
      paddingHorizontal: spacing.sm + 2,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      minHeight: 56,
    },
    menuItemLast: { borderBottomWidth: 0 },
    menuIcon: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceAlt,
    },
    menuCopy: { flex: 1, gap: 2 },
    menuTitle: { ...type.body, color: colors.text, fontSize: 13 },
    menuNote: { ...type.caption, color: colors.muted, fontSize: 11 },

    state: {
      alignItems: 'center',
      gap: 8,
      paddingVertical: spacing.lg,
      paddingHorizontal: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
    },
    stateTitle: { ...type.title, fontSize: 15 },
    stateText: { ...type.caption, color: colors.muted, textAlign: 'center', lineHeight: 18 },
    retry: {
      marginTop: 4,
      paddingHorizontal: spacing.md,
      paddingVertical: 9,
      borderRadius: button.radius,
      backgroundColor: button.background,
    },
    retryText: { ...type.label, color: colors.onImage },

    actionError: { ...type.caption, color: colors.danger },
    privacyNote: { ...type.caption, color: colors.muted, lineHeight: 18, marginTop: spacing.xs },
    sectionGap: { height: spacing.md },
  });
};
