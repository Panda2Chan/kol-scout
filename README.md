# KOL Scout

面向 KOL 运营场景的 Chrome 插件 MVP。当前版本覆盖 X 和 TikTok：
通过全站匹配召回真实创作者，读取公开主页资料，按匹配度和质量过滤后生成候选 list。

更新记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 已实现能力

- Chrome Side Panel 形态，不遮挡网页内容
- X / TikTok 全站匹配：输入关键词和筛选需求后召回真实创作者
- X 支持 AI 搜索规划和 Web Search 召回，默认使用 cc-switch / OpenAI 配置
- TikTok 支持三方数据源和公开网页搜索兜底召回
- 公开主页补全：头像、简介、粉丝量、邮箱
- 粉丝数下限筛选
- 低质量、疑似品牌号、疑似假粉/异常互动过滤
- 候选 / 已保存两个列表
- 候选不会自动保存，只有用户手动保存才进入已保存 list
- 已保存 list 支持查看、删除、清空、CSV 导出
- 扫描当前页可见 OP
- 一键打开 OP 主页、查看公开邮箱

## 技术结构

```text
├── manifest.json
├── src
│   ├── background        # MV3 service worker，转发请求和操作 active tab
│   ├── content           # 页面扫描 detector
│   ├── sidepanel         # Chrome Side Panel UI
│   └── shared            # schema、storage、export
└── backend
    ├── server.js         # 本地 API
    ├── platforms         # 多平台 provider 架构，当前实现 X / TikTok
    └── services          # AI 搜索、匹配、发现和质量过滤
```

## 本地运行

安装依赖：

```bash
npm install
```

启动后端：

```bash
npm run backend
```

默认监听：

```text
http://127.0.0.1:8787
```

本地开发默认不会启用公网鉴权、IP 限速、每日额度、用户并发限制和队列容量拒绝。需要测试这些能力时，在 `.env` 中显式开启对应配置。

检查代码和 manifest：

```bash
npm run check
```

运行测试：

```bash
npm test
```

## 安装插件

1. 打开 Chrome：`chrome://extensions`
2. 开启 Developer mode
3. 点击 Load unpacked
4. 选择本项目目录
5. 点击插件图标打开 Side Panel

## 后端 API

- `GET /health`
- `POST /api/match/creators`
- `POST /api/search/creators`
- `POST /api/discover/creators`

## 部署和发布配置

后端运行配置：

- `APP_ENV`：运行环境，默认 `development`，生产使用 `production`
- `HOST`：监听地址，本地默认 `127.0.0.1`，容器或公网部署常用 `0.0.0.0`
- `PORT`：监听端口，默认 `8787`
- `CORS_ORIGINS`：允许的来源，默认 `*`
- `PUBLIC_BASE_URL`：公网后端地址，仅用于健康检查和部署自检

扩展发布配置：

- `KOL_API_BASE_URL`：扩展访问的后端 API 地址
- `KOL_API_AUTH_TOKEN`：扩展请求后端时携带的 token，后续鉴权任务启用

生产扩展包必须使用 HTTPS API 地址：

```bash
KOL_API_BASE_URL=https://api.example.com npm run package:extension
```

打包产物默认输出到：

```text
dist/kol-scout-extension
```

本地开发包可用：

```bash
npm run package:extension:dev
```

生产后端建议放在 HTTPS 反向代理后面，例如 Nginx、Caddy 或云厂商负载均衡。扩展的 `host_permissions` 会在打包时根据 `KOL_API_BASE_URL` 生成。

## AI 和数据源配置

AI 搜索优先读取：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- cc-switch 配置：`~/.cc-switch`

三方 KOL 数据源可选：

- `KOL_DATA_API_URL`
- `KOL_DATA_API_KEY`

TikTok 多源搜索聚合可选，配置后会优先合并这些搜索源结果：

- `SERPER_API_KEY`
- `TAVILY_API_KEY`
- `BRAVE_SEARCH_API_KEY`
- `JINA_API_KEY`

