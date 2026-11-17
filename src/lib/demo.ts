import { Platform } from 'react-native';

/**
 * 演示模式：不调用任何 AI 供应商，直接用预先跑出来的真实结果顶上。
 *
 * 为什么需要它：
 * - 单件试衣要 40–70 秒、¥0.4/张；视频排队 1–25 分钟、¥0.3–0.5/条。
 *   面试现场点两下就是「等一分钟 + 花钱」，很可能还没出图就被打断。
 * - 供应商、Supabase、国内到海外的线路都不稳，现场断一次就很难看。
 *
 * 怎么开：
 * - 构建时：`EXPO_PUBLIC_DEMO=1`
 * - 运行时（Web 最方便）：在地址后面加 `?demo=1`
 *   例如 https://xxx.github.io/ai-outfit-butler/tryon?demo=1
 *
 * 诚实原则：演示模式下界面会显式标注「演示模式 · 预生成样例」，
 * 不假装是刚刚算出来的；这些图/视频确实都是本项目真实跑出来的产物。
 */

function readRuntimeFlag(): boolean {
  if (Platform.OS !== 'web') return false;
  if (typeof window === 'undefined') return false;
  try {
    const search = window.location?.search ?? '';
    if (!search) return false;
    return new URLSearchParams(search).get('demo') === '1';
  } catch {
    return false;
  }
}

export const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO === '1' || readRuntimeFlag();

/** 演示用的示例全身照（真实人物、正面站姿，公开可读）。 */
export const DEMO_SAMPLE_PHOTO =
  'https://ydcajujmhlksjgrhjgtl.supabase.co/storage/v1/object/public/garments/demo/sample-fullbody.jpg';

/** 演示用的试穿结果（本项目真实生成过的两张）。 */
export const DEMO_TRYON_RESULTS = [
  'https://ydcajujmhlksjgrhjgtl.supabase.co/storage/v1/object/public/inspiration-posts/demo/result-1-1794896028227.jpg',
  'https://ydcajujmhlksjgrhjgtl.supabase.co/storage/v1/object/public/inspiration-posts/demo/result-2-1794896049229.jpg',
];

/** 演示用的动态结果（本项目真实生成过的 5 秒转身视频，744×1238）。 */
export const DEMO_VIDEO =
  'https://ydcajujmhlksjgrhjgtl.supabase.co/storage/v1/object/public/garments/demo/sample-motion.mp4';

/** 每件衣服对应一张样例图；多于两张就循环，保证「叠穿 3 件」也有图看。 */
export function demoResultFor(index: number): string {
  return DEMO_TRYON_RESULTS[index % DEMO_TRYON_RESULTS.length];
}

export const DEMO_BADGE = '演示模式 · 预生成样例';

/** 演示模式下的生成耗时（秒），用来模拟进度条，别让人以为卡死了。 */
export const DEMO_TRYON_STEP_MS = 1400;
export const DEMO_VIDEO_MS = 2600;
