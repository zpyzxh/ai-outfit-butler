-- 013_security_hardening.sql
-- 目标：在不改变 App 现有行为的前提下，堵住三个「用明文 anon key 就能作恶」的口子。
-- 可直接应用；不需要开匿名登录，也不需要改客户端代码。
--
-- 1) 客户端不再能直接写 tryon_tasks（写入统一走 Edge Function 的 service_role）
-- 2) 未登录不能再 list user-photos / tryon-results 桶（公开直链读取保留）
-- 3) consume_edge_rate_limit 收回执行权，避免被拿来刷爆限流表
-- 4) garments 增加 archived_at，为「下架而不删」的软删除做准备

begin;

-- ---------------------------------------------------------------------------
-- 1) tryon_tasks：只保留 Edge Function（service_role）写入
-- ---------------------------------------------------------------------------
drop policy if exists "public insert tryon_tasks" on public.tryon_tasks;
drop policy if exists "public update tryon_tasks" on public.tryon_tasks;
drop policy if exists "public insert/update tryon_tasks" on public.tryon_tasks;

revoke insert, update on public.tryon_tasks from anon, authenticated;

comment on table public.tryon_tasks is
  '试衣/视频任务。客户端只读；写入全部由 Edge Function 以 service_role 完成（RLS 对 service_role 不生效）。';


-- ---------------------------------------------------------------------------
-- 2) Storage：关闭「未登录可列目录」
--    之前 select to anon using (bucket_id = 'user-photos') 让
--    POST /storage/v1/object/list/user-photos 能枚举所有人的照片名。
--    这里把所有针对这两个桶的 SELECT 策略清掉再按「本人目录」重建，
--    同时收回 anon 在 storage.objects 上的 select 权限。
--    注意：桶仍然是 public=true，所以已有的 public URL 直链照旧能打开，
--    只是无法再列举。后续要彻底私有化，改用 createSignedUrl 时再把桶设为 private。
-- ---------------------------------------------------------------------------
-- 2a) 先清掉所有涉及这两个私有桶的策略（不论 cmd、不论策略名）。
--     只 drop 同名策略不够：线上还残留 001 时代的宽泛策略，而 PostgreSQL 的
--     RLS 是「任一策略通过即放行」，留着它们等于 012 的 owner 校验完全失效。
--     实测证据（2026-11-16）：新匿名用户能把文件写进别人目录、也能删别人的文件。
do $$
declare pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        coalesce(qual, '') ilike '%user-photos%'
        or coalesce(qual, '') ilike '%tryon-results%'
        or coalesce(with_check, '') ilike '%user-photos%'
        or coalesce(with_check, '') ilike '%tryon-results%'
      )
  loop
    execute format('drop policy if exists %I on storage.objects', pol.policyname);
    raise notice 'dropped private-bucket policy: %', pol.policyname;
  end loop;
end $$;

-- 2b) 素材桶只清 SELECT（写策略留给管理端，那是后台功能依赖的），
--     目的是禁止「未登录按目录枚举」。
do $$
declare pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and cmd = 'SELECT'
      and (
        coalesce(qual, '') ilike '%garments%'
        or coalesce(qual, '') ilike '%poses%'
        or coalesce(qual, '') ilike '%inspiration-posts%'
      )
  loop
    execute format('drop policy if exists %I on storage.objects', pol.policyname);
    raise notice 'dropped asset-bucket read policy: %', pol.policyname;
  end loop;
end $$;

-- 未登录身份不再能读 storage.objects（public 直链不受 RLS 影响）
revoke select on storage.objects from anon;

-- 2c) user-photos：只有本人目录可读/写/删
drop policy if exists "owner read user-photos" on storage.objects;
create policy "owner read user-photos" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'user-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "owner write user-photos" on storage.objects;
create policy "owner write user-photos" on storage.objects
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

-- 2d) tryon-results：只有本人目录可读/删（写入仍由 service_role 完成）
drop policy if exists "owner read tryon-results" on storage.objects;
create policy "owner read tryon-results" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tryon-results'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "owner delete tryon-results" on storage.objects;
create policy "owner delete tryon-results" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'tryon-results'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- 2e) 素材桶（garments / poses / inspiration-posts）内容本身是公开素材，
--     登录用户可读；禁止未登录枚举。
drop policy if exists "signed in read public assets" on storage.objects;
create policy "signed in read public assets" on storage.objects
  for select to authenticated
  using (bucket_id in ('garments', 'poses', 'inspiration-posts'));


-- ---------------------------------------------------------------------------
-- 3) 限流 RPC 只给 service_role 用
-- ---------------------------------------------------------------------------
-- 注意：这里必须按「函数实际签名」动态处理。
-- 线上 011 的定义是 consume_edge_rate_limit(p_rate_key text, p_limit integer,
-- p_window_seconds integer) —— 三个参数。写死四个参数的 revoke 会直接报
-- 42883 function does not exist，把整个 013 事务一起回滚。
do $$
declare fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'consume_edge_rate_limit'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
    raise notice '已收口限流函数 %', fn;
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- 4) garments 软删除字段
--    删素材不应连带删掉用户的试穿历史（001 的 on delete cascade 会造成这个后果）。
-- ---------------------------------------------------------------------------
alter table public.garments
  add column if not exists archived_at timestamptz;

create index if not exists garments_active_idx
  on public.garments (created_at desc)
  where archived_at is null;

comment on column public.garments.archived_at is
  '下架时间。非空表示不再出现在前端列表，但历史试穿记录仍然有效。';

commit;
