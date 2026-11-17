// supabase/functions/tryon/index.ts
// 试衣 Edge Function：
//   POST /tryon        创建试衣任务，调用 Replicate IDM-VTON，返回 task_id
//   GET  /tryon?id=xx  前端每 5 秒轮询，返回任务状态；成功后回传首帧图 URL
//
// 状态值统一：pending / processing / done / failed / timeout

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id",
};

const REPLICATE_API_TOKEN = Deno.env.get("REPLICATE_API_TOKEN")!;
// provider 选择：aidge（默认，当前实际在用）| dashscope | replicate。
// 百炼账户已欠费停服，默认值绝不能静默回落到 dashscope；取值非法时直接报错，不做降级。
const SUPPORTED_PROVIDERS = ["aidge", "dashscope", "replicate"] as const;
type TryonProvider = (typeof SUPPORTED_PROVIDERS)[number];
const TRYON_PROVIDER_RAW = (Deno.env.get("TRYON_PROVIDER") ?? "aidge").toLowerCase();
const TRYON_PROVIDER_CONFIGURED = (SUPPORTED_PROVIDERS as readonly string[]).includes(TRYON_PROVIDER_RAW);
const TRYON_PROVIDER = TRYON_PROVIDER_RAW as TryonProvider;
const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
// aitryon 约 0.20 元/张、15~30 秒；aitryon-plus 约 0.50 元/张、约 90 秒
const AITRYON_MODEL = Deno.env.get("AITRYON_MODEL") ?? "aitryon";
// 异步任务 ID 前缀，用于轮询时区分 provider（不改表结构）
const DASHSCOPE_TASK_PREFIX = "ds:";
// IDM-VTON 最新版本（2024-04-22 发布，作者已标记为 Latest）
const IDM_VTON_VERSION = "0513734a452173b8173e907e3a59d19a36266e55b48528559432bd21c7d7e985";
// 服务端兜底超时：与前端 MAX_WAIT_MS 对齐（15 分钟），避免任务永远停在 processing
const TRYON_TIMEOUT_MS = 15 * 60 * 1000;

