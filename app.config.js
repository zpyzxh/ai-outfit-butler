// 动态配置：在 app.json 之上只补「Web 静态部署」需要的两项。
// 本地开发不设 EXPO_BASE_URL，一切照旧；GitHub Pages 子路径部署时由 CI 注入。
module.exports = ({ config }) => {
  const baseUrl = (process.env.EXPO_BASE_URL || "").trim();

  return {
    ...config,
    web: {
      ...(config.web ?? {}),
      // SPA 单页输出：dist/ 里只有一套 index.html + 打包好的 js/css
      output: "single",
      bundler: "metro",
    },
    experiments: {
      ...(config.experiments ?? {}),
      // 只有显式给了前缀才写，避免本地 `http://localhost:8081/` 变成 `/repo/`
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
};
