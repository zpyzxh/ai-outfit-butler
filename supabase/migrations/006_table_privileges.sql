-- ============================================
-- 006_table_privileges.sql
-- 补齐表级权限。
-- 001_init.sql 只创建了 RLS 策略，没有 GRANT；新库默认不给 anon 表级权限，
-- 会导致前端查询 garments / poses / tryon_tasks 直接 401 permission denied。
-- RLS 策略仍负责行级过滤，这里只补角色级权限。
-- ============================================

-- anon：首页瀑布流、姿势列表、试衣任务读写
grant select on public.garments to anon;
grant select on public.poses to anon;
grant select, insert, update, delete on public.tryon_tasks to anon;

-- authenticated：管理员页/匿名登录用户读取素材与任务
grant select on public.garments to authenticated;
grant select on public.poses to authenticated;
grant select, insert, update on public.tryon_tasks to authenticated;

-- service_role：Edge Function 用它查衣服、读写任务；缺权限会直接 500
grant select on public.garments to service_role;
grant select on public.poses to service_role;
grant select, insert, update, delete on public.tryon_tasks to service_role;

