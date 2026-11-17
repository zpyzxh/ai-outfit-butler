import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { supabase, uploadWithRetry } from './supabase';
import { ensureSession } from './auth';

// 私有桶：只有本人和服务端能读，客户端显示前用 createSignedUrl 换临时直链。
// 老桶 user-photos 仍是 public（里面还有历史商品图，供应商要直接下载），见 016 迁移注释。
const BUCKET = 'user-media';
const MAX_IMAGE_EDGE = 2049;
const MIN_IMAGE_EDGE = 256;

function getExtension(uri: string) {
  const clean = uri.split('?')[0];
  const ext = clean.split('.').pop()?.toLowerCase();
  return ext && ext.length <= 5 ? ext : 'jpg';
}

/** 选择一张全身照上传到私有桶 user-media，返回规范地址（显示前需换签名直链） */
export async function pickAndUploadUserPhoto(): Promise<string | null> {
  if (Platform.OS !== 'web') {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      throw new Error('需要相册权限才能选择全身照');
    }
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.8,
  });

  if (result.canceled) {
    return null;
  }

  const asset = result.assets[0];
  let extension = getExtension(asset.uri);
  let contentType = asset.mimeType ?? (extension === 'png' ? 'image/png' : `image/${extension === 'jpg' ? 'jpeg' : extension}`);
  // 部分 Android 相册返回 image/jpg、image/x-png，桶的 MIME 白名单只接受标准类型
  if (contentType === 'image/jpg') contentType = 'image/jpeg';
  if (contentType === 'image/x-png') contentType = 'image/png';
  let bytes: ArrayBuffer;

  if (Platform.OS === 'web' && asset.file) {
    const bitmap = await createImageBitmap(asset.file);
    if (Math.min(bitmap.width, bitmap.height) < MIN_IMAGE_EDGE) {
      bitmap.close();
      throw new Error(`这张照片太小，最短边至少需要 ${MIN_IMAGE_EDGE} 像素，请换一张更清晰的全身照`);
    }
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法处理这张照片，请换一张再试');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('照片压缩失败，请重试')), 'image/jpeg', 0.88);
    });
    extension = 'jpg';
    contentType = 'image/jpeg';
    bytes = await blob.arrayBuffer();
  } else {
    const longest = Math.max(asset.width, asset.height);
    const shortest = Math.min(asset.width, asset.height);
    if (longest > MAX_IMAGE_EDGE) {
      throw new Error(`这张照片尺寸过大，请先裁剪到最长边不超过 ${MAX_IMAGE_EDGE} 像素`);
    }
    if (shortest < MIN_IMAGE_EDGE) {
      throw new Error(`这张照片太小，最短边至少需要 ${MIN_IMAGE_EDGE} 像素，请换一张更清晰的全身照`);
    }
    bytes = await new File(asset.uri).arrayBuffer();
  }

  // 存储策略按 `<uid>/...` 首段校验归属，上传前必须有会话（匿名登录或邮箱登录均可）
  const session = await ensureSession();
  if (!session) {
    throw new Error('上传全身照前请先登录：请在「我的」页完成邮箱验证码登录');
  }

  const path = `${session.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

  await uploadWithRetry(BUCKET, path, bytes, contentType);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
