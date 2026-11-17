import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { ensureSession } from './auth';
import { supabase, uploadWithRetry } from './supabase';

const BUCKET = 'inspiration-posts';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/quicktime', 'video/webm',
]);

export type PickedInspiration = {
  uri: string;
  name: string;
  mimeType: string;
  mediaType: 'image' | 'video';
  bytes: ArrayBuffer;
};

export async function pickInspirationMedia(): Promise<PickedInspiration | null> {
  if (Platform.OS !== 'web') {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error('需要相册权限才能选择图片或视频');
  }
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.9 });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (asset.fileSize && asset.fileSize > MAX_FILE_BYTES) throw new Error('文件不能超过 50 MB');
  const ext = asset.fileName?.split('.').pop()?.toLowerCase() || '';
  const mimeType = asset.mimeType || (ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : ext === 'mp4' ? 'video/mp4' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
  if (!ALLOWED_TYPES.has(mimeType)) throw new Error('请使用 JPG、PNG、WebP、MP4、MOV 或 WebM 格式');
  const mediaType = asset.type === 'video' || mimeType.startsWith('video/') ? 'video' : 'image';
  const name = asset.fileName || `inspiration-${Date.now()}.${ext || (mediaType === 'video' ? 'mp4' : 'jpg')}`;
  const bytes = Platform.OS === 'web' && asset.file
    ? await asset.file.arrayBuffer()
    : await new File(asset.uri).arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('文件不能超过 50 MB');
  return { uri: asset.uri, name, mimeType, mediaType, bytes };
}

async function ensurePublisher() {
  // 与全局账号体系共用同一个 session：匿名账户也能发布，邮箱升级后 UUID 不变，
  // 已发布作品的 owner_id 依然对得上。
  const session = await ensureSession();
  if (!session?.user) throw new Error('发布作品前请先在「我的」页用邮箱验证码登录');
  return session.user.id;
}

export async function publishInspiration(
  media: PickedInspiration,
  caption: string,
  garmentId?: string | null,
) {
  const ownerId = await ensurePublisher();
  const ext = media.name.split('.').pop()?.toLowerCase() || (media.mediaType === 'video' ? 'mp4' : 'jpg');
  const path = `${ownerId}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
  await uploadWithRetry(BUCKET, path, media.bytes, media.mimeType);
  const mediaUrl = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const baseRow = {
    owner_id: ownerId,
    caption: caption.trim(),
    media_type: media.mediaType,
    media_url: mediaUrl,
  };
  // 015 迁移未应用时 insert garment_id 会报 42703，这里退化成不带关联的插入，
  // 保证「发布」不会因为后端还没升级而整体失败。
  // supabase-js 的 Insert 类型里还没有 garment_id，只能放行这一次断言。
  const row = (garmentId ? { ...baseRow, garment_id: garmentId } : baseRow) as never;
  let { error: insertError } = await supabase.from('inspiration_posts').insert(row);
  if (insertError && garmentId && /garment_id/i.test(insertError.message)) {
    ({ error: insertError } = await supabase.from('inspiration_posts').insert(baseRow));
  }
  if (insertError) {
    await supabase.storage.from(BUCKET).remove([path]);
    throw new Error(insertError.message);
  }
}

export async function fetchMyInspiration() {
  const { data: sessionData } = await supabase.auth.getSession();
  const ownerId = sessionData.session?.user.id;
  if (!ownerId) return [];
  const { data, error } = await supabase.from('inspiration_posts')
    .select('id,caption,media_type,media_url,created_at')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** 删除我的作品：先删记录，再清媒体。媒体清理失败不算删除失败，通过 warning 回传。 */
export async function deleteMyInspiration(id: string, mediaUrl: string): Promise<{ warning?: string }> {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const markerIndex = mediaUrl.indexOf(marker);
  if (markerIndex < 0) throw new Error('无法识别媒体文件地址');
  const path = decodeURIComponent(mediaUrl.slice(markerIndex + marker.length).split('?')[0]);
  const { error: rowError } = await supabase.from('inspiration_posts').delete().eq('id', id);
  if (rowError) throw new Error(rowError.message);
  const { error: storageError } = await supabase.storage.from(BUCKET).remove([path]);
  if (storageError) return { warning: `作品已从首页移除，但媒体文件清理失败：${storageError.message}` };
  return {};
}

/**
 * 把已经生成好的结果图（私有桶里的一张签名图）发布到公开的灵感流。
 *
 * 为什么要走这条路而不是直接存 URL：试穿结果是私有桶里的临时签名地址，
 * 1 小时后失效；发布必须把字节**复制**一份到公开桶，否则首页过一会就裂图。
 */
export async function publishInspirationFromUrl(params: {
  sourceUrl: string;
  caption: string;
  garmentId?: string | null;
}): Promise<void> {
  const { sourceUrl, caption, garmentId } = params;
  const bytes = await downloadBytes(sourceUrl);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('图片过大，无法发布');
  await publishInspiration(
    {
      uri: sourceUrl,
      name: `tryon-${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
      mediaType: 'image',
      bytes,
    },
    caption,
    garmentId,
  );
}

/** 原生端没有可靠的大文件 fetch，走 expo-file-system 下载到缓存再读字节 */
async function downloadBytes(url: string): Promise<ArrayBuffer> {
  if (Platform.OS === 'web') {
    const response = await fetch(url);
    if (!response.ok) throw new Error('读取生成结果失败，请稍后重试');
    return response.arrayBuffer();
  }
  const target = new File(Paths.cache, `inspiration-${Date.now()}.jpg`);
  const downloaded = await File.downloadFileAsync(url, target);
  return downloaded.arrayBuffer();
}
