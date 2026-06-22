# KOL Lite MVP

面向 KOL 运营场景的 Chrome 插件 MVP。当前版本优先覆盖 X 平台：
通过 AI 全站匹配召回真实 OP，读取公开主页资料，按匹配度和质量过滤后生成候选 list。

## 已实现能力

- Chrome Side Panel 形态，不遮挡网页内容
- X 全站匹配：输入关键词和筛选需求后召回真实 OP
- AI 搜索规划和 Web Search 召回，默认使用 cc-switch / OpenAI 配置
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
    ├── platforms         # 多平台 provider 架构，当前先实现 X
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

未配置三方源时，后端会使用 AI Web Search 和网页搜索兜底召回真实 X 账号。

## MVP 边界

- 只采集公开可见信息
- 不绕过平台限制
- 不做登录态爬取
- 粉丝量、邮箱、简介来自公开页面或 AI Web Search，可用于运营初筛，最终合作前仍需人工复核
