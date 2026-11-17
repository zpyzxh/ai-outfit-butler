import { ensureSession } from './auth';
import { supabase } from './supabase';

// 支付客户端：所有状态以服务端返回为准，前端不推断「支付成功」。
// 身份只走 JWT（Authorization: Bearer <access_token>），不再自报 user_id。

export type PlanId = 'tryon_10' | 'tryon_50' | 'monthly';

export type PlanOption = {
  id: PlanId;
  name: string;
  description: string;
  amountCents: number;
  quota: number | null;
  validDays: number;
};

export const PLAN_OPTIONS: PlanOption[] = [
  { id: 'tryon_10', name: '轻享 10 次', description: '适合偶尔试用，一年内有效', amountCents: 990, quota: 10, validDays: 365 },
  { id: 'tryon_50', name: '进阶 50 次', description: '适合频繁搭配，一年内有效', amountCents: 3990, quota: 50, validDays: 365 },
  { id: 'monthly', name: '月度会员', description: '30 天内不限次数', amountCents: 2990, quota: null, validDays: 30 },
];

export type PaymentOrder = {
  order_no: string;
  plan_id: string;
  amount_cents: number;
  status: string;
  channel: string;
  expires_at: string;
  reused: boolean;
};

export type Entitlement = {
  id: string;
  plan_id: string;
  quota_total: number | null;
  quota_used: number;
  valid_from: string;
  valid_until: string | null;
  status: 'active' | 'expired' | 'revoked';
  created_at: string;
};

export class PaymentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}

/** 整数分转显示金额，不做浮点累加。 */
export function formatCents(cents: number): string {
  const value = Math.round(cents);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}¥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function createIdempotencyKey(): string {
  const bytes = new Uint8Array(8);
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `idem_${Date.now().toString(36)}_${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function invokePayment<T>(body: Record<string, unknown>): Promise<T> {
  const session = await ensureSession();
  if (!session?.access_token) {
    throw new PaymentError('AUTH_REQUIRED', '请先在「我的」页用邮箱验证码登录后再购买');
  }

  const { data, error } = await supabase.functions.invoke('payment', {
    body,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });

  if (error) {
    // 非 2xx 时服务端仍返回 { error, code }，从 context 里取出来，避免只显示 "non-2xx"
    let code = 'FUNCTION_ERROR';
    let message = error.message;
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === 'function') {
      try {
        const payload = (await context.json()) as { error?: string; code?: string };
        if (payload?.code) code = payload.code;
        if (payload?.error) message = payload.error;
      } catch {
        // 响应体不是 JSON 时保留原始 message
      }
    }
    throw new PaymentError(code, message);
  }

  const payload = data as { error?: string; code?: string } | null;
  if (!payload) throw new PaymentError('EMPTY_RESPONSE', '支付服务没有返回数据');
  if (payload.error) throw new PaymentError(payload.code ?? 'ERROR', payload.error);
  return payload as T;
}

export function createOrder(planId: PlanId, idempotencyKey: string): Promise<PaymentOrder> {
  return invokePayment<PaymentOrder>({ action: 'create_order', plan_id: planId, idempotency_key: idempotencyKey });
}

export function mockPay(orderNo: string): Promise<{ result?: { status?: string; order_no?: string; entitlement_created?: boolean } }> {
  return invokePayment({ action: 'mock_pay', order_no: orderNo, channel: 'mock' });
}

export function queryPayments(): Promise<{ orders: PaymentOrder[]; entitlements: Entitlement[] }> {
  return invokePayment({ action: 'query' });
}

/** 把服务端错误码翻译成用户看得懂的话。 */
export function describePaymentError(error: unknown): string {
  if (error instanceof PaymentError) {
    switch (error.code) {
      case 'CHANNEL_DISABLED':
        return '支付通道未开通，请稍后再试';
      case 'CHANNEL_NOT_CONFIGURED':
        return '支付通道还没配置完成，暂时无法下单';
      case 'ORDER_EXPIRED':
        return '订单已过期，请重新下单';
      case 'ORDER_NOT_FOUND':
        return '订单不存在，请重新下单';
      case 'ORDER_STATE_INVALID':
        return '订单状态已变化，请刷新后重试';
      case 'AMOUNT_MISMATCH':
        return '订单金额校验失败，已停止支付';
      case 'PLAN_MISMATCH':
        return '套餐校验失败，已停止支付';
      default:
        return error.message || '支付请求失败，请重试';
    }
  }
  return error instanceof Error ? error.message : '支付请求失败，请重试';
}
