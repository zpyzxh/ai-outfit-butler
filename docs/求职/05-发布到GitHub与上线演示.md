# 发布到 GitHub + 上线 Web 演示

> 目标：得到两个链接——**一个能点开就用的演示站**，**一个能看源码的仓库**。简历里就放这两个。
>
> 现状：**本地已经能打出静态站并跑通**（`expo export -p web` → `dist/`，本地起静态服务后 `/outfits` 深链、14 张图 0 裂图）。缺的只有「推到 GitHub」这一步。

---

## 0. 已经准备好的东西

| 文件 | 作用 |
|---|---|
| `app.config.js` | 动态配置：本地不设 `EXPO_BASE_URL` 时行为完全不变；CI 注入子路径时自动加 `baseUrl` |
| `.github/workflows/deploy-web.yml` | 推 main 自动构建 + 发布 GitHub Pages，含 SPA 深链兜底（`dist/404.html`） |
| `.env.example` | 告诉别人要填哪两个变量 |
| `.env.demo` | 演示构建用（anon key 本身就是公开凭证，安全边界在 RLS，不在这个 key） |
| `.gitignore` | 已忽略 `node_modules/`、`.expo/`、`dist/`、`.env` —— 仓库里不会混进依赖和私密配置 |

---

## 0.5 已经本地验证过的（所以在 Pages 上大概率一次成功）

| 验证项 | 结果 |
|---|---|
| `expo export --platform web` | ✅ 13 个 bundle + `index.html`，2 分半完成 |
| 静态站独立运行（不经 Metro） | ✅ `.tools/serve-dist.mjs` 起在 `:8090`，`/outfits` 深链直开 |
| 图片 | ✅ 14 张，0 裂图 |
| 真实后端数据 | ✅ 灵感流 6 条、搭配 3 套均来自线上 Supabase |
| 环境变量内联 | ✅ 打包产物里能搜到项目域名 |
| 天气链 | ✅ 新 origin 首屏显示「18° 阴」（顺手修了一个「新设备永远天气不可用」的 bug，见迭代报告第 28 节） |
| **Pages 子路径** | ✅ 用 `EXPO_BASE_URL=/ai-outfit-butler` 重导一份，再用 `.tools/serve-dist.mjs <root> 8091 /ai-outfit-butler` 在本机拟合 Pages 行为：`/ai-outfit-butler/outfits` 直开、14 张图 0 裂图、`_expo/...js` 返回 `text/javascript`、`/` 返回 404 不影响） |

> 到这一步，「能不能在 Pages 上跑」已经不是未知数；剩下只有「workflow 能不能在 GitHub 的 runner 上重现同一件事」。万一 Pages 上 404，看第 4 节 Q2。

---

## 0.9 现在最快的路：你只建仓，我 push（git 已装好）

本机现在有 git 了（PortableGit 2.56.1，`.tools/git/cmd/git.exe`，带 Git Credential Manager）：
仓库已 `git init` 并完成两次提交（`9ec1f63` 主体 + `7597d40` 忽略构建产物），115 个文件已入库，`.env` / `node_modules` / `dist` 都没进去。

你只需：

1. 打开 <https://github.com/new>，仓库名 **`ai-outfit-butler`**，选 **Public**，**不要**勾 README
2. 回我一句「建好了」（顺便告诉我你的用户名）

然后我执行：

```bash
git remote add origin https://github.com/<用户名>/ai-outfit-butler.git
git push -u origin main
```

push 时 Git Credential Manager 会弹出浏览器让你登录 GitHub（一次授权即可），之后 workflow 自动建站、自动开 Pages。

---

## 1. 路线 A：只给 Token（不需要弹浏览器）

适合「不想在这台机器上登录 GitHub」的情况：用 GitHub REST API 建仓、上传源码、开 Pages。

### 你要做的（2 分钟）

1. 打开 <https://github.com/settings/tokens/new>（登录 `17728296846@163.com` 对应的账号）
2. **Note** 填 `dsh-deploy`，**Expiration** 选 `7 days`
3. 勾选两个 scope：
   - ☑ `repo`（建仓、写文件、开 Pages）
   - ☑ `workflow`（提交 `.github/workflows/` 下的文件必须勾这个，否则 GitHub 会拒绝）
4. 点 **Generate token**，把 `ghp_` 开头的字符串发给我
5. 发完就可以**立刻不用管了**，我做完你再回来看；用完建议直接 Revoke（设置页里同一个 token 右侧有 Delete）

### 我拿到 Token 后会做的事

1. `POST /user/repos` 建仓库 `ai-outfit-butler`（public，带描述和 topics）
2. 用 Git Data API 上传全部源码（`src/`、`supabase/`、`assets/`、`docs/`、`scripts/`、配置与 `.github/`；**不含** `node_modules/`、`.expo/`、`dist/`、`.env`）
3. 提交一条真实 commit message
4. `POST /repos/{owner}/{repo}/pages` 把 Pages 的 Source 设成 "GitHub Actions"
5. 触发一次 workflow，等它跑完，把最终地址给你（`https://<你的用户名>.github.io/ai-outfit-butler/`）
6. 顺手验证：打开演示地址截图，`/outfits` 深链能直接打开（Pages 的 SPA 兜底是否生效）

