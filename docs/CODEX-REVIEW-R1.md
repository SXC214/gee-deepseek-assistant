# Codex 审核报告 Round 1（CODEX-REVIEW-R1）

审核对象：`pre-fix-baseline` 之后的全部改动。
审核结论：**不通过**。完整原始输出见 `F:\Qoder\GEE\codex-review-output.txt`（文件含编码乱码，本文件为按上下文整理后的结构化结论）。

## Blocker

无。

## Major

- **M1 `compatibleStreaming` 开关未接入实际调用选择**
  - 位置：`lib/orchestrator.js:174-185`、`service-worker.js:175-180`
  - 问题：编排器仅在 `supportsThinking` 为真时建立流式 Port，而兼容端点该值永远为假，因此 UI 开启开关后仍走 `AI_CHAT` 非流式路径。
  - 建议：条件改为 `supportsThinking || compatibleStreaming`，并增加从设置到 Port 的集成测试。

- **M2 超时与外部 abort 不覆盖响应正文**
  - 位置：`lib/http.js:113-139`、`service-worker.js:376`、`lib/gee-rest.js:68`
  - 问题：超时和外部 abort 只覆盖 `fetch()` 返回响应头之前；响应返回后立即清理定时器和 abort 监听，而 `response.text()` 在外部执行。正文停滞时模型、检索和 GEE REST 请求均可永久挂起，`chat()` 声称的“总超时”实际无效。
  - 建议：让传输内核在同一控制器生命周期内完成正文消费，或提供受控的 consume 回调，并测试“已返回响应头但正文不结束”。

- **M3 对话对齐在二次截断后失配**
  - 位置：`lib/orchestrator.js:139-151`、`sidepanel.js:549-556`
  - 问题：对齐在截取 12 条后执行，但发送前再次 `slice(-6)`，会重新产生 assistant-first。典型情况：12 条窗口以 assistant 开头，对齐后剩 11 条，最后 6 条又以 assistant 开头。
  - 建议：对最终发送窗口再次调用 `alignConversationToUser()`，或按完整 user/assistant turn 保存与截断。

- **M4（storage）所有 `storage.set()` 异常都被当作配额不足**
  - 位置：`lib/storage.js:100-174`
  - 问题：任何异常都被吞掉并视为配额不足，随后破坏性裁剪聊天和代码候选。瞬态存储错误、上下文失效或序列化错误都可能造成永久数据丢失；加入 `unlimitedStorage` 后真实配额错误反而更少。
  - 建议：仅对明确的 quota 错误执行淘汰，其余错误原样抛出。

- **M5（storage）淘汰链状态不一致**
  - 位置：`lib/storage.js:133-170`、`sidepanel.js:738-755`
  - 问题：释放候选空间后只重试原始聊天快照，不重试此前已缩减且可能已能写入的快照；候选降级为空代码后仍返回 `persisted: true`，UI 随即宣称代码卡已保存；候选写入导致聊天被裁剪时，内存聊天也未同步。
  - 建议：返回所有受影响键的最终值和明确的 `degraded` 状态，逐一同步内存，并在第二阶段重试最后可用的缩减快照。

- **M6 索引 single-flight 使用首个调用者的 `signal`**
  - 位置：`service-worker.js:646-698`
  - 问题：两个搜索共享加载时，首个请求取消会使未取消的第二个请求一起失败；第二个请求取消则不能独立停止等待。
  - 建议：共享加载使用独立控制器，并为每个等待者单独处理 abort，必要时采用引用计数取消底层任务。

- **M7 OAuth token 获取与 401 刷新无 single-flight**
  - 位置：`service-worker.js:279-326`
  - 问题：OAuth token 获取和 401 刷新没有 single-flight 或版本保护。并发缓存未命中会打开多个交互式授权窗口；并发 401 中较晚的请求还可能清除另一请求刚写入的新 token。
  - 建议：按 clientId 建立授权 Promise 锁，并仅当缓存仍等于本请求使用的旧 token 时执行失效。

