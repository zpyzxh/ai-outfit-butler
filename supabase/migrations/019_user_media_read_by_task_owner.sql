-- 019_user_media_read_by_task_owner.sql
--
-- 背景：016 给 user-media 的读策略是「路径首段 = 当前用户 uid」。
-- 但存量迁移（2026-11-17）把 user-photos 根目录下的两张历史全身照
-- （test-person-1.jpg、test-person-1-2048.jpg）搬进了 user-media 根目录，
-- 路径里没有 uid，按原策略谁都签不出地址 → 「我的」页会裂图。
--
-- 语义上更正确的判定是「这张图被我自己的一条试穿记录引用」，
-- 与 018 对 tryon-results 的做法一致。这里给读策略加一个 OR 分支：
--   1) 路径首段 = 我的 uid（新上传的照片，任务行还没建出来时也能预览）
--   2) 存在一条属于我的 tryon_tasks 记录，其 user_photo_url 指向这个对象
--      （owner_user_id 为空的历史记录同样放行，和 014 保持一致）
--
-- 写策略不动：上传/覆盖/删除仍然只允许「自己的目录」。

begin;

drop policy if exists "owner read user-media" on storage.objects;
create policy "owner read user-media" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'user-media'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or exists (
        select 1
          from public.tryon_tasks t
         where right(t.user_photo_url, length(name)) = name
           and t.user_photo_url like '%/user-media/%'
           and (t.owner_user_id is null or t.owner_user_id = (select auth.uid())::text)
      )
    )
  );

-- 删除也放开到「属于我的记录引用的对象」，否则「我的」页删除记录时
-- 清不掉这类历史文件（不放开只会留下孤儿文件，不影响功能）。
drop policy if exists "owner delete user-media" on storage.objects;
create policy "owner delete user-media" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'user-media'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or exists (
        select 1
          from public.tryon_tasks t
         where right(t.user_photo_url, length(name)) = name
           and t.user_photo_url like '%/user-media/%'
           and t.owner_user_id = (select auth.uid())::text
      )
    )
  );

commit;

-- 验证：
--   select policyname, cmd from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and policyname like '%user-media%';
-- 期望四条：insert / update 各一条（016 建的），read / delete 各一条（本文件）。