> 你也可以**不给 token**，走路线 B，效果完全一样，只是要点十几下。

---

## 2. 路线 B：你自己点（约 12 分钟，不用装 git）

### 2.1 建仓库

1. 打开 <https://github.com/new>
2. Repository name 填 **`ai-outfit-butler`**（名字要记住，后面 URL 里有它）
3. 选 **Public**（Private 的 Pages 要付费）
4. **不要**勾 "Add a README file"（否则会和本地 README 冲突）
5. Create repository

### 2.2 上传源码

**不要**把整个项目文件夹拖进去（会带上 `node_modules`，几十万个文件，必失败）。

在文件资源管理器里进到项目根目录，**只选中下面这些**，一起拖到 GitHub 页面的上传区：

```
app.config.js  app.json  eas.json  package.json  package-lock.json
tsconfig.json  .gitignore  .env.example  .env.demo  LICENSE
README.md  ADMIN_SETUP.md  AGENTS.md
assets/  src/  supabase/  scripts/  docs/  .github/
```

> 拖 `.github/` 时 Windows 资源管理器可能因为「以点开头」不显示：先在文件夹选项里打开「显示隐藏文件」，或者用 WinRAR/7-Zip 把 `.github` 作为压缩包拖进去。

**如果 GitHub 提示「无法上传超过 100 个文件」**：分两次传，先传根目录文件 + `assets/`，再传 `src/`、`supabase/`、`docs/`。

### 2.3 加两个 Secret（可选但建议）

`Settings → Secrets and variables → Actions → New repository secret`：

| Name | Value |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | `https://ydcajujmhlksjgrhjgtl.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `.env` 里那串 `eyJhbGci...` |

> 不加也能跑：workflow 会自动回落到仓库里的 `.env.demo`。

### 2.4 打开 Pages

`Settings → Pages → Build and deployment → Source` 选 **GitHub Actions**（不要选 "Deploy from a branch"）。

### 2.5 等构建

`Actions` 标签页会看到 `Deploy web demo to GitHub Pages` 在跑，约 2–4 分钟。绿勾后地址是：

```
https://<你的用户名>.github.io/ai-outfit-butler/
```

---

## 3. 上线后必须自查的 5 条

| 检查 | 怎么查 | 不合格的表现 |
|---|---|---|
| 1. 首页能出图 | 打开地址，看灵感流有没有图片 | 白屏或裂图 |
| 2. 深链能直开 | 直接访问 `.../outfits`、`.../profile` | 404（说明 `404.html` 兜底没生成） |
| 3. 资源路径带前缀 | 右键查看某张图片地址 | 少了 `/ai-outfit-butler/` 前缀（说明 `baseUrl` 没生效） |
| 4. 能连数据库 | 首页出现「共 N 条灵感」且不是 0 | 一直骨架屏 / 报错（说明 `.env` 没进构建） |
| 5. 手机能开 | 用手机浏览器打开同一地址 | 布局错位（底栏 5 个入口应全部可见） |

---

## 4. 常见问题

**Q. Pages 显示 404，但 Actions 是绿的？**
`Settings → Pages` 里的 Source 没选成 "GitHub Actions"，或者首次部署还没完成（等 1 分钟刷新）。

**Q. 页面白屏、控制台报 404 找不到 `_expo/static/...`？**
`baseUrl` 没生效。确认 workflow 的 "Resolve base path" 步骤输出是 `/<repo>`，并且 `app.config.js` 在仓库里（不是只有 `app.json`）。

**Q. 深链 404？**
`dist/404.html` 没生成。workflow 里有 `cp dist/index.html dist/404.html`，确认它没被删；手改时保留这一行。

**Q. 上传时 GitHub 报 `Yowza, that's a lot of files`？**
说明把 `node_modules` 拖进去了。删掉仓库重来，只传第 2.2 节列的那些。

**Q. 演示站想改成我自己的 Supabase 项目？**
改 `.env.demo` 两个变量，或者配仓库 Secrets（优先级更高），推一次就重新构建。

---

## 5. 上线之后简历怎么写

一句话版本（放项目标题下面）：

> 在线演示：`https://<user>.github.io/ai-outfit-butler/`　·　源码：`https://github.com/<user>/ai-outfit-butler`

如果对方问「这是真上线还是本地跑的」，直接答：

> 「前端是静态部署在 GitHub Pages，后端是 Supabase 的真实项目（数据库、存储、Edge Functions 都是线上跑），试衣和视频走的是真实供应商接口，所以生成一张确实要花四毛钱。」——这句话比任何形容词都有说服力。
