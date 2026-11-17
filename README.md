# AI 穿搭管家

> **在线演示（Web）**：https://zpyzxh.github.io/ai-outfit-butler/　·　**源码**：https://github.com/zpyzxh/ai-outfit-butler
>
> 移动端为 Expo RN 同一套代码（iOS / Android），Web 版是给面试与演示用的入口。
>
> **演示模式**：在任意页面地址后加 `?demo=1`（或构建时设 `EXPO_PUBLIC_DEMO=1`），
> 试穿与视频直接给**本项目真实跑过的预生成结果**，不调用 AI、不消耗额度；
> 界面会在标题下明确标注「演示模式 · 预生成样例」，不会假装实时计算。
> 直达：https://zpyzxh.github.io/ai-outfit-butler/tryon?demo=1

时尚穿搭 App：**看灵感 → 挑搭配 → 整套试穿 → 生成动态视频 → 收藏/发布**。

技术栈：Expo React Native (TypeScript, expo-router) + Supabase（Postgres / Storage / Edge Functions）+ Aidge 试衣 + 图生视频提供方。

> 结构大改版与逐条修 bug 记录见 [`docs/迭代报告-2026-11-16.md`](docs/迭代报告-2026-11-16.md)，
> 后端待办与服务端方案见 [`docs/后端优化路线图.md`](docs/后端优化路线图.md)，
> **面试/演示材料（简历措辞、一页纸、12 页讲解、录屏脚本、扫码卡）统一在 [`docs/面试材料/`](docs/面试材料/00-从这里开始.md)**。

---

## 一、当前页面结构

底栏 5 个入口（浮动黑胶囊）：

| 位置 | 路由 | 说明 |
|---|---|---|
| 首页 | `/(tabs)/index` | 全屏竖滑灵感流（社区图片/视频 + 单品），右侧收藏、底部「试穿同款」 |
| 搭配 | `/(tabs)/outfits` | 基于衣橱 + 天气 + 风格档案的搭配推荐，3 套/次，可换一批；每套可「试穿这套」或一键「出视频」 |
| 发布 | `/(tabs)/create` | 发布图片/视频到社区灵感流，可关联一件单品，让别人的「试穿同款」能直接用（FAB 入口） |
| 试衣 | `/(tabs)/tryon` | 上传全身照 → 选 1–3 件单品 → 依次试穿 → 选姿势生成视频 → 可一键发布到首页；支持 `?look=id,id,id`（整套带入）与 `&autoVideo=1`（跑完整套自动出片） |
| 我的 | `/(tabs)/profile` | 试穿记录（含加载失败兜底）、收藏单品/收藏搭配、风格档案、恢复码、界面风格、更多入口 |

不进底栏但可达（`tabBarButton: () => null`，保留路由）：

- `/(tabs)/chat` 穿搭问答 — 从「搭配」页底部「拿不定主意？问问搭配师」进入
- `/(tabs)/plans` 套餐页 — 从「我的」页「试穿套餐」进入
- `/admin` 素材管理 — 从「我的」页进入

## 二、目录结构

