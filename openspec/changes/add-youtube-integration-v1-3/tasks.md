## 1. YouTube 平台基础与搜索计划

- [x] 1.1 在后端平台归一化中正式支持 `youtube`，并补充 `yt`、`YouTube` 等常见输入别名。
- [x] 1.2 扩展 brief 解析和搜索 stopwords，确保 YouTube 平台词不会污染 creator keywords。
- [x] 1.3 为 YouTube direct profile 提取支持 `@handle`、`/channel/<id>`、`/c/<name>`、`/user/<name>` URL。
- [x] 1.4 新增 YouTube 专属 AI 搜索计划 prompt，并将 prompt 选择从 TikTok/X 二分改为按平台映射。
- [x] 1.5 更新 AI Web Search prompt 的平台描述和 profile hint，使 YouTube 不复用 X/Twitter 文案。
- [x] 1.6 扩展 match-service 和 ai-search-service 单元测试，覆盖 YouTube 平台识别、direct profile、AI 降级和 TikTok/X 回归。

## 2. YouTube Provider

- [x] 2.1 新增 `backend/platforms/youtube-provider.js`，实现 provider 契约：`platform`、`sourceName`、`buildSearchUrl`、`buildProfileUrl`、`discoverCreators`、`enrich`。
- [x] 2.2 实现 YouTube profile URL 归一化，确保 `@handle`、channel、custom、user 路径都能保留可访问主页。
- [x] 2.3 实现三方 HTTP 数据源召回，请求体发送 `platform: "youtube"`、query、keywords、excludeKeywords、filters 和 limit。
- [x] 2.4 实现公开网页搜索 fallback，构造 YouTube 频道主页查询并过滤视频页、播放列表、品牌页和低证据搜索结果。
- [x] 2.5 实现公开频道资料补全，提取名称、简介、头像、订阅数、邮箱证据、标签和 enrichment 状态。
- [x] 2.6 将 YouTube 订阅数解析为数字并写入 `metrics.followers`，保留无法确认时的 null 语义。
- [x] 2.7 新增 YouTube provider 单元测试，覆盖搜索 URL、profile URL、候选解析、订阅数解析、fallback 和 enrich。

## 3. Discovery 主流程接入

- [x] 3.1 在 `backend/platforms/registry.js` 注册 YouTube provider，并确保 `/api/search/creators` 可返回 YouTube 搜索动作。
- [x] 3.2 确认 YouTube discovery 复用现有缓存 key、usage stage、logger 和 stream candidate 事件。
- [x] 3.3 为 YouTube 网页搜索候选增加最小公开证据门槛，避免低证据结果直接通过硬过滤。
- [x] 3.4 确认粉丝数下限、国家筛选、基础特征、质量分、AI 复核和最终排序对 YouTube 候选生效。
- [x] 3.5 扩展 discovery-service 测试，覆盖 YouTube provider 注册、成功召回、缓存命中、粉丝下限和低证据过滤。

## 4. 扩展前端与主页打开

- [x] 4.1 在 popup 和 sidepanel 平台下拉中新增 YouTube，并保持默认平台仍为 TikTok。
- [x] 4.2 更新 popup 和 sidepanel 的平台归一化、平台标签和 brief 自动识别逻辑，支持 YouTube 意图。
- [x] 4.3 确认 YouTube 候选卡片、联系弹窗、保存列表和导出数据展示正确平台标签与 profileUrl。
- [x] 4.4 更新 background 主页打开白名单和错误文案，允许 `youtube.com`、`www.youtube.com`、`m.youtube.com` 创作者主页。
- [x] 4.5 检查 content detector 的 YouTube URL 处理，修正会把 channel/custom/user 路径误拼成 `@handle` 的场景。
- [x] 4.6 补充前端共享 schema、background 或 detector 相关测试/静态校验，覆盖 YouTube 标签、跳转和保存导出兼容性。

## 5. v1.3 发布元数据与文档

- [x] 5.1 将 `package.json` 版本更新为 `1.3.0`。
- [x] 5.2 同步 `package-lock.json` 根版本和 package 版本为 `1.3.0`。
- [x] 5.3 将 `manifest.json` 扩展版本更新为 `1.3.0`。
- [x] 5.4 将后端 `/health` 版本兜底更新为 `1.3.0`，确保直接 `node backend/server.js` 启动时版本不回落到 1.0。
- [x] 5.5 更新 README 当前能力描述，把 YouTube 纳入 v1.3 支持平台。
- [x] 5.6 按现有格式在 `CHANGELOG.md` 新增 2026-07-09 的 `feat: 发布 KOL Scout v1.3 YouTube 接入` 记录。

## 6. 验证

- [x] 6.1 运行 `npm run check`，确认 JS 语法和 manifest JSON 校验通过。
- [x] 6.2 运行 `npm test`，确认现有与新增单元测试通过。
- [x] 6.3 手测 `/api/search/creators` 的 YouTube 请求，确认返回 YouTube plan、searchUrl 和 directProfileUrls。
- [x] 6.4 手测 `/api/discover/creators` 或 stream 的 YouTube 请求，确认返回候选、summary、cache/usage 元数据和过滤结果。
- [x] 6.5 手测扩展 sidepanel 选择 YouTube 的全站匹配、保存候选、打开主页和导出数据流程。
