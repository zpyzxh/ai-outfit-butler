import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * 把「视频最后一帧」存成单品的背面图。
 *
 * 为什么需要这个函数：`garments` 表的写入策略只给 admin（`public.is_admin()`），
 * 普通用户没法直接把 back_image_url 写进去；`garments` 桶的写入也只给 admin。
 * 所以由这个函数用 service_role 代劳，但对外只暴露「给自己没有背面图的单品补一张」，
 * 不允许覆盖已有背面图（避免任何人把别人的商品图换掉）。
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BUCKET = "garments";
const MAX_BYTES = 3 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 防止被刷：一台设备一小时最多补 12 张（正常情况下一个人不会有这么多单品）
const RATE_WINDOW_SECONDS = 3600;
const RATE_LIMIT = 12;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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

async function enforceRateLimit(req: Request) {
  const deviceId = req.headers.get("x-device-id")?.trim() ?? "";
  const key = DEVICE_ID_PATTERN.test(deviceId)
    ? `garment-back:dev:${await sha256(deviceId)}`
    : `garment-back:ip:${await sha256(getClientIp(req))}`;
  const { data, error } = await supabase.rpc("consume_edge_rate_limit", {
    p_rate_key: key,
    p_limit: RATE_LIMIT,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (error) {
    console.error("rate limit rpc failed", error.message);
    return json({ error: "频次限制服务暂不可用，请稍后重试" }, 503);
  }
  if (!data) return json({ error: "操作过于频繁，请稍后再试" }, 429);
  return null;
}

async function resolveUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error) return null;
  return data.user?.id ?? null;
}

function decodeBase64(input: string): Uint8Array | null {
  try {
    const binary = atob(input);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function handle(req: Request) {
  const limited = await enforceRateLimit(req);
  if (limited) return limited;

  const userId = await resolveUserId(req);
  if (!userId) return json({ error: "请先进入 App 再试（缺少有效会话）", code: "NO_SESSION" }, 401);

  const body = await req.json().catch(() => null);
  const garmentId = typeof body?.garment_id === "string" ? body.garment_id.trim() : "";
  const imageBase64 = typeof body?.image_base64 === "string" ? body.image_base64.trim() : "";
  const mime = typeof body?.mime === "string" ? body.mime.trim().toLowerCase() : "image/jpeg";

  if (!UUID_PATTERN.test(garmentId)) return json({ error: "单品 ID 无效" }, 400);
  const ext = MIME_EXT[mime];
  if (!ext) return json({ error: "只支持 JPG / PNG / WebP" }, 400);
  if (!imageBase64) return json({ error: "缺少图片数据" }, 400);

  const bytes = decodeBase64(imageBase64.replace(/^data:[^;]+;base64,/, ""));
  if (!bytes) return json({ error: "图片数据损坏，请重试" }, 400);
  if (bytes.byteLength > MAX_BYTES) {
    return json({ error: "图片超过 3MB，请压缩后重试" }, 413);
  }

  const { data: garment, error: gErr } = await supabase
    .from("garments")
    .select("id, name, back_image_url, archived_at")
    .eq("id", garmentId)
    .maybeSingle();
  if (gErr) {
    console.error("garment lookup failed", gErr.message);
    return json({ error: "查询单品失败，请稍后重试" }, 500);
  }
  if (!garment) return json({ error: "单品不存在", code: "NOT_FOUND" }, 404);
  if (garment.archived_at) return json({ error: "这件单品已下架", code: "ARCHIVED" }, 409);
  if (garment.back_image_url) {
    // 已有背面图时不允许覆盖：任何登录用户都能改商品图会造成串改风险。
    return json(
      { error: "这件单品已经有背面图了，如需更换请在素材管理里操作", code: "ALREADY_HAS_BACK" },
      409,
    );
  }

  const path = `${garmentId}/back-${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: mime,
    upsert: false,
  });
  if (uploadError) {
    console.error("back image upload failed", uploadError.message);
    return json({ error: "保存背面图失败，请稍后重试", code: "UPLOAD_FAILED", detail: uploadError.message }, 500);
  }

  const { data: publicUrl } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const backImageUrl = publicUrl.publicUrl;

  const { error: updateError } = await supabase
    .from("garments")
    .update({ back_image_url: backImageUrl })
    .eq("id", garmentId)
    // 只在仍为空时写入，等价于一个 CAS，避免并发覆盖
    .is("back_image_url", null);
  if (updateError) {
    console.error("back image update failed", updateError.message);
    await supabase.storage.from(BUCKET).remove([path]);
    return json({ error: "保存背面图失败，请稍后重试", code: "UPDATE_FAILED", detail: updateError.message }, 500);
  }

  return json({ garment_id: garmentId, back_image_url: backImageUrl, name: garment.name });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "只支持 POST" }, 405);
  try {
    return await handle(req);
  } catch (error) {
    console.error("garment-back unhandled", error instanceof Error ? error.message : String(error));
    return json({ error: "服务异常，请稍后重试" }, 500);
  }
});
