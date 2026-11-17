import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';

import { supabase } from './supabase';

// 账号体系第一版：
//   1) 首次启动无 session 时建匿名账户（anonymous sign-in），先有稳定 UUID
//   2) 邮箱 6 位验证码 signInWithOtp + verifyOtp（不用 magic link 深链，项目没配 scheme）
//   3) 匿名账户在邮箱验证通过后升级为正式账户：updateUser({ email }) + verifyOtp(email_change)
//      GoTrue 的语义是「给同一个 user 补邮箱」，UUID 不变，已有数据自然保留
//   4) 手机号登录本版不实现，只留 PHONE_AUTH_ENABLED 开关与同构函数，见文件末尾

/** 手机号登录开关：接短信服务商（Twilio / 阿里云短信）并配好后台后再打开。 */
export const PHONE_AUTH_ENABLED = false;

export type AuthProfile = {
  userId: string;
  email: string | null;
  /** 匿名账户（已登录但没有邮箱身份） */
  isAnonymous: boolean;
  /** 升级流程中已发出验证码、等待确认的新邮箱 */
  pendingEmail: string | null;
};

export type EmailCodeMode = 'signin' | 'upgrade';

export class AuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

function toProfile(user: User | null | undefined): AuthProfile | null {
  if (!user) return null;
  return {
    userId: user.id,
    email: user.email ?? null,
    isAnonymous: Boolean(user.is_anonymous),
    pendingEmail: user.new_email ?? null,
  };
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

/** 只做格式前置校验，真实有效性由服务端判定 */
export function isEmailLike(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function describeAuthError(error: { message?: string; status?: number; code?: string }): AuthError {
  const message = error.message ?? '';
  const status = error.status ?? 0;
  if (status === 429 || /rate limit|too many/i.test(message)) {
    return new AuthError('RATE_LIMITED', '验证码发送太频繁，同一邮箱 60 秒内只能发一次，请稍后再试');
  }
  if (/anonymous/i.test(message)) {
    return new AuthError('ANONYMIC_DISABLED', 'Supabase 后台未开启匿名登录，请联系管理员开启后再试');
  }
  if (/invalid.*email|email.*invalid/i.test(message)) {
    return new AuthError('EMAIL_INVALID', '邮箱格式不正确，请检查后重试');
  }
  if (/signups? not allowed|signup.*disabled/i.test(message)) {
    return new AuthError('SIGNUP_DISABLED', 'Supabase 后台已关闭注册，无法新注册账号');
  }
  if (/token has expired|expired/i.test(message)) {
    return new AuthError('CODE_EXPIRED', '验证码已过期，请重新获取');
  }
  if (/invalid.*(token|otp)|token.*invalid/i.test(message)) {
    return new AuthError('CODE_INVALID', '验证码不正确，请检查后重试');
  }
  if (/already registered|already been registered/i.test(message)) {
    return new AuthError('EMAIL_TAKEN', '该邮箱已注册，请直接使用验证码登录');
  }
  return new AuthError(error.code ?? 'AUTH_FAILED', message || '账号服务暂时不可用，请稍后重试');
}

const sessionBootstraps = { current: null as Promise<Session | null> | null };

/**
 * 取当前 session；没有就建匿名账户。
 * 匿名登录在后台被关闭时返回 null（不抛错），由界面展示登录入口。
 */
export async function ensureSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw describeAuthError(error);
  if (data.session) return data.session;

  if (!sessionBootstraps.current) {
    sessionBootstraps.current = (async () => {
      const { data: anonData, error: anonError } = await supabase.auth.signInAnonymously();
      if (anonError) return null;
      return anonData.session ?? null;
    })();
  }

  const created = await sessionBootstraps.current;
  sessionBootstraps.current = null;
  return created;
}

/**
 * 发邮箱验证码。
 * - 没有 session：signInWithOtp（注册与登录同一条路，shouldCreateUser）
 * - 匿名账户：updateUser({ email })，走 email_change 验证码，验证后 UUID 不变
 */
export async function sendEmailCode(rawEmail: string): Promise<EmailCodeMode> {
  const email = normalizeEmail(rawEmail);
  if (!isEmailLike(email)) throw new AuthError('EMAIL_INVALID', '请输入正确的邮箱地址');

  const { data, error } = await supabase.auth.getSession();
  if (error) throw describeAuthError(error);

  const user = data.session?.user;
  if (user && !user.is_anonymous) {
    if (normalizeEmail(user.email ?? '') === email) {
      throw new AuthError('ALREADY_SIGNED_IN', '当前已登录该邮箱');
    }
    throw new AuthError('ALREADY_SIGNED_IN', '已登录其他账号，请先退出登录');
  }

  if (user?.is_anonymous) {
    const { error: updateError } = await supabase.auth.updateUser({ email });
    if (updateError) throw describeAuthError(updateError);
    return 'upgrade';
  }

  const { error: otpError } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (otpError) throw describeAuthError(otpError);
  return 'signin';
}

/**
 * 校验 6 位验证码；成功后 session 由 supabase-js 写回本地存储。
 * 首次登录是 email 类型，匿名升级是 email_change 类型；先按已知模式试，失败再试另一种，
 * 这样即使 App 重启丢掉模式也能登进去。
 */
export async function verifyEmailCode(
  rawEmail: string,
  rawToken: string,
  preferred: EmailCodeMode = 'signin',
): Promise<Session> {
  const email = normalizeEmail(rawEmail);
  const token = rawToken.replace(/\s/g, '');
  if (!/^\d{6}$/.test(token)) throw new AuthError('CODE_FORMAT', '请输入 6 位数字验证码');

  const first: 'email' | 'email_change' = preferred === 'upgrade' ? 'email_change' : 'email';
  const second: 'email' | 'email_change' = first === 'email' ? 'email_change' : 'email';

  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: first });
  if (!error && data.session) return data.session;

  const fallback = await supabase.auth.verifyOtp({ email, token, type: second });
  if (fallback.error || !fallback.data.session) {
    throw describeAuthError(error ?? fallback.error ?? {});
  }
  return fallback.data.session;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw describeAuthError(error);
}

