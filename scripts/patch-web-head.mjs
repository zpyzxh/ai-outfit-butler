#!/usr/bin/env node
/**
 * 往导出的 dist/index.html 里注入 PWA / 手机端需要的 head 标签。
 *
 * 为什么需要这一步：`web.output: "single"`（经典 SPA 外壳）下，Expo Router 的
 * `app/+html.tsx` 不参与生成——它只在 `output: "static"`（SSG）时生效。
 * 而改成 static 会把每个路由都在构建期渲染一遍，这个项目里用到了
 * AsyncStorage / window 之类只能在浏览器里跑的东西，风险不值得。
 * 所以这里做一次确定性的后处理：只改 head，不动任何 JS。
 *
 * 用法：node scripts/patch-web-head.mjs [distDir]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2] || 'dist';
const file = resolve(dir, 'index.html');

if (!existsSync(file)) {
  console.error(`[patch-web-head] 找不到 ${file}，先跑 expo export --platform web`);
  process.exit(1);
}

let html = readFileSync(file, 'utf8');

/** 加在 </head> 之前的标签；相对路径（./）是为了兼容 Pages 的子路径部署 */
const TAGS = `
    <!-- 手机端：添加到主屏幕后像 App 一样独立运行（由 scripts/patch-web-head.mjs 注入） -->
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
    <meta name="theme-color" content="#111113" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="穿搭管家" />
    <meta name="format-detection" content="telephone=no" />
    <link rel="manifest" href="./manifest.json" />
    <link rel="apple-touch-icon" href="./apple-touch-icon.png" />
    <link rel="icon" type="image/png" href="./icon-192.png" />
    <style>html,body{background-color:#FFFFFF;}body{overscroll-behavior-y:none;}</style>
`;

if (html.includes('apple-mobile-web-app-capable')) {
  console.log('[patch-web-head] 已经注入过，跳过');
  process.exit(0);
}

// 1) 语言标记
html = html.replace('<html lang="en">', '<html lang="zh-CN">');

// 2) 去掉原来那条没有 viewport-fit 的 viewport，交给新标签统一描述
html = html.replace(/\s*<meta name="viewport"[^>]*\/?>\n?/g, '\n');

// 3) 注入
html = html.replace('</head>', `${TAGS}  </head>`);

writeFileSync(file, html, 'utf8');
console.log(`[patch-web-head] 已注入 head 标签 → ${file}`);