```
AI穿搭管家/
├─ src/
│  ├─ app/
│  │  ├─ _layout.tsx              # 根布局（ThemeProvider + 字体 + Stack）
│  │  ├─ admin.tsx                # 素材管理后台
│  │  └─ (tabs)/
│  │     ├─ _layout.tsx           # 底栏（浮动胶囊，宽度自算，隐藏路由用 tabBarButton 而非 href:null）
│  │     ├─ index.tsx             # 首页灵感流
│  │     ├─ outfits.tsx           # 搭配页
│  │     ├─ create.tsx            # 发布
│  │     ├─ tryon.tsx             # 试衣（1–3 件串行）
│  │     ├─ profile.tsx           # 我的
│  │     ├─ chat.tsx              # 穿搭问答（隐藏路由）
│  │     └─ plans.tsx             # 套餐（隐藏路由）
│  ├─ components/
│  │  ├─ FeedMediaCard.tsx        # 首页卡片（overlay / stacked 两套布局）
│  │  ├─ OutfitCard.tsx           # 搭配卡片（1–3 张图的拼贴）
│  │  ├─ StyleProfileSheet.tsx    # 风格档案底部抽屉
│  │  ├─ Skeleton.tsx             # 骨架屏
│  │  ├─ WeatherChip.tsx / GarmentCard.tsx / AccountSection.tsx / icons.tsx …
│  ├─ lib/
│  │  ├─ supabase.ts              # 客户端 + 查询 + Edge 调用 + 超时重试
│  │  ├─ outfits.ts               # 搭配推荐引擎（纯函数、无网络）
│  │  ├─ styleProfile.ts          # 风格档案（AsyncStorage）
│  │  ├─ favorites.ts             # 收藏（AsyncStorage）
│  │  ├─ errors.ts                # 错误 → 中文文案
│  │  ├─ recovery.ts              # 恢复码（12 位短码，服务端存哈希）
│  │  ├─ inflight.ts              # 进行中任务记账，换页/重启后可续看
│  │  ├─ userPhoto.ts / inspirationUpload.ts / payment.ts / weather.ts / auth.tsx
│  └─ theme/                      # 5 套主题 + ThemeProvider
├─ supabase/
│  ├─ migrations/                 # 001 → 020（013–020 已应用到线上，见 docs 迭代报告八 ~ 十四节）
│  └─ functions/                  # tryon / video / chat / payment
├─ docs/                          # 迭代报告、后端路线图、面试材料/（投递与演示用的成品）
├─ scripts/                       # 一次性运维脚本（存量照片迁移等）
├─ app.json / eas.json / package.json
└─ AGENTS.md / .trae/rules/project_rules.md
```

## 三、本地运行

```bash
npm install
npx expo start --web        # 浏览器预览
npx expo start              # 真机/模拟器
npm run typecheck           # tsc --noEmit
```

`.env` 只放两个公开变量（**不要**把服务端密钥放进来）：

```
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

> 改动文件后如果页面没更新：`npx expo start --web --clear` 重启（CI 模式下 Metro 不 watch）。

## 四、数据库与函数

```bash
# 应用新迁移（001 → 022；013 安全收口 / 014 任务锁本人 / 015 灵感关联单品 / 016-019 存储私有化 / 020 恢复码 / 021 背面图 / 022 service_role 写 garments）
supabase db push

