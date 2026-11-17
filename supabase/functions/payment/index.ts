// supabase/functions/payment/index.ts
// 支付骨架 Edge Function（服务端）：
//   action=create_order  创建订单（幂等：同一 user_id + idempotency_key 只产生一单）
//   action=callback      第三方支付回调（签名校验 + 金额校验 + 原子发放权益 + 回调去重）
//   action=mock_pay      仅 mock 通道开启时可用，模拟支付成功并走同一套回调逻辑
//   action=query         查询某用户的订单与权益（客户端读取入口）
//
// 通道抽象：createPayment / verifyCallback 两个可替换实现。
//   mock      可用（需 PAYMENT_MOCK_ENABLED=true 且有 PAYMENT_MOCK_SECRET）
//   wechat    占位，未配置商户凭据时明确报错
//   alipay    占位，未配置商户凭据时明确报错
//
// 身份：create_order / mock_pay / query 一律从 Authorization: Bearer <access_token> 取
// Supabase Auth 校验过的用户（service_role 调 auth.getUser），不接受 body.user_id 或
// x-device-id 自报身份；只有第三方回调（action=callback）走签名校验、不需要用户 JWT。
//
// 所有数据库写操作使用 service_role，客户端（anon）没有订单/权益表的写权限。

import { createClient } from "jsr:@supabase/supabase-js@2";
import { classifyMarkPaidResult, type MarkPaidResult } from "./payment-result.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id",
};

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ACTIVE_CHANNEL = (Deno.env.get("PAYMENT_CHANNEL") ?? "mock").toLowerCase();
const MOCK_ENABLED = (Deno.env.get("PAYMENT_MOCK_ENABLED") ?? "false") === "true";
const MOCK_SECRET = Deno.env.get("PAYMENT_MOCK_SECRET") ?? "";
const ORDER_TTL_MINUTES = 15;

// 套餐表：金额单位为「分」
const PLANS: Record<string, { amountCents: number; quota: number | null; validDays: number | null }> = {
  tryon_10: { amountCents: 990, quota: 10, validDays: 365 },
  tryon_50: { amountCents: 3990, quota: 50, validDays: 365 },
  monthly: { amountCents: 2990, quota: null, validDays: 30 },
};

type OrderRow = {
  id: string;
  order_no: string;
  user_id: string;
  plan_id: string;
  amount_cents: number;
  status: string;
  channel: string;
  expires_at: string;
};

type CallbackInput = {
  eventId: string;
  orderNo: string;
  amountCents: number;
  externalTxnId: string | null;
};

