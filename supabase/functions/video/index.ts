// supabase/functions/video/index.ts
// 视频 Edge Function：
//   POST /video        基于已有首帧图创建图生视频任务（通义万相 wan2.6-i2v-flash）
//   GET  /video?id=xx  前端每 5 秒轮询；超过 30 分钟才标记 timeout（实测排队可达 25 分钟）
//
// 状态值统一：pending / processing / done / failed / timeout

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id",
};

const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY")!;
// 规则：视频最多等 30 分钟。原先写 10 分钟，但实测万相排队能到 25 分钟，
// 结果是「视频其实已经生成好了，却在第 10 分钟被服务端判成 timeout」——白花一次钱。
// 客户端 `MAX_VIDEO_WAIT_MS` 也是 30 分钟，两边必须一致。
const VIDEO_TIMEOUT_MS = 30 * 60 * 1000;

// tryon-results 一旦改成私有桶，万相就拿不到首帧图的公开直链了。
// 供应商是「无鉴权 GET」取图的，所以这里用 service_role 现签一个 1 小时直链给它；
// 公开桶保持原样，不额外发签名请求。
const PRIVATE_BUCKETS = new Set(["tryon-results", "user-media", "user-photos"]);

function parseStoragePath(url: string): { bucket: string; path: string } | null {
  const match = url.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/);
  if (!match) return null;
  return { bucket: match[1], path: decodeURIComponent(match[2]) };
}

