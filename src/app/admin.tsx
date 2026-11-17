import { AppIcon } from '@/components/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pickAndUploadGarmentImage, removeGarmentImage } from '@/lib/adminGarments';
import { fetchGarments, supabase, type Garment } from '@/lib/supabase';
import { useTheme, useThemedStyles, type Theme } from '@/theme';

export default function AdminScreen() {
  const { theme } = useTheme();
  const { colors, button } = theme;
  const styles = useThemedStyles(makeStyles);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [items, setItems] = useState<Garment[]>([]);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('上装');
  const [color, setColor] = useState('');
  const [gender, setGender] = useState('female');
  const [flatImage, setFlatImage] = useState<string | null>(null);
  const [modelImage, setModelImage] = useState<string | null>(null);
  // 背面平铺图（可选）：试衣模型只吃一张衣服图，正面图推出来的背面褶裥是编的。
  // 传了背面图，用户就能在试衣结果里点「看背面」拿到真实背面。
  const [backImage, setBackImage] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 本次编辑里已上传到 Storage、但还没被数据库引用到的图片，取消/替换/离开时要清掉，避免孤儿文件
  const pendingUploadsRef = useRef<string[]>([]);
  // 编辑开始时数据库里已引用的图片：保存后如果被替换掉，旧图就成了孤儿
  const originalImagesRef = useRef<{ flat: string | null; model: string | null; back: string | null }>({ flat: null, model: null, back: null });

  const isImageStillReferenced = useCallback(async (url: string, excludeId: string) => {
    const [flatQuery, modelQuery, backQuery] = await Promise.all([
      supabase.from('garments').select('id').eq('flat_image_url', url).neq('id', excludeId).limit(1),
      supabase.from('garments').select('id').eq('model_image_url', url).neq('id', excludeId).limit(1),
      // 021 之前的库没有 back_image_url 列，查它会报错 → 走下面的「按仍被引用处理」分支，安全
      supabase.from('garments').select('id').eq('back_image_url', url).neq('id', excludeId).limit(1),
    ]);
    // 查询失败时按「仍被引用」处理，宁可留下文件也不要误删别人的图
    if (flatQuery.error || modelQuery.error || backQuery.error) return true;
    return Boolean(flatQuery.data?.length || modelQuery.data?.length || backQuery.data?.length);
  }, []);

  const discardPendingUploads = useCallback(() => {
    const urls = pendingUploadsRef.current;
    pendingUploadsRef.current = [];
    urls.forEach((url) => { void removeGarmentImage(url).catch(() => {}); });
  }, []);

  useEffect(() => () => {
    // 页面卸载时仍有未保存的上传，一并清理
    const urls = pendingUploadsRef.current;
    pendingUploadsRef.current = [];
    urls.forEach((url) => { void removeGarmentImage(url).catch(() => {}); });
  }, []);

  const loadItems = useCallback(async () => {
    try {
      setItems(await fetchGarments());
    } catch (err) {
      setError(err instanceof Error ? err.message : '素材加载失败');
    }
  }, []);

  const updateUser = useCallback((user: { email?: string; app_metadata?: Record<string, unknown> } | null) => {
    setUserEmail(user?.email ?? null);
    setIsAdmin(user?.app_metadata?.role === 'admin');
  }, []);

  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      updateUser(data.session?.user ?? null);
      setCheckingSession(false);
    });
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => updateUser(session?.user ?? null));
    return () => { alive = false; authListener.subscription.unsubscribe(); };
  }, [updateUser]);

  useEffect(() => {
    if (isAdmin) void loadItems();
  }, [isAdmin, loadItems]);

  const signIn = async () => {
    setBusy(true); setError(null); setMessage(null);
    const { data, error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (authError) { setError(authError.message); return; }
    updateUser(data.user);
    if (data.user.app_metadata?.role !== 'admin') {
      setError('此账号还没有管理员权限，请先按项目说明设置 app_metadata.role = admin。');
      await supabase.auth.signOut();
      updateUser(null);
    }
  };

  const chooseImage = async (kind: 'flat' | 'model' | 'back') => {
    setBusy(true); setError(null);
    try {
      const url = await pickAndUploadGarmentImage(kind);
      if (!url) return;
      // 本次编辑中尚未保存的上一张图：直接删掉，避免替换后残留
      const previous = kind === 'flat' ? flatImage : kind === 'model' ? modelImage : backImage;
      if (previous && pendingUploadsRef.current.includes(previous)) {
        pendingUploadsRef.current = pendingUploadsRef.current.filter((item) => item !== previous);
        void removeGarmentImage(previous).catch(() => {});
      }
      pendingUploadsRef.current.push(url);
      if (kind === 'flat') setFlatImage(url);
      else if (kind === 'model') setModelImage(url);
      else setBackImage(url);
    } catch (err) { setError(err instanceof Error ? err.message : '图片上传失败'); }
    finally { setBusy(false); }
  };

  const saveGarment = async () => {
    if (!name.trim() || !flatImage) { setError('请填写衣服名称并上传平铺图'); return; }
    setBusy(true); setError(null); setMessage(null);
    const payload = {
      name: name.trim(), category: category.trim() || '其他', color: color.trim() || null,
      gender, flat_image_url: flatImage, model_image_url: modelImage, back_image_url: backImage,
    };
    const { error: saveError } = editingId
      ? await supabase.from('garments').update(payload).eq('id', editingId)
      : await supabase.from('garments').insert(payload);
    setBusy(false);
    if (saveError) { setError(saveError.message); return; }
    // 保存成功后这些图片已被数据库引用，不再算待清理
    pendingUploadsRef.current = [];
    // 编辑时替换掉的旧图：数据库已不再引用，顺手清掉，避免 Storage 留孤儿
    if (editingId) {
      const stale = [
        originalImagesRef.current.flat && originalImagesRef.current.flat !== payload.flat_image_url ? originalImagesRef.current.flat : null,
        originalImagesRef.current.model && originalImagesRef.current.model !== payload.model_image_url ? originalImagesRef.current.model : null,
        originalImagesRef.current.back && originalImagesRef.current.back !== payload.back_image_url ? originalImagesRef.current.back : null,
      ].filter((url): url is string => Boolean(url));
      for (const url of stale) {
        try {
          if (!(await isImageStillReferenced(url, editingId))) await removeGarmentImage(url);
        } catch {
          setError('衣服信息已保存，但旧图片清理失败，Storage 里可能残留一张图');
        }
      }
    }
    originalImagesRef.current = { flat: null, model: null, back: null };
    setName(''); setColor(''); setFlatImage(null); setModelImage(null); setBackImage(null); setEditingId(null);
    setMessage(editingId ? '衣服信息已更新' : '衣服已添加');
    await loadItems();
  };

  const editGarment = (item: Garment) => {
    discardPendingUploads();
    originalImagesRef.current = { flat: item.flat_image_url, model: item.model_image_url, back: item.back_image_url ?? null };
    setEditingId(item.id); setName(item.name); setCategory(item.category); setColor(item.color || '');
    setGender(item.gender); setFlatImage(item.flat_image_url); setModelImage(item.model_image_url); setBackImage(item.back_image_url ?? null);
    setMessage(null); setError(null);
  };

  const resetForm = () => {
    discardPendingUploads();
    originalImagesRef.current = { flat: null, model: null, back: null };
    setEditingId(null); setName(''); setCategory('上装'); setColor(''); setGender('female');
    setFlatImage(null); setModelImage(null); setBackImage(null); setMessage(null); setError(null);
  };

  const deleteGarment = async (item: Garment) => {
    const prompt = `删除“${item.name}”？相关试穿记录也可能随数据库关联删除。`;
    // web 用 window.confirm，原生端必须走 Alert，不能默认 true 直接删
    if (Platform.OS === 'web') {
      if (!window.confirm(prompt)) return;
    } else {
      const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert('删除衣服素材？', prompt, [
          { text: '取消', style: 'cancel', onPress: () => resolve(false) },
          { text: '删除', style: 'destructive', onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) });
      });
      if (!confirmed) return;
    }
    setBusy(true); setError(null);
    const { error: deleteError } = await supabase.from('garments').delete().eq('id', item.id);
    if (deleteError) { setError(deleteError.message); setBusy(false); return; }
    try {
      await Promise.all([
        removeGarmentImage(item.flat_image_url),
        removeGarmentImage(item.model_image_url),
        removeGarmentImage(item.back_image_url ?? null),
      ]);
    } catch (err) {
      setError(`素材记录已删，但图片清理失败：${err instanceof Error ? err.message : '请检查 Storage'}`);
    }
    // 删除的正是当前编辑项时，清空表单避免继续基于已删除记录保存
    if (editingId === item.id) resetForm();
    setBusy(false);
    await loadItems();
  };

  const signOut = async () => { await supabase.auth.signOut(); updateUser(null); };

  if (checkingSession) return <SafeAreaView style={styles.safe}><View style={styles.center}><ActivityIndicator color={colors.accent} /></View></SafeAreaView>;

  if (!userEmail || !isAdmin) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView contentContainerStyle={styles.authContent}>
          <Text style={styles.eyebrow}>AI 穿搭管家</Text>
          <Text style={styles.title}>素材管理</Text>
          <Text style={styles.subtitle}>使用 Supabase 管理员账号登录后，可添加和维护衣服素材。</Text>
          <View style={styles.formCard}>
            <Text style={styles.label}>管理员邮箱</Text>
            <TextInput autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} placeholder="admin@example.com" placeholderTextColor={colors.muted} style={styles.input} />
            <Text style={styles.label}>密码</Text>
            <TextInput secureTextEntry value={password} onChangeText={setPassword} placeholder="Supabase Auth 密码" placeholderTextColor={colors.muted} style={styles.input} />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable disabled={busy || !email || !password} onPress={() => void signIn()} style={[styles.primary, (busy || !email || !password) && styles.disabled]}>
              {busy ? <ActivityIndicator color={button.color} /> : <Text style={styles.primaryText}>登录管理页</Text>}
            </Pressable>
          </View>
          <Text style={styles.note}>首次使用前，在 Supabase Auth 创建管理员账号，并通过安全的 Admin API 将 app_metadata.role 设为 admin。不要把 service role key 放进 App。</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View><Text style={styles.eyebrow}>ADMIN</Text><Text style={styles.title}>衣服素材管理</Text><Text style={styles.subtitle}>{userEmail}</Text></View>
          <Pressable onPress={() => void signOut()} style={styles.signOut}><Text style={styles.signOutText}>退出</Text></Pressable>
        </View>

        <View style={styles.formCard}>
          <Text style={styles.formTitle}>{editingId ? '编辑衣服' : '添加衣服'}</Text>
          <Text style={styles.label}>名称 *</Text>
          <TextInput value={name} onChangeText={setName} placeholder="例如：奶油色针织开衫" placeholderTextColor={colors.muted} style={styles.input} />
          <View style={styles.twoCol}>
            <View style={styles.col}><Text style={styles.label}>分类</Text><TextInput value={category} onChangeText={setCategory} placeholder="上装" placeholderTextColor={colors.muted} style={styles.input} /></View>
            <View style={styles.col}><Text style={styles.label}>颜色</Text><TextInput value={color} onChangeText={setColor} placeholder="米白" placeholderTextColor={colors.muted} style={styles.input} /></View>
          </View>
          <Text style={styles.label}>适用性别</Text>
          <View style={styles.genderRow}>{[['female', '女装'], ['male', '男装'], ['unisex', '中性']].map(([value, label]) => <Pressable key={value} onPress={() => setGender(value)} style={[styles.genderChoice, gender === value && styles.genderSelected]}><Text style={[styles.genderText, gender === value && styles.genderTextSelected]}>{label}</Text></Pressable>)}</View>
          <View style={styles.twoCol}>
            <Pressable disabled={busy} onPress={() => void chooseImage('flat')} style={styles.imagePick}>
              {flatImage ? <Image source={{ uri: flatImage }} style={styles.imagePreview} /> : <AppIcon name="image-outline" size={24} color={colors.accent} />}
              <Text style={styles.imagePickText}>{flatImage ? '更换平铺图' : '上传平铺图 *'}</Text>
            </Pressable>
            <Pressable disabled={busy} onPress={() => void chooseImage('model')} style={styles.imagePick}>
              {modelImage ? <Image source={{ uri: modelImage }} style={styles.imagePreview} /> : <AppIcon name="person-outline" size={24} color={colors.accent} />}
              <Text style={styles.imagePickText}>{modelImage ? '更换模特图' : '上传模特图（可选）'}</Text>
            </Pressable>
          </View>
          <Pressable disabled={busy} onPress={() => void chooseImage('back')} style={[styles.imagePick, styles.backPick]}>
            {backImage ? <Image source={{ uri: backImage }} style={styles.imagePreview} /> : <AppIcon name="swap" size={24} color={colors.accent} />}
            <Text style={styles.imagePickText}>{backImage ? '更换背面平铺图' : '上传背面平铺图（可选）'}</Text>
          </Pressable>
          <Text style={styles.hint}>背面图不是必填，但传了之后试衣结果里会出现「看背面」，能拿到真实背面而不是模型猜的褶裥。</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {message ? <Text style={styles.success}>{message}</Text> : null}
          <Pressable disabled={busy} onPress={() => void saveGarment()} style={[styles.primary, busy && styles.disabled]}>
            {busy ? <ActivityIndicator color={button.color} /> : <Text style={styles.primaryText}>{editingId ? '更新衣服素材' : '保存衣服素材'}</Text>}
          </Pressable>
          {editingId ? <Pressable disabled={busy} onPress={resetForm} style={styles.cancelEdit}><Text style={styles.cancelEditText}>取消编辑</Text></Pressable> : null}
        </View>

        <View style={styles.listHeading}><Text style={styles.formTitle}>已有素材</Text><Text style={styles.count}>{items.length} 件</Text></View>
        {items.map((item) => (
          <View key={item.id} style={styles.itemRow}>
            <Image source={{ uri: item.model_image_url || item.flat_image_url }} style={styles.itemImage} />
            <View style={styles.itemInfo}><Text style={styles.itemName}>{item.name}</Text><Text style={styles.muted}>{item.category}{item.color ? ` · ${item.color}` : ''}</Text></View>
            <Pressable disabled={busy} onPress={() => editGarment(item)} style={styles.iconButton}><AppIcon name="create-outline" size={18} color={colors.accent} /></Pressable>
            <Pressable disabled={busy} onPress={() => void deleteGarment(item)} style={styles.deleteButton}><AppIcon name="trash-outline" size={18} color={colors.danger} /></Pressable>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, type, button, chip, card } = theme;
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    authContent: {
      width: '100%',
      maxWidth: 560,
      alignSelf: 'center',
      padding: spacing.lg,
      gap: spacing.sm,
    },
    content: {
      width: '100%',
      maxWidth: 900,
      alignSelf: 'center',
      padding: spacing.lg,
      paddingBottom: spacing.xl,
      gap: spacing.md,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: card.radius,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    eyebrow: { ...type.label, color: colors.accent },
    title: { ...type.title, color: colors.text, marginTop: spacing.xs },
    subtitle: { ...type.caption, color: colors.muted, marginTop: spacing.xs },
    formCard: {
      padding: spacing.md,
      borderRadius: card.radius,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      gap: spacing.sm,
    },
    formTitle: { ...type.section, color: colors.text, marginBottom: 2 },
    label: { color: colors.text, fontSize: 12, fontWeight: '600' },
    input: {
      minHeight: 44,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      backgroundColor: colors.surfaceAlt,
      color: colors.text,
    },
    twoCol: { flexDirection: 'row', gap: spacing.sm },
    col: { flex: 1, gap: spacing.xs },
    genderRow: { flexDirection: 'row', gap: spacing.xs },
    genderChoice: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderWidth: 1,
      borderColor: chip.borderColor,
      borderRadius: chip.radius,
      backgroundColor: chip.background,
    },
    genderSelected: { backgroundColor: chip.activeBackground, borderColor: chip.activeBorderColor },
    genderText: { ...type.caption, color: chip.color },
    genderTextSelected: { color: chip.activeColor, fontWeight: '700' },
    imagePick: {
      flex: 1,
      minHeight: 104,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: colors.border,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      backgroundColor: colors.surface,
      overflow: 'hidden',
    },
    // 背面图是整行宽度（它和正面图同等重要，不该被挤成半个格子）
    backPick: { flex: 0, width: '100%' },
    imagePreview: { width: '100%', height: 74 },
    hint: { ...type.caption, color: colors.muted, lineHeight: 17 },
    imagePickText: { ...type.caption, color: colors.accent, fontWeight: '600', padding: 4, textAlign: 'center' },
    primary: {
      minHeight: button.minHeight,
      borderRadius: button.radius,
      borderWidth: button.borderWidth,
      borderColor: button.borderColor,
      backgroundColor: button.background,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.xs,
    },
    primaryText: { color: button.color, fontWeight: '700', fontSize: 14, letterSpacing: button.letterSpacing },
    cancelEdit: { alignSelf: 'center', padding: spacing.xs },
    cancelEditText: { ...type.caption, color: colors.muted },
    disabled: { opacity: 0.5 },
    error: { ...type.caption, color: colors.danger },
    success: { ...type.caption, color: colors.success },
    note: { ...type.caption, color: colors.muted },
    signOut: { padding: spacing.sm },
    signOutText: { color: colors.accent, fontWeight: '600' },
    listHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    count: { ...type.caption, color: colors.muted },
    itemRow: {
      minHeight: 76,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.sm,
      borderRadius: card.radius,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    itemImage: { width: 52, height: 60, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt },
    itemInfo: { flex: 1, gap: 4 },
    itemName: { ...type.body, fontSize: 13, color: colors.text, fontWeight: '600' },
    muted: { ...type.caption, color: colors.muted },
    deleteButton: { padding: spacing.sm },
    iconButton: { padding: spacing.sm },
  });
};
