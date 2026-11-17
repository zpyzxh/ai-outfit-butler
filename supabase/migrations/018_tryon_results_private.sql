-- 018_tryon_results_private.sql
--
-- ⚠️ 执行顺序（很重要）：
--   1) 先部署 `supabase/functions/video/index.ts` 的新版本
--      （它会在首帧图位于私有桶时用 service_role 现签 1 小时直链给万相）；
--   2) 再执行本文件。
--   顺序反了会让「图生视频」直接失败：万相拿不到首帧图就会 400。
--
-- 为什么把 tryon-results 也收私有：
--   结果图里有用户的真实身形（试衣就是「你的身体 + 这件衣服」），
--   公开直链等于任何人都能按 task_id 猜到并下载。收私有后只剩本人可读，
--   客户端用 createSignedUrl 换 1 小时临时直链显示。
--
-- 历史兼容：014 之后的 17 条老记录 owner_user_id 为空，
-- 策略里对「owner 为空」也放行，否则这些历史会全部变成裂图。

begin;

update storage.buckets
   set public = false
 where id = 'tryon-results';

-- 先清掉可能存在的宽松读策略（001/012 时代的遗留），否则「任一策略通过即放行」会架空下面这条
drop policy if exists "public read tryon-results" on storage.objects;
drop policy if exists "read tryon-results" on storage.objects;
drop policy if exists "authenticated read tryon-results" on storage.objects;

drop policy if exists "owner read tryon-results" on storage.objects;
create policy "owner read tryon-results" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tryon-results'
    and exists (
      select 1
        from public.tryon_tasks t
       where t.id::text = (storage.foldername(name))[1]
         -- owner_user_id 为空的历史记录保持可读，避免老结果全部裂图
         and (t.owner_user_id is null or t.owner_user_id = (select auth.uid())::text)
    )
  );

drop policy if exists "owner delete tryon-results" on storage.objects;
create policy "owner delete tryon-results" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'tryon-results'
    and exists (
      select 1
        from public.tryon_tasks t
       where t.id::text = (storage.foldername(name))[1]
         and t.owner_user_id = (select auth.uid())::text
    )
  );

commit;

-- 验证（期望 public = false，且策略只剩 owner 两条）：
--   select id, public from storage.buckets where id = 'tryon-results';
--   select policyname, cmd from pg_policies
--    where schemaname = 'storage' and tablename = 'objects' and policyname like '%tryon-results%';
