# API 用量统计

## Purpose

定义 discovery 请求的结构化用量记录、provider 调用计数、安全脱敏、开发和生产存储模式，以及按身份聚合用量的能力。

## Requirements

### Requirement: Discovery 请求创建结构化用量记录
后端 SHALL 为每个达到认证准入阶段的 discovery 请求创建一条结构化用量记录。

#### Scenario: Discovery 成功
- **WHEN** discovery 请求成功完成
- **THEN** 用量记录包含请求身份、平台、请求 limit、状态、开始时间、结束时间、耗时和返回候选数量

#### Scenario: Discovery 失败
- **WHEN** discovery 请求失败、超时或被取消
- **THEN** 用量记录包含请求身份、状态、错误码、开始时间、可用时的结束时间和可用时的耗时

### Requirement: 用量记录包含 provider 调用计数
后端 SHALL 在用量记录中跟踪 provider 阶段调用次数和耗时。

#### Scenario: 调用 AI 和搜索 provider
- **WHEN** discovery 使用 AI planning、web search、三方搜索、资料补全或 AI review
- **THEN** 用量记录采集这些阶段的配置计数和耗时字段

### Requirement: 用量记录对日志和存储安全
后端 MUST NOT 在用量记录中保存 API key、bearer token 或完整敏感 prompt。

#### Scenario: 写入用量记录
- **WHEN** 后端写出一条用量记录
- **THEN** token 值用稳定非密标识表示，prompt 内容只用长度或 hash 等安全元数据表示

### Requirement: 用量存储支持开发和生产模式
后端 SHALL 支持本地开发用量 sink 和生产可用的 append-only 用量 sink。

#### Scenario: 开发用量模式
- **WHEN** 后端使用开发用量 sink 运行
- **THEN** 用量记录写入本地 JSONL 兼容目标，方便检查

#### Scenario: 生产用量模式
- **WHEN** 后端使用生产用量 sink 运行
- **THEN** 用量记录写入适合跨后端实例聚合的共享存储

### Requirement: 支持按身份和日期汇总用量
后端 SHALL 提供按认证身份、平台和日期聚合用量的能力。

#### Scenario: 内部请求每日用量汇总
- **WHEN** 运维或额度逻辑请求某个身份今天的用量
- **THEN** 后端可以返回该身份的调用次数、总耗时、候选总数和估算成本元数据
