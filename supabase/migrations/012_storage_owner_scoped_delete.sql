-- ============================================
-- 012_storage_owner_scoped_delete.sql
-- Storage 删除权限收口（不改 001–011 已有内容）：
--   1) user-photos：上传/删除都要求 `<auth.uid()>/...` 路径前缀，仅本人可操作
--   2) tryon-results：删除要求 `<auth.uid()>/...` 前缀，仅本人可删
--   3) user-photos 桶补大小与 MIME 限制
--
-- 路径约定：
--   新对象：<owner_uid>/<task_id>/first_frame.jpg
--           <owner_uid>/<task_id>/result.mp4
--           <owner_uid>/<timestamp>-<random>.<ext>
--   无归属的历史/匿名任务写入 `anon/...`，客户端不尝试删除（避免 403），
--   需要清理时用 service_role 脚本；`anon` 前缀不对任何客户端开放删除。
-- ============================================

-- ---------- 1. user-photos 桶限制 ----------
update storage.buckets
set file_size_limit = 20971520, -- 20 MB
    allowed_mime_types = array[
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/heic',
      'image/heif'
    ]
where id = 'user-photos';

-- ---------- 2. 关闭旧的宽泛策略 ----------
drop policy if exists "anon upload user-photos" on storage.objects;
drop policy if exists "anon delete user-photos" on storage.objects;
drop policy if exists "anon delete tryon-results" on storage.objects;

-- ---------- 3. user-photos：仅本人可上传/删除 ----------
drop policy if exists "owner upload user-photos" on storage.objects;
create policy "owner upload user-photos" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'user-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "owner delete user-photos" on storage.objects;
create policy "owner delete user-photos" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'user-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ---------- 4. tryon-results：仅本人可删除 ----------
-- 写入仍由 Edge Function 的 service_role 完成（service_role 绕过 RLS）
drop policy if exists "owner delete tryon-results" on storage.objects;
create policy "owner delete tryon-results" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'tryon-results'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