async function toFetchableUrl(url: string): Promise<string> {
  const ref = parseStoragePath(url);
  if (!ref || !PRIVATE_BUCKETS.has(ref.bucket)) return url;
  const { data, error } = await supabase.storage.from(ref.bucket).createSignedUrl(ref.path, 3600);
  if (error || !data?.signedUrl) return url; // 签不出来就退回原地址：公开桶依然能下载
  return data.signedUrl;
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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

// ---------- 创建视频任务 ----------
async function createVideo(req: Request) {
  // task_id：已完成的试衣任务；pose_id 可选；duration 秒
  let body: {
    task_id?: string;
    pose_id?: string;
    duration?: number;
    show_back?: boolean;
    /** 背景预设：keep（保持原背景，默认）/ studio-white / studio-gray / street / cafe / seaside */
    background?: string;
    /** 分辨率：480P 更快更便宜，720P 是默认 */
    resolution?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "请求体不是合法的 JSON" }, 400);
  }
  const { task_id, pose_id, duration = 5 } = body ?? {};
  if (!task_id) return json({ error: "task_id 必填" }, 400);
  const durationSec = Number(duration);
  if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 10) {
    return json({ error: "duration 只支持 1-10 秒的整数" }, 400);
  }

  const { data: task, error } = await supabase
    .from("tryon_tasks")
    .select("*")
    .eq("id", task_id)
    .single();
  if (error || !task) return json({ error: "任务不存在" }, 404);
  // 归属校验：知道 task_id 不能替别人发起视频生成（历史任务 owner 为空，保持兼容）
  if (task.owner_user_id) {
    const viewerId = await resolveUserId(req);
    if (viewerId !== task.owner_user_id) {
      return json({ error: "无权操作该任务" }, 403);
    }
  }
  if (!task.first_frame_url) return json({ error: "首帧图尚未生成" }, 400);
  // 同一任务正在生成视频时拒绝重复提交，避免覆盖 provider_task_id、让前一个收费任务失联
  if (task.stage === "video" && task.status === "processing") {
    return json({ error: "该任务的视频正在生成中，请勿重复提交", task_id }, 409);
  }

  // 限流计次：参数与任务校验都通过、即将提交供应商任务时才扣额度。
  // 非法 JSON / 缺 task_id / 任务不存在 / 无首帧 / 重复提交都不消耗次数。
  const limited = await enforceRateLimits(req, "video", { device: 2, ip: 6, ipWithoutDevice: 2 });
  if (limited) return limited;

  // 图生视频的提示词公式是「运动 + 运镜 + 背景 + 保真约束」四段。
  // 只写一句静态描述（"模特自然展示服装"），模型会几乎不动 —— 画面看着僵硬。
  //
  // 关于「看到背面」：真机模特展示最需要的是背面（后中缝、领口、下摆），但让模型
  // 「转过去再转回来」等于两次大幅度重绘，脸最容易崩。所以这里设计成**单向转身**：
  // 正面微动 → 侧身 → 转到背对镜头并停住，结尾正好定格在背面。既满足看背面，
  // 又让最容易崩的脸在最后 1/3 时间里根本不在画面里，还省了回程的时间（不用把
  // duration 从 5 秒拉到 10 秒），成本不变。
  // 背景预设。
  // 注意：换背景等于让模型重绘整个画面，是最容易把人和衣服带崩的操作，
  // 所以每个预设都强制附带「人物与服装保持输入帧不变」的约束；
  // 如果实测崩得厉害，就把默认值保持为 keep（只锁原背景）。
  const BACKGROUND_PRESETS: Record<string, string> = {
    keep: "",
    "studio-white": "a seamless pure-white studio backdrop with a soft floor shadow",
    "studio-gray": "a seamless light-gray studio backdrop with soft directional light and a gentle floor shadow",
    street: "a quiet city sidewalk with soft daylight, distant blurred buildings, shallow depth of field",
    cafe: "a warm cafe interior with blurred wooden shelves and soft window light, shallow depth of field",
    seaside: "a seaside boardwalk with soft golden-hour light and a blurred horizon, shallow depth of field",
  };

  // 姿势自带的描述里通常已经写了动作，甚至写了镜头；如果原样拼上去，会和下面通用的动作段/运镜段
  // 互相打架（典型症状：视频原地摇晃或动作半途卡住）。所以：
  //   1) 有姿势时，动作段只补一句「结尾转身」的收尾指令，不再追加通用动作；
  //   2) 姿势描述里的 Camera 句子一律剥掉，运镜只由我们统一控制。
  const stripCamera = (text: string) => text.replace(/Camera[^.]*\.\s*/gi, "").replace(/\s+/g, " ").trim();

  const buildMotionPrompt = (poseDesc: string, seconds: number, showBack: boolean, backgroundKey: string) => {
    const hasPose = poseDesc.length > 0;

    const fullMotion = [
      "The model starts facing the camera, shifts her weight and takes two unhurried steps forward, ",
      "letting the fabric settle, then turns slowly in one continuous motion to one side until she ",
      "faces away from the camera, and holds that back view still in the final second so the back of ",
      "the garment is clearly visible.",
    ].join("");

    const turnOnly =
      "End the clip with the model turned away from the camera so the back of the garment is clearly " +
      "visible, and hold that back view still for the final second.";

    const stayFacing =
      "The model stays facing the camera, shifts her weight and takes one slow step forward, " +
      "letting the fabric settle, then relaxes her shoulders and holds the pose.";

    const motion = hasPose ? (showBack ? turnOnly : "") : showBack ? fullMotion : stayFacing;

    const camera =
      seconds >= 8
        ? "Camera: slow dolly-in with a gentle lateral arc, eye level, constant speed, no cut, no shake, no zoom jump."
        : "Camera: very slow push-in with subtle lateral parallax, eye level, constant speed, no cut, no shake.";

    const preset = BACKGROUND_PRESETS[backgroundKey] ?? "";
    const background = preset
      ? [
          `Background: replace the background with ${preset}, keeping the person's lighting consistent with the new scene. `,
          "The person and the garment must remain pixel-faithful to the input frame — only the surroundings change.",
        ].join("")
      : [
          "Background: keep the exact same seamless studio backdrop, floor and lighting as the input frame; ",
          "only a soft light sweep across the backdrop is allowed, no scene change, no new objects, no people.",
        ].join("");

    const fidelity =
      "Fidelity lock: the person's face, hair, skin tone, body proportions and the garment's color, print, " +
      "fabric texture and silhouette must stay identical to the input frame at every moment; hands stay " +
      "relaxed and simple, natural cloth physics only.";

    const guard =
      "No extra limbs, no warped or melted fabric, no duplicate person, no morphing of the face, no text, no watermark.";

    return [poseDesc.trim(), motion, camera, background, fidelity, guard].join(" ");
  };

  let baseMotion = task.text_intent ?? "The model stands facing the camera and slowly shifts her weight.";
  if (pose_id) {
    const { data: pose } = await supabase
      .from("poses")
      .select("pose_desc, name")
      .eq("id", pose_id)
      .single();
    if (pose) baseMotion = stripCamera(pose.pose_desc || pose.name || "");
  }
  // 5 秒也足够走完「正面 → 侧身 → 背对」这条单向动线，所以默认就带转身
  const showBack = body.show_back !== false;
  const backgroundKey = typeof body.background === "string" && body.background in BACKGROUND_PRESETS
    ? body.background
    : "keep";
  const prompt = buildMotionPrompt(baseMotion, durationSec, showBack, backgroundKey);

  const firstFrameUrl = await toFetchableUrl(task.first_frame_url);

  // 调通义万相图生视频（异步模式）
  const dsRes = await fetch(
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
        "X-DashScope-Async": "enable",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "wan2.6-i2v-flash",
        input: {
          img_url: firstFrameUrl,
          prompt,
        },
        parameters: {
          resolution: body.resolution === "480P" ? "480P" : "720P",
          duration: durationSec,
        },
      }),
    },
  );

  if (!dsRes.ok) {
    const msg = await dsRes.text();
    await supabase.from("tryon_tasks")
      .update({ status: "failed", error_msg: msg })
      .eq("id", task_id);
    return json({ error: "视频生成失败，请重试", task_id }, 502);
  }

  const dsData = await dsRes.json();
  const providerTaskId = dsData?.output?.task_id;
  if (!providerTaskId) {
    await supabase.from("tryon_tasks")
      .update({ status: "failed", error_msg: "未拿到视频任务ID" })
      .eq("id", task_id);
    return json({ error: "视频生成失败，请重试", task_id }, 502);
  }

  // 更新原任务进入视频阶段（不新建行，保持一条任务记录贯穿两个阶段）
  await supabase.from("tryon_tasks")
    .update({
      pose_id: pose_id ?? null,
      output_type: "video",
      duration: durationSec,
      stage: "video",
      status: "processing",
      resolution: "720p",
      provider_task_id: providerTaskId,
      stage_started_at: new Date().toISOString(),
    })
    .eq("id", task_id);

  return json({ task_id, status: "processing" });
}

