## 1. 公网后端配置

- [x] 1.1 新增后端运行配置服务，管理 app env、host、port、CORS origins、鉴权设置、队列设置、用量统计设置和缓存设置。
- [x] 1.2 将后端硬编码监听 host 替换为配置项 `HOST`，同时保留本地开发默认值。
- [x] 1.3 将重复的扩展 API 基础地址常量替换为一个共享扩展配置来源。
- [x] 1.4 新增生产安全的扩展配置或构建步骤，校验 HTTPS API 基础地址。
- [x] 1.5 新增本地和生产 API origins 对应的 manifest host-permission 生成或校验。
- [x] 1.6 扩展 `/health`，安全返回 version、environment、provider、cache 和 queue 元数据。
- [x] 1.7 新增 release 构建/打包命令，执行 CSS 构建、生产配置校验、manifest host permissions 校验，并产出可发布扩展包。
- [x] 1.8 更新 `.env.example` 和部署文档，说明新增配置变量。

## 2. 鉴权和限制

- [x] 2.1 新增本地开发默认值：默认关闭鉴权、IP 限速、每日额度、用户并发限制和队列容量拒绝，除非显式开启。
- [x] 2.2 新增 `Authorization: Bearer <token>` 的 token 身份解析和校验。
- [x] 2.3 在启用鉴权时，在高成本工作开始前保护 `/api/search/creators`、`/api/discover/creators`、`/api/discover/creators/stream` 和 `/api/match/creators`。
- [x] 2.4 为缺少 token、token 非法、限速、每日额度和用户并发失败新增稳定 JSON 错误码和 HTTP 状态。
- [x] 2.5 新增 IP 解析和可配置的 IP 时间窗口请求限制。
- [x] 2.6 新增认证身份每日 discovery 额度检查。
- [x] 2.7 新增认证身份并发 discovery 任务检查。
- [x] 2.8 更新扩展后端客户端，在需要时发送配置的 auth token。
- [x] 2.9 将鉴权、额度和限速错误码映射为简洁中文前端提示。

## 3. Discovery 队列

- [x] 3.1 新增 `DiscoveryQueue` 服务，支持配置最大并发、最大队列长度和队列等待超时。
- [x] 3.2 在 AI planning 或 provider 调用前，让 stream 和 non-stream discovery 端点进入同一个队列。
- [x] 3.3 为 stream discovery 响应发出 `queued` 和 `started` 生命周期事件。
- [x] 3.4 对无法准入的请求返回稳定的队列已满和队列超时错误。
- [x] 3.5 在成功、失败、超时或取消后释放全局和按身份的运行计数。
- [x] 3.6 当 stream 客户端在执行前断开时，取消排队工作并释放资源。

## 4. 用量统计

- [x] 4.1 新增请求级 usage context，绑定 request ID 和认证身份。
- [x] 4.2 新增开发 JSONL usage sink 和生产共享 usage sink 接口。
- [x] 4.3 记录 discovery 状态、平台、请求 limit、候选数量、开始时间、结束时间和耗时。
- [x] 4.4 埋点 AI planning、web search、三方搜索、资料补全和 AI review 的计数/耗时。
- [x] 4.5 确保用量记录不包含 API key、bearer token 或完整敏感 prompt。
- [x] 4.6 新增按身份和平台汇总每日用量的 helper。

## 5. 分布式缓存和 Redis

- [x] 5.1 在统一后端接口后新增 memory 和 Redis 缓存/计数器适配器。
- [x] 5.2 新增 Redis 连接校验，以及 Redis 必需时的生产失败行为。
- [x] 5.3 将三方 discovery 成功结果和可缓存错误缓存迁移到适配器。
- [x] 5.4 将 AI plan cache 迁移到适配器，并支持可配置 TTL。
- [x] 5.5 通过适配器存储 IP 限速窗口、每日额度计数和用户并发计数。
- [x] 5.6 使用稳定 namespace key，并使用 hash 或规范化后的非密输入。
- [x] 5.7 在 `/health` 中报告缓存驱动和 Redis 可用性，不暴露凭据。

## 6. 验证和文档

- [x] 6.1 新增运行配置校验和生产 HTTPS 强制规则的单元测试。
- [x] 6.2 新增本地开发默认绕过限制的单元测试。
- [x] 6.3 新增鉴权中间层、token 身份、限速错误和额度错误的单元测试。
- [x] 6.4 新增队列准入、队列容量、队列超时和取消清理的单元测试。
- [x] 6.5 新增用量记录创建和密钥脱敏的单元测试。
- [x] 6.6 新增 memory cache adapter 和 Redis adapter 行为单元测试；Redis 不可用时使用 test double。
- [x] 6.7 运行 `npm run check` 和 `npm test`。
- [x] 6.8 记录 v1.1 部署路径、release 构建命令、必需环境变量和本地冒烟命令。