// 阿里云「电商经营助手 Aidge」虚拟试穿（同步接口，仅 1K，¥0.4/张）
const AIDGE_ACCESS_KEY_ID = Deno.env.get("AIDGE_ACCESS_KEY_ID") ?? "";
const AIDGE_ACCESS_KEY_SECRET = Deno.env.get("AIDGE_ACCESS_KEY_SECRET") ?? "";
const AIDGE_HOST = "aidge.cn-beijing.aliyuncs.com";
const AIDGE_VERSION = "2026-04-28";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// IDM-VTON 的 category 只认 upper_body / lower_body / dresses
function toIdmCategory(category: string | null) {
  if (category === "下装") return "lower_body";
  if (category === "连衣裙") return "dresses";
  return "upper_body";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------- 频次限制 ----------
// 两层配额：
//   1) 设备维度（主）：客户端安装级 x-device-id，避免共享 WiFi / 运营商 NAT 下的多个正常用户被合并计数
//   2) IP 维度（兜底）：设备 ID 可被伪造，用较宽松的 IP 上限拦住轮换设备 ID 的滥用
// 客户端未带设备 ID 时退回原来的严格 IP 配额。轮询（GET）不计次。

const RATE_WINDOW_SECONDS = 600;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

// Supabase 边缘网关会覆盖 x-forwarded-for（客户端伪造无效，已实测），
// 但仍优先取 CDN 注入的 cf-connecting-ip；x-forwarded-for 取最后一跳（可信代理追加的那一条）。
function getClientIp(req: Request) {
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function consumeQuota(key: string, limit: number) {
  const { data, error } = await supabase.rpc("consume_edge_rate_limit", {
    p_rate_key: key, p_limit: limit, p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (error) {
    console.error("rate limit rpc failed", { key: key.split(":")[0], message: error.message });
    return "error" as const;
  }
  return data ? "ok" as const : "limited" as const;
}

async function enforceRateLimits(
  req: Request,
  name: string,
  limits: { device: number; ip: number; ipWithoutDevice: number },
) {
  const deviceId = req.headers.get("x-device-id")?.trim() ?? "";
  const hasDeviceId = DEVICE_ID_PATTERN.test(deviceId);

  if (hasDeviceId) {
    const deviceHash = await sha256(deviceId);
    const deviceResult = await consumeQuota(`${name}:dev:${deviceHash}`, limits.device);
    if (deviceResult === "error") return json({ error: "频次限制服务暂不可用，请稍后重试" }, 503);
    if (deviceResult === "limited") {
      console.warn("rate limited", { fn: name, scope: "device", token: deviceHash.slice(0, 8) });
      return json({ error: "请求过于频繁，请稍后再试" }, 429);
    }
  }

  // 无设备 ID：使用独立的严格 IP 配额，避免与带设备 ID 用户的兜底计数互相污染。
  if (!hasDeviceId) {
    const strictIpHash = await sha256(getClientIp(req));
    const strictResult = await consumeQuota(`${name}:ip-strict:${strictIpHash}`, limits.ipWithoutDevice);
    if (strictResult === "error") return json({ error: "频次限制服务暂不可用，请稍后重试" }, 503);
    if (strictResult === "limited") {
      console.warn("rate limited", { fn: name, scope: "ip-strict", token: strictIpHash.slice(0, 8) });
      return json({ error: "请求过于频繁，请稍后再试" }, 429);
    }
    return null;
  }

  // 带设备 ID：设备配额之外再用 IP 兜底上限，拦住轮换设备 ID 的滥用。
  const ipHash = await sha256(getClientIp(req));
  const ipResult = await consumeQuota(`${name}:ip:${ipHash}`, limits.ip);
  if (ipResult === "error") return json({ error: "频次限制服务暂不可用，请稍后重试" }, 503);
  if (ipResult === "limited") {
    console.warn("rate limited", { fn: name, scope: "ip", token: ipHash.slice(0, 8) });
    return json({ error: "请求过于频繁，请稍后再试" }, 429);
  }
  return null;
}

// ---------- 调用者身份 ----------
// 只认 Supabase Auth 校验过的 JWT；只有 anon key / 无 Authorization 时返回 null。
async function resolveUserId(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match ? match[1].trim() : "";
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

// ---------- 权益扣减 ----------
// 未购买过套餐 -> no_entitlement（免费额度，保持原行为）
// 买过且仍有可用权益 -> consumed（quota_used + 1）
// 买过但次数耗尽 / 已过期 -> exhausted（阻断）
type QuotaConsumeResult =
  | { status: "consumed"; entitlementId: string }
  | { status: "no_entitlement" }
  | { status: "exhausted" }
  | { status: "error" };

async function consumeTryonQuota(userId: string | null): Promise<QuotaConsumeResult> {
  if (!userId) return { status: "no_entitlement" };
  const { data, error } = await supabase.rpc("consume_entitlement", { p_user_id: userId });
  if (error) {
    console.error("consume_entitlement rpc failed", { message: error.message });
    return { status: "error" };
  }
  const status = String((data as { status?: string } | null)?.status ?? "");
  if (status === "consumed") {
    const entitlementId = String((data as { entitlement_id?: string }).entitlement_id ?? "");
    if (!entitlementId) {
      console.error("consume_entitlement returned consumed without entitlement_id", data);
      return { status: "error" };
    }
    return { status: "consumed", entitlementId };
  }
  if (status === "exhausted") return { status: "exhausted" };
  return { status: "no_entitlement" };
}

async function refundTryonQuota(entitlementId: string | null, reason: string) {
  if (!entitlementId) return;
  const { error } = await supabase.rpc("refund_entitlement", { p_entitlement_id: entitlementId });
  if (error) console.error("refund_entitlement rpc failed", { entitlementId, reason, message: error.message });
}

// resolution 元数据按供应商真实输出写，不再依赖 001 里 '720p' 的默认值
function defaultResolution(): string {
  if (TRYON_PROVIDER === "replicate") return "768x1024";
  return "1K";
}

// ---------- 创建任务 ----------
async function createTask(req: Request) {
  if (!TRYON_PROVIDER_CONFIGURED) {
    console.error("invalid TRYON_PROVIDER", { value: TRYON_PROVIDER_RAW });
    return json({
      error: `试衣供应商配置无效：TRYON_PROVIDER=${TRYON_PROVIDER_RAW || "(空)"}，仅支持 ${SUPPORTED_PROVIDERS.join(" / ")}`,
      provider: TRYON_PROVIDER_RAW || null,
    }, 500);
  }

  // 参数校验阶段的失败不消耗配额
  let body: { user_photo_url?: string; garment_id?: string; text_intent?: string; use_back?: boolean };
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "请求体不是合法的 JSON" }, 400);
  }
  const { user_photo_url, garment_id, text_intent, use_back } = body;
  if (!user_photo_url || !garment_id) {
    return json({ error: "user_photo_url 和 garment_id 必填" }, 400);
  }

  // 查衣服的平铺图（背面图可选：021 迁移加的列，老库没有就查不到，按 undefined 处理）
  const { data: garment, error: gErr } = await supabase
    .from("garments")
    .select("id, flat_image_url, back_image_url, name, category")
    .eq("id", garment_id)
    .maybeSingle();
  if (gErr) {
    console.error("tryon garment lookup failed", gErr);
    return json({ error: "查询衣服失败", details: gErr.message }, 500);
  }
  if (!garment) {
    console.warn("tryon garment not found", { garment_id });
    return json({ error: "衣服不存在", garment_id }, 404);
  }

  // 用背面图试穿：只换输入图，其余流程完全一样（同一个供应商、同一份配额）。
  // 客户端在「看背面」时传 use_back=true；没有背面图就直接 400，不要静默退回正面图，
  // 否则用户会以为看到的是真实背面。
  const backImageUrl = typeof (garment as { back_image_url?: string | null }).back_image_url === "string"
    ? (garment as { back_image_url?: string | null }).back_image_url
    : null;
  if (use_back) {
    if (!backImageUrl) {
      return json({ error: "这件单品还没有上传背面图", code: "NO_BACK_IMAGE" }, 400);
    }
    (garment as { flat_image_url: string }).flat_image_url = backImageUrl as string;
  }

  // 调用者身份：带有效 JWT 时把任务绑定到该用户，GET 轮询据此校验归属
  const ownerUserId = await resolveUserId(req);

  // 限流计次：参数与衣服校验都通过、即将提交供应商任务时才扣额度。
  // 空提交、参数错误、衣服不存在都不消耗次数；轮询（GET）路径不经过这里。
  const limited = await enforceRateLimits(req, "tryon", { device: 3, ip: 10, ipWithoutDevice: 3 });
  if (limited) return limited;

  // 权益扣减：买过套餐的用户按次消耗，次数耗尽直接阻断；没买过保持免费额度。
  const quota = await consumeTryonQuota(ownerUserId);
  if (quota.status === "error") return json({ error: "权益服务暂不可用，请稍后重试" }, 503);
  if (quota.status === "exhausted") {
    return json({ error: "试穿次数已用完，请购买套餐后继续", code: "QUOTA_EXHAUSTED" }, 402);
  }
  const entitlementId = quota.status === "consumed" ? quota.entitlementId : null;

  // 先落库
  const { data: task, error: tErr } = await supabase
    .from("tryon_tasks")
    .insert({
      user_photo_url,
      garment_id,
      text_intent: text_intent ?? null,
      output_type: "image",
      stage: "tryon",
      status: "processing",
      owner_user_id: ownerUserId,
      resolution: defaultResolution(),
    })
    .select("id")
    .single();
  if (tErr || !task) {
    console.error("tryon task insert failed", tErr);
    await refundTryonQuota(entitlementId, "task_insert_failed");
    return json({ error: "试衣任务写入失败", details: tErr?.message }, 500);
  }

  if (TRYON_PROVIDER === "replicate") {
    return await createReplicateTask(task.id, user_photo_url, garment, entitlementId);
  }
  if (TRYON_PROVIDER === "aidge") {
    return await createAidgeTask(task.id, user_photo_url, garment, entitlementId);
  }
  return await createDashScopeTask(task.id, user_photo_url, garment, entitlementId);
}

// ---------- DashScope AI 试衣（aitryon / aitryon-plus）----------
// 异步任务：先 POST 创建，拿到 task_id；轮询 GET /api/v1/tasks/{task_id}。
// 图片只接受公网 HTTP/HTTPS 地址；我们用的是 Supabase 公共存储桶，可直接传。
async function createDashScopeTask(
  taskId: string,
  userPhotoUrl: string,
  garment: { flat_image_url: string; name: string; category: string | null },
  entitlementId: string | null,
) {
  if (!DASHSCOPE_API_KEY) {
    await supabase.from("tryon_tasks").update({ status: "failed", error_msg: "DASHSCOPE_API_KEY 未配置" }).eq("id", taskId);
    await refundTryonQuota(entitlementId, "dashscope_key_missing");
    return json({
      error: "试衣供应商（百炼 DashScope）未配置：缺少 DASHSCOPE_API_KEY",
      provider: "dashscope",
      task_id: taskId,
    }, 500);
  }

  // 下装走 bottom_garment_url；上装/外套/连衣裙走 top_garment_url
  const isBottom = garment.category === "下装";
  const input = isBottom
    ? { person_image_url: userPhotoUrl, bottom_garment_url: garment.flat_image_url }
    : { person_image_url: userPhotoUrl, top_garment_url: garment.flat_image_url };

  const dsRes = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify({
      model: AITRYON_MODEL,
      input,
      parameters: { resolution: -1, restore_face: true },
    }),
  });

  const dsBody = await dsRes.text();
  if (!dsRes.ok) {
    console.error("DashScope tryon create failed", dsRes.status, dsBody);
    await supabase.from("tryon_tasks").update({ status: "failed", error_msg: dsBody }).eq("id", taskId);
    await refundTryonQuota(entitlementId, "dashscope_create_failed");
    return json({
      error: "试衣生成失败（百炼 DashScope 拒绝了请求，常见原因是账户欠费或模型未开通）",
      provider: "dashscope",
      details: dsBody.slice(0, 500),
      provider_status: dsRes.status,
      task_id: taskId,
    }, 502);
  }

  let dsTaskId = "";
  try {
    dsTaskId = JSON.parse(dsBody)?.output?.task_id ?? "";
  } catch (_) {
    // 解析失败按无 task_id 处理
  }
  if (!dsTaskId) {
    await supabase.from("tryon_tasks").update({ status: "failed", error_msg: dsBody }).eq("id", taskId);
    await refundTryonQuota(entitlementId, "dashscope_no_task_id");
    return json({
      error: "试衣生成失败（百炼 DashScope 未返回任务 ID）",
      provider: "dashscope",
      details: dsBody.slice(0, 500),
      task_id: taskId,
    }, 502);
  }

  await supabase.from("tryon_tasks")
    .update({ provider_task_id: `${DASHSCOPE_TASK_PREFIX}${dsTaskId}` })
    .eq("id", taskId);

  return json({ task_id: taskId, status: "processing" });
}

