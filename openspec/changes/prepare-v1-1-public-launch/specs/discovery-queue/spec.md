## ADDED Requirements

### Requirement: Discovery 请求共享全局队列
后端 MUST 在高成本 provider 工作开始前，将所有 discovery 工作路由到同一个队列抽象。

#### Scenario: Stream discovery 请求
- **WHEN** `/api/discover/creators/stream` 收到已准入请求
- **THEN** 该请求在 AI planning、搜索、资料补全或 AI review 开始前进入共享 discovery 队列

#### Scenario: 非 stream discovery 请求
- **WHEN** `/api/discover/creators` 收到已准入请求
- **THEN** 该请求进入与 stream discovery 相同的共享 discovery 队列

### Requirement: 队列执行配置并发上限
Discovery 队列 SHALL 保证同时运行的 discovery 任务数不超过配置值。

#### Scenario: 并发任务低于上限
- **WHEN** 运行中的 discovery 任务数低于配置上限
- **THEN** 下一个排队 discovery 任务开始执行

#### Scenario: 并发任务达到上限
- **WHEN** 运行中的 discovery 任务数等于配置上限
- **THEN** 额外已准入 discovery 任务保持排队，或按容量策略被拒绝

### Requirement: 执行队列容量和超时
Discovery 队列 MUST 执行配置的最大队列长度和最大队列等待时间。

#### Scenario: 队列已满
- **WHEN** discovery 请求到达且队列已经达到配置容量
- **THEN** 后端在 provider 工作开始前用稳定队列已满错误码拒绝请求

#### Scenario: 队列等待超时
- **WHEN** 排队中的 discovery 请求等待时间超过配置队列超时
- **THEN** 后端用稳定队列超时错误码拒绝请求

### Requirement: Stream 调用方收到队列生命周期事件
Stream discovery 端点 SHALL 在 discovery 工作前和工作中发出队列生命周期事件。

#### Scenario: Stream 请求进入排队
- **WHEN** stream discovery 请求进入队列
- **THEN** 响应发出 `queued` 事件，包含 request ID 和队列位置或等待元数据

#### Scenario: Stream 请求开始执行
- **WHEN** 排队中的 stream discovery 请求开始执行
- **THEN** 响应在 candidate 事件前发出 `started` 事件

### Requirement: 队列在完成和取消时释放资源
Discovery 队列 MUST 在任务完成、失败、超时或取消时释放身份和全局运行计数。

#### Scenario: 客户端在执行前断开
- **WHEN** 排队中的 stream 客户端在任务开始前断开
- **THEN** 后端移除该排队任务或标记为取消，并且不为它启动 provider 工作

#### Scenario: 运行中任务结束
- **WHEN** 运行中的 discovery 任务完成、失败或被中止
- **THEN** 队列释放该运行槽位，并可以启动另一个排队任务
