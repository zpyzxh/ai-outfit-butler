-- 011_edge_rate_limits.sql
-- 限流基础设施：表 + 计数函数（从线上库导出存档，逻辑未改动）
-- 依赖：无（本文件自带建表，可独立于 009/010 执行，放在最后即可）
-- 说明：Edge Function tryon / video 通过 rpc('consume_edge_rate_limit', ...) 调用。
-- 若缺此表/函数，两个函数会直接 503。

-- 1) 表结构（线上 information_schema / pg_indexes 导出）
create table if not exists public.edge_rate_limits (
  rate_key text not null,
  window_started_at timestamptz not null,
  request_count integer not null,
  updated_at timestamptz not null
);

create unique index if not exists edge_rate_limits_pkey
  on public.edge_rate_limits using btree (rate_key);

-- 2) 权限：线上 anon/authenticated 均无访问权（实测 REST 返回 42501 permission denied）
alter table public.edge_rate_limits enable row level security;
revoke all on public.edge_rate_limits from anon, authenticated;
grant all on public.edge_rate_limits to service_role;

-- 3) 计数函数（线上 pg_get_functiondef 原文）
create or replace function public.consume_edge_rate_limit(
  p_rate_key text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare allowed boolean;
begin
  insert into public.edge_rate_limits(rate_key, window_started_at, request_count)
  values (p_rate_key, clock_timestamp(), 1)
  on conflict (rate_key) do update set
    request_count = case
      when public.edge_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= clock_timestamp() then 1
      else public.edge_rate_limits.request_count + 1 end,
    window_started_at = case
      when public.edge_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= clock_timestamp() then clock_timestamp()
      else public.edge_rate_limits.window_started_at end,
    updated_at = clock_timestamp()
  returning request_count <= p_limit into allowed;
  return allowed;
end $function$;