// ---------- 阿里云 Aidge 虚拟试穿（同步接口，仅 1K，¥0.4/张）----------
// Aidge 官方取值：tops / bottoms / dresses / outerwear（2026-11 实测为 outerwear，
// 传 outwear 会返回 InvalidParameter: ClothType must use: tops/outerwear/...）。
const AIDGE_CLOTH_TYPE: Record<string, string> = {
  "上装": "tops",
  "外套": "outerwear",
  "下装": "bottoms",
  "连衣裙": "dresses",
};

function rfc3986(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function hmacSha256Hex(key: string, msg: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 阿里云 OpenAPI V3 签名（ACS3-HMAC-SHA256）
async function signAidgeRequest(
  ak: string,
  sk: string,
  query: Record<string, string>,
  payload: string,
) {
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`)
    .join("&");

  const bodyHash = await sha256(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: AIDGE_HOST,
    "x-acs-action": "AiTryOn",
    "x-acs-content-sha256": bodyHash,
    "x-acs-date": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-acs-signature-nonce": crypto.randomUUID(),
    "x-acs-version": AIDGE_VERSION,
  };

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}`)
    .join("\n") + "\n";
  const canonicalRequest = [
    "POST",
    "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const stringToSign = `ACS3-HMAC-SHA256\n${await sha256(canonicalRequest)}`;
  const signature = await hmacSha256Hex(sk, stringToSign);
  headers.authorization =
    `ACS3-HMAC-SHA256 Credential=${ak},SignedHeaders=${signedHeaders},Signature=${signature}`;

  return { headers, canonicalQuery };
}

async function createAidgeTask(
  taskId: string,
  userPhotoUrl: string,
  garment: { flat_image_url: string; name: string; category: string | null },
  entitlementId: string | null,
) {
  if (!AIDGE_ACCESS_KEY_ID || !AIDGE_ACCESS_KEY_SECRET) {
    await supabase.from("tryon_tasks")
      .update({ status: "failed", error_msg: "AIDGE AccessKey 未配置" })
      .eq("id", taskId);
    await refundTryonQuota(entitlementId, "aidge_key_missing");
    return json({
      error: "试衣供应商（Aidge）未配置：缺少 AIDGE_ACCESS_KEY_ID / AIDGE_ACCESS_KEY_SECRET",
      provider: "aidge",
      task_id: taskId,
    }, 500);
  }

  const clothType = AIDGE_CLOTH_TYPE[garment.category ?? ""];
  const payload = JSON.stringify({
    ModelImageUrl: userPhotoUrl,
    ClothImageUrl: garment.flat_image_url,
    ...(clothType ? { ClothType: clothType } : {}),
    Resolution: "1K",
  });
  const { headers, canonicalQuery } = await signAidgeRequest(
    AIDGE_ACCESS_KEY_ID,
    AIDGE_ACCESS_KEY_SECRET,
    { Action: "AiTryOn", Format: "JSON", Version: AIDGE_VERSION },
    payload,
  );

  let res: Response;
  try {
    res = await fetch(`https://${AIDGE_HOST}/?${canonicalQuery}`, {
      method: "POST",
      headers,
      body: payload,
      // Aidge 同步接口实际耗时常超过 30 秒（官方文档的 30 秒是服务端超时上限），
      // 客户端留 90 秒，避免图片已生成但响应被我们自己掐断、导致白扣额度。
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    const msg = `Aidge 请求超时或网络错误：${String(e)}`;
    await supabase.from("tryon_tasks")
      .update({ status: "failed", error_msg: msg })
      .eq("id", taskId);
    // 超时不回滚权益：图片可能已在服务端生成并计费，避免白用一次
    return json({
      error: "试衣生成超时（Aidge 未在 90 秒内返回）",
      provider: "aidge",
      details: msg,
      task_id: taskId,
    }, 504);
  }

  const rawBody = await res.text();
  let data: Record<string, any> | null = null;
  try {
    data = JSON.parse(rawBody);
  } catch (_) {
    // 非 JSON 响应按失败处理
  }

  if (!res.ok || data?.Success !== true) {
    const msg = data?.Message ?? rawBody;
    console.error("Aidge tryon failed", res.status, rawBody);
    await supabase.from("tryon_tasks")
      .update({ status: "failed", error_msg: String(msg) })
      .eq("id", taskId);
    // 供应商明确拒绝：未产生有效出图，回滚本次权益
    await refundTryonQuota(entitlementId, "aidge_rejected");
    return json({
      error: `试衣生成失败（Aidge 返回 ${res.status}${data?.Code ? ` / ${data.Code}` : ""}）`,
      provider: "aidge",
      details: String(msg).slice(0, 500),
      provider_status: res.status,
      task_id: taskId,
    }, 502);
  }

  const rawUrl = data?.Data?.ImageUrl as string | undefined;
  if (!rawUrl) {
    await supabase.from("tryon_tasks")
      .update({ status: "failed", error_msg: "试衣成功但未返回图片地址" })
      .eq("id", taskId);
    return json({ error: "试衣成功但未返回图片地址", task_id: taskId }, 502);
  }

  const publicUrl = await persistResult(taskId, rawUrl);
  // resolution 记录真实输出尺寸，不再沿用建表时的 720p 默认值
  const width = Number(data?.Data?.ImageWidth ?? 0);
  const height = Number(data?.Data?.ImageHeight ?? 0);
  const resolution = width > 0 && height > 0 ? `${width}x${height}` : "1K";
  const { data: updated } = await supabase.from("tryon_tasks")
    .update({ status: "done", first_frame_url: publicUrl, result_url: publicUrl, resolution })
    .eq("id", taskId)
    .select()
    .single();

  return json({
    task_id: taskId,
    status: "done",
    result_url: publicUrl,
    width: width > 0 ? width : null,
    height: height > 0 ? height : null,
    task: updated,
  });
}

// ---------- Replicate IDM-VTON（保留分支，充值后可切回）----------
async function createReplicateTask(
  taskId: string,
  userPhotoUrl: string,
  garment: { flat_image_url: string; name: string; category: string | null },
  entitlementId: string | null,
) {
  // 注意：不要用 /v1/models/{owner}/{name}/predictions，该模型没有默认版本时会 404；
  // 必须走 /v1/predictions 并显式指定 version。
  const repRes = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
      Prefer: "wait=5",
    },
    body: JSON.stringify({
      version: IDM_VTON_VERSION,
      input: {
        human_img: userPhotoUrl,
        garm_img: garment.flat_image_url,
        garment_des: garment.name,
        category: toIdmCategory(garment.category),
      },
    }),
  });

  if (!repRes.ok) {
    const msg = await repRes.text();
    console.error("Replicate tryon request failed", repRes.status, msg);
    await supabase.from("tryon_tasks")
      .update({ status: "failed", error_msg: msg })
      .eq("id", taskId);
    await refundTryonQuota(entitlementId, "replicate_create_failed");
    return json({
      error: `试衣生成失败（Replicate 返回 ${repRes.status}）`,
      provider: "replicate",
      details: msg.slice(0, 500),
      provider_status: repRes.status,
      task_id: taskId,
    }, 502);
  }

  const prediction = await repRes.json();
  await supabase.from("tryon_tasks")
    .update({ provider_task_id: prediction.id })
    .eq("id", taskId);

  return json({ task_id: taskId, status: "processing" });
}

// ---------- 轮询状态 ----------
async function pollTask(req: Request, url: URL) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "缺少 id" }, 400);

  const { data: task, error } = await supabase
    .from("tryon_tasks")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !task) return json({ error: "任务不存在" }, 404);

  // 归属校验：新任务绑定调用者 uid，只有本人能读；迁移前的历史任务 owner 为空，保持可读
  if (task.owner_user_id) {
    const viewerId = await resolveUserId(req);
    if (viewerId !== task.owner_user_id) {
      return json({ error: "无权访问该任务" }, 403);
    }
  }

  // 已是终态直接返回
  if (task.status !== "pending" && task.status !== "processing") {
    return json(task);
  }
  // 只处理试衣阶段：视频阶段的 provider_task_id 属于 DashScope 视频任务，不能按试衣逻辑轮询
  if (task.stage !== "tryon") return json(task);
  if (!task.provider_task_id) return json(task);

  // 服务端兜底超时，避免供应商卡住时任务永久停留在 processing
  const startedAt = new Date(task.stage_started_at ?? task.created_at).getTime();
  if (Number.isFinite(startedAt) && Date.now() - startedAt > TRYON_TIMEOUT_MS) {
    const { data: updated } = await supabase
      .from("tryon_tasks")
      .update({ status: "timeout", error_msg: "试衣生成超时，请稍后重试" })
      .eq("id", task.id)
      .select()
      .single();
    return json(updated);
  }

  if (task.provider_task_id.startsWith(DASHSCOPE_TASK_PREFIX)) {
    return await pollDashScopeTask(task);
  }
  return await pollReplicateTask(task);
}

