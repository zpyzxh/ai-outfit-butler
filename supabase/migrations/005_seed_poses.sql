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
