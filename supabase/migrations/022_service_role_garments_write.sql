-- 022：给 service_role 补上 garments 的写权限
--
-- 背景：`006_table_privileges.sql` 只给 service_role 授了 `select`，
-- 而 `003_admin_and_history.sql` 把 insert/update/delete 授给了 `authenticated`（受 admin RLS 约束）。
-- 于是 Edge Function 用 service_role 写 `garments.back_image_url` 时会报
--   permission denied for table garments
-- ——BYPassrls 只绕过行级策略，不绕过表级 GRANT。
--
-- 这里只补 update（当前唯一需要 service_role 代写的字段是 back_image_url）；
-- 不给 delete/insert，避免扩大面。

grant update on public.garments to service_role;
grant select on public.garments to service_role;
