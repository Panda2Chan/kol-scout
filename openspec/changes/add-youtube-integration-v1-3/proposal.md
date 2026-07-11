## 为什么

KOL Scout 当前真实可用的平台能力集中在 TikTok 和 X，无法覆盖出海团队常见的 YouTube 创作者发现、筛选和线索整理场景。v1.3 需要把 YouTube 接入现有搜索计划、discovery、候选复核、保存导出和主页打开链路，并同步版本号与变更记录，避免代码能力和发布信息继续漂移。

## 变更内容

- 新增 YouTube 平台接入，支持从 brief、平台选择和 API 请求中识别 `youtube`，并生成 YouTube 创作者搜索计划。
- 新增 YouTube provider，复用现有三方数据源优先、公开网页搜索兜底、资料补全、缓存、AI 复核和质量过滤链路。
- 扩展前端平台选择、平台标签、候选卡片、联系弹窗、保存/导出和打开主页能力，使 YouTube 与 TikTok、X 一致参与主流程。
- 扩展 background 主页跳转白名单，允许打开 YouTube 频道、handle 或用户主页。
- 更新 v1.3 发布元数据：同步 `package.json`、`package-lock.json`、`manifest.json`、后端 `/health` 版本兜底、README 能力描述，并在 `CHANGELOG.md` 记录本次变更。
- 补充 YouTube 搜索计划、provider 解析、discovery 主链路、前端平台归一化和版本元数据相关验证。

## 能力范围

### 新增能力

- `youtube-creator-discovery`：覆盖 YouTube 平台的搜索计划、provider 召回、公开资料补全、候选标准化、前端平台选择、主页打开、保存导出和降级行为。

### 修改能力

本变更不修改现有 OpenSpec 能力的用户契约；v1.3 版本号、changelog 和 README 属于发布元数据任务，纳入 tasks 验收，不单独建立长期能力规格。

## 影响范围

- 后端搜索计划与 AI 规划：
  - `backend/services/match-service.js`
  - `backend/services/ai-search-service.js`
- 后端 discovery 编排、缓存、用量和 provider 注册：
  - `backend/services/discovery-service.js`
  - `backend/platforms/registry.js`
  - 新增 `backend/platforms/youtube-provider.js`
  - `backend/server.js`
- 扩展前端和共享模型：
  - `src/shared/schema.js`
  - `src/shared/backend-api.js`
  - `src/background/service-worker.js`
  - `src/sidepanel/sidepanel.js`
  - 必要时同步 `src/popup/popup.js`
- 发布元数据与文档：
  - `package.json`
  - `package-lock.json`
  - `manifest.json`
  - `backend/services/config-service.js`
  - `README.md`
  - `CHANGELOG.md`
- 测试：
  - 新增 YouTube provider 测试
  - 扩展 match、AI search、discovery、schema/background 和 release metadata 相关测试