## Minor

- **m1 OAuth 请求缺少 `state` 与回调校验**
  - 位置：`lib/gee-rest.js:28-54`
  - 问题：OAuth 请求没有 `state`，回调也未校验 state 和精确 redirect URI，缺少标准的 CSRF/响应混淆防护。
  - 建议：每次授权生成高熵 state，回调时恒定时间比对并验证来源。

- **m2 模型名前缀误匹配**
  - 位置：`lib/api.js:11-14`、`lib/api.js:31-33`
  - 问题：裸 `startsWith()` 会把 `deepseek-v4-flashback`、`deepseek-v4-prototype` 等名称误判为 V4，进而发送不兼容的 thinking/stream 字段。
  - 建议：仅接受完全匹配或约定分隔符后的后缀。

- **m3 Retry-After 仅支持秒数**
  - 位置：`lib/http.js:101-106`
  - 问题：`Retry-After` 只支持秒数，不支持合法的 HTTP-date；同时无条件截断到 10 秒可能提前违反服务端限流要求。
  - 建议：支持两种格式，并将最大等待策略显式交由调用方决定。

- **m4 解析结果内存缓存无 TTL，且无详情页 single-flight**
  - 位置：`service-worker.js:712-726`
  - 问题：解析结果内存缓存没有时间戳，只有持久缓存执行 TTL；只要 worker 持续存活，过期结果仍会永久命中。相同详情页也没有 in-flight 锁，并发首次查询会重复抓取。
  - 建议：内存项同样保存 `createdAt`，并增加按详情 key 的 single-flight。

- **m5（content-script）硬编码“第二个 tab”优先于 ARIA 探测**
  - 位置：`content-script.js:103-107`、`content-script.js:225-234`
  - 问题：未验证标签语义的硬编码“第二个 tab”优先于 ARIA 探测，DOM 顺序变化时可能把 Tasks 等内容当作 Console，并阻止更可靠策略继续执行。
  - 建议：先用 ARIA/标签语义，位置选择器仅作为最后回退且必须验证 Console 信号。

- **m6（sidepanel）资产/任务状态互相覆盖**
  - 位置：`sidepanel.js:389-459`
  - 问题：资产加载失败被内部吞掉后仍继续加载任务；任务成功会清空资产错误状态，使空资产列表看起来像真实结果。刷新时也未清空旧任务。
  - 建议：分别维护资产/任务状态，并由 `refreshGeeRest()` 汇总结果而非互相覆盖。

- **m7 任务接口固定读取前 50 条**
  - 位置：`lib/gee-rest.js:121-126`
  - 问题：任务接口固定读取前 50 条并丢弃 `nextPageToken`，UI 无任何“不完整”提示。
  - 建议：像资产一样返回分页令牌并提供继续加载。

- **m8（response）GEE 代码块无条件选择最后一个**
  - 位置：`lib/response.js:7-13`
  - 问题：多个含 GEE 信号的代码块无条件选择最后一个；若完整脚本后附一个短用法示例，会把示例作为可整段替换的候选。
  - 建议：按完整性、长度和 GEE 信号综合评分，仅将“最后出现”作为同分条件。

- **m9 测试缺口**
  - 位置：`tests/service-worker-tests.mjs:430-468`、`tests/conversation-tests.mjs:12-21`、`tests/http-tests.mjs:37-52`
  - 问题：测试分别直接调用 worker Port、只验证一次对齐、只模拟响应头前超时，因此全部通过仍无法发现兼容流式开关失效、二次截断失配和正文挂起。
  - 建议：增加跨模块调用链及上述边界场景测试。

## Nit

- **n1 lint 规则全为 warning，无法作为合并守卫**
  - 位置：`eslint.config.js:27-31`
  - 问题：核心规则全部为 warning，当前已有 11 条警告但 `npm run lint` 仍成功退出。
  - 建议：将关键规则设为 error，或使用 `--max-warnings=0`。

## 总体结论

**不通过**。
