import { Platform } from 'react-native';

/**
 * 把试穿结果存到用户本地。
 *
 * 为什么是「先取字节、再造一个本地链接」：
 * 1. 结果图/视频在**私有桶**里，页面拿到的是 1 小时有效的签名地址 —— 不能直接当永久链接存。
 * 2. 跨域下 `<a download="x.jpg" href="远端">` 的 download 属性会被忽略（浏览器改成新标签打开）。
 * 3. 试过让存储端回 `Content-Disposition: attachment`（`?download=` 与 createSignedUrl 的
 *    download 选项），本项目所用的 storage 版本会忽略该参数 —— 返回里既没有 download 参数，
 *    GET 的响应头也没有 content-disposition，所以这条路走不通。
 *
 * 于是走 blob：fetch 成 Blob → objectURL → `<a download>` 点一下 → 10 秒后释放。
 * 已知边界：Safari/iOS 对「非手势触发的下载」会改为打开图片，此时提示用户长按保存。
 */
export type SaveResult = { ok: boolean; message: string };

const EXT_BY_KIND = { image: 'jpg', video: 'mp4' } as const;

export function suggestFilename(kind: 'image' | 'video', seed?: string | null): string {
  const stamp = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
  const short = seed ? seed.slice(0, 8) : 'tryon';
  return `ai-chuanda-${short}-${date}.${EXT_BY_KIND[kind]}`;
}

export async function saveRemoteFile(
  url: string,
  filename: string,
  kind: 'image' | 'video',
): Promise<SaveResult> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') {
    return { ok: false, message: '原生端暂不支持直接保存，可以截图或录屏保留。' };
  }

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.position = 'fixed';
    anchor.style.opacity = '0';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // 给浏览器一点时间接管下载再释放内存
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    return { ok: true, message: kind === 'video' ? '视频已开始下载' : '图片已开始下载' };
  } catch (error) {
    return {
      ok: false,
      message: `没存下来：${error instanceof Error ? error.message : '网络异常'}，可以再试一次，或长按图片保存`,
    };
  }
}
