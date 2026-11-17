import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { supabase } from './supabase';

// Aidge 试穿对服装图边长有上限（>2049 会被服务端拒绝），提前在管理端拦截，
// 避免素材上传成功、用户试衣时才失败。
const MAX_IMAGE_EDGE = 2049;
const MIN_IMAGE_EDGE = 256;

export async function pickAndUploadGarmentImage(label: string) {
  if (Platform.OS !== 'web') {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error('需要相册权限才能选择图片');
  }
  const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
  if (picked.canceled) return null;
  const asset = picked.assets[0];
  // 平铺图会直接作为试穿输入；模特图只用于展示，不做尺寸限制
  if (label === 'flat') {
    const longest = Math.max(asset.width, asset.height);
    const shortest = Math.min(asset.width, asset.height);
    if (longest > MAX_IMAGE_EDGE) {
      throw new Error(`平铺图最长边不能超过 ${MAX_IMAGE_EDGE} 像素，请先压缩或裁剪后再上传`);
    }
    if (shortest < MIN_IMAGE_EDGE) {
      throw new Error(`平铺图最短边至少需要 ${MIN_IMAGE_EDGE} 像素，请换一张更清晰的图片`);
    }
  }
  const extension = asset.fileName?.split('.').pop()?.toLowerCase() || (asset.mimeType === 'image/png' ? 'png' : 'jpg');
  const path = `${Date.now()}-${label}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
  const bytes = Platform.OS === 'web' && asset.file
    ? await asset.file.arrayBuffer()
    : await new File(asset.uri).arrayBuffer();
  const { error } = await supabase.storage.from('garments').upload(path, bytes, {
    contentType: asset.mimeType || (extension === 'png' ? 'image/png' : 'image/jpeg'),
    upsert: false,
  });
  if (error) throw new Error(error.message);
  return supabase.storage.from('garments').getPublicUrl(path).data.publicUrl;
}

export async function removeGarmentImage(url: string | null) {
  if (!url) return;
  const marker = '/storage/v1/object/public/garments/';
  const index = url.indexOf(marker);
  if (index < 0) return;
  const path = decodeURIComponent(url.slice(index + marker.length).split('?')[0]);
  const { error } = await supabase.storage.from('garments').remove([path]);
  if (error) throw new Error(error.message);
}
