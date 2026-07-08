## 为什么

KOL Scout 1.0 仍然假设后端只在本地运行，调用方也默认可信。如果直接暴露到公网，AI 和搜索 API 额度很容易被滥用，多实例部署也缺少可靠的共享状态。

v1.1 要把 MVP 推进到“小流量公网可用”的候选版本，补齐配置化部署、高成本接口保护、全站发现并发控制、用量可观测和共享缓存基础设施。

## 变更内容

- 后端 API 地址、后端监听地址、生产 HTTPS 域名和扩展 `host_permissions` 支持配置化，不再靠改源码切环境。
- 高成本后端接口需要鉴权，并通过稳定错误码执行 IP、用户每日额度和用户并发限制。
- discovery 请求进入全局服务队列，统一限制不同用户和不同请求模式下的并发工作量。
- 按请求、用户或 token、平台和 provider 阶段记录结构化 API 用量与耗时。
- 生产缓存和计数器从进程内状态迁移到 Redis 适配器，同时保留本地开发的内存 fallback。

## 能力范围

### 新增能力
- `public-backend-config`：覆盖生产 API URL 配置、生产 HTTPS 访问、host permissions、后端监听 host/port 和健康检查自检。
- `api-access-control`：覆盖 token 鉴权、高成本接口保护、IP 限速、用户每日额度和用户并发任务限制。
- `discovery-queue`：覆盖全局 discovery 任务队列、服务级并发限制、队列状态事件、超时处理和取消行为。
- `api-usage-metering`：覆盖单请求用量记录、provider 调用计数、耗时指标、状态/错误采集和成本汇总基础。
- `distributed-cache`：覆盖内存/Redis 缓存适配器、共享缓存 key、TTL 配置、额度计数存储和 Redis 健康/降级规则。

### 修改能力

当前仓库还没有已归档的 OpenSpec 能力；本变更会建立第一组 v1.1 能力规格。

## 影响范围

- 扩展前端 API 客户端：
  - `src/shared/backend-api.js`
  - `src/background/service-worker.js`
  - `manifest.json`
- 后端 HTTP 接口：
  - `backend/server.js`
  - `/api/search`、`/api/discover`、`/api/match` 下的高成本接口
  - `/health`
- 后端服务：
  - discovery 编排
  - discovery 缓存
  - 日志和 request ID 链路
  - 新增鉴权、限流、用量统计、队列和缓存适配器服务
- 配置与运维：
  - `.env.example`
  - README 或部署文档
  - 用于开发/生产 manifest 或配置生成的 package scripts
- 依赖：
  - Redis 客户端包，或等价的生产缓存/限流存储网络依赖。
