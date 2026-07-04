# KOL Scout MVP 产品方案

## 目标用户

- 跨境电商品牌主
- 中小营销团队
- 独立增长顾问
- 每天需要筛选 KOL、达人、内容合作对象的人

## 核心价值

把“看到一个可能合适的创作者 → 判断是否值得联系 → 保存到表格”这条链路从 5-10 分钟压到 30 秒内。

## 首发定位

低价、轻量、浏览器内完成。

不直接对标 EasyKOL 的完整数据库，而是先切“研究助手 + 线索库”。

## 功能优先级

### P0：当前已实现

- Chrome 插件 Manifest V3
- X 当前页面可见创作者批量发现
- 支持从 X 帖子作者、推荐用户卡、普通 profile 链接生成候选
- 社媒链接识别
- 创作者候选卡片
- 本地保存、编辑、删除
- 标签、备注、状态
- 基础评分
- discovery/enrichment 字段：区分“页面发现”和“待后端增强”
- 后台增强接口骨架：`ENRICH_CANDIDATES`
- 本地 Node 后端：多平台 provider 架构，当前支持 X mock catalog 和 HTTP 三方数据源
- AI 智能匹配：Brief 调用后端全站数据源，过滤低质/疑似假粉账号，并按匹配度排序
- 候选列表评分：规则版 brief 匹配、推荐理由、风险和排序
- Tailwind CSS 本地构建 popup UI
- CSV / JSON 导出

### P1：建议下一轮

- Side Panel，更适合长列表管理
- X / YouTube 平台专项解析继续加深
- 近帖互动率和发帖频率
- Outreach brief：生成个性化外联摘要
- 重复线索合并策略
- 隐私政策和 Chrome Web Store 上架材料

### P2：后台订阅阶段

- 账号登录
- Stripe 订阅
- 远程同步
- 团队 workspace
- 邮箱额度
- LLM/Embedding 语义匹配
- AI 画像分析
- Campaign 追踪

## 后端架构

```text
backend/
├── server.js
├── platforms/
│   ├── registry.js
│   └── x-provider.js
└── services/
    ├── discovery-service.js
    └── match-service.js
```

当前 API：

- `GET /health`
- `POST /api/enrich/creators`
- `POST /api/match/creators`
- `POST /api/search/creators`
- `POST /api/discover/creators`

插件只在 `background service worker` 调后端，content script 不直接联网。

## AI 匹配策略

首版拆成三层，避免把“找人”和“排序”混在一起：

- 找人：Brief → 关键词/排除词 → 后端 provider → 三方数据源或 mock catalog
- 过滤：低匹配、低质量、疑似假粉/异常互动账号先剔除
- 排序：对剩余候选做规则版、可解释评分

候选评分维度：

- 主题匹配：brief 关键词命中 `bio / evidence / tags / notes`
- 平台匹配：是否符合目标平台
- 粉丝区间：缺数据不判死刑，标记待增强
- 线索质量：profile / post author / avatar / bio
- 质量过滤：互动率、关注/粉丝比例、内容沉淀、低质关键词
- 假粉风险：高粉低互动、异常 follow 比例、抽奖/airdrop/promo 信号
- 品牌安全：排除词命中会扣分

后续替换点：

- `parseBrief(rawText)` 接 LLM
- `semanticMatch(brief, creator)` 接 Embedding
- `explainMatch()` 接 LLM 生成更自然的推荐理由

## 建议定价

- Free：本地保存 20 个 KOL，基础扫描
- Solo：`$9-19/mo`，无限本地保存、CSV 导出、Outreach brief
- Team Lite：`$29-49/mo`，云同步、团队标签、共享列表
- Growth：`$79+/mo`，邮箱额度、AI 分析、批量相似创作者

## 差异化

- EasyKOL：完整闭环，价格从 `$50/mo` 起，功能重。
- KOL Scout：轻量插件，先在用户浏览 X/YouTube 等页面时批量发现候选，帮用户省搜索和建表时间，低价切入。

## 产品边界更新

单个主页采集不是核心功能，只是数据补全能力之一。

真正 MVP 核心是：

```text
关键词和筛选需求
        ↓
后端全站数据源召回
        ↓
质量过滤、假粉风险判断、匹配评分
        ↓
返回已排序 OP 列表，用户保存/导出/跳主页复核
```

## 风险控制

- 不做自动私信、自动关注、自动翻页
- 不抓取登录后不可见数据
- 不承诺粉丝数绝对准确
- 默认本地保存，用户主动导出
- 后续上传云端前必须展示隐私说明和授权
