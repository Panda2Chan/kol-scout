## ADDED Requirements

### Requirement: 本地开发默认绕过公网访问限制
后端 SHALL 在本地开发模式默认关闭公网上线用的鉴权和限制执行。

#### Scenario: 本地请求不带 token
- **WHEN** 后端以本地开发默认配置运行，且本地扩展请求不带 bearer token 调用受保护高成本接口
- **THEN** 后端允许请求继续执行，不因鉴权失败而拒绝

#### Scenario: 本地重复 discovery 请求
- **WHEN** 后端以本地开发默认配置运行，且同一开发机反复发起 discovery 请求
- **THEN** IP 限速、用户每日额度和用户并发 discovery 限制不会拒绝这些请求

#### Scenario: 显式开启本地限制测试
- **WHEN** 开发者在本地开发模式显式开启鉴权或限制执行
- **THEN** 后端按配置应用公网访问控制规则，便于测试

### Requirement: 受保护高成本接口需要 bearer 鉴权
后端 MUST 在执行高成本 API 路由前要求合法 bearer token。

#### Scenario: 生产请求缺少 bearer token
- **WHEN** 后端以生产模式运行，且请求不带 `Authorization: Bearer <token>` 调用受保护高成本路由
- **THEN** 后端在 provider 工作开始前拒绝请求，并返回稳定鉴权错误码

#### Scenario: 缺少 bearer token
- **WHEN** 请求不带 `Authorization: Bearer <token>` 调用受保护高成本路由
- **THEN** 后端在 provider 工作开始前拒绝请求，并返回稳定鉴权错误码

#### Scenario: bearer token 非法
- **WHEN** 请求带未知或格式错误的 bearer token 调用受保护高成本路由
- **THEN** 后端在 provider 工作开始前拒绝请求，并返回稳定鉴权错误码

#### Scenario: bearer token 合法
- **WHEN** 请求带合法 bearer token 调用受保护高成本路由
- **THEN** 后端将 token 解析为身份，并用于额度、队列和用量统计

### Requirement: 健康检查可安全匿名访问
后端 SHALL 允许匿名访问安全的运维健康检查。

#### Scenario: 匿名健康检查
- **WHEN** 客户端不带 bearer token 请求 `/health`
- **THEN** 后端返回安全健康元数据，且不包含密钥值

### Requirement: IP 限速保护公网接口
后端 MUST 执行可配置的基于 IP 的请求限速。

#### Scenario: IP 超过请求频率
- **WHEN** 同一解析 IP 的请求超过配置窗口限制
- **THEN** 后端用 HTTP 429、稳定限速错误码和重试提示拒绝后续请求

### Requirement: 执行用户每日 discovery 额度
后端 MUST 按认证身份执行可配置的每日 discovery 额度。

#### Scenario: 身份仍有额度
- **WHEN** 已认证身份在仍有每日额度时启动 discovery
- **THEN** 后端允许请求进入下一控制阶段，并按配置计费规则记录额度使用

#### Scenario: 身份超过每日额度
- **WHEN** 已认证身份没有剩余每日 discovery 额度
- **THEN** 后端在 provider 工作开始前用 HTTP 429 和稳定每日额度错误码拒绝 discovery

### Requirement: 执行用户并发 discovery 限制
后端 MUST 限制每个认证身份同时运行的 discovery 任务数量。

#### Scenario: 身份达到并发任务上限
- **WHEN** 已认证身份已经达到允许的最大运行中 discovery 任务数
- **THEN** 后端按队列策略拒绝或延后额外 discovery；如果未准入，则返回稳定并发错误码

### Requirement: 前端展示可行动的访问控制错误
扩展 SHALL 将后端访问控制错误码转换为简洁中文用户提示。

#### Scenario: 额度或限速错误到达扩展
- **WHEN** 后端返回鉴权、额度或限速错误码
- **THEN** 扩展展示面向用户的中文提示，说明下一步操作且不暴露原始 token 数据
