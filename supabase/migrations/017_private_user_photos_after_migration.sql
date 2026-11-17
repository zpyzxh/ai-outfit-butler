-- 017_private_user_photos_after_migration.sql
--
-- ⚠️ 不要提前执行。这是「最后一步」，前置条件是：
--   a) 已经跑过 `node scripts/migrate-legacy-user-photos.mjs`
--      （把历史全身照从 user-photos 搬到 user-media，并改写 tryon_tasks）；
--   b) 6 张历史商品平铺图已经重新上传到 garments 桶
--      （人工路径：/admin 逐条编辑商品、重选平铺图，会写到 garments 桶）。
--
-- 文件自带守卫：只要还有记录/商品图指向 user-photos，就直接抛异常中止，
-- 不会出现「桶私有化之后历史图全裂」的情况。
--
-- 执行后代码侧无需再改：`src/lib/supabase.ts` 的 PRIVATE_BUCKETS 已经包含 user-photos，
-- 客户端会自动给这些地址换签名直链。

begin;

do $$
declare
  task_count integer;
  garment_count integer;
begin
  select count(*) into task_count
  from public.tryon_tasks
  where user_photo_url like '%/storage/v1/object/%/user-photos/%';

  select count(*) into garment_count
  from public.garments
  where flat_image_url like '%/storage/v1/object/%/user-photos/%'
     or model_image_url like '%/storage/v1/object/%/user-photos/%';

  if task_count > 0 then
    raise exception '还有 % 条试穿记录指向 user-photos，请先运行 scripts/migrate-legacy-user-photos.mjs', task_count;
  end if;
  if garment_count > 0 then
    raise exception '还有 % 件商品图在 user-photos 里，请先在 /admin 重新上传平铺图', garment_count;
  end if;
end $$;

update storage.buckets set public = false where id = 'user-photos';

-- 私有化之后，任何人（包括匿名）都不能再用 public 直链读取，只剩本人签名访问
drop policy if exists "read shared root assets user-photos" on storage.objects;

commit;