TikTok 召回调优可选：

- `TIKTOK_SEARCH_QUERY_LIMIT`：每轮最多执行的 TikTok 搜索 query 数，默认 `16`
- `TIKTOK_ENRICH_LIMIT`：每轮最多补全公开主页资料的候选数，默认 `40`
- `TIKTOK_SEARCH_SOURCE_CONCURRENCY`：并发搜索源数量，默认 `3`
- `TIKTOK_SEARCH_QUERY_CONCURRENCY`：单个搜索源内并发 query 数，默认 `3`
- `TIKTOK_ENRICH_CONCURRENCY`：公开主页补全并发数，默认 `8`

AI 后处理调优可选：

- `AI_POSTPROCESS_DISABLED=true`：关闭候选 AI 清洗和重排
- `AI_POSTPROCESS_LIMIT`：每轮最多提交给 AI 复核的候选数，默认 `30`
- `AI_POSTPROCESS_TIMEOUT_MS`：AI 复核超时时间，默认 `45000`

服务端定位日志可选：

- `DISCOVERY_TOTAL_TIMEOUT_MS`：全站匹配总超时时间，默认 `600000`（10 分钟）
- `DISCOVERY_THIRD_PARTY_CACHE_TTL_MS`：三方召回结果内存缓存时间，默认 `600000`（10 分钟）
- `DISCOVERY_THIRD_PARTY_CACHE_DISABLED=true`：关闭三方召回缓存
- `DISCOVERY_DEBUG_LOGS=false`：关闭全站匹配阶段耗时日志，默认开启
- `DISCOVERY_LOG_QUERIES=true`：在 TikTok 搜索日志中打印 query 样本，默认关闭

公网访问控制配置：

- `AUTH_REQUIRED`：是否要求 bearer token，本地默认 `false`，生产默认 `true`
- `API_AUTH_TOKEN` / `API_AUTH_TOKENS`：允许访问后端的 token
- `ACCESS_LIMITS_ENABLED`：是否启用公网限流和额度，本地默认 `false`，生产默认 `true`
- `IP_RATE_LIMIT_WINDOW_MS`：IP 限速窗口
- `IP_RATE_LIMIT_MAX_REQUESTS`：单 IP 每窗口最大请求数
- `USER_DAILY_DISCOVERY_QUOTA`：单身份每日 discovery 额度
- `USER_CONCURRENT_DISCOVERY_LIMIT`：单身份并发 discovery 上限

队列、用量和缓存配置：

- `DISCOVERY_QUEUE_LIMITS_ENABLED`：是否启用队列容量限制，本地默认 `false`，生产默认 `true`
- `DISCOVERY_MAX_CONCURRENT`：全局 discovery 最大并发数
- `DISCOVERY_QUEUE_MAX_SIZE`：最大排队数量
- `DISCOVERY_QUEUE_TIMEOUT_MS`：队列等待超时
- `USAGE_SINK`：用量记录写入方式，支持 `jsonl`、`redis`、`none`
- `USAGE_JSONL_PATH`：开发环境 JSONL 用量日志路径
- `CACHE_DRIVER`：缓存驱动，支持 `memory`、`redis`
- `REDIS_URL`：Redis 连接地址
- `AI_PLAN_CACHE_TTL_MS`：AI plan 缓存 TTL

保存、忽略、删除等用户反馈会保存在本地 `chrome.storage.local`，
下一轮全站匹配会把反馈摘要提交给后端，用于优化 AI 搜索规划和候选重排。

未配置三方源时，X 会使用 AI Web Search 和网页搜索兜底召回；
TikTok 会使用已配置的搜索聚合源，并回退到公开网页搜索兜底召回。

## MVP 边界

- 只采集公开可见信息
- 不绕过平台限制
- 不做登录态爬取
- 粉丝量、邮箱、简介来自公开页面、AI Web Search 或三方数据源，可用于运营初筛，最终合作前仍需人工复核
