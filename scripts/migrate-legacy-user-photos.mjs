#!/usr/bin/env node
/**
 * 把历史的全身照从公开桶 user-photos 迁到私有桶 user-media。
 *
 * 背景：2026-11-16 起新上传的照片都进私有桶（见 supabase/migrations/016_*.sql），
 * 但更早的试穿记录里 user_photo_url 仍指向公开桶。这个脚本负责收尾：
 *   1. 列出 user-photos 里所有 `<uid>/...` 的对象（桶根目录的 garment-*.jpg 是商品图，跳过）；
 *   2. 下载 → 上传到 user-media 同一路径；
 *   3. 把 tryon_tasks 里指向旧地址的行改写成新地址；
 *   4. 确认没有行再引用旧对象后，才删除旧对象。
 *
 * 为什么必须用 service_role：这两步都要跨用户读写 Storage 并改 tryon_tasks，
 * 013 之后客户端已经拿不到这些权限了。
 *
 * 用法：
 *   $env:SUPABASE_URL="https://xxxx.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="eyJ..."
 *   node scripts/migrate-legacy-user-photos.mjs --dry-run   # 只打印计划，不动数据
 *   node scripts/migrate-legacy-user-photos.mjs             # 真正执行
 *
 * 可重复执行：已经在新桶里的对象会被跳过，已改写的行不会被再改。
 */

import { createClient } from '@supabase/supabase-js';

const SOURCE_BUCKET = 'user-photos';
const TARGET_BUCKET = 'user-media';
const DRY_RUN = process.argv.includes('--dry-run');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

/** 递归列出某个「目录」下的所有对象（Storage 的 list 不是递归的）。 */
async function listAll(bucket, prefix = '') {
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(`列出 ${bucket}/${prefix} 失败：${error.message}`);
  const files = [];
  for (const entry of data ?? []) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) {
      files.push(...(await listAll(bucket, path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

function isLegacyGarmentAsset(path) {
  // 桶根目录的商品平铺图，供应商还要直接下载，必须留在公开桶
  return !path.includes('/') && /^garment-.*\.(jpe?g|png|webp)$/i.test(path);
}

async function main() {
  console.log(`==> ${DRY_RUN ? '[dry-run] ' : ''}迁移 ${SOURCE_BUCKET} → ${TARGET_BUCKET}`);

  const all = await listAll(SOURCE_BUCKET);
  const userPhotos = all.filter((path) => !isLegacyGarmentAsset(path));
  console.log(`共 ${all.length} 个对象，其中用户照片 ${userPhotos.length} 个，商品素材 ${all.length - userPhotos.length} 个（保留）`);

  let moved = 0;
  let rows = 0;
  let skipped = 0;
  const failures = [];

  for (const path of userPhotos) {
    const oldUrl = supabase.storage.from(SOURCE_BUCKET).getPublicUrl(path).data.publicUrl;
    const newUrl = supabase.storage.from(TARGET_BUCKET).getPublicUrl(path).data.publicUrl;

    const { data: referenced, error: refError } = await supabase
      .from('tryon_tasks')
      .select('id')
      .eq('user_photo_url', oldUrl);
    if (refError) {
      failures.push({ path, step: 'query', message: refError.message });
      continue;
    }
    if (!referenced?.length) {
      skipped += 1;
      continue;
    }

    if (DRY_RUN) {
      console.log(`[dry-run] 迁移 ${path}（${referenced.length} 行引用）`);
      moved += 1;
      rows += referenced.length;
      continue;
    }

    const download = await supabase.storage.from(SOURCE_BUCKET).download(path);
    if (download.error || !download.data) {
      failures.push({ path, step: 'download', message: download.error?.message ?? '空文件' });
      continue;
    }
    const upload = await supabase.storage.from(TARGET_BUCKET).upload(path, download.data, {
      contentType: download.data.type || 'image/jpeg',
      upsert: true,
    });
    if (upload.error) {
      failures.push({ path, step: 'upload', message: upload.error.message });
      continue;
    }

    const patch = await supabase.from('tryon_tasks').update({ user_photo_url: newUrl }).eq('user_photo_url', oldUrl);
    if (patch.error) {
      failures.push({ path, step: 'update-row', message: patch.error.message });
      continue;
    }

    // 只有确认再也没有行引用旧地址，才删旧对象，避免「记录还在、图没了」
    const { data: stillUsed } = await supabase.from('tryon_tasks').select('id').eq('user_photo_url', oldUrl).limit(1);
    if (!stillUsed?.length) {
      const removed = await supabase.storage.from(SOURCE_BUCKET).remove([path]);
      if (removed.error) failures.push({ path, step: 'remove-old', message: removed.error.message });
    }

    moved += 1;
    rows += referenced.length;
  }

  console.log(`\n迁移对象 ${moved} 个，改写记录 ${rows} 行，跳过 ${skipped} 个（无引用）`);
  if (failures.length) {
    console.log(`\n失败 ${failures.length} 项：`);
    for (const item of failures) console.log(`  - ${item.path} [${item.step}] ${item.message}`);
    process.exitCode = 1;
  } else {
    console.log('\n全部完成。可以接着把 user-photos 也设为私有：');
    console.log("  update storage.buckets set public = false where id = 'user-photos';");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
