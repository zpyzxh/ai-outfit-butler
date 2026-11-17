import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 风格档案：存在本机（AsyncStorage），不上传服务器。
 * 用途：给搭配推荐加权、给试衣页预设性别筛选、给我的页展示「你的风格」。
 */

export type StyleGender = '女' | '男' | '不限';

export type StyleProfile = {
  gender: StyleGender;
  vibes: string[];
  occasions: string[];
  updatedAt: string;
};

export const VIBE_OPTIONS = ['极简', '复古', '通勤', '甜酷', '松弛', '先锋'] as const;
export const OCCASION_OPTIONS = ['通勤', '约会', '出行', '聚会', '居家'] as const;
export const GENDER_OPTIONS: StyleGender[] = ['女', '男', '不限'];

const STORAGE_KEY = 'style.profile.v1';

export const DEFAULT_PROFILE: StyleProfile = {
  gender: '不限',
  vibes: ['极简', '通勤'],
  occasions: ['通勤'],
  updatedAt: '',
};

function sanitize(raw: unknown): StyleProfile {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PROFILE };
  const value = raw as Partial<StyleProfile>;
  const gender = GENDER_OPTIONS.includes(value.gender as StyleGender)
    ? (value.gender as StyleGender)
    : DEFAULT_PROFILE.gender;
  const vibes = Array.isArray(value.vibes)
    ? value.vibes.filter((vibe): vibe is string => typeof vibe === 'string').slice(0, 3)
    : [...DEFAULT_PROFILE.vibes];
  const occasions = Array.isArray(value.occasions)
    ? value.occasions.filter((item): item is string => typeof item === 'string').slice(0, 3)
    : [...DEFAULT_PROFILE.occasions];
  return {
    gender,
    vibes: vibes.length ? vibes : [...DEFAULT_PROFILE.vibes],
    occasions: occasions.length ? occasions : [...DEFAULT_PROFILE.occasions],
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  };
}

export async function loadStyleProfile(): Promise<StyleProfile> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    return sanitize(JSON.parse(raw));
  } catch {
    // 存储损坏不应该阻塞页面，静默回到默认档案
    return { ...DEFAULT_PROFILE };
  }
}

export async function saveStyleProfile(profile: StyleProfile): Promise<StyleProfile> {
  const next: StyleProfile = { ...profile, updatedAt: new Date().toISOString() };
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 写失败时仍返回新值，界面继续可用（下次进来会退回旧档案）
  }
  return next;
}

/** 「通勤 · 极简」这样的短摘要，给卡片和标题用 */
export function profileSummary(profile: StyleProfile) {
  const parts = [profile.occasions[0], profile.vibes[0]].filter(Boolean);
  return parts.length ? parts.join(' · ') : '还没设置风格';
}

export function profileIsSet(profile: StyleProfile) {
  return Boolean(profile.updatedAt);
}
