## ADDED Requirements

### Requirement: YouTube 平台搜索计划
系统 SHALL 在搜索计划接口和 discovery 主流程中把 `youtube` 识别为受支持平台，并生成面向 YouTube 频道主页的搜索计划。

#### Scenario: 用户显式选择 YouTube 平台
- **WHEN** 客户端请求 `/api/search/creators` 且 `platform` 为 `youtube`
- **THEN** 响应计划的 `platform` SHALL 为 `youtube`，`searchUrl` SHALL 指向 YouTube 公开搜索页面或 YouTube 频道搜索语义，且返回的打开动作 SHALL 使用 YouTube 平台文案

#### Scenario: Brief 中包含 YouTube 意图
- **WHEN** 用户 brief 明确包含 `youtube` 且请求未显式覆盖其他平台
- **THEN** 规则搜索计划 SHALL 选择 YouTube，并保留用户的垂类、地区、人群、粉丝区间和负向词约束

#### Scenario: YouTube AI 搜索计划降级
- **WHEN** AI 搜索计划不可用、超时或失败
- **THEN** 系统 MUST 使用规则搜索计划继续返回 YouTube plan，不得退回 TikTok 或 X

### Requirement: YouTube 频道主页归一化
系统 SHALL 支持 YouTube 常见公开频道主页形态，并在 direct profile、候选资料和打开主页时保持可访问 URL。

#### Scenario: 识别 @handle 主页
- **WHEN** brief 或候选中出现 `https://www.youtube.com/@somehandle`
- **THEN** 系统 SHALL 将其识别为 YouTube 主页，并保留或生成可打开的 `@handle` profile URL

#### Scenario: 识别 channel/custom/user 主页
- **WHEN** brief 或候选中出现 `/channel/<id>`、`/c/<name>` 或 `/user/<name>` 形态的 YouTube URL
- **THEN** 系统 SHALL 将其识别为 YouTube 主页，并 MUST NOT 错误改写成 `/@channel/<id>`、`/@c/<name>` 或 `@user/<name>`

#### Scenario: 打开 YouTube 创作者主页
- **WHEN** 用户在候选卡片或联系弹窗中打开 YouTube 主页
- **THEN** background SHALL 允许 `youtube.com`、`www.youtube.com` 和 `m.youtube.com` 的创作者主页跳转

### Requirement: YouTube Provider 召回与补全
系统 SHALL 提供 YouTube provider，并通过现有 provider registry 接入搜索、discovery、缓存、日志和用量统计链路。

#### Scenario: 三方数据源召回 YouTube 候选
- **WHEN** 配置了三方数据源并执行 YouTube discovery
- **THEN** provider SHALL 向三方数据源发送 `platform: "youtube"` 及 query、keywords、excludeKeywords、filters、limit，并把返回候选标准化为 `platform: "youtube"`

#### Scenario: 公开网页搜索兜底召回 YouTube 候选
- **WHEN** 未配置三方数据源或三方数据源不可用且允许 fallback
- **THEN** provider SHALL 使用公开网页搜索构造 YouTube 频道主页查询，并返回具备主页 URL 和公开证据的候选

#### Scenario: 补全 YouTube 公开频道资料
- **WHEN** provider 获取到 YouTube 频道主页
- **THEN** 系统 SHALL 尽量补全名称、handle 或频道路径、简介、头像、订阅数、公开邮箱证据和主题标签，并记录 enrichment 状态

### Requirement: YouTube 候选标准化和过滤
系统 SHALL 将 YouTube 候选映射到现有创作者模型，并复用粉丝数、国家、基础特征、质量和 AI 复核过滤。

#### Scenario: 订阅数映射为粉丝规模
- **WHEN** YouTube 候选公开资料包含可解析订阅数
- **THEN** 系统 SHALL 将订阅数写入 `metrics.followers`，用于粉丝下限筛选、排序、展示和导出

#### Scenario: 粉丝数未知时应用现有过滤
- **WHEN** 用户设置粉丝数下限且 YouTube 候选订阅数未知
- **THEN** 系统 SHALL 按现有粉丝数未知规则过滤或降权，不得编造订阅数

#### Scenario: 过滤低证据 YouTube 搜索结果
- **WHEN** 公开网页搜索结果缺少频道主页、名称、简介、订阅数、主题标签或其他可验证公开证据
- **THEN** 系统 SHALL 将候选标记为低证据并过滤或降权，避免把视频页、播放列表、品牌号、新闻媒体或聚合搬运号当作个人创作者

### Requirement: YouTube 前端操作体验
扩展前端 SHALL 在 popup 和 sidepanel 中提供 YouTube 平台入口，并让候选展示、保存、导出和联系弹窗使用一致的平台标签。

#### Scenario: 选择 YouTube 进行全站匹配
- **WHEN** 用户在 popup 或 sidepanel 的目标平台中选择 YouTube 并开始全站匹配
- **THEN** 客户端 SHALL 向后端发送 `platform: "youtube"`，并在结果区展示 YouTube 候选

#### Scenario: 展示和保存 YouTube 候选
- **WHEN** discovery 返回 YouTube 候选
- **THEN** 候选卡片、联系弹窗、保存列表和导出数据 SHALL 显示 YouTube 平台标签，并保留 profileUrl、handle、metrics、tags、quality 和 discovery 证据

#### Scenario: Brief 自动识别 YouTube
- **WHEN** 用户没有手动选择平台但 brief 明确包含 YouTube 意图
- **THEN** 前端平台归一化 SHALL 能选择或保留 YouTube，不得默认覆盖回 TikTok
