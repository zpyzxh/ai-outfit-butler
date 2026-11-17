-- AI穿搭管家新 Supabase 项目初始化脚本
-- 仅在刚创建的空项目中，通过 Dashboard > SQL Editor 执行一次。
-- 包含 001-005：核心表、RLS、Storage、后台管理、灵感社区和默认姿势。
-- 不要在旧项目或已执行这些 migrations 的项目中重复运行。


-- ===== BEGIN 001_init.sql =====
-- ============================================
-- AI穿搭管家 - 初始化迁移
-- 001_init.sql：建表 + 索引 + RLS + Storage 桶
-- 无用户登录，前端使用 anon key，故全部开放公共读写（自用/演示场景）
-- ============================================

-- ---------- 1. 表 ----------

-- 衣服素材表
create table if not exists public.garments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,                -- 如：上装 / 下装 / 连衣裙 / 外套
  color text,
  flat_image_url text not null,          -- 平铺图（IDM-VTON 输入）
  model_image_url text,                  -- 模特图（首页瀑布流展示）
  gender text not null default 'female', -- male / female / unisex
  created_at timestamptz not null default now()
);

-- 姿势表
create table if not exists public.poses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pose_desc text,                        -- 姿势描述（用于视频生成 prompt）
  image_url text,                        -- 姿势示例图
  gender text not null default 'female',
  created_at timestamptz not null default now()
);

-- 试衣任务表
create table if not exists public.tryon_tasks (
  id uuid primary key default gen_random_uuid(),
  user_photo_url text not null,          -- 用户全身照
  garment_id uuid not null references public.garments(id) on delete cascade,
  pose_id uuid references public.poses(id) on delete set null,
  text_intent text,                      -- 用户文字意图（可选）
  output_type text not null default 'image',   -- image / video
  resolution text not null default '720p',     -- 规则：不做 1080P 默认
  duration int,                          -- 视频时长（秒），图片任务为 null
  stage text not null default 'tryon',         -- tryon（首帧阶段） / video（视频阶段）
  status text not null default 'pending',      -- pending / processing / done / failed / timeout
  first_frame_url text,                  -- IDM-VTON 生成的首帧图
  result_url text,                       -- 最终结果（图片或视频）
  error_msg text,
  created_at timestamptz not null default now()
);

-- ---------- 2. 索引 ----------

create index if not exists idx_garments_category on public.garments(category);
create index if not exists idx_garments_gender on public.garments(gender);
create index if not exists idx_tryon_tasks_status on public.tryon_tasks(status);
create index if not exists idx_tryon_tasks_created_at on public.tryon_tasks(created_at desc);

-- ---------- 3. RLS ----------
-- 无登录体系，anon 角色全量读写（自用演示，不公开分发）

alter table public.garments enable row level security;
alter table public.poses enable row level security;
alter table public.tryon_tasks enable row level security;

create policy "public read garments" on public.garments
  for select to anon using (true);

create policy "public read poses" on public.poses
  for select to anon using (true);

create policy "public read tryon_tasks" on public.tryon_tasks
  for select to anon using (true);

create policy "public insert tryon_tasks" on public.tryon_tasks
  for insert to anon with check (true);

create policy "public update tryon_tasks" on public.tryon_tasks
  for update to anon using (true) with check (true);

-- ---------- 4. Storage 桶 ----------
-- public = true：前端直接通过公共 URL 展示图片/视频

insert into storage.buckets (id, name, public)
values
  ('garments', 'garments', true),        -- 衣服平铺图/模特图
  ('poses', 'poses', true),              -- 姿势示例图
  ('user-photos', 'user-photos', true),  -- 用户上传的全身照
  ('tryon-results', 'tryon-results', true) -- 首帧图与视频结果
on conflict (id) do nothing;

-- ---------- 5. Storage 策略 ----------
-- anon 可读；user-photos 允许 anon 上传；tryon-results 允许 Edge Function（service_role）写入

create policy "public read garments bucket" on storage.objects
  for select to anon using (bucket_id = 'garments');

create policy "public read poses bucket" on storage.objects
  for select to anon using (bucket_id = 'poses');

create policy "public read user-photos bucket" on storage.objects
  for select to anon using (bucket_id = 'user-photos');

create policy "anon upload user-photos" on storage.objects
  for insert to anon with check (bucket_id = 'user-photos');

create policy "public read tryon-results bucket" on storage.objects
  for select to anon using (bucket_id = 'tryon-results');

create policy "service write tryon-results" on storage.objects
  for insert to service_role with check (bucket_id = 'tryon-results');

create policy "service update tryon-results" on storage.objects
  for update to service_role using (bucket_id = 'tryon-results') with check (bucket_id = 'tryon-results');

-- ===== END 001_init.sql =====


-- ===== BEGIN 002_task_provider_fields.sql =====
-- ============================================
-- 002_task_provider_fields.sql
-- Edge Functions 需要：
-- 1) provider_task_id 存第三方任务 ID（Replicate prediction id / DashScope task id）
-- 2) stage_started_at 记录当前阶段开始时间（视频 10 分钟超时判断用）
-- ============================================

alter table public.tryon_tasks
  add column if not exists provider_task_id text;

alter table public.tryon_tasks
  add column if not exists stage_started_at timestamptz not null default now();

-- ===== END 002_task_provider_fields.sql =====


-- ===== BEGIN 003_admin_and_history.sql =====
-- Admin write access for garment management and single-user task cleanup.
-- Add the Supabase Auth user's app_metadata.role = 'admin' before using /admin.