// 结果图是临时链接（DashScope 24h / Replicate 有期限），下载后转存到 tryon-results 桶
async function persistResult(taskId: string, rawUrl: string) {
  let publicUrl = rawUrl;
  try {
    const imgRes = await fetch(rawUrl);
    if (!imgRes.ok) throw new Error(`结果图片下载失败（HTTP ${imgRes.status}）`);
    const contentType = imgRes.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error("服务商返回的结果不是图片");
    }
    const imgBuf = await imgRes.arrayBuffer();
    if (imgBuf.byteLength === 0) throw new Error("服务商返回了空图片");
    // 路径首段必须是 owner（无归属的历史/匿名任务写 anon），Storage 删除策略按首段校验
    const { data: task } = await supabase
      .from("tryon_tasks")
      .select("owner_user_id")
      .eq("id", taskId)
      .single();
    const ownerPrefix = task?.owner_user_id ?? "anon";
    const path = `${ownerPrefix}/${taskId}/first_frame.jpg`;
    const { error: upErr } = await supabase.storage
      .from("tryon-results")
      .upload(path, imgBuf, { contentType: "image/jpeg", upsert: true });
    if (!upErr) {
      const { data } = supabase.storage.from("tryon-results").getPublicUrl(path);
      publicUrl = data.publicUrl;
    }
  } catch (error) {
    console.error("tryon result persistence failed", { taskId, error: String(error) });
    // 转存失败就用原链接兜底
  }
  return publicUrl;
}