# 部署 Edge Functions
supabase functions deploy tryon
supabase functions deploy video
supabase functions deploy chat
supabase functions deploy payment
```

细节与注意事项（应用顺序、前置条件、回滚）见 `docs/后端优化路线图.md`。

## 四、成本与开关（谁在花钱）

| 能力 | 触发 | 单次成本 | 默认策略 |
|---|---|---|---|
| 试衣出图（Aidge AiTryOn） | 用户点「生成试穿效果」 | 约 ¥0.4 / 张 | **核心功能**，一次最多串行 3 件（约 ¥1.2） |
| 试穿出视频（通义万相 wan i2v） | 用户点「生成穿搭视频」 | 约 ¥0.3–0.5 / 5 秒 | **锦上添花**，需用户主动点击，不随试衣自动触发 |
| 穿搭问答（qwen-plus） | 用户发一句话 | 约 ¥0.001 / 次 | 免费，带上风格档案与衣橱上下文 |

省钱开关（都在客户端，不用改后端）：
- 视频默认 `duration: 5`、`resolution: '720P'`，要更快更省可在 `createVideoTask` 传 `resolution: '480P'`。
- 视频默认 `background: 'keep'`（锁原背景）。换背景最容易把人和衣服带崩，所以非 `keep` 才传。
- 试衣串行链最多 3 件（`MAX_STEPS`），超过会提示「一次最多试 3 件」。

## 五、存储与隐私

- `user-media` / `tryon-results` 已私有（017/018/019/020 之后），客户端一律走 `src/lib/supabase.ts` 的签名层（`signStorageUrl` / `resolveDisplayUrls`），库里存的是**规范地址**，只有展示和发给 Edge Function 时才换签名。
- `garments` 桶保持公开（供应商要直接拉商品图）；背面素材走 `garments/<garment_id>/back-*.jpg`。
- **新：视频最后一帧可存为背面素材**（`/functions/v1/garment-back`，Web 端可用），单品有了 `back_image_url` 之后，试衣结果里会出现「看背面实物图」。
- `garments` 表的写权限：`authenticated`（受 admin RLS 约束）+ `service_role`（022 补的 GRANT，给 `garment-back` 用）。

| 桶 | 可见性 | 用途 |
|---|---|---|
| `user-media` | **私有** | 用户全身照。本人可读写；存量 13 条历史照片已迁入（2026-11-17），显示前换 1 小时签名直链 |
| `user-photos` | 公开 | 只剩 6 张历史商品图（供应商要直接下载）；用户照片已全部搬走 |
| `tryon-results` | **私有** | 试穿结果图/视频。`/video` 会用 service_role 现签首帧地址给万相 |
| `inspiration-posts` / `garments` / `poses` | 公开 | 社区流与素材，本来就该公开 |

签名实现在 `src/lib/supabase.ts` 的「私有存储的访问票据」一节：
`signStorageUrl` / `resolveDisplayUrl(s)` / `canonicalStorageUrl` / `parseStorageUrl`。
数据库里存的是**不含 token 的规范地址**，所以不会因为签名过期变成死链；
发给 Edge Function 的 `user_photo_url` 会临时换成签名地址（服务端要能直接下载）。

存量照片的收口步骤见 `docs/迭代报告-2026-11-16.md` 第 10.5 节。

## 六、已知限制

- **匿名登录已开启**（2026-11-16 实测 `POST /auth/v1/signup` → 200，`is_anonymous: true`），App 启动即拿到设备级匿名会话；全身照上传、试穿记录归属都依赖它。
- **013/014/015 已在线上库应用**（执行记录见 `docs/迭代报告-2026-11-16.md` 第八节）。实测收口效果：写别人目录 → 403、删别人文件 → 403、未登录 list 桶 → 空、未登录读 `tryon_tasks` → 0 行。若在新环境重建数据库，直接跑 `supabase/migrations/` 全量（顺序 001 → 015），或粘 `supabase/manual-apply-2026-11-16.sql`。
- **存储私有化已完成**（2026-11-17 实测）：`user-media` / `tryon-results` 均 `public=false`，公开直链返回 400 `Bucket not found`；`garments` / `inspiration-posts` / `poses` / `user-photos` 仍公开（供应商要直接拉图、社区流要公开展示）。
- **匿名用户会累积**：每次重装/换浏览器都会新建一个 `auth.users` 匿名行，建议定期清理 90 天未活跃的。
- **百炼已恢复**（2026-11-16 充值后实测）：`chat` 3.8s 返回中文建议、`video` 提交 5.4s、约 25 分钟后 `result.mp4` 生成完成。仍建议按 `docs/后端优化路线图.md` 做多提供方抽象，避免再次被单一账户卡住；同一场景排队可能长达 20 分钟以上，客户端等待上限已放宽到 30 分钟。
- **天气是链式降级的**：定位 `ipwho.is` → `ipinfo.io`，天气 `open-meteo` → `wttr.in`，失败的供应商冷却 1 小时（`src/lib/weather.ts`）。国内网络下 `open-meteo` 经常整体不可达、`ipwho.is` 会 429，所以别把任何单一接口当硬依赖。
- **APK 只能走 EAS 云构建**（Windows 本地 `assembleRelease` 会因 ninja 路径长度失败）。
- 支付是 mock 通道，上线前必须关闭。
- Web 端与国内网络到 Supabase 偶发 TLS 抖动：客户端已加「6.5s 超时 + 2 次重试 + 中文错误提示」。
