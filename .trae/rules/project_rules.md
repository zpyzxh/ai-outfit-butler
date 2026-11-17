# AI穿搭管家 — 项目规则

## 项目定位
自用/小范围演示的AI穿搭试用App，不公开分发、不商业化。

## 技术栈
- 前端：Expo React Native + TypeScript
- 后端：Supabase Edge Functions (Deno)
- 数据库：Supabase PostgreSQL
- 试衣：Replicate IDM-VTON（cuuupid/idm-vton）
- 视频：阿里云百炼通义万相 wan2.6-i2v-flash

## 核心流程
1. 首页展示衣服素材，双列瀑布流
2. 用户上传全身照
3. 用户选衣服，点击试衣
4. 后端调 Replicate IDM-VTON 生成首帧图
5. 前端轮询状态，展示首帧图
6. 可选：选姿势，后端调通义万相图生视频
7. 前端轮询，展示视频

## 数据库表
garments: id, name, category, color, flat_image_url, model_image_url, gender, created_at
poses: id, name, pose_desc, image_url, gender, created_at
tryon_tasks: id, user_photo_url, garment_id, pose_id, text_intent, output_type, resolution, duration, stage, status, first_frame_url, result_url, error_msg, created_at

## 关键约束
- 所有API Key只存在Edge Function环境变量
- 前端.env只放 EXPO_PUBLIC_SUPABASE_URL 和 EXPO_PUBLIC_SUPABASE_ANON_KEY
- 轮询间隔5秒，视频最多10分钟，超时标记failed
- 普通用户不做登录和衣橱Tab；保留对话Tab用于AI穿搭问答
- 管理页使用 Supabase Auth 管理员登录，1080P不做默认
- 发布图片/视频时使用匿名 Supabase Auth 识别作者；作品发布后对访问首页的人公开可见
- 试穿上传的全身照不得自动发布到公开灵感流

## 异常处理
- 试衣失败提示“试衣生成失败，请重试”
- 视频超时提示“视频生成超时，请稍后重试”
- 等待状态显示已等待秒数
