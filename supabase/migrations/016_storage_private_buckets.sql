-- 016_storage_private_buckets.sql
--
-- 目标：用户全身照走「私有桶 + 短时签名直链」，不再有永久公开地址。
--
-- 为什么新建 user-media 而不是把 user-photos 直接改私有：
--   * user-photos 桶的**根目录**里还躺着 6 张历史商品平铺图（`garment-N-1536.jpg`），
--     而 Edge Function 会把这些 URL 原样交给 Aidge / 万相 / Replicate 去下载 ——
--     一旦桶变私有，供应商拿不到图，试衣直接坏掉。
--   * 把文件搬到 garments 桶需要 service_role（客户端上传被 RLS 挡住），
--     在没法部署脚本的前提下，最省事、最安全的做法是「新桶私有、老桶先留作素材」。
--
-- 结果：
--   * 新上传的全身照 → `user-media`（public=false，只有本人 + 服务端能读，客户端用签名 URL 显示）。
--   * `user-photos` 保持 public，只当历史素材桶用；等商品图迁到 garments 桶后，
--     可以把 `user-photos` 一并改私有（见 docs/后端优化路线图.md Phase B）。
--   * inspiration-posts / garments / poses 是「本来就要公开」的内容，保持 public。
--
-- 成本：Storage 的 createSignedUrl 不额外收费，也不增加出网流量，
-- 只是把「永久公开直链」换成「1 小时有效的临时直链」。
--
-- 依赖：013（Storage 策略已收口）。本文件可重复执行。

begin;

-- ---------------------------------------------------------------------------
-- 1) 私有桶 user-media（桶级就顺带把大小和类型白名单加上，省掉一次应用层校验）
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-media',
  'user-media',
  false,
  15728640, -- 15 MB：客户端已压到最长边 2049 / jpeg 0.88，正常在 1–3 MB
  -- iOS 相册偶尔给出 HEIC，客户端压缩失败时会原样上传，这里一并放行
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2) 只允许本人读写删：路径首段必须是自己的 uid
-- ---------------------------------------------------------------------------
drop policy if exists "owner read user-media" on storage.objects;
create policy "owner read user-media" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'user-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "owner upload user-media" on storage.objects;
create policy "owner upload user-media" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'user-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- 覆盖写（重传同一路径）也走同一条归属校验
drop policy if exists "owner update user-media" on storage.objects;
create policy "owner update user-media" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'user-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'user-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "owner delete user-media" on storage.objects;
create policy "owner delete user-media" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'user-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

commit;

-- 验证（单独跑，期望 public = false）：
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'user-media';
--   select policyname, cmd from pg_policies where schemaname = 'storage' and tablename = 'objects'
--    and policyname like '%user-media%';
