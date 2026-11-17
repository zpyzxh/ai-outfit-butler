-- ============================================
-- 010_authenticated_role_access.sql
-- 修复：核心表与 Storage 的 RLS 策略只授予了 anon，但 App 在登录（匿名或邮箱）后
-- JWT 角色是 authenticated。PostgreSQL 中 RLS 没有匹配当前角色的策略时查询返回 0 行
-- （不报错），表现为：登录后首页/试衣/“我的”全部空白，全身照上传与记录删除被拒。
--
-- 依赖 009_edge_hardening.sql 新增的 tryon_tasks.owner_user_id：
-- 登录用户只能读/删自己的任务，历史任务（owner 为空）保持可读，避免升级后记录消失。
-- garments 的写权限仍只保留给 is_admin()，不在此放宽。
-- ============================================

-- ---------- 表：公开读 ----------
drop policy if exists "public read garments" on public.garments;
create policy "public read garments" on public.garments
  for select to anon, authenticated using (true);

drop policy if exists "public read poses" on public.poses;
create policy "public read poses" on public.poses
  for select to anon, authenticated using (true);

-- ---------- 表：试衣任务按归属读写 ----------
drop policy if exists "public read tryon_tasks" on public.tryon_tasks;
create policy "public read tryon_tasks" on public.tryon_tasks
  for select to anon using (true);

drop policy if exists "read own tryon_tasks" on public.tryon_tasks;
create policy "read own tryon_tasks" on public.tryon_tasks
  for select to authenticated
  using (owner_user_id is null or owner_user_id = auth.uid()::text);

drop policy if exists "public delete tryon_tasks" on public.tryon_tasks;
create policy "public delete tryon_tasks" on public.tryon_tasks
  for delete to anon using (true);

drop policy if exists "delete own tryon_tasks" on public.tryon_tasks;
create policy "delete own tryon_tasks" on public.tryon_tasks
  for delete to authenticated
  using (owner_user_id is null or owner_user_id = auth.uid()::text);

-- 006 只给 authenticated 授予了 select/insert/update，删除需要显式补
grant delete on public.tryon_tasks to authenticated;

-- ---------- Storage：读 ----------
drop policy if exists "public read garments bucket" on storage.objects;
create policy "public read garments bucket" on storage.objects
  for select to anon, authenticated using (bucket_id = 'garments');

drop policy if exists "public read poses bucket" on storage.objects;
create policy "public read poses bucket" on storage.objects
  for select to anon, authenticated using (bucket_id = 'poses');

drop policy if exists "public read user-photos bucket" on storage.objects;
create policy "public read user-photos bucket" on storage.objects
  for select to anon, authenticated using (bucket_id = 'user-photos');

drop policy if exists "public read tryon-results bucket" on storage.objects;
create policy "public read tryon-results bucket" on storage.objects
  for select to anon, authenticated using (bucket_id = 'tryon-results');

-- ---------- Storage：全身照上传/删除 ----------
drop policy if exists "anon upload user-photos" on storage.objects;
create policy "anon upload user-photos" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'user-photos');

drop policy if exists "anon delete user-photos" on storage.objects;
create policy "anon delete user-photos" on storage.objects
  for delete to anon, authenticated using (bucket_id = 'user-photos');

-- ---------- Storage：试衣结果删除 ----------
drop policy if exists "anon delete tryon-results" on storage.objects;
create policy "anon delete tryon-results" on storage.objects
  for delete to anon, authenticated using (bucket_id = 'tryon-results');
