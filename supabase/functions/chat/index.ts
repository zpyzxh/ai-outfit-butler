import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id",
};

const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY");
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const MODEL = "qwen-plus";
const SYSTEM_PROMPT = `你是 AI 穿搭管家，一位友好、务实的中文穿搭顾问。根据用户提供的场景、天气、偏好和衣物给出具体、容易执行的搭配建议。优先说明单品、颜色、版型和鞋包配饰组合；信息不足时先问一两个关键问题。尊重不同身材与风格，不评价或羞辱外貌，不虚构用户衣橱里没有的衣服。回答简洁，通常不超过 180 字。`;

type ChatMessage = { role: "user" | "assistant"; content: string };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------- 频次限制 ----------
// 与 tryon / video 同一套两层配额：设备维度为主，IP 仅兜底。
// qwen-plus 按 token 计费，公网可直刷，因此必须在调供应商前拦截。

const RATE_WINDOW_SECONDS = 600;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

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
      return json({ error: "问答请求过于频繁，请稍后再试" }, 429);
    }
  }

  if (!hasDeviceId) {
    const strictIpHash = await sha256(getClientIp(req));
    const strictResult = await consumeQuota(`${name}:ip-strict:${strictIpHash}`, limits.ipWithoutDevice);
    if (strictResult === "error") return json({ error: "频次限制服务暂不可用，请稍后重试" }, 503);
    if (strictResult === "limited") {
      console.warn("rate limited", { fn: name, scope: "ip-strict", token: strictIpHash.slice(0, 8) });
      return json({ error: "问答请求过于频繁，请稍后再试" }, 429);
    }
    return null;
  }

  const ipHash = await sha256(getClientIp(req));
  const ipResult = await consumeQuota(`${name}:ip:${ipHash}`, limits.ip);
  if (ipResult === "error") return json({ error: "频次限制服务暂不可用，请稍后重试" }, 503);
  if (ipResult === "limited") {
    console.warn("rate limited", { fn: name, scope: "ip", token: ipHash.slice(0, 8) });
    return json({ error: "问答请求过于频繁，请稍后再试" }, 429);
  }
  return null;
}

async function respond(req: Request) {
  if (!DASHSCOPE_API_KEY) return json({ error: "穿搭问答服务尚未配置，请设置 DashScope 密钥" }, 503);
  const body = await req.json().catch(() => null);
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 12) {
    return json({ error: "对话内容无效，请重试" }, 400);
  }

  const cleanMessages: ChatMessage[] = [];
  for (const message of messages) {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      return json({ error: "对话内容格式无效" }, 400);
    }
    const content = message.content.trim();
    if (!content || content.length > 2000) return json({ error: "每条消息请控制在 2000 字以内" }, 400);
    cleanMessages.push({ role: message.role, content });
  }
  if (cleanMessages[cleanMessages.length - 1]?.role !== "user") {
    return json({ error: "请先发送一个问题" }, 400);
  }

  // 参数校验通过后才计次：无效对话不消耗额度
  const limited = await enforceRateLimits(req, "chat", { device: 30, ip: 60, ipWithoutDevice: 15 });
  if (limited) return limited;

  const response = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...cleanMessages],
      temperature: 0.7,
      max_tokens: 600,
    }),
  });

  if (!response.ok) {
    const providerMessage = await response.text();
    console.error("DashScope chat request failed:", response.status, providerMessage.slice(0, 500));
    return json({ error: "暂时无法生成建议，请稍后重试" }, 502);
  }
  const result = await response.json();
  const reply = result?.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || !reply.trim()) return json({ error: "暂时没有收到有效回复，请重试" }, 502);
  return json({ reply: reply.trim() });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    return await respond(req);
  } catch (error) {
    console.error("Chat function error:", error);
    return json({ error: "问答服务暂时不可用，请稍后重试" }, 500);
  }
});
