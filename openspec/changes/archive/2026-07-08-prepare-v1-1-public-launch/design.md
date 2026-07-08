## 背景

KOL Scout 1.0 由 Chrome 扩展和 Node HTTP 后端组成。扩展目前在 popup 侧共享 API 客户端和 background service worker 中都调用 `http://127.0.0.1:8787`。后端监听 `127.0.0.1`，CORS 放开为 `*`，高成本 AI/search 接口没有鉴权和公网限流。

Discovery 现在已经有 provider 内部并发控制和部分请求日志，但没有服务级全局队列、用户额度、结构化成本账本，生产缓存也仍然是进程内 `Map`。如果直接公网部署，多个用户或多个后端实例会很难安全运营。

## 目标 / 非目标

**目标：**

- 本地、测试、生产 API 地址可配置，不需要修改源码。
- 用 token 鉴权和稳定错误契约保护高成本后端接口。
- 用 IP、用户每日额度、用户并发任务限制降低滥用风险。
- 本地开发默认不启用公网鉴权、限流、额度和队列容量限制，除非开发者显式开启。
- 用共享队列限制 discovery 工作量，并为 stream / non-stream 调用提供清晰队列状态。
- 增加结构化用量统计，记录 provider 调用、任务耗时、结果数量和失败状态。
- 为生产环境引入 Redis 缓存/计数器支持，同时保留本地开发内存 fallback。

**非目标：**

- 完整注册登录、团队管理或付费套餐。
- 用量管理后台。
- Chrome Web Store 上架材料。
- 已保存 KOL 列表云同步。
- 用新 Web 框架重写后端。

## 技术决策

### 决策 1：后端继续保持轻框架，但增加中间层风格 helper

v1.1 后端继续使用 Node 内置 HTTP server。鉴权、限流、请求上下文、队列准入和错误响应等横切逻辑抽成小型后端服务，而不是现在引入 Express/Koa。

备选方案：现在迁移到 Web 框架。这样中间件模型更熟悉，但会在产品流量模式尚未验证前扩大迁移面。

### 决策 2：后端运行配置和扩展生成配置都走统一入口

后端配置集中到 config service，在启动时校验 `APP_ENV`、`HOST`、`PORT`、CORS origins、鉴权开关、额度限制、Redis 设置、队列设置和用量统计设置。

扩展 API 配置来自生成文件或环境专属配置文件，并同时被 `src/shared/backend-api.js` 和 `src/background/service-worker.js` 使用。生产构建必须指向 HTTPS API URL，并包含匹配的 `host_permissions`。

备选方案：继续在 popup 和 background 中保留各自常量。这样改动小，但已经存在漂移风险，也阻碍环境切换。

### 决策 3：先使用 token 鉴权，但抽象成 token 身份

v1.1 受保护接口接收 `Authorization: Bearer <token>`。合法 token 解析成稳定的 `tokenId` 或 `userId`，用于额度、队列和用量记录。第一版公网测试可以从环境变量定义 token；服务边界要允许后续替换成用户系统。

备选方案：现在直接做完整用户鉴权。这个方向后续有价值，但不是小流量 beta 安全运行的必要条件。

### 决策 3.1：本地开发默认关闭公网限制

`APP_ENV=development` 默认不要求 bearer 鉴权、IP 限流、每日额度、用户并发限制或队列容量拒绝。开发者必须能在本地反复调试 discovery，而不需要先配置额度。每个保护项仍需要显式本地开关或测试配置，以便自动化测试覆盖。

备选方案：所有环境使用同一套限制。这样更早接近生产行为，但会拖慢本地调试，在调 prompt 和 provider 时制造迷惑性失败。

### 决策 4：限流、队列计数、用量和缓存使用共享存储接口

实现需要提供明确适配器：

- 本地开发和测试使用 memory adapter
- 生产和多实例部署使用 Redis adapter

生产环境不能在额度、队列或限流状态上从 Redis 静默降级到内存，否则多实例限制会不一致。

备选方案：v1.1 继续使用内存状态，后续再加 Redis。这样更快，但无法满足多实例和成本控制目标。

### 决策 5：discovery 准入必须发生在高成本 provider 调用之前

鉴权和限流要在 discovery 进入队列前执行。队列准入要发生在 AI planning、三方搜索、资料补全或 AI review 之前。Stream 调用方要收到 `queued` 和 `started` 事件；non-stream 调用方等待完成或收到结构化忙碌/超时错误。

备选方案：只对 TikTok provider 阶段排队。这会让 AI planning 和其他高成本工作仍然不受控，不足以支持公网版本。

### 决策 6：通过请求级 usage context 记录用量

每个受保护请求都有请求级 usage context，绑定 request ID 和 token 身份。Discovery 各阶段通过该 context 增加计数和耗时，在成功、受控错误、超时或取消时写出最终记录。

开发环境可以写 JSONL 方便排查；生产环境应写 Redis stream 或其他 append-only sink，确保记录跨进程重启保留，并支持后续聚合。

## 风险 / 取舍

- Redis 依赖会增加部署复杂度 -> 本地开发提供内存模式，生产环境在 Redis 必需但不可用时快速失败。
- 静态 token 运维简单，但不是完整用户系统 -> 现在把 token 表示成身份，后续账号系统可复用额度和用量记录。
- 队列可能让用户等待且无反馈 -> stream 响应必须发送队列状态，non-stream 错误必须包含稳定 code 和重试提示。
- 成本估算可能跟 provider 定价漂移 -> v1.1 以调用次数和耗时为权威数据，金额估算只做辅助元数据。
- 扩展生产 API URL 变化可能需要重新构建/重新加载 -> 文档明确构建路径，并保持本地开发默认值。

## 迁移计划

1. 初始化配置和生产构建路径，同时保留本地默认 API URL。
2. 增加鉴权和 IP 限流，本地默认关闭，再用 Redis adapter 开启生产限制。
3. 增加 discovery 队列准入和取消行为。
4. 增加 usage context 和 JSONL/Redis 用量写入。
5. 将现有缓存和额度计数迁移到 cache/storage adapter。
6. 更新 README 或部署文档，说明必需环境变量和本地冒烟流程。

回滚可以通过部署上一版 v1.0 后端和扩展构建完成。Redis 状态是增量能力，且扩展保存数据仍在 Chrome 本地存储，不应阻塞回滚。

## 待确认问题

- 首次部署使用哪个生产 API 域名？
- 第一版 beta 使用一个共享部署 token，还是按用户分发 token？
- 面向大陆 beta 用户的默认每日 discovery 额度是多少？
- Redis 自建在同一台服务器，还是使用托管服务？