create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Starter poses make the video action usable immediately after applying this migration.
insert into public.poses (name, pose_desc, gender)
select seed.name, seed.pose_desc, 'unisex'
from (values
  ('自然展示', 'The model stands naturally and gently shifts weight to show the outfit clearly.'),
  ('侧身展示', 'The model slowly turns slightly to the side and back with a calm, natural movement.'),
  ('轻摆展示', 'The model makes a subtle graceful movement to show the garment fabric and silhouette.')
) as seed(name, pose_desc)
where not exists (
  select 1 from public.poses existing
  where existing.name = seed.name and existing.gender = 'unisex'
);

grant insert, update, delete on public.garments to authenticated;

drop policy if exists "admin insert garments" on public.garments;
create policy "admin insert garments" on public.garments
  for insert to authenticated with check (public.is_admin());

drop policy if exists "admin update garments" on public.garments;
create policy "admin update garments" on public.garments
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin delete garments" on public.garments;
create policy "admin delete garments" on public.garments
  for delete to authenticated using (public.is_admin());

drop policy if exists "admin upload garments" on storage.objects;
create policy "admin upload garments" on storage.objects
  for insert to authenticated with check (bucket_id = 'garments' and public.is_admin());

drop policy if exists "admin update garment images" on storage.objects;
create policy "admin update garment images" on storage.objects
  for update to authenticated using (bucket_id = 'garments' and public.is_admin())
  with check (bucket_id = 'garments' and public.is_admin());

drop policy if exists "admin delete garment images" on storage.objects;
create policy "admin delete garment images" on storage.objects
  for delete to authenticated using (bucket_id = 'garments' and public.is_admin());

-- This project is configured for one trusted, self-use installation without end-user accounts.
-- If it is shared with other users, replace these anon policies with per-user ownership before deployment.
drop policy if exists "public delete tryon_tasks" on public.tryon_tasks;
create policy "public delete tryon_tasks" on public.tryon_tasks
  for delete to anon using (true);

drop policy if exists "anon delete user-photos" on storage.objects;
create policy "anon delete user-photos" on storage.objects
  for delete to anon using (bucket_id = 'user-photos');

drop policy if exists "anon delete tryon-results" on storage.objects;
create policy "anon delete tryon-results" on storage.objects
  for delete to anon using (bucket_id = 'tryon-results');

-- ===== END 003_admin_and_history.sql =====


-- ===== BEGIN 004_public_inspiration_feed.sql =====
-- Public inspiration feed. Uploaders get an anonymous Auth session so they can
-- delete only their own posts without entering account credentials.

create table if not exists public.inspiration_posts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  caption text not null default '',
  media_type text not null check (media_type in ('image', 'video')),
  media_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_inspiration_posts_created_at
  on public.inspiration_posts(created_at desc);

alter table public.inspiration_posts enable row level security;
grant select on public.inspiration_posts to anon, authenticated;
grant insert, delete on public.inspiration_posts to authenticated;

drop policy if exists "public read inspiration posts" on public.inspiration_posts;
create policy "public read inspiration posts" on public.inspiration_posts
  for select to anon, authenticated using (true);

drop policy if exists "users publish own inspiration posts" on public.inspiration_posts;
create policy "users publish own inspiration posts" on public.inspiration_posts
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists "users delete own inspiration posts" on public.inspiration_posts;
create policy "users delete own inspiration posts" on public.inspiration_posts
  for delete to authenticated using (owner_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'inspiration-posts', 'inspiration-posts', true, 52428800,
  array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public read inspiration media" on storage.objects;
create policy "public read inspiration media" on storage.objects
  for select to anon, authenticated using (bucket_id = 'inspiration-posts');

drop policy if exists "users upload own inspiration media" on storage.objects;
create policy "users upload own inspiration media" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'inspiration-posts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users delete own inspiration media" on storage.objects;
create policy "users delete own inspiration media" on storage.objects
  for delete to authenticated using (
    bucket_id = 'inspiration-posts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ===== END 004_public_inspiration_feed.sql =====


-- ===== BEGIN 005_seed_poses.sql =====
-- 005_seed_poses.sql
-- Seed a small, reusable pose library. Images can be uploaded to the public
-- `poses` Storage bucket later and image_url can then be updated in Dashboard.

insert into public.poses (name, pose_desc, image_url, gender)
select seed.name, seed.pose_desc, null, 'unisex'
from (values
  (
    '自然展示',
    'The model stands naturally and gently shifts weight to show the outfit clearly.'
  ),
  (
    '侧身展示',
    'The model slowly turns slightly to the side and back with a calm, natural movement.'
  ),
  (
    '轻摆展示',
    'The model makes a subtle graceful movement to show the garment fabric and silhouette.'
  )
) as seed(name, pose_desc)
where not exists (
  select 1
  from public.poses existing
  where existing.name = seed.name
    and existing.gender = 'unisex'
);

-- ===== END 005_seed_poses.sql =====


-- ===== BEGIN 006_table_privileges.sql =====
-- Match the role grants applied by migration 006. RLS policies alone do not
-- grant table-level access to anon/authenticated roles.
grant select on public.garments to anon;
grant select on public.poses to anon;
grant select, insert, update, delete on public.tryon_tasks to anon;

grant select on public.garments to authenticated;
grant select on public.poses to authenticated;
grant select, insert, update on public.tryon_tasks to authenticated;
-- ===== END 006_table_privileges.sql =====
