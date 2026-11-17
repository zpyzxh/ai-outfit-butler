-- 015 让社区灵感帖可以关联一件单品
--
-- 为什么要做：首页「试穿同款」按钮原本只对内置单品灵感有效，用户发布的
-- 作品 garment_id 恒为 null，社区内容永远无法一键试穿。加上这一列之后，
-- 发布页可以选择「这条穿搭用的是哪件衣服」，首页卡片就会带上试穿入口。
--
-- 注意：这一列可以为空，老数据不受影响；外键用 on delete set null，
-- 素材下架时帖子保留、只是失去试穿入口（不能用 cascade，否则删素材会连带
-- 删掉用户发布的内容）。

alter table public.inspiration_posts
  add column if not exists garment_id uuid references public.garments(id) on delete set null;

create index if not exists inspiration_posts_garment_idx
  on public.inspiration_posts (garment_id)
  where garment_id is not null;

-- 只有作者能改自己帖子的关联单品；发布时由客户端写入，owner 校验沿用既有策略。
comment on column public.inspiration_posts.garment_id is '关联单品；为空表示这条灵感不绑定可试穿的衣服';
