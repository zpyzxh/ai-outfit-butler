-- 021：给单品加「背面平铺图」。
-- 用途：试衣模型只吃一张衣服图，正面图推出来的背面褶裥/分割线全是编的。
-- 用户上传背面图后，可以再跑一次试衣，得到真实背面。
alter table public.garments add column if not exists back_image_url text;

comment on column public.garments.back_image_url is '背面平铺图（可选）。为空时前端不显示「看背面」，背面只能由模型推断。';