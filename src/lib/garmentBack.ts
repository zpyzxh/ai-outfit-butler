import { Platform } from 'react-native';

import { getFunctionErrorMessage, getDeviceId, supabase } from '@/lib/supabase';

/**
 * 「把视频最后一帧存成背面素材」的客户端部分。
 *
 * 背景：视频是我们唯一能拿到**真实背面**的画面（试衣单图只会贴正面，见迭代报告第二十四节）。
 * 所以视频生成完之后，允许用户把最后一帧存成这件单品的背面图，下次就能点「看背面实物图」。
 *
 * 平台限制：抽帧用 `<video>` + `<canvas>`，只有 Web 端能做（原生端 expo-video 不提供取帧 API）。
 * 原生端这里直接返回 null，由调用方隐藏入口。
 */

export const CAN_CAPTURE_FRAME = Platform.OS === 'web';

/** 从视频地址抓最后一帧，返回 data:image/jpeg;base64,...（Web only） */
export async function captureLastFrame(videoUrl: string): Promise<string | null> {
  if (!CAN_CAPTURE_FRAME) return null;
  if (typeof document === 'undefined') return null;

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('读取视频超时')), 20_000);
      video.onloadeddata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('视频读取失败'));
      };
    });

    // 停在最后一帧之前一点，避免正好落在结束黑帧上
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = Math.max(0, duration - 0.12);
    if (target > 0.2) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => resolve(), 4_000);
        video.onseeked = () => {
          window.clearTimeout(timer);
          resolve();
        };
        video.currentTime = target;
      });
    }

    const width = video.videoWidth || 720;
    const height = video.videoHeight || 1280;
    // 长边压到 1280，足够看清背面版型，又不至于让请求体过大
    const scale = Math.min(1, 1280 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

export type SaveBackFrameResult =
  | { ok: true; backImageUrl: string }
  | { ok: false; message: string };

/** 把抓到的帧交给服务端存成背面图（服务端用 service_role 写 garments 表与桶） */
export async function saveBackFrame(garmentId: string, dataUrl: string): Promise<SaveBackFrameResult> {
  const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
  if (!base64) return { ok: false, message: '没有拿到画面，请重试' };

  const deviceId = await getDeviceId().catch(() => null);
  const { data, error } = await supabase.functions.invoke('garment-back', {
    body: { garment_id: garmentId, image_base64: base64, mime: 'image/jpeg' },
    headers: deviceId ? { 'x-device-id': deviceId } : undefined,
    timeout: 30_000,
  });

  if (error) {
    const message = await getFunctionErrorMessage(error);
    return { ok: false, message: message || '保存背面图失败，请稍后重试' };
  }

  const backImageUrl = (data as { back_image_url?: string } | null)?.back_image_url;
  if (!backImageUrl) return { ok: false, message: '保存背面图失败，请稍后重试' };
  return { ok: true, backImageUrl };
}
