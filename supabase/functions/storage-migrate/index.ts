// 一次性迁移函数：把 user-photos 里的用户全身照搬到私有桶 user-media
//
// 为什么需要它：user-photos 至今是公开桶（里面的 6 张商品平铺图必须让供应商公开下载），
// 但同一桶里还躺着启用匿名登录之前上传的历史全身照。搬文件需要跨桶写权限，
// 客户端（anon / authenticated）没有，所以用 service_role 的一次性函数来做。
//
// 用法（部署后调用一次，随后立刻删除本函数）：
//   POST /functions/v1/storage-migrate   body: { "confirm": "MIGRATE-USERPHOTOS-2026-11-17", "dry": true }
//   把 dry 改成 false 才真正搬。
//
// 安全设计：
//   - confirm 必须与源码里的常量逐字一致，不知道常量的人无法触发；
//   - dry 默认 true，误调用只会返回「会做什么」；
//   - 只处理首段是 UUID 的对象（即 <uid>/<file>），根目录的 garment-*.jpg 一律跳过；
//   - 只有「确认库里已没有任何记录引用旧地址」时才删源文件，删不掉不算失败。

import { createClient } from "jsr:@supabase/supabase-js@2";

const CONFIRM_TOKEN = "MIGRATE-USERPHOTOS-2026-11-17";
const SOURCE_BUCKET = "user-photos";
const TARGET_BUCKET = "user-media";
const MAX_DEPTH = 3;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function publicUrlOf(bucket: string, path: string) {
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}

function guessContentType(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  return "image/jpeg";
}

/** 递归列出一个桶里的所有对象路径 */
async function walk(bucket: string, prefix = "", depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const out: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`列出 ${bucket}/${prefix || "(根)"} 失败：${error.message}`);
    if (!data || data.length === 0) break;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // 目录的 id 为 null，需要继续下钻
      if (entry.id === null) out.push(...(await walk(bucket, path, depth + 1)));
      else out.push(path);
    }
    if (data.length < 100) break;
    offset += 100;
  }
  return out;
}

async function countReferences(url: string) {
  const { count, error } = await supabase
    .from("tryon_tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_photo_url", url);
  if (error) throw new Error(`统计引用失败：${error.message}`);
  return count ?? 0;
}

async function handle(body: Record<string, unknown>) {
  if (String(body.confirm ?? "") !== CONFIRM_TOKEN) {
    return json({ error: "confirm 不匹配，拒绝执行" }, 403);
  }
  const dryRun = body.dry !== false; // 默认只做演练

  // 只跳过商品平铺图（根目录 garment-*.jpg）；其余一律当作用户照片候选，
  // 由「库里有没有记录引用它」来兜底判断，避免历史目录结构不规范时漏搬。
  const isGarmentAsset = (path: string) => path.split("/").pop()?.toLowerCase().startsWith("garment-") ?? false;
  const allFiles = await walk(SOURCE_BUCKET);
  const candidates = allFiles.filter((path) => !isGarmentAsset(path));
  const skipped = allFiles.filter(isGarmentAsset);

  const report = {
    dryRun,
    sourceBucket: SOURCE_BUCKET,
    targetBucket: TARGET_BUCKET,
    scanned: allFiles.length,
    candidates: candidates.length,
    skipped: skipped.length,
    skippedSamples: skipped.slice(0, 10),
    migrated: 0,
    updatedRows: 0,
    removedObjects: 0,
    failures: [] as { path: string; reason: string }[],
    samples: [] as { path: string; rows: number }[],
    // 演练时把完整候选列表带出来，方便人工确认没有误搬别的资源
    candidateList: dryRun ? candidates.slice(0, 50) : undefined,
  };

  for (const path of candidates) {
    const oldUrl = publicUrlOf(SOURCE_BUCKET, path);
    const newUrl = publicUrlOf(TARGET_BUCKET, path);

    const refs = await countReferences(oldUrl);
    if (report.samples.length < 5) report.samples.push({ path, rows: refs });
    if (refs === 0) {
      report.failures.push({ path, reason: "库里没有记录引用它，跳过（避免删掉别处仍在用的图）" });
      continue;
    }
    if (dryRun) {
      report.migrated += 1;
      report.updatedRows += refs;
      continue;
    }

    try {
      // 1) 复制到私有桶（已存在则视为成功，方便重跑）
      const { data: blob, error: dlErr } = await supabase.storage.from(SOURCE_BUCKET).download(path);
      if (dlErr || !blob) throw new Error(`下载失败：${dlErr?.message ?? "空文件"}`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error("下载到的文件是空的");

      const { error: upErr } = await supabase.storage
        .from(TARGET_BUCKET)
        .upload(path, bytes, { contentType: guessContentType(path), upsert: true });
      if (upErr) throw new Error(`上传失败：${upErr.message}`);

      // 2) 把库里所有引用旧地址的记录改到新地址
      const { data: updated, error: updErr } = await supabase
        .from("tryon_tasks")
        .update({ user_photo_url: newUrl })
        .eq("user_photo_url", oldUrl)
        .select("id");
      if (updErr) throw new Error(`更新记录失败：${updErr.message}`);
      report.updatedRows += updated?.length ?? 0;
      report.migrated += 1;

      // 3) 确认没人再引用旧地址，才删源对象
      const stillReferenced = await countReferences(oldUrl);
      if (stillReferenced > 0) {
        report.failures.push({ path, reason: `还有 ${stillReferenced} 条记录指向旧地址，保留源文件` });
        continue;
      }
      const { error: rmErr } = await supabase.storage.from(SOURCE_BUCKET).remove([path]);
      if (rmErr) {
        report.failures.push({ path, reason: `删除源文件失败（不影响使用）：${rmErr.message}` });
      } else {
        report.removedObjects += 1;
      }
    } catch (e) {
      report.failures.push({ path, reason: String(e instanceof Error ? e.message : e) });
    }
  }

  return json(report);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    return await handle(body as Record<string, unknown>);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