async function pollDashScopeTask(task: Record<string, any>) {
  const dsTaskId = String(task.provider_task_id).slice(DASHSCOPE_TASK_PREFIX.length);
  const dsRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${dsTaskId}`, {
    headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}` },
  });
  if (!dsRes.ok) return json(task); // 网络抖动，下次轮询再试

  const ds = await dsRes.json();
  const status = ds?.output?.task_status;

  if (status === "SUCCEEDED") {
    const rawUrl = ds?.output?.image_url as string | undefined;
    if (!rawUrl) {
      const { data: failed } = await supabase.from("tryon_tasks")
        .update({ status: "failed", error_msg: "试衣成功但未返回图片地址" })
        .eq("id", task.id).select().single();
      return json(failed);
    }
    const publicUrl = await persistResult(task.id, rawUrl);
    const { data: updated } = await supabase.from("tryon_tasks")
      .update({ status: "done", first_frame_url: publicUrl, result_url: publicUrl })
      .eq("id", task.id).select().single();
    return json(updated);
  }

  if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
    const msg = `${ds?.output?.code ?? status}: ${ds?.output?.message ?? "试衣生成失败"}`;
    const { data: updated } = await supabase.from("tryon_tasks")
      .update({ status: "failed", error_msg: msg })
      .eq("id", task.id).select().single();
    return json(updated);
  }

  // PENDING / PRE-PROCESSING / RUNNING / POST-PROCESSING → 还在跑
  return json(task);
}