// ---------- 手机号登录占位（本版不实现） ----------
// 启用条件：Supabase 后台 Phone provider 打开 + 配置短信服务商凭据（Twilio Account SID /
// Auth Token / Messaging Service SID，或阿里云短信 AccessKey 与模板 ID），并把 PHONE_AUTH_ENABLED 设为 true。
export async function sendPhoneCode(_rawPhone: string): Promise<void> {
  throw new AuthError('PHONE_NOT_ENABLED', '手机号登录暂未接入短信服务商');
}

export async function verifyPhoneCode(_rawPhone: string, _rawToken: string): Promise<Session> {
  throw new AuthError('PHONE_NOT_ENABLED', '手机号登录暂未接入短信服务商');
}

type AuthContextValue = {
  /** 首次 session 初始化是否完成 */
  ready: boolean;
  profile: AuthProfile | null;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<AuthProfile | null>(null);

  const applySession = useCallback((session: Session | null) => {
    setProfile(toProfile(session?.user));
  }, []);

  const refresh = useCallback(async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw describeAuthError(error);
    applySession(data.session);
  }, [applySession]);

  useEffect(() => {
    let alive = true;

    ensureSession()
      .then((session) => {
        if (alive) applySession(session);
      })
      .catch(() => {
        if (alive) applySession(null);
      })
      .finally(() => {
        if (alive) setReady(true);
      });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setProfile(toProfile(session?.user));
    });

    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, [applySession]);

  const value = useMemo(() => ({ ready, profile, refresh }), [ready, profile, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return context;
}

/** 短 ID：UUID 前 8 位，便于用户比对又不至于刷屏 */
export function shortUserId(userId: string | null | undefined) {
  return userId ? userId.slice(0, 8) : '';
}
