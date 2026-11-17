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
