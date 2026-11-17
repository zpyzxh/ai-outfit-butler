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

drop policy if exists "public read garments" on public.garments;
create policy "public read garments" on public.garments
  for select to anon using (true);

drop policy if exists "public read poses" on public.poses;
create policy "public read poses" on public.poses
  for select to anon using (true);

drop policy if exists "public read tryon_tasks" on public.tryon_tasks;
create policy "public read tryon_tasks" on public.tryon_tasks
  for select to anon using (true);

drop policy if exists "public insert tryon_tasks" on public.tryon_tasks;
create policy "public insert tryon_tasks" on public.tryon_tasks
  for insert to anon with check (true);

drop policy if exists "public update tryon_tasks" on public.tryon_tasks;
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

drop policy if exists "public read garments bucket" on storage.objects;
create policy "public read garments bucket" on storage.objects
  for select to anon using (bucket_id = 'garments');

drop policy if exists "public read poses bucket" on storage.objects;
create policy "public read poses bucket" on storage.objects
  for select to anon using (bucket_id = 'poses');

drop policy if exists "public read user-photos bucket" on storage.objects;
create policy "public read user-photos bucket" on storage.objects
  for select to anon using (bucket_id = 'user-photos');

drop policy if exists "anon upload user-photos" on storage.objects;
create policy "anon upload user-photos" on storage.objects
  for insert to anon with check (bucket_id = 'user-photos');

drop policy if exists "public read tryon-results bucket" on storage.objects;
create policy "public read tryon-results bucket" on storage.objects
  for select to anon using (bucket_id = 'tryon-results');

drop policy if exists "service write tryon-results" on storage.objects;
create policy "service write tryon-results" on storage.objects
  for insert to service_role with check (bucket_id = 'tryon-results');

drop policy if exists "service update tryon-results" on storage.objects;
create policy "service update tryon-results" on storage.objects
  for update to service_role using (bucket_id = 'tryon-results') with check (bucket_id = 'tryon-results');