type PaymentChannel = {
  name: string;
  createPayment(order: OrderRow): Promise<Record<string, unknown>>;
  verifyCallback(rawBody: string, payload: Record<string, unknown>): Promise<CallbackInput>;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const fail = (code: string, message: string, status = 400) =>
  json({ error: message, code }, status);

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

// mock 通道：签名 = HMAC-SHA256(secret, `${eventId}.${orderNo}.${amountCents}`)
const mockChannel: PaymentChannel = {
  name: "mock",
  async createPayment(order) {
    const eventId = `mock_${order.order_no}`;
    const signInput = `${eventId}.${order.order_no}.${order.amount_cents}`;
    return {
      channel: "mock",
      pay_url: `https://example.invalid/mock-pay?order_no=${order.order_no}&amount_cents=${order.amount_cents}&event_id=${eventId}`,
      event_id: eventId,
      signature: await hmacSha256(MOCK_SECRET, signInput),
    };
  },
  async verifyCallback(rawBody, payload) {
    const eventId = String(payload.event_id ?? "");
    const orderNo = String(payload.order_no ?? "");
    const amountCents = Number(payload.amount_cents ?? NaN);
    const signature = String(payload.signature ?? "");
    if (!eventId || !orderNo || !Number.isInteger(amountCents)) {
      throw new Error("CALLBACK_PARAM_MISSING");
    }
    const expected = await hmacSha256(MOCK_SECRET, `${eventId}.${orderNo}.${amountCents}`);
    if (expected !== signature) throw new Error("SIGNATURE_INVALID");
    return {
      eventId,
      orderNo,
      amountCents,
      externalTxnId: payload.external_txn_id ? String(payload.external_txn_id) : null,
    };
  },
};

// 真通道占位：没有商户凭据时不实现，明确报错
const wechatChannel: PaymentChannel = {
  name: "wechat",
  async createPayment() {
    throw new Error("CHANNEL_NOT_CONFIGURED: 微信支付未配置商户凭据（mch_id / api_v3_key / 证书）");
  },
  async verifyCallback() {
    throw new Error("CHANNEL_NOT_CONFIGURED: 微信支付未配置商户凭据（mch_id / api_v3_key / 证书）");
  },
};

const alipayChannel: PaymentChannel = {
  name: "alipay",
  async createPayment() {
    throw new Error("CHANNEL_NOT_CONFIGURED: 支付宝未配置商户凭据（app_id / 私钥 / 支付宝公钥）");
  },
  async verifyCallback() {
    throw new Error("CHANNEL_NOT_CONFIGURED: 支付宝未配置商户凭据（app_id / 私钥 / 支付宝公钥）");
  },
};

const CHANNELS: Record<string, PaymentChannel> = {
  mock: mockChannel,
  wechat: wechatChannel,
  alipay: alipayChannel,
};

function getChannel(name: string): PaymentChannel {
  const ch = CHANNELS[name];
  if (!ch) throw new Error(`CHANNEL_UNKNOWN: ${name}`);
  if (name === "mock" && !MOCK_ENABLED) {
    throw new Error("CHANNEL_DISABLED: mock 通道未启用（PAYMENT_MOCK_ENABLED!=true）");
  }
  if (name === "mock" && !MOCK_SECRET) {
    throw new Error("CHANNEL_NOT_CONFIGURED: mock 通道缺少 PAYMENT_MOCK_SECRET");
  }
  return ch;
}

function newOrderNo(): string {
  const ts = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const rand = crypto.getRandomValues(new Uint8Array(4));
  return `WD${ts}${hex(rand.buffer).toUpperCase()}`;
}

type AuthedUser = { id: string; isAnonymous: boolean };

function getBearerToken(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

/**
 * 用 Supabase Auth 校验调用者 JWT，返回真实 uid。
 * 失败时给出一条 401 响应，调用方直接 return 即可。
 */
async function requireUser(
  supabase: ReturnType<typeof createClient>,
  req: Request,
): Promise<{ user: AuthedUser } | { response: Response }> {
  const token = getBearerToken(req);
  if (!token) {
    return { response: fail("AUTH_REQUIRED", "缺少登录凭证：请在 Authorization 头里带上 access_token", 401) };
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { response: fail("AUTH_INVALID", "登录凭证无效或已过期，请重新登录", 401) };
  }
  return { user: { id: data.user.id, isAnonymous: Boolean(data.user.is_anonymous) } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", "只支持 POST", 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("INVALID_JSON", "请求体不是合法的 JSON");
  }

  const action = String(body.action ?? "");
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    if (action === "create_order") {
      const planId = String(body.plan_id ?? "");
      const plan = PLANS[planId];
      if (!plan) return fail("PLAN_INVALID", `未知套餐: ${planId || "(空)"}`);

      const auth = await requireUser(supabase, req);
      if ("response" in auth) return auth.response;
      const userId = auth.user.id;

      const idemKey = String(body.idempotency_key ?? "").trim();
      if (!idemKey) return fail("IDEMPOTENCY_KEY_REQUIRED", "缺少 idempotency_key");

      const channelName = String(body.channel ?? ACTIVE_CHANNEL).toLowerCase();
      const channel = getChannel(channelName);

      const expiresAt = new Date(Date.now() + ORDER_TTL_MINUTES * 60 * 1000).toISOString();
      const orderNo = newOrderNo();

      // 幂等插入：唯一约束 (user_id, idempotency_key)
      const { error: insErr } = await supabase.from("payment_orders").insert({
        order_no: orderNo,
        user_id: userId,
        plan_id: planId,
        amount_cents: plan.amountCents,
        channel: channelName,
        idempotency_key: idemKey,
        expires_at: expiresAt,
      });
      if (insErr && insErr.code !== "23505") {
        return fail("ORDER_INSERT_FAILED", insErr.message, 500);
      }

      const { data: order, error: selErr } = await supabase
        .from("payment_orders")
        .select("*")
        .eq("user_id", userId)
        .eq("idempotency_key", idemKey)
        .single<OrderRow>();
      if (selErr || !order) return fail("ORDER_LOAD_FAILED", selErr?.message ?? "订单读取失败", 500);

      const reused = insErr?.code === "23505";
      const payParams = order.status === "pending" ? await channel.createPayment(order) : null;

      return json({
        order_no: order.order_no,
        plan_id: order.plan_id,
        amount_cents: order.amount_cents,
        status: order.status,
        channel: order.channel,
        expires_at: order.expires_at,
        reused,
        pay_params: payParams,
      });
    }

    if (action === "callback") {
      const channelName = String(body.channel ?? "").toLowerCase();
      const payload = (body.payload ?? body) as Record<string, unknown>;
      const channel = getChannel(channelName);
      const rawBody = JSON.stringify(payload);

      let input: CallbackInput;
      try {
        input = await channel.verifyCallback(rawBody, payload);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = msg.startsWith("SIGNATURE_INVALID") ? 401 : 400;
        return fail(msg.split(":")[0], msg, status);
      }

      const planId = String(payload.plan_id ?? "");
      const plan = PLANS[planId];
      if (!plan) return fail("PLAN_INVALID", `回调 scaffold 需要 plan_id，收到: ${planId || "(空)"}`);

      const { data, error } = await supabase.rpc("mark_order_paid", {
        p_order_no: input.orderNo,
        p_channel: channelName,
        p_event_id: input.eventId,
        p_external_txn_id: input.externalTxnId,
        p_amount_cents: input.amountCents,
        p_plan_id: planId,
        p_quota_total: plan.quota,
        p_valid_days: plan.validDays,
      });
      return markPaidResponse(data as MarkPaidResult | null, error);
    }

    if (action === "mock_pay") {
      if (!MOCK_ENABLED) return fail("CHANNEL_DISABLED", "mock 通道未启用", 403);
      if (!MOCK_SECRET) return fail("CHANNEL_NOT_CONFIGURED", "缺少 PAYMENT_MOCK_SECRET", 500);

      const orderNo = String(body.order_no ?? "");
      if (!orderNo) return fail("ORDER_REQUIRED", "缺少 order_no");

      const { data: order, error: selErr } = await supabase
        .from("payment_orders")
        .select("*")
        .eq("order_no", orderNo)
        .maybeSingle<OrderRow>();
      if (selErr) return fail("ORDER_LOAD_FAILED", selErr.message, 500);
      if (!order) return fail("ORDER_NOT_FOUND", "订单不存在", 404);

      // 只允许订单所属用户自己支付这笔订单，避免拿到别人的 order_no 就能替他把单推成已支付。
      // 归属以 JWT 里的 uid 为准，body 里的任何用户标识都不采信。
      const auth = await requireUser(supabase, req);
      if ("response" in auth) return auth.response;
      if (order.user_id !== auth.user.id) return fail("ORDER_FORBIDDEN", "这笔订单不属于当前用户", 403);

      const eventId = String(body.event_id ?? `mock_${order.order_no}`);
      const signature = await hmacSha256(MOCK_SECRET, `${eventId}.${order.order_no}.${order.amount_cents}`);

      return await handleCallback(
        supabase,
        "mock",
        {
          event_id: eventId,
          order_no: order.order_no,
          amount_cents: order.amount_cents,
          plan_id: order.plan_id,
          signature,
          external_txn_id: `mock_txn_${order.order_no}`,
        },
      );
    }

    if (action === "query") {
      const auth = await requireUser(supabase, req);
      if ("response" in auth) return auth.response;
      const userId = auth.user.id;
      const [{ data: orders, error: ordersErr }, { data: ents, error: entsErr }] = await Promise.all([
        supabase.from("payment_orders").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
        supabase.from("entitlements").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
      ]);
      // 查询失败不能返回空数组：客户端会把「读不到权益」误判成「还没购买」
      if (ordersErr || entsErr) {
        return fail("QUERY_FAILED", ordersErr?.message ?? entsErr?.message ?? "权益查询失败", 500);
      }
      return json({ orders: orders ?? [], entitlements: ents ?? [] });
    }

    return fail("ACTION_UNKNOWN", `未知 action: ${action || "(空)"}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("CHANNEL_NOT_CONFIGURED") ? 501 : msg.startsWith("CHANNEL_DISABLED") ? 403 : 500;
    return fail(msg.split(":")[0], msg, status);
  }
});

/**
 * mark_order_paid 返回 200 后，把业务状态翻译成 HTTP 响应：
 *   paid / already_paid / duplicate -> 200 {result}
 *   rejected + code                  -> 404/410/422/400/409，{error, code}
 *   其它未知状态                      -> 502，避免被当成支付成功
 */
function markPaidResponse(
  data: MarkPaidResult | null,
  error: { message?: string } | null,
): Response {
  const outcome = classifyMarkPaidResult(data, error);
  if (outcome.kind === "success") return json({ result: data });
  return fail(outcome.code, outcome.message, outcome.status);
}

// 供 mock_pay 复用：与 action=callback 完全同一条处理路径
async function handleCallback(
  supabase: ReturnType<typeof createClient>,
  channelName: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const channel = getChannel(channelName);
  let input: CallbackInput;
  try {
    input = await channel.verifyCallback(JSON.stringify(payload), payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("SIGNATURE_INVALID") ? 401 : 400;
    return fail(msg.split(":")[0], msg, status);
  }

  const planId = String(payload.plan_id ?? "");
  const plan = PLANS[planId];
  if (!plan) return fail("PLAN_INVALID", `未知套餐: ${planId || "(空)"}`);

  const { data, error } = await supabase.rpc("mark_order_paid", {
    p_order_no: input.orderNo,
    p_channel: channelName,
    p_event_id: input.eventId,
    p_external_txn_id: input.externalTxnId,
    p_amount_cents: input.amountCents,
    p_plan_id: planId,
    p_quota_total: plan.quota,
    p_valid_days: plan.validDays,
  });
  return markPaidResponse(data as MarkPaidResult | null, error);
}
