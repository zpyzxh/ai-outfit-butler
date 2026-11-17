# 管理页配置

管理页地址：`/admin`。登录使用 Supabase Auth 账号，服务端 RLS 还会检查该账号的 `app_metadata.role`，所以普通登录账号不能写入素材。

## 启用管理员

1. 在 Supabase Dashboard 的 Authentication → Users 中创建管理员账号。
2. 在 SQL Editor 以项目管理员身份执行下面的语句，把邮箱替换成该账号邮箱：

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
where email = 'admin@example.com';
```

3. 确认只更新了一行，然后重新登录 `/admin`，让新角色进入登录令牌。

不要把 `service_role` key 写入 `.env` 的 `EXPO_PUBLIC_*` 变量、前端代码或提交记录。

## 启用作品发布

在 Supabase Dashboard 的 Authentication → Settings 中启用 Anonymous Sign-Ins。发布入口会为设备创建匿名 Supabase Auth 身份，不要求用户填写账号密码；该身份用于限制用户只能删除自己的发布。

发布到灵感流的图片和视频会使用公开 Storage URL，首页对所有访问者可见。上传界面会提示这一点；试穿全身照不会自动发布。

## 执行数据库迁移

如果旧版迁移已执行，在 SQL Editor 依次执行 `supabase/migrations/003_admin_and_history.sql`、`004_public_inspiration_feed.sql` 和 `005_seed_poses.sql`。新环境按顺序执行 `001_init.sql`、`002_task_provider_fields.sql`、`003_admin_and_history.sql`、`004_public_inspiration_feed.sql`、`005_seed_poses.sql`。003 和 005 都会补齐三个基础展示姿势，重复执行 005 不会重复插入；004 会建立公开灵感流和媒体存储桶。

003 为 garments 表和 Storage 配置管理员写策略，并允许免登录试衣流程删除任务和对应图片。004 使用匿名 Auth 标记公开发布的作者，但现有试衣任务仍没有用户归属字段；多人使用时，试衣历史目前是共享的。
