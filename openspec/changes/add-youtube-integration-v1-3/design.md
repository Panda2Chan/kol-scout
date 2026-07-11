## 背景

KOL Scout 当前后端 provider registry 只注册 TikTok 和 X。`/api/search/creators` 负责生成搜索计划和打开动作，`/api/discover/creators` 与 stream 入口共用 discovery 主流程：规则计划、AI 搜索计划、provider 召回、缓存、候选标准化、规则评分、AI 复核、硬过滤和排序。

代码里已经有少量 YouTube 痕迹：brief parser 可以识别 `youtube`，统一 schema 有 YouTube label，content detector 也能从 YouTube 页面提取频道信息。但 YouTube 没有后端 provider、没有注册到 discovery registry，AI plan 仍会把非 TikTok 平台落到 X/Twitter prompt，前端平台下拉也只暴露 TikTok / X。

v1.3 要把 YouTube 做成一等平台，而不是只补一个前端选项。版本号和 changelog 也必须同步更新，避免当前 changelog 已记录 v1.1、但 package/manifest 仍停在 1.0 的漂移继续扩大。

## 目标 / 非目标

**目标：**

- `/api/search/creators`、`/api/discover/creators` 和 `/api/discover/creators/stream` 支持 `platform=youtube`。
- YouTube 有独立 provider，支持三方数据源优先、公开网页搜索兜底和公开频道资料补全。
- YouTube 搜索计划和 AI prompt 使用 YouTube 专属规则，不复用 X/Twitter 语义。
- YouTube 候选统一进入现有候选模型，订阅数映射为 `metrics.followers`，从而复用粉丝下限、质量过滤、保存、导出和用量统计。
- 前端 popup 和 sidepanel 可以选择 YouTube，并以正确平台标签、主页打开和保存/导出行为展示候选。
- v1.3 发布元数据同步到 package、lockfile、manifest、健康检查兜底、README 和 changelog。

**非目标：**

- 不接入 YouTube Data API，不新增 Google OAuth 或 API key 管理。
- 不抓取登录后内容、不绕过平台访问限制、不采集非公开资料。
- 不实现视频级深度分析、评论抓取、频道历史增长曲线或互动率精算。
- 不重构现有 discovery 队列、鉴权、用量统计和缓存基础设施。
- 不把 Instagram、LinkedIn 等其他平台顺手接入。

## 技术决策

### 决策 1：YouTube 进入现有 provider registry

新增 `youtubeProvider` 并注册到 `createPlatformRegistry()`，保持与 TikTok、X 一致的 provider 契约：`platform`、`sourceName`、`buildSearchUrl`、`buildProfileUrl`、`discoverCreators`、`enrich`。

备选方案：在 discovery-service 里为 YouTube 写平台分支。这样短期代码少，但会绕开 provider 抽象，让缓存、日志、usage 和后续平台扩展变得更难维护。

### 决策 2：YouTube provider 不新增外部依赖

provider 先复用现有两层召回策略：

- 配置了 `KOL_DATA_API_URL` 时，向三方数据源发送 `platform: "youtube"`、query、keywords、excludeKeywords、filters 和 limit。
- 未配置三方数据源时，使用公开网页搜索兜底，优先构造 `site:youtube.com/@`、`site:youtube.com/channel`、`site:youtube.com/c`、`site:youtube.com/user` 查询，并解析可验证的频道主页候选。

备选方案：直接接 YouTube Data API。它能提供更稳定的结构化数据，但需要 Google API key、额度治理和服务条款评估，不适合 v1.3 的最小接入目标。

### 决策 3：频道 URL 形态必须显式建模

YouTube 主页不像 TikTok/X 只有单一 handle 形态。实现需要支持并保留以下公开主页：

- `https://www.youtube.com/@handle`
- `https://www.youtube.com/channel/<channelId>`
- `https://www.youtube.com/c/<customName>`
- `https://www.youtube.com/user/<userName>`

`buildProfileUrl` 只能把明确的 handle 规范化为 `/@handle`；对 channel/custom/user URL 应保留原始主页路径，不能错误拼成 `/@channel/<id>`。

备选方案：只支持 `@handle`。这样实现最简单，但会漏掉大量仍以 channel/custom/user 路径曝光的频道，也会影响 direct profile brief。

### 决策 4：订阅数复用 `metrics.followers`

候选模型继续使用 `metrics.followers` 作为跨平台“关注/订阅规模”字段。YouTube provider 在能确认订阅数时把 subscribers 转成数字写入 `metrics.followers`，并可在 discovery evidence 中保留原始文本。

