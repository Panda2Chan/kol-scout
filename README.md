# KOL Lite MVP

面向 KOL 运营场景的 Chrome 插件 MVP。当前版本覆盖 X 和 TikTok：
通过全站匹配召回真实创作者，读取公开主页资料，按匹配度和质量过滤后生成候选 list。

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

检查代码和 manifest：

```bash
npm run check
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

保存、忽略、删除等用户反馈会保存在本地 `chrome.storage.local`，
下一轮全站匹配会把反馈摘要提交给后端，用于优化 AI 搜索规划和候选重排。

未配置三方源时，X 会使用 AI Web Search 和网页搜索兜底召回；
TikTok 会使用已配置的搜索聚合源，并回退到公开网页搜索兜底召回。

## MVP 边界

- 只采集公开可见信息
- 不绕过平台限制
- 不做登录态爬取
- 粉丝量、邮箱、简介来自公开页面、AI Web Search 或三方数据源，可用于运营初筛，最终合作前仍需人工复核
