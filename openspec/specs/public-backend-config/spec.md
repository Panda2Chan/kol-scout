# 公网后端配置

## Purpose

定义扩展和后端面向公网部署时的 API 地址配置、HTTPS 校验、发布打包、监听地址、manifest host permissions 和健康检查要求。

## Requirements

### Requirement: 可配置的扩展 API 基础地址
扩展 SHALL 使用同一个共享 API 基础地址配置，供 popup 侧和 background 侧后端请求共同使用。

#### Scenario: 本地开发默认地址
- **WHEN** 扩展构建时没有配置生产 API 覆盖值
- **THEN** 后端请求使用本地开发 API 基础地址

#### Scenario: 生产 API 地址覆盖
- **WHEN** 扩展构建配置了生产 API 基础地址
- **THEN** popup 侧和 background 侧后端请求都使用该配置地址，且不需要修改源码

### Requirement: 生产后端地址使用 HTTPS
生产扩展配置 MUST 要求后端 API 基础地址使用 HTTPS。

#### Scenario: 生产构建配置 HTTP 地址
- **WHEN** 生产扩展构建配置了 `http://` API 基础地址
- **THEN** 构建或校验步骤失败，并给出清晰配置错误

### Requirement: 发布打包使用生成后的生产产物
扩展发布流程 SHALL 运行构建或打包步骤，校验生产配置并产出可发布扩展包。

#### Scenario: 创建发布包
- **WHEN** 准备分发用发布包
- **THEN** 包内包含生成后的生产配置、生产 manifest host permissions、已编译 CSS 资产，并且不依赖仅开发环境使用的 API origin

#### Scenario: 发布包校验失败
- **WHEN** 必需的生产发布配置缺失或非法
- **THEN** release 构建在产出可发布包之前失败

### Requirement: 后端监听地址可配置
后端 SHALL 从配置读取监听 host 和 port，同时保留安全的本地默认值。

#### Scenario: 本地后端启动
- **WHEN** 未配置 host 覆盖值
- **THEN** 后端监听本地开发 host，并使用配置或默认 port

#### Scenario: 公网后端启动
- **WHEN** 配置了 `HOST=0.0.0.0` 和合法 `PORT`
- **THEN** 后端监听对应 host 和 port

### Requirement: Manifest host permissions 匹配配置的 API origin
扩展 manifest SHALL 包含配置后端 API origin 对应的 host permissions。

#### Scenario: 本地 manifest
- **WHEN** 扩展为本地开发构建
- **THEN** manifest 允许本地后端 origins

#### Scenario: 生产 manifest
- **WHEN** 扩展为生产环境构建
- **THEN** manifest 允许配置的 HTTPS 后端 origin，且不要求本地后端 origins

### Requirement: 健康检查暴露安全部署状态
后端 SHALL 暴露健康检查，包含运维可用的安全部署状态。

#### Scenario: 健康检查请求
- **WHEN** 客户端请求 `/health`
- **THEN** 响应包含服务状态、版本、环境、已配置 provider 可用性、缓存驱动状态和队列驱动状态，且不暴露密钥
