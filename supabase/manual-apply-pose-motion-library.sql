-- 姿势库升级：把 pose_desc 从「静态描述」改写成「运动 + 运镜」句式。
--
-- 背景：万相图生视频的提示词公式是「运动 + 运镜」（见
-- https://help.aliyun.com/zh/model-studio/text-to-video-prompt ）。
-- 图片已经决定了主体和场景，模型唯一需要知道的就是「怎么动」「镜头怎么动」。
-- 我们原来只写了「站着自然展示」，模型只能做最小幅度形变，所以视频看起来僵硬。
--
-- 这条 SQL 是纯数据更新，不建表、不改策略，可随时回滚（把旧文案贴回去即可）。
-- 在 Supabase → SQL Editor 整段选中执行。

begin;

-- 1) 三条老姿势：补动作幅度与运镜
update public.poses set
  pose_desc = 'The model slowly shifts her weight from one leg to the other, then takes one unhurried step toward the camera and gently smooths the front of the garment with one hand, her hair swaying slightly. Camera stays fixed and pushes in very slowly. '
where name = '自然展示';

update public.poses set
  pose_desc = 'The model pivots smoothly to a three-quarter side profile, one hand resting on the hip, takes a slow half step and lets the fabric settle, then turns her chin slightly toward the lens. Camera slowly dollies from left to right. '
where name = '侧身展示';

update public.poses set
  pose_desc = 'The model walks two slow steps forward while the hem of the outfit sways with each step, pauses with her weight on one leg and looks down briefly, then lifts her eyes back to the camera. Camera tracks forward gently and settles. '
where name = '轻摆展示';

-- 2) 新增三条动作更大、更适合展示服装动态的姿势
--    注意：poses.name 上没有唯一约束，不能用 on conflict，改用 where not exists 保证幂等
insert into public.poses (name, pose_desc, gender, image_url)
select v.name, v.pose_desc, 'unisex', null
from (
  values
    (
      '转圈展示',
      'The model turns a slow full circle on the spot so the skirt and its pleats flow outward, her arms slightly away from the body, then stops facing the camera with a calm smile. Camera stays fixed, no zoom. '
    ),
    (
      '行走回头',
      'The model walks three unhurried steps away along a sunlit path, the garment moving with her stride, then turns her head back over her shoulder toward the camera before walking on. Camera follows behind at shoulder height. '
    ),
    (
      '撩发侧身',
      'The model lifts one hand to push her hair back from her face, tilts her head slightly, then settles into a relaxed three-quarter pose with shoulders down and one knee slightly bent. Camera fixed with a very slow push-in. '
    )
) as v(name, pose_desc)
where not exists (select 1 from public.poses p where p.name = v.name);

commit;

-- 验证：应该看到 6 条，且每条描述里都有明确的动作动词
select name, gender, left(pose_desc, 60) as preview
from public.poses
order by created_at asc;