async function pollReplicateTask(task: Record<string, any>) {
  const repRes = await fetch(
    `https://api.replicate.com/v1/predictions/${task.provider_task_id}`,
    { headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` } },
  );
  if (!repRes.ok) return json(task); // 网络抖动，下次轮询再试

  const prediction = await repRes.json();

  if (prediction.status === "succeeded") {
    // output 可能是 string 或 string[]
    const rawUrl = Array.isArray(prediction.output)
      ? prediction.output[0]
      : prediction.output;

    // 没有结果地址时不能标 done，否则前端会一直轮询到超时
    if (typeof rawUrl !== "string" || !rawUrl) {
      const { data: failed } = await supabase
        .from("tryon_tasks")
        .update({ status: "failed", error_msg: "试衣成功但未返回图片地址" })
        .eq("id", task.id)
        .select()
        .single();
      return json(failed);
    }

    const publicUrl = await persistResult(task.id, rawUrl);

    const { data: updated } = await supabase
      .from("tryon_tasks")
      .update({
        status: "done",
        first_frame_url: publicUrl,
        result_url: publicUrl, // 图片任务的最终结果即首帧图
      })
      .eq("id", task.id)
      .select()
      .single();
    return json(updated);
  }

  if (prediction.status === "failed" || prediction.status === "canceled") {
    const { data: updated } = await supabase
      .from("tryon_tasks")
      .update({ status: "failed", error_msg: String(prediction.error ?? "试衣生成失败") })
      .eq("id", task.id)
      .select()
      .single();
    return json(updated);
  }

  // starting / processing → 还在跑
  return json(task);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method === "POST") {
      return await createTask(req);
    }
    if (req.method === "GET") return await pollTask(req, new URL(req.url));
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
