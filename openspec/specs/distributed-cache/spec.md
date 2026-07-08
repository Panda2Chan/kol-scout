# 分布式缓存

## Purpose

定义后端缓存和计数器适配器、Redis 校验、跨实例 discovery 缓存、安全 key、TTL 配置和健康状态上报。

## Requirements

### Requirement: 缓存适配器支持 memory 和 Redis 驱动
后端 SHALL 通过适配器访问缓存和计数器状态，该适配器支持 memory 和 Redis 驱动。

#### Scenario: 本地 memory 驱动
- **WHEN** 缓存驱动配置为 memory
- **THEN** 缓存和计数器操作无需 Redis server 即可工作，且作用域仅限当前进程

#### Scenario: Redis 驱动
- **WHEN** 缓存驱动配置为 Redis
- **THEN** 缓存和计数器操作使用 Redis，使多个后端实例可以共享状态

### Requirement: 启动时校验 Redis 配置
后端 MUST 在服务需要 Redis 的生产流量前校验 Redis 配置。

#### Scenario: Redis 必需但不可用
- **WHEN** 生产配置要求 Redis，且后端无法连接 Redis
- **THEN** 后端启动失败，或受保护高成本接口保持不可用并返回清晰运维错误

### Requirement: 现有 discovery 缓存迁移到缓存适配器
后端 SHALL 通过缓存适配器存储三方 discovery 成功结果和可缓存错误。

#### Scenario: 跨实例 discovery 缓存命中
- **WHEN** 一个后端实例通过 Redis 存储三方 discovery 缓存条目
- **THEN** 另一个后端实例可以在 TTL 过期前读取同一缓存条目

### Requirement: 缓存 key 避免敏感原始输入
后端 MUST 避免在 Redis key 中存储完整敏感用户输入。

#### Scenario: 生成缓存 key
- **WHEN** 后端根据 brief、filters、platform、provider、locale 或 limit 创建缓存 key
- **THEN** 存储 key 使用稳定 namespace 和安全的 hash 或规范化组件，不包含原始密钥值

### Requirement: 按缓存用途配置 TTL
后端 SHALL 为 AI plan cache、三方 discovery cache、额度计数器和限流计数器使用可配置 TTL。

#### Scenario: 缓存条目过期
- **WHEN** 某个缓存条目或计数窗口达到配置 TTL
- **THEN** 后端按该缓存用途将条目视为过期，并重新计算或重置

### Requirement: 安全上报 Redis 健康状态
后端 SHALL 在健康元数据中上报缓存驱动和 Redis 可用性，同时不暴露连接密钥。

#### Scenario: 配置 Redis 后请求健康检查
- **WHEN** 已配置 Redis 且请求 `/health`
- **THEN** 响应包含安全的 Redis 可用性状态，且不包含 Redis 凭据
