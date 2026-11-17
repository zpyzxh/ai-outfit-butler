// 匿名身份的恢复码
//
// 身份只存在本地存储里：清缓存 / 换浏览器 / 重装 App 都会换成一个新身份，
// 历史记录随之变成孤儿。恢复码是「把旧身份的数据搬到当前身份」的唯一入口。
//
// 分工：
//   客户端：生成、展示、归一化、保存在本地（明文只存在用户设备上）
//   服务端：只存 sha256 哈希，靠 RPC 校验并搬数据（见 020_recovery_codes.sql）

import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabase } from '@/lib/supabase';

const STORAGE_KEY = 'recovery.code.v1';

// 去掉容易混淆的 I / L / O / U，与 020 的 normalize 规则保持一致
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const GROUP_SIZE = 4;

export function normalizeRecoveryCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 把 12 位裸码排版成 XXXX-XXXX-XXXX，便于抄写 */
export function formatRecoveryCode(value: string): string {
  const normalized = normalizeRecoveryCode(value).slice(0, CODE_LENGTH);
  const groups: string[] = [];
  for (let index = 0; index < normalized.length; index += GROUP_SIZE) {
    groups.push(normalized.slice(index, index + GROUP_SIZE));
  }
  return groups.join('-');
}

function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    // 理论上走不到（RN 0.88 与浏览器都有 crypto），兜底避免整页崩掉
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let code = '';
  for (const byte of bytes) {
    code += ALPHABET[byte % ALPHABET.length];
  }
  return code;
}

export type RedeemResult = {
  ok: boolean;
  error?: string;
  alreadyCurrent?: boolean;
  movedTasks?: number;
  movedPosts?: number;
  movedEntitlements?: number;
};

/**
 * 确保当前身份在服务端有一条恢复码记录，返回展示用的格式化码。
 * 本地已有码就复用（用户可能已经截图保存过），没有才生成新的。
 */
export async function ensureRecoveryCode(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user?.id) return null;

  let raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw || normalizeRecoveryCode(raw).length !== CODE_LENGTH) {
    raw = randomCode();
    await AsyncStorage.setItem(STORAGE_KEY, raw);
  }

  // 每次都登记一遍：换设备后本地码可能已在别的身份下，重新绑定到当前身份
  const { error } = await supabase.rpc('register_recovery_code', { p_code: raw });
  if (error) {
    // 函数未部署（020 没跑）时不要让页面报错，界面会隐藏恢复码区块
    return null;
  }
  return formatRecoveryCode(raw);
}

/** 用恢复码把旧身份的数据接到当前身份下 */
export async function redeemRecoveryCode(input: string): Promise<RedeemResult> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length !== CODE_LENGTH) {
    return { ok: false, error: '恢复码是 12 位，请检查是否漏输' };
  }

  const { data, error } = await supabase.rpc('redeem_recovery_code', { p_code: normalized });
  if (error) {
    return { ok: false, error: error.message };
  }
  const payload = (data ?? {}) as {
    ok?: boolean;
    error?: string;
    already_current?: boolean;
    moved_tasks?: number;
    moved_posts?: number;
    moved_entitlements?: number;
  };
  return {
    ok: payload.ok === true,
    error: payload.error,
    alreadyCurrent: payload.already_current === true,
    movedTasks: payload.moved_tasks ?? 0,
    movedPosts: payload.moved_posts ?? 0,
    movedEntitlements: payload.moved_entitlements ?? 0,
  };
}

/** 本地是否已经有码（用于界面上的「已保存/未保存」提示，不做强约束） */
export async function hasLocalRecoveryCode(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  return Boolean(raw) && normalizeRecoveryCode(raw ?? '').length === CODE_LENGTH;
}
