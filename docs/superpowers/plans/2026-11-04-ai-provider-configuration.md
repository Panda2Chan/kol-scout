# 可配置 AI 供应商与模型实施计划

目标：支持 DeepSeek、Command Code 和通用 OpenAI 兼容中转；模型来自环境或 cc-switch，不设置代码默认模型。
范围：配置加载、现有 Chat/Responses 请求、计划缓存隔离、测试和配置文档。不增加模型池/并发模型调度，不调用真实收费 API。

## 任务一：配置与请求回归（主代理）
- [x] 新建 test/ai-provider-config.test.js，用临时 cc-switch SQLite 数据库和模拟 HTTP 响应验证：环境模型/cc-switch模型优先级、无模型降级、任意模型名、完整环境凭据不混用cc-switch、model_provider选择、wire_api、DeepSeek/Command Code/自定义前缀/完整端点地址。
- [x] 运行 node --test test/ai-provider-config.test.js，确认旧实现因固定gpt-5.5与错误拼接等预期行为失败。
- [x] 最小修改 backend/services/ai-search-service.js；通用 AI_* 优先，保留既有环境别名。显式环境连接需要自身模型；仅环境模型可覆盖cc-switch。
- [x] 计划/复核请求使用已解析apiMode与model；缓存key包含有效端点、协议、密钥的哈希输入，避免跨供应商/账户复用。
- [x] 新测试转绿，运行 npm test 与 npm run check（各设60秒上限）。

## 任务二：部署说明（文档代理，独立文件）
- [x] 更新 README.md 与 .env.example 的AI配置段，覆盖DeepSeek、Command Code、cc-switch、变量优先级与内置联网能力边界。

## 任务三：审查（独立只读代理）
- [x] 核对实际diff、任意模型传递与凭据来源、缓存隔离、失败回退；修正实质问题并重跑对应验证。
- [x] 汇总改动、配置示例、验证证据及未进行真实供应商调用的限制。不提交或发布。

## 验证记录

初始17项专项测试全部按预期失败，完成实现后17/17通过；独立审查再补2个根级完整端点回归，先2项失败，修复后19/19通过。最终全套104/104通过，npm run check及git diff --check通过，独立审查问题已关闭。测试使用临时cc-switch夹具与模拟HTTP，没有读取真实密钥或调用付费接口。执行期间.gitignore出现的外部修改未纳入任务编辑。
