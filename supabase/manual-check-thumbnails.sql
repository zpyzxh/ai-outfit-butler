-- ============================================================
-- 诊断：「我的」页里有的试穿记录缩略图是空白
-- ------------------------------------------------------------
-- 背景：
--   缩略图地址来自 tryon_tasks 的 result_url / first_frame_url / user_photo_url，
--   而这三个字段在私有桶（user-media / tryon-results）里，客户端必须先 createSignedUrl
--   才能显示。签名失败（对象不存在、路径对不上策略）时 <Image> 只会画一块空白。
--
-- 这条 SQL 不修任何东西，只回答一个问题：
--   「记录里存的文件名，在 storage.objects 里到底存不存在？」
--
--   photo_object_exists = false  →  照片对象没了或路径对不上（缩略图必空）
--   frame_object_exists = false  →  视频封面对象没了或路径对不上
--   两者都 true 但界面仍空白   →  问题在客户端签名（把结果截图给我）
--
-- 用法：整段粘进 Supabase SQL Editor 执行，把结果截图发回。
-- ============================================================

with me as (
  select id::text as uid
  from auth.users
  where id::text like '146ba173%'   -- 当前设备身份前 8 位
)
select
  t.created_at,
  t.stage,
  t.status,
  t.output_type,
  right(t.user_photo_url, 46)                     as photo_tail,
  right(coalesce(t.first_frame_url, ''), 46)      as frame_tail,
  exists (
    select 1 from storage.objects o
    where o.bucket_id = 'user-media'
      and right(t.user_photo_url, length(o.name)) = o.name
  )                                               as photo_object_exists,
  exists (
    select 1 from storage.objects o
    where o.bucket_id = 'tryon-results'
      and right(t.first_frame_url, length(o.name)) = o.name
  )                                               as frame_object_exists
from public.tryon_tasks t
where t.owner_user_id = (select uid from me)
order by t.created_at desc;
