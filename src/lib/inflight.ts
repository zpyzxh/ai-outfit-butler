import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 「进行中的生成任务」。
 *
 * 为什么需要它：试衣是同步接口（40–70 秒），视频更久（排队常见，实测 25 分钟）。
 * 用户在这期间很容易切到别的 Tab、切走浏览器，甚至杀掉进程再回来。
 * 之前的结果是：回来后界面一片空白，用户不知道任务还在跑，往往再点一次——
 * 既重复扣费，又可能覆盖已经生成好的视频。
 *
 * 现在每次创建任务就记一条（单槽位，只记最近一次），回到试衣页时自动接管轮询，
 * 任务走到终态就清掉。40 分钟以上的记录视为失效（服务端有超时兜底，不必再追）。
 */

export type InflightKind = 'tryon' | 'video';

export type InflightTask = {
  taskId: string;
  kind: InflightKind;
  label: string;
  startedAt: number;
};

const STORAGE_KEY = 'inflight.task.v1';
const STALE_MS = 40 * 60_000;

export async function saveInflight(task: InflightTask): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(task));
  } catch {
    // 记不住不影响主流程：只是少了「回来继续看」的能力
  }
}

export async function clearInflight(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}

export async function loadInflight(): Promise<InflightTask | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InflightTask>;
    if (!parsed?.taskId || (parsed.kind !== 'tryon' && parsed.kind !== 'video')) return null;
    if (typeof parsed.startedAt !== 'number') return null;
    if (Date.now() - parsed.startedAt > STALE_MS) {
      await clearInflight();
      return null;
    }
    return {
      taskId: parsed.taskId,
      kind: parsed.kind,
      label: typeof parsed.label === 'string' ? parsed.label : '上次的生成任务',
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}
