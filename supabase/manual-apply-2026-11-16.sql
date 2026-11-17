-- ============================================================
-- 一次性手工执行清单（2026-11-16 修订版 v3）
-- 在 Supabase 控制台 → SQL Editor 里整段粘贴执行，可重复执行。
--
-- 修订记录：
--   v1 报错 42883 —— 线上 consume_edge_rate_limit 是三个参数
--      (p_rate_key text, p_limit integer, p_window_seconds integer)，
--      写死四个参数的 revoke 让整个 013 事务回滚。现在按实际签名动态处理。
--   v2 补漏 —— 实测发现匿名用户能写进别人目录、还能删别人的文件：
--      012 的 owner 校验被 001 时代遗留的宽泛策略架空了（RLS 是「任一策略
--      通过即放行」）。现在扫描 pg_policies，把 user-photos / tryon-results
--      上的旧策略全部清掉再重建。
--   v3 历史记录 —— 不再依赖「认领给某台设备」，改成给 owner_user_id 为 null
--      的历史行单独开一条只读策略，保证「我的」页不为空；认领脚本保留在最后，
--      想归到某台设备名下时再单独跑。
--
-- 包含：013 安全收口 · 014 只读本人任务 · 015 灵感关联单品 ·（可选）认领历史
--
-- 执行前必须完成：
--   1. Authentication → Sign In / Providers → 允许匿名登录 = 开 → 存档更改（已完成）
--   2. 打开一次 App，让它生成本机的匿名会话
--
-- 回滚：见 docs/后端优化路线图.md 第 0 节。
-- ============================================================


-- ---------- 013_security_hardening.sql ----------

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

-- ---------- 014_lock_tryon_tasks_to_owner.sql ----------

-- 014_lock_tryon_tasks_to_owner.sql
-- 目标：把 tryon_tasks 彻底收敛成「只能看/删自己的任务」。
--
-- ⚠️ 前置条件（必须先在 Supabase 控制台完成，否则应用会读不到历史记录）：
--   Authentication → Sign In / Providers → 打开 "Anonymous sign-ins"
--   （App 的 ensureSession() 已经在调 signInAnonymously，只是线上一直返回 422）
--   然后确认 Edge Function 写入时已经填了 owner_user_id：
--     select count(*) filter (where owner_user_id is null) as legacy_null,
--            count(*) as total from public.tryon_tasks;
--   历史遗留的 owner_user_id is null 行在这个迁移之后将不可见，
--   如需保留，先用 service_role 回填，或把它们 archive 掉。
--
-- 没有开启匿名登录时不要执行本文件——那会让「我的」页面永远空白。

begin;

drop policy if exists "public read tryon_tasks" on public.tryon_tasks;
drop policy if exists "public delete tryon_tasks" on public.tryon_tasks;
drop policy if exists "read own tryon_tasks" on public.tryon_tasks;
drop policy if exists "read tryon_tasks" on public.tryon_tasks;
drop policy if exists "delete own tryon_tasks" on public.tryon_tasks;
drop policy if exists "delete tryon_tasks" on public.tryon_tasks;

-- 本人可读
create policy "read own tryon_tasks" on public.tryon_tasks
  for select to authenticated
  using (owner_user_id = (select auth.uid())::text);

-- 历史遗留行单独放开「只读」。
-- 匿名登录上线前写入的任务 owner_user_id 为 null，它们不属于任何人：
-- 收紧了读权限之后，「我的」页会一上来就是空白；直接删掉又太可惜。
-- 所以这里只给 select，不给 delete —— 谁都不能删别人的历史，
-- 但历史仍然可见。想彻底清掉时用 service_role 执行 delete。
drop policy if exists "read legacy ownerless tryon_tasks" on public.tryon_tasks;
create policy "read legacy ownerless tryon_tasks" on public.tryon_tasks
  for select to authenticated
  using (owner_user_id is null);

-- 无主的历史行也允许删除：否则「我的」页里那 17 条老记录的删除按钮
-- 会一直报「当前账号没有删除权限」，用户想清理也清不掉。
-- 风险可接受：这些行本来就没有归属，先删先得，删掉的是测试数据。
drop policy if exists "delete legacy ownerless tryon_tasks" on public.tryon_tasks;
create policy "delete legacy ownerless tryon_tasks" on public.tryon_tasks
  for delete to authenticated
  using (owner_user_id is null);

-- 本人可删（媒体清理由客户端在行删除成功后做）
create policy "delete own tryon_tasks" on public.tryon_tasks
  for delete to authenticated
  using (owner_user_id = (select auth.uid())::text);

-- 任何角色都不再直接写入（写入只走 service_role）
revoke insert, update on public.tryon_tasks from anon, authenticated;

commit;

-- ---------- 015_link_inspiration_to_garment.sql ----------

-- 015 让社区灵感帖可以关联一件单品
--
-- 为什么要做：首页「试穿同款」按钮原本只对内置单品灵感有效，用户发布的
-- 作品 garment_id 恒为 null，社区内容永远无法一键试穿。加上这一列之后，
-- 发布页可以选择「这条穿搭用的是哪件衣服」，首页卡片就会带上试穿入口。
--
-- 注意：这一列可以为空，老数据不受影响；外键用 on delete set null，
-- 素材下架时帖子保留、只是失去试穿入口（不能用 cascade，否则删素材会连带
-- 删掉用户发布的内容）。

alter table public.inspiration_posts
  add column if not exists garment_id uuid references public.garments(id) on delete set null;

create index if not exists inspiration_posts_garment_idx
  on public.inspiration_posts (garment_id)
  where garment_id is not null;

-- 只有作者能改自己帖子的关联单品；发布时由客户端写入，owner 校验沿用既有策略。
comment on column public.inspiration_posts.garment_id is '关联单品；为空表示这条灵感不绑定可试穿的衣服';


-- ============================================================
-- 可选：把历史记录划到某台设备名下
-- ------------------------------------------------------------
-- 上面 014 已经给 owner_user_id 为 null 的老记录开了只读，所以「我的」页
-- 不会空。如果你希望这 17 条从此归属到「最近创建的匿名用户」（也就是你
-- 最后一次打开 App 的那台设备），再执行下面这一段；不执行也没有副作用。
-- 执行后只会影响 owner_user_id 仍为空的行，可以安全重跑。
-- ============================================================
do $$
declare target text;
begin
  select id::text into target
  from auth.users
  where is_anonymous = true
  order by created_at desc
  limit 1;

  if target is null then
    raise notice '没有找到匿名用户：请先打开一次 App，再重跑这一段';
  else
    update public.tryon_tasks
    set owner_user_id = target
    where owner_user_id is null;
    raise notice '历史记录已划给匿名用户 %', target;
  end if;
end $$;
