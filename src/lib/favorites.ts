import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 收藏：本地存储，不做账号绑定。
 * - garments：单品收藏（也用于试衣页「我的爱用」）
 * - looks：整套搭配收藏（id 由搭配引擎按单品组合算出，稳定可复现）
 */

export type Favorites = {
  garments: string[];
  looks: string[];
};

const STORAGE_KEY = 'style.favorites.v1';

const EMPTY: Favorites = { garments: [], looks: [] };

function sanitize(raw: unknown): Favorites {
  if (!raw || typeof raw !== 'object') return { ...EMPTY };
  const value = raw as Partial<Favorites>;
  const clean = (list: unknown) =>
    Array.isArray(list) ? Array.from(new Set(list.filter((item): item is string => typeof item === 'string'))) : [];
  return { garments: clean(value.garments), looks: clean(value.looks) };
}

export async function loadFavorites(): Promise<Favorites> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...EMPTY };
  }
}

async function persist(next: Favorites) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 忽略写入失败：收藏是锦上添花，不能阻塞主流程
  }
}

export async function toggleGarmentFavorite(id: string): Promise<Favorites> {
  const current = await loadFavorites();
  const has = current.garments.includes(id);
  const next: Favorites = {
    ...current,
    garments: has ? current.garments.filter((item) => item !== id) : [id, ...current.garments],
  };
  await persist(next);
  return next;
}

export async function toggleLookFavorite(id: string): Promise<Favorites> {
  const current = await loadFavorites();
  const has = current.looks.includes(id);
  const next: Favorites = {
    ...current,
    looks: has ? current.looks.filter((item) => item !== id) : [id, ...current.looks],
  };
  await persist(next);
  return next;
}
