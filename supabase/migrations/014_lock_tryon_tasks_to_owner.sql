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
