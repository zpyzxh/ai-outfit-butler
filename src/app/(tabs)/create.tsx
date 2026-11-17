import { AppIcon } from '@/components/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ResultVideo } from '@/components/ResultVideo';
import { deleteMyInspiration, fetchMyInspiration, pickInspirationMedia, publishInspiration, type PickedInspiration } from '@/lib/inspirationUpload';
import { fetchGarments, type Garment } from '@/lib/supabase';
import { useTheme, useThemedStyles, type Theme } from '@/theme';

type MyPost = Awaited<ReturnType<typeof fetchMyInspiration>>[number];

export default function CreateScreen() {
  const { theme } = useTheme();
  const { colors, button } = theme;
  const styles = useThemedStyles(makeStyles);
  const [media, setMedia] = useState<PickedInspiration | null>(null);
  const [caption, setCaption] = useState('');
  const [garments, setGarments] = useState<Garment[]>([]);
  const [linkedGarmentId, setLinkedGarmentId] = useState<string | null>(null);
  const [posts, setPosts] = useState<MyPost[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const publishLockRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const loadPosts = useCallback(async () => {
    try {
      const next = await fetchMyInspiration();
      if (!aliveRef.current) return;
      setPosts(next);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : '作品列表加载失败');
    } finally {
      if (aliveRef.current) setLoadingPosts(false);
    }
  }, []);

  useEffect(() => { void loadPosts(); }, [loadPosts]);

  // 关联单品是可选项：读不到衣橱就不展示这一块，不能影响发布主流程
  useEffect(() => {
    let cancelled = false;
    void fetchGarments()
      .then((list) => { if (!cancelled && aliveRef.current) setGarments(list); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const chooseMedia = async () => {
    setError(null); setMessage(null);
    try {
      const picked = await pickInspirationMedia();
      if (picked) setMedia(picked);
    } catch (err) { setError(err instanceof Error ? err.message : '选择文件失败'); }
  };

  const publish = async () => {
    if (!media || busy || publishLockRef.current) return;
    publishLockRef.current = true;
    setBusy(true); setError(null); setMessage(null);
    try {
      await publishInspiration(media, caption, linkedGarmentId);
      setMedia(null); setCaption(''); setLinkedGarmentId(null);
      setMessage('已发布，其他人现在可以在首页刷到。');
      await loadPosts();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发布失败，请重试');
    } finally {
      publishLockRef.current = false;
      setBusy(false);
    }
  };

  const removePost = async (post: MyPost) => {
    setBusy(true); setError(null);
    try {
      const { warning } = await deleteMyInspiration(post.id, post.media_url);
      if (!aliveRef.current) return;
      // 记录已删除成功，本地列表必须同步移除，否则会出现「已删但仍在列表」的状态残留
      setPosts((current) => current.filter((item) => item.id !== post.id));
      setMessage('作品已从首页移除');
      setError(warning ?? null);
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : '删除失败，请重试');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const confirmRemove = (post: MyPost) => {
    const prompt = `删除“${post.caption || '这条作品'}”？删除后会从首页移除。`;
    if (Platform.OS === 'web') {
      if (window.confirm(prompt)) void removePost(post);
      return;
    }
    Alert.alert('删除作品？', prompt, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => void removePost(post) },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* iOS 键盘弹出时把页面顶起来，否则多行配文框会被键盘盖住 */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
        >
        <Text style={styles.eyebrow}>分享穿搭灵感</Text>
        <Text style={styles.title}>发布作品</Text>
        <Text style={styles.subtitle}>选择一张穿搭图片或一段短视频，发布后会出现在所有人的首页灵感流。</Text>

        <Pressable disabled={busy} onPress={() => void chooseMedia()} style={styles.mediaPicker}>
          {media ? (
            <>
              {media.mediaType === 'video' ? <ResultVideo uri={media.uri} style={styles.preview} /> : <Image source={{ uri: media.uri }} style={styles.preview} resizeMode="cover" />}
              <View style={styles.changeOverlay}><AppIcon name="swap-horizontal" size={16} color={colors.onImage} /><Text style={styles.changeText}>更换媒体</Text></View>
            </>
          ) : (
            <>
              <View style={styles.addIcon}><AppIcon name="add" size={28} color={colors.accent} /></View>
              <Text style={styles.pickerTitle}>选择图片或视频</Text>
              <Text style={styles.pickerHint}>JPG · PNG · WebP · MP4 · MOV · WebM，最大 50 MB</Text>
            </>
          )}
        </Pressable>

        <Text style={styles.label}>配文（可选）</Text>
        <TextInput
          value={caption}
          onChangeText={setCaption}
          placeholder="写一句搭配心得或灵感…"
          placeholderTextColor={colors.muted}
          maxLength={120}
          multiline
          style={styles.captionInput}
        />
        <Text style={styles.characterCount}>{caption.length}/120</Text>

        {garments.length > 0 ? (
          <>
            <Text style={styles.label}>关联单品（可选）</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.garmentRow}>
              {garments.slice(0, 12).map((garment) => {
                const active = linkedGarmentId === garment.id;
                return (
                  <Pressable
                    key={garment.id}
                    onPress={() => setLinkedGarmentId(active ? null : garment.id)}
                    style={[styles.garmentChip, active && styles.garmentChipActive]}
                    accessibilityRole="button"
                  >
                    <Image
                      source={{ uri: garment.flat_image_url }}
                      style={styles.garmentThumb}
                      resizeMode="cover"
                    />
                    <Text
                      numberOfLines={1}
                      style={[styles.garmentName, active && styles.garmentNameActive]}
                    >
                      {garment.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Text style={styles.linkHint}>
              关联后，别人在首页看到这条作品就能直接「试穿同款」。
            </Text>
          </>
        ) : null}

        <View style={styles.publicNotice}>
          <AppIcon name="earth-outline" size={17} color={colors.accent} />
          <Text style={styles.noticeText}>发布后所有使用者都能在首页看到。请只发布你有权分享的内容；不要上传他人未授权的照片或个人信息。</Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {message ? <Text style={styles.success}>{message}</Text> : null}
        <Pressable disabled={!media || busy} onPress={() => void publish()} style={[styles.publishButton, (!media || busy) && styles.disabled]}>
          {busy ? <ActivityIndicator color={button.color} /> : <AppIcon name="cloud-upload-outline" size={18} color={button.color} />}
          <Text style={styles.publishText}>{busy ? '正在发布…' : '发布到首页'}</Text>
        </Pressable>

        <View style={styles.myPostsHeader}>
          <Text style={styles.sectionTitle}>我的发布</Text>
          <Pressable onPress={() => void loadPosts()}><Text style={styles.refresh}>刷新</Text></Pressable>
        </View>
        {loadingPosts ? <ActivityIndicator color={colors.accent} /> : posts.length === 0 ? (
          <Text style={styles.empty}>发布后的图片和视频会显示在这里。</Text>
        ) : posts.map((post) => (
          <View key={post.id} style={styles.postRow}>
            {post.media_type === 'video' ? <View style={[styles.postThumb, styles.videoThumb]}><AppIcon name="play-circle" size={25} color={colors.text} /></View> : <Image source={{ uri: post.media_url }} style={styles.postThumb} />}
            <View style={styles.postText}><Text numberOfLines={2} style={styles.postCaption}>{post.caption || (post.media_type === 'video' ? '穿搭视频' : '穿搭图片')}</Text><Text style={styles.postDate}>{new Date(post.created_at).toLocaleDateString()}</Text></View>
            <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel="删除我的作品" onPress={() => confirmRemove(post)} style={styles.deleteButton}><AppIcon name="trash-outline" size={18} color={colors.danger} /></Pressable>
          </View>
        ))}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, button, type, nav } = theme;
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    content: { padding: spacing.md, paddingBottom: spacing.xl + (nav.floating ? nav.height + 16 : 0), gap: spacing.sm },
    eyebrow: { ...type.label, color: colors.accent },
    title: { ...type.display, color: colors.text },
    subtitle: { ...type.body, color: colors.muted, marginBottom: spacing.sm },
    mediaPicker: { minHeight: 270, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', gap: spacing.sm },
    addIcon: { width: 58, height: 58, borderRadius: radius.pill, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
    pickerTitle: { ...type.section, color: colors.text },
    pickerHint: { ...type.caption, color: colors.muted },
    preview: { width: '100%', height: 320, borderRadius: radius.lg },
    changeOverlay: { position: 'absolute', right: 12, bottom: 12, flexDirection: 'row', gap: 5, alignItems: 'center', backgroundColor: colors.scrim, paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.pill },
    changeText: { color: colors.onImage, fontSize: 11, fontWeight: '600' },
    label: { ...type.label, color: colors.text, marginTop: spacing.sm },
    captionInput: { ...type.body, minHeight: 82, textAlignVertical: 'top', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.sm, color: colors.text },
    characterCount: { ...type.caption, alignSelf: 'flex-end', color: colors.muted },
    garmentRow: { gap: spacing.xs, paddingVertical: 2 },
    garmentChip: {
      width: 84,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      padding: 5,
      gap: 5,
    },
    garmentChipActive: { borderColor: colors.accent, borderWidth: 1.5 },
    garmentThumb: { width: '100%', height: 62, borderRadius: 5, backgroundColor: colors.surfaceAlt },
    garmentName: { ...type.caption, fontSize: 10, color: colors.muted },
    garmentNameActive: { color: colors.text, fontWeight: '600' },
    linkHint: { ...type.caption, color: colors.muted },
    publicNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.accentSoft },
    noticeText: { ...type.caption, flex: 1, color: colors.text },
    error: { ...type.caption, color: colors.danger },
    success: { ...type.caption, color: colors.success },
    publishButton: { minHeight: button.minHeight, borderRadius: button.radius, borderWidth: button.borderWidth, borderColor: button.borderColor, backgroundColor: button.background, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
    disabled: { opacity: 0.45 },
    publishText: { color: button.color, fontSize: 14, fontWeight: '700', letterSpacing: button.letterSpacing },
    myPostsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg },
    sectionTitle: { ...type.section, color: colors.text },
    refresh: { color: colors.accent, fontSize: 12, fontWeight: '600' },
    empty: { ...type.caption, color: colors.muted, paddingVertical: spacing.sm },
    postRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 72, padding: spacing.xs, borderRadius: radius.md, backgroundColor: colors.surface },
    postThumb: { width: 54, height: 62, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt },
    videoThumb: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt },
    postText: { flex: 1, gap: 4 },
    postCaption: { ...type.body, color: colors.text, fontSize: 12, fontWeight: '600' },
    postDate: { ...type.caption, color: colors.muted, fontSize: 10 },
    deleteButton: { padding: spacing.sm },
  });
};