备选方案：新增 `metrics.subscribers`。字段语义更精确，但前端、过滤、导出、AI 复核和质量评分都要同时理解两个规模字段，扩大改动面。

### 决策 5：AI 搜索计划增加 YouTube 专属 prompt

`buildSearchPlanSystemPrompt` 需要从二分的 TikTok/X 逻辑扩展为平台 prompt map。YouTube prompt 应要求 query 面向频道主页和 creator/influencer，不编造频道 handle，不编造订阅数、邮箱或地区，并保留现有负向词和质量信号约束。

AI Web Search prompt 也应能按平台生成 YouTube profile hint，即使 v1.3 仍优先通过 provider fallback 召回，也避免后续开启 YouTube AI Web Search 时复用 X/Twitter 文案。

备选方案：让 YouTube 暂时复用 X/Twitter prompt。这样开发更快，但会生成 `site:x.com` 或 Twitter 语义查询，直接损害 YouTube 召回质量。

### 决策 6：质量过滤复用主流程，但补 YouTube 公开证据门槛

YouTube 候选仍通过 `normalizeDiscoveredCreator`、`matchCreators`、`postProcessCreatorsWithAi` 和 `getFilteredReason`。公开网页搜索候选必须至少具备主页 URL，以及名称、简介、订阅数、标签、公开 evidence 中的若干证据，避免搜索结果标题被误当作真实 KOL。

备选方案：完全相信搜索结果。召回量更高，但会把播放列表、品牌频道、新闻媒体或视频页作者标题混入候选。

### 决策 7：v1.3 版本号统一使用 `1.3.0`

`package.json`、`package-lock.json`、`manifest.json` 和后端版本兜底统一到 `1.3.0`。Chrome manifest 支持三段数字版本，统一三段可以减少 package 和扩展版本的认知差异。`CHANGELOG.md` 按当前格式新增 2026-07-09 的 v1.3 小节。

备选方案：manifest 使用 `1.3`，package 使用 `1.3.0`。这符合当前文件风格，但版本同步检查会更容易出现例外。

## 风险 / 取舍

- YouTube 公开页面结构变化频繁 -> provider 解析必须容忍缺字段，用 evidence 和 enrichment status 表明可信度。
- 公开网页搜索结果可能返回视频页、播放列表或品牌频道 -> URL 归一化和候选质量门槛必须过滤非频道主页和低证据结果。
- 未使用 YouTube Data API 会降低订阅数稳定性 -> v1.3 接受“订阅数未知但可降权/过滤”，不编造订阅数。
- AI prompt 新增平台分支可能影响现有 TikTok/X -> 保留现有 prompt 文案，并用单元测试锁定 TikTok/X 关键输出。
- 前端平台默认值变化可能影响已有用户习惯 -> 默认仍保持 TikTok，只有用户显式选择或 brief 明确出现 YouTube 时使用 YouTube。
- 版本号从 1.0 直接到 1.3.0 会暴露历史漂移 -> changelog 保留 v1.1 记录，并在 v1.3 小节明确本次发布范围。

## 迁移计划

1. 增加 YouTube 平台归一化、direct profile 提取和 provider 注册，先让 `/api/search/creators` 能返回 YouTube 搜索计划和打开动作。
2. 新增 YouTube provider 的三方数据源路径、公开网页搜索 fallback、频道 URL 归一化和公开资料补全。
3. 接入 discovery 主流程，补齐缓存、usage stage、AI review、粉丝下限和质量过滤验证。
4. 更新 popup、sidepanel、background 白名单和共享 schema，让 YouTube 可被选择、展示、打开、保存和导出。
5. 同步 v1.3 版本元数据、README 和 changelog。
6. 跑 `npm run check`、`npm test`，并对 `/api/search/creators` 与 `/api/discover/creators` 做 YouTube 冒烟验证。

回滚时可以从 registry 移除 YouTube provider 和前端选项，并恢复版本元数据到上一发布版本。已保存的 YouTube 候选仍是普通本地存储记录，不应阻塞回滚。

## 待确认问题

- 三方数据源是否已经接受 `platform: "youtube"`，返回字段是否与 TikTok/X 一致？
- v1.3 是否需要在发布包中增加 `version_name`，展示更友好的 `1.3`？
- YouTube 公开搜索 fallback 首选哪些搜索源配置，是否需要为 Jina/Serper/Brave 分别设平台级开关？