// ---------- 轮询视频状态 ----------
async function pollVideo(req: Request, url: URL) {
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

  // 只处理视频阶段的任务：试衣阶段的任务不能被 /video 轮询改写状态或套用视频超时
  if (task.stage !== "video") return json(task);

  if (task.status !== "pending" && task.status !== "processing") {
    return json(task);
  }

  const elapsed = Date.now() - new Date(task.stage_started_at).getTime();

  // 收尾函数：超时才允许写 timeout，且只在这一轮确认「供应商没给结果」之后调用。
  const markTimeout = async () => {
    const { data: updated } = await supabase
      .from("tryon_tasks")
      .update({ status: "timeout", error_msg: "视频生成超时，请稍后重试" })
      .eq("id", task.id)
      .select()
      .single();
    return json(updated);
  };

  if (!task.provider_task_id) {
    // 连供应商 id 都没有，只能按时间收尾
    if (elapsed > VIDEO_TIMEOUT_MS) return await markTimeout();
    return json(task);
  }

  // 查 DashScope 任务
  const dsRes = await fetch(
    `https://dashscope.aliyuncs.com/api/v1/tasks/${task.provider_task_id}`,
    { headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}` } },
  );
  if (!dsRes.ok) {
    // 抖动时下次再试；但已经等过头了就收尾，避免任务永远挂着
    if (elapsed > VIDEO_TIMEOUT_MS) return await markTimeout();
    return json(task);
  }

  const dsData = await dsRes.json();
  const dsStatus = dsData?.output?.task_status;

  if (dsStatus === "SUCCEEDED") {
    const rawUrl = dsData.output.video_url as string | undefined;
    if (!rawUrl) {
      const { data: failed } = await supabase
        .from("tryon_tasks")
        .update({ status: "failed", error_msg: "视频生成成功但未返回视频地址" })
        .eq("id", task.id)
        .select()
        .single();
      return json(failed);
    }

    // 转存视频到 tryon-results 桶
    let publicUrl = rawUrl;
    try {
      const vRes = await fetch(rawUrl);
      if (!vRes.ok) throw new Error(`视频下载失败（HTTP ${vRes.status}）`);
      const contentType = (vRes.headers.get("content-type") ?? "").toLowerCase();
      const vBuf = await vRes.arrayBuffer();
      if (vBuf.byteLength === 0) throw new Error("服务商返回了空视频");
      // 双重校验：content-type 必须是 video/*；octet-stream 时用 MP4/WebM 魔数兜底，
      // 避免把 JSON/HTML 报错体当 mp4 存进桶里
      const isVideoType = contentType.startsWith("video/");
      const head = new Uint8Array(vBuf.slice(0, 16));
      const isMp4 = head.length >= 8 && new TextDecoder().decode(head.slice(4, 8)) === "ftyp";
      const isWebm = head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
      if (!isVideoType && !isMp4 && !isWebm) {
        throw new Error(`服务商返回的内容不是视频（content-type=${contentType || "(空)"}）`);
      }
      // 路径首段必须是 task_id —— 018 的 owner read/delete 策略是拿首段去 join tryon_tasks.id 的，
      // 这里若改成 `${uid}/...` 客户端就签不出地址、播放会 400
      const path = `${task.id}/result.mp4`;
      const { error: upErr } = await supabase.storage
        .from("tryon-results")
        .upload(path, vBuf, { contentType: "video/mp4", upsert: true });
      if (upErr) {
        // 内容已校验为视频，只是转存失败：退回供应商临时链
        console.error("video upload failed", { taskId: task.id, message: upErr.message });
      } else {
        const { data } = supabase.storage.from("tryon-results").getPublicUrl(path);
        publicUrl = data.publicUrl;
      }
    } catch (e) {
      // 校验失败不能标 done：保持 processing 让下次轮询重试，持续失败会在 10 分钟处转 timeout
      console.error("video result validation failed", { taskId: task.id, error: String(e) });
      return json(task);
    }

    const { data: updated } = await supabase
      .from("tryon_tasks")
      .update({ status: "done", result_url: publicUrl })
      .eq("id", task.id)
      .select()
      .single();
    return json(updated);
  }

  if (dsStatus === "FAILED" || dsStatus === "UNKNOWN") {
    const { data: updated } = await supabase
      .from("tryon_tasks")
      .update({ status: "failed", error_msg: "视频生成失败，请重试" })
      .eq("id", task.id)
      .select()
      .single();
    return json(updated);
  }

  // PENDING / RUNNING：只有真的一直没出来、且超过上限才收尾
  if (elapsed > VIDEO_TIMEOUT_MS) return await markTimeout();
  return json(task);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method === "POST") {
      return await createVideo(req);
    }
    if (req.method === "GET") return await pollVideo(req, new URL(req.url));
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
