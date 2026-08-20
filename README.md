# GEE AI Code Assistant v0.4.0

为 Google Earth Engine Code Editor 打造的 AI 代码助手侧栏 · An AI coding-assistant side panel built for the Google Earth Engine Code Editor

- Chrome Web Store：即将上架（链接待补充）/ Coming soon (link to be added after listing)
- 本扩展不是 Google 官方产品，与 Google 无关联。/ This extension is not an official Google product and is not affiliated with or endorsed by Google.

## 简介 / Overview

这是一个 Chrome / Edge Manifest V3 扩展，为 Google Earth Engine Code Editor 增加独立的 AI 侧边栏。它支持 DeepSeek，也支持其他提供 OpenAI Chat Completions 兼容接口的模型服务。

This is a Chrome / Edge Manifest V3 extension that adds a dedicated AI side panel to the Google Earth Engine Code Editor. It supports DeepSeek as well as any other model service that exposes an OpenAI Chat Completions-compatible API.

## 已实现 / Features

- 读取 Earth Engine Ace 编辑器中的完整脚本、选区和 Console 文本。
- 将任务与可选上下文发送到自定义模型接口。
- 提取模型返回的完整 JavaScript 脚本并显示逐行差异。
- 经用户确认后替换完整脚本，或在光标处插入代码。
- 未连接 Earth Engine 编辑器时仍可按已确认计划生成独立完整脚本，并通过“复制代码”粘贴到 Code Editor。
- 写入前校验脚本版本，防止覆盖用户刚刚做出的修改。
- 用户确认后点击 Earth Engine 的 Run 按钮。
- API Key 默认只保存在浏览器会话中；可由用户选择在本机持久保存。
- API Key 不会传递给 Earth Engine 页面或 content script。
- Dataset Search：检索 Google Earth Engine 官方数据目录，核验数据集 ID、说明、波段和时间范围。
- Docs Search：检索 Google Earth Engine 官方指南、API 参考、REST 参考和教程。
- 检索结果会显示为可点击来源，并作为有边界的参考上下文传给模型。
- DeepSeek V4 Flash / Pro 支持实时展示思考过程，并可选择 High 或 Max 思考强度；最终回答开始后自动折叠思考内容。
- 为复杂任务加入 `fast / full / loop` 推理门控与 `Goal / Core / Verified / Open / Next` 可审计账本；只持久化任务状态，不保存详细思维链。
- 官方 DeepSeek V4 的 `full / loop` 回合可按需调用严格白名单的只读工具，定向检索官方数据目录/文档或重新读取用户已启用的编辑器、Console 上下文；模型没有写入、运行或删除工具权限。
- 生成代码先经过确定性本地预检，检查 JavaScript 结构、Code Editor 运行面、常见密钥模式、数据集官方来源和确认计划一致性；阻断项最多触发一次诊断式修复，仍失败时禁止一键写入。
- 用户确认运行后会短时监测真实 GEE Console；检测到错误时只显示“根据 Console 修复”入口，必须再次由用户点击才会发起模型请求。
- 计划模式会先检索官方资料、比较数据集、澄清分析口径，经用户确认后才生成代码；官方 DeepSeek V4 Flash 会先建立 4-8 项可验证 TODO，再按顺序逐项调研。
- 模型与项目设置默认隐藏，通过侧栏左上角的齿轮按钮打开。
- 独立的对话记录窗口按时间顺序显示用户输入、助手回复、官方来源快照、错误、思考状态和计划操作；每个计划 revision 会保留只读文字快照，可清空并在重新打开侧栏后恢复。
- 最近一次生成代码会作为代码卡保留在对话区；应用后标记为“已应用”而不自动消失，重新打开侧栏仍可查看、复制，只有点击“关闭代码卡”才会清除。
- v0.4 使用单一任务流布局：官方检索、思考、计划、错误和代码结果都紧邻对应消息显示，底部输入器始终可用，不再出现页面与聊天框同时滚动。
- 用户向上阅读时会暂停自动跟随；有新内容时显示“回到最新”，回到底部后恢复跟随。
- 模型处理期间仍可继续发送要求。消息会进入可编辑、可删除和可调整优先级的后续队列；停止当前任务会暂停而不会清空队列。
- 顶部“＋”用于开始新对话；会先确认，再清除当前聊天、计划、代码卡和后续队列，不影响 GEE 编辑器脚本。
- Earth Engine REST 直连：配置独立 OAuth 客户端后，可在侧边栏浏览项目资产与任务、复制资产 ID 并注入对话；令牌只保存在浏览器会话中。
- 上传 Shapefile：在「资产 / 任务」面板把整套 shapefile（必需 `.shp`/`.shx`/`.dbf`，可选 `.prj`/`.cpg`）入库为云端 Table 资产；云端不可用时经确认后降级为本地 GeoJSON 条目，仍可注入脚本与对话。

- Reads the full script, the current selection, and Console text from the Earth Engine Ace editor.
- Sends the task with optional context to a custom model endpoint.
- Extracts the complete JavaScript script returned by the model and shows a line-by-line diff.
- Replaces the full script or inserts code at the cursor, only after the user confirms.
- Even when not connected to the Earth Engine editor, it can generate a standalone complete script from a confirmed plan, ready to paste into the Code Editor via "Copy code".
- Validates the script version before writing, so edits the user just made are never overwritten.
- Clicks the Earth Engine Run button after the user confirms.
- The API key is kept in the browser session by default; the user may opt to persist it locally.
- The API key is never passed to the Earth Engine page or the content script.
- Dataset Search: searches the official Google Earth Engine data catalog and verifies dataset IDs, descriptions, bands, and time ranges.
- Docs Search: searches the official Google Earth Engine guides, API reference, REST reference, and tutorials.
- Search results are shown as clickable sources and passed to the model as bounded reference context.
- DeepSeek V4 Flash / Pro support real-time reasoning display with High or Max thinking effort; reasoning collapses automatically once the final answer starts.
- Complex tasks use a `fast / full / loop` reasoning gate and an auditable `Goal / Core / Verified / Open / Next` ledger; only task state is persisted, never detailed chain-of-thought.
- On official DeepSeek V4, `full / loop` turns may invoke a strict allowlist of read-only tools to search official datasets/docs or re-read editor/Console context already enabled by the user; the model receives no write, run, or delete tools.
- Generated code passes a deterministic local preflight for JavaScript structure, Code Editor runtime surface, common secret patterns, official dataset evidence, and confirmed-plan alignment. Blocking findings get at most one diagnostic repair; unresolved candidates cannot be written with one click.
- After the user confirms Run, the extension briefly monitors the real GEE Console. If an error appears, it exposes a "Repair from Console" action; another explicit user click is required before any model request is made.
- Plan mode first researches official sources, compares datasets, and clarifies the analysis scope, and only generates code after user confirmation; with official DeepSeek V4 Flash it first builds a 4–8 item verifiable TODO list, then researches each item in order.
- Model and project settings are hidden by default and open via the gear button at the top-left of the side panel.
- A dedicated conversation window shows user inputs, assistant replies, official source snapshots, errors, thinking status, and plan actions in chronological order; every plan revision keeps a read-only text snapshot, which can be cleared and is restored after reopening the side panel.
- The most recently generated code stays in the conversation as a code card; after applying it is marked "Applied" instead of disappearing, remains viewable and copyable after reopening the side panel, and is removed only when "Close code card" is clicked.
- v0.4 uses a single task-stream layout: official search, thinking, plans, errors, and code results all appear right next to their messages, the bottom composer is always available, and the page and chat no longer scroll against each other.
- Auto-follow pauses while the user reads upward; a "Back to latest" control appears when new content arrives, and following resumes after returning to the bottom.
- You can keep sending requests while the model is working. Messages enter a follow-up queue that is editable, deletable, and re-prioritizable; stopping the current task pauses without clearing the queue.
- The top "＋" starts a new conversation; it asks for confirmation, then clears the current chat, plan, code card, and follow-up queue, without touching the GEE editor script.
- Earth Engine REST direct connection: after configuring a dedicated OAuth client, you can browse project assets and tasks in the side panel, copy asset IDs, and inject them into the conversation; the token is kept in the browser session only.
- Shapefile upload: from the "Assets / Tasks" panel, upload a complete shapefile set (required `.shp`/`.shx`/`.dbf`, optional `.prj`/`.cpg`) as a cloud Table asset; when the cloud path is unavailable, it falls back to a local GeoJSON entry after confirmation, which can still be injected into scripts and conversations.

## 安装 / Installation

1. 解压发布的 ZIP 文件。
2. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择本扩展目录。
5. 打开 `https://code.earthengine.google.com/`。
6. 点击浏览器工具栏中的扩展图标，打开侧边栏。
7. 点击侧栏左上角齿轮，在“模型与项目设置”中选择模型服务商（或直接填写 API 地址、模型名称），再输入 API Key。

1. Unzip the release ZIP file.
2. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
3. Enable "Developer mode".
4. Click "Load unpacked" and select this extension's directory.
5. Open `https://code.earthengine.google.com/`.
6. Click the extension icon in the browser toolbar to open the side panel.
7. Click the gear at the top-left of the side panel, pick a model provider under "Model & project settings" (or enter the API address and model name directly), then enter the API key.

DeepSeek 默认 API 地址为 `https://api.deepseek.com`。扩展会调用其 `/chat/completions` 路径。如果服务商要求完整路径，也可以直接把 API 地址填写为以 `/chat/completions` 结尾的地址。只有官方 DeepSeek V4 Flash / Pro 会启用流式思考参数；其他 OpenAI 兼容接口自动使用普通非流式模式。

The default DeepSeek API address is `https://api.deepseek.com`; the extension calls its `/chat/completions` path. If a provider requires the full path, you may enter an API address ending in `/chat/completions` directly. Only official DeepSeek V4 Flash / Pro enable streaming reasoning parameters; other OpenAI-compatible endpoints automatically use plain non-streaming mode.

填写自定义（含本地模型等）OpenAI 兼容端点时，扩展仅在保存设置那一刻通过 `chrome.permissions.request` 按需申请对应端点的可选主机权限，不预授权、不在后台静默申请。

When you enter a custom OpenAI-compatible endpoint (including local models), the extension requests the optional host permission for that endpoint on demand via `chrome.permissions.request`, only at the moment you save settings — there is no pre-authorization and no silent background request.

### 模型服务商预设 / Provider Presets

设置面板顶部的“模型服务商”下拉内置了 DeepSeek 官方、智谱 GLM、Moonshot Kimi 和阿里通义 Qwen 的 OpenAI 兼容端点与各系列通用默认模型；选中后会自动填充 API 地址与模型名称，只需输入对应平台的 API Key 即可使用。两个字段填充后仍可自由修改；手动改成与预设不一致的值时，下拉会自动回到“自定义”，选择“自定义”不会改动已填内容。预设只做便捷填充，不改变请求构造与思考模式判定；非官方 DeepSeek 接口如需流式输出，仍可勾选“兼容接口启用流式输出”。

The "Model provider" dropdown at the top of the settings panel ships with the OpenAI-compatible endpoints and sensible default models for official DeepSeek, Zhipu GLM, Moonshot Kimi, and Alibaba Qwen. Selecting one auto-fills the API address and model name — you only need to enter that platform's API key. Both fields remain editable afterwards; if you change them to values that no longer match a preset, the dropdown automatically falls back to "Custom", and selecting "Custom" never alters what you typed. Presets are purely for convenience and do not change request construction or thinking-mode detection; if a non-official DeepSeek endpoint needs streaming output, you can still enable "Streaming output for compatible endpoints".

## 使用方法 / Usage

1. 点击“读取代码”，确认状态显示“已连接”。
2. 输入任务，例如“修复 Console 报错并返回完整脚本”。
3. 根据需要启用 Dataset Search、Docs Search；两者可以同时使用。
4. 检查官方资料来源、模型解释和差异预览。
5. 点击“替换完整脚本”或“插入到光标”。
6. 如需执行，点击“运行脚本”并再次确认；若监测到真实 Console 错误，可再点击“根据 Console 修复”。

1. Click "Read code" and confirm the status shows "Connected".
2. Enter a task, e.g. "fix the Console errors and return the full script".
3. Enable Dataset Search and/or Docs Search as needed; both can be used together.
4. Review the official sources, the model's explanation, and the diff preview.
5. Click "Replace full script" or "Insert at cursor".
6. To execute, click "Run script" and confirm again. If a real Console error is detected, click "Repair from Console" to explicitly request a diagnostic fix.

生成代码后，如果你仍停留在对话底部，界面会定位到代码卡；如果正在阅读较早内容，则只显示“回到最新”而不会抢走滚动位置。代码卡同时提供差异预览和可展开的完整代码；即使模型没有正确使用 Markdown 代码围栏，扩展也会尝试从说明文字后识别 GEE JavaScript。应用代码后卡片会保留并显示“已应用”，方便复查或再次复制。

After code is generated, if you are still at the bottom of the conversation the view scrolls to the code card; if you are reading earlier content, only "Back to latest" is shown and your scroll position is never stolen. The code card offers both a diff preview and the expandable full code; even when the model misuses Markdown code fences, the extension tries to recognize GEE JavaScript after the explanatory text. After applying, the card stays and shows "Applied", so you can review or copy it again.

第一次使用搜索工具时，扩展会从 Google 官方页面建立轻量索引并缓存 24 小时，因此可能比后续检索稍慢。Dataset Search 只使用官方 Earth Engine Data Catalog；Docs Search 只使用 `developers.google.com/earth-engine` 下的官方资料，不调用 Gemini 的内部工具接口。

On first use of the search tools, the extension builds a lightweight index from Google's official pages and caches it for 24 hours, so the first search may be slower than later ones. Dataset Search uses only the official Earth Engine Data Catalog; Docs Search uses only official material under `developers.google.com/earth-engine` and never calls any internal Gemini tool API.

### 思考模式 / Thinking Mode

在齿轮设置中可以开启或关闭思考，并选择 `High` 或 `Max`。思考内容仅在当前请求期间显示，最终回答开始后自动折叠；它不会保存到对话历史或浏览器存储。关闭思考时仍使用流式最终回答，但不显示思考区域。

复杂任务会另外保存一个不含思维链的控制账本，记录目标、稳定约束、已验证检查点及其覆盖范围、待解决问题、下一动作和失败签名。该账本显示在对话中的“推理控制”卡，可在重开侧栏后恢复；开始新对话会清除它。

Thinking can be toggled in the gear settings, with `High` or `Max` effort. Reasoning is displayed only during the current request and collapses automatically once the final answer starts; it is never saved to conversation history or browser storage. With thinking off, the final answer still streams, but no reasoning area is shown.

Complex tasks separately persist a control ledger without chain-of-thought: goal, stable constraints, verified checkpoints with coverage, open questions, next action, and failure signatures. It appears in the conversation as the "Reasoning control" card, survives reopening the side panel, and is cleared by starting a new conversation.

### 计划模式 / Plan Mode

1. 在底部输入器中切换到“计划”。Dataset Search 和 Docs Search 会强制开启。
2. 输入计算需求，例如“计算 2000–2020 年广州市 NDVI 均值变化”。
3. 检查候选数据集的覆盖范围、空间分辨率、优势和限制，并回答计划卡中的关键问题。可依次点击多个问题的选项，答案会自动叠加到输入框；同一问题重新选择只替换该题答案，不会清除其他回答或手动补充内容。
   使用官方 DeepSeek V4 Flash 时，计划卡还会显示完整 TODO List、当前任务、所需证据、本轮完成项和每项调研结果；详细内部思维链不会写入计划或对话记录。
4. 每次补充需求都会产生新的计划 revision，并使旧版本失效；检查调研结论、研究区、时间聚合、空间统计、质量控制、假设、风险和输出。
5. 当状态变为“审阅方案”后，点击对应 revision 的“采用方案 rN 并生成代码”。没有显式采用当前版本前，计划模式不会生成或写入代码。
6. 检查生成脚本的差异并手动应用；成功应用后，长期保存的计划会自动清除。

1. Switch to "Plan" in the bottom composer. Dataset Search and Docs Search are force-enabled.
2. Enter the analysis requirement, e.g. "compute the mean NDVI change in Guangzhou from 2000 to 2020".
3. Review the coverage, spatial resolution, strengths, and limits of candidate datasets, and answer the key questions on the plan card. You can click options for several questions in a row and the answers accumulate in the input box; re-answering the same question only replaces that answer and never clears other answers or manually added content.
   With official DeepSeek V4 Flash, the plan card also shows the full TODO list, the current task, the required evidence, the items completed this round, and each item's research findings; detailed internal chain-of-thought is never written into the plan or the conversation log.
4. Every additional requirement creates a new plan revision and invalidates older ones; review the research conclusions, study area, temporal aggregation, spatial statistics, quality control, assumptions, risks, and output.
5. Once the status becomes "Review plan", click "Adopt plan rN and generate code" for the desired revision. Plan mode never generates or writes code until the current revision is explicitly adopted.
6. Review the diff of the generated script and apply it manually; after a successful apply, the long-term saved plan is cleared automatically.

未完成计划保存在 `chrome.storage.local`，关闭或重启浏览器后可以恢复。保存内容只包括原始需求、用户答复、官方来源和结构化方案，不包括完整编辑器代码、Console、API Key 或思考过程。对话窗口另外保存经过长度限制和常见密钥脱敏的可见文字记录，思考过程不会进入其中；点击顶部“＋”可开始新对话，点击“取消计划”只删除当前计划。后续消息队列也会本地保存并经过同样的常见密钥脱敏。

Unfinished plans are stored in `chrome.storage.local` and survive closing or restarting the browser. What is saved includes only the original requirement, user answers, official sources, and the structured plan — never the full editor code, Console, API key, or reasoning process. The conversation window additionally keeps a length-limited, common-key-redacted visible text log that never contains reasoning; the top "＋" starts a new conversation, and "Cancel plan" deletes only the current plan. The follow-up message queue is also stored locally with the same common-key redaction.

### 上传 Shapefile / Uploading Shapefiles

点击侧栏「资产 / 任务」面板头部「刷新」旁的「上传 Shapefile」按钮，选择一整套 shapefile 文件（必需 `.shp`、`.shx`、`.dbf`，可选 `.prj`、`.cpg`）。扩展按以下两条路径处理：

Click the "Upload Shapefile" button next to "Refresh" in the side panel's "Assets / Tasks" panel header, and select a complete shapefile set (required `.shp`, `.shx`, `.dbf`; optional `.prj`, `.cpg`). The extension then follows one of two paths:

1. **云端直传（主路径）**：当处于 Code Editor 页面且已完成 REST 直连的 OAuth 客户端与项目配置时，扩展先经页面桥接借用页面会话把文件字节暂存到 Google 后端（与「注入脚本 / 读取状态」同一 MAIN world 桥接机制），再用扩展自有的 `earthengine` 范围 OAuth 令牌调用公开的 `table:import` REST 接口，把暂存字节入库为云端 Table 资产。成功后资产出现在资产列表中，可直接使用既有的「复制 ID」与「注入对话」。整套文件直传上限 8MB。
2. **本地降级路径**：云端不可用（不在编辑器页面、未完成配置或上传失败）时，经用户确认后扩展在本地解析 shapefile 为 GeoJSON，保存为「SHP·本地」条目：支持注入脚本（生成内联 `ee.FeatureCollection`）与注入对话（摘要标记）。

1. **Cloud direct upload (primary path)**: when you are on the Code Editor page and the REST direct connection's OAuth client and project are configured, the extension first borrows the page session via the page bridge to stage the file bytes on Google's backend (the same MAIN-world bridge used for "inject script / read status"), then calls the public `table:import` REST endpoint with the extension's own `earthengine`-scoped OAuth token to import the staged bytes as a cloud Table asset. On success the asset appears in the asset list, ready for the existing "Copy ID" and "Inject into conversation" actions. The whole-set direct upload limit is 8 MB.
2. **Local fallback path**: when the cloud path is unavailable (not on the editor page, not configured, or the upload fails), the extension parses the shapefile locally into GeoJSON after user confirmation and saves it as an "SHP·Local" entry: script injection (an inline `ee.FeatureCollection`) and conversation injection (a summary marker) are both supported.

使用限制：

- 云端直传整套上限 8MB；本地解析整套上限 32MB、要素数不超过 50000、生成的注入片段不超过 1MB。
- 只支持 2D 点、线、面几何（带 Z 值的几何会降维处理）；属性仅支持 dBase III 格式。
- `.prj` 声明非 EPSG:4326 的文件会被拒绝，扩展不做重投影；`.cpg` 用于声明属性编码，缺省按 UTF-8 解析。
- 同名云端资产已存在时上传会报错，请改名后重试。

Usage limits:

- Cloud direct upload: 8 MB per whole set; local parsing: 32 MB per whole set, at most 50,000 features, and the generated injection snippet at most 1 MB.
- Only 2D point, line, and polygon geometries are supported (geometries with Z values are dimension-reduced); attributes must be dBase III format.
- Files whose `.prj` declares anything other than EPSG:4326 are rejected — the extension performs no reprojection; `.cpg` declares the attribute encoding, defaulting to UTF-8.
- Uploading fails if a cloud asset with the same name already exists; rename and retry.

## Earth Engine API 说明 / Earth Engine API Notes

当前版本复用 Code Editor 自身已经完成的 Earth Engine 登录和运行环境，仅通过编辑器写入代码并由用户触发 Run；它不会把登录 Cookie、OAuth token 或 XSRF token 读取进扩展存储或传出页面。唯一例外是 Shapefile 云端上传的字节暂存段：该操作在 Code Editor 页面上下文内借用页面会话完成，详见下文「安全边界」。

The current version reuses the Earth Engine login and runtime already established by the Code Editor itself: it only writes code through the editor and lets the user trigger Run. It never reads login cookies, OAuth tokens, or XSRF tokens into extension storage or out of the page. The single exception is the byte-staging step of cloud shapefile upload, which borrows the page session inside the Code Editor page context — see "Security Boundaries" below.

“Earth Engine Project ID”会作为模型上下文，帮助模型生成适用于该项目的代码；它同时也是 REST 直连的目标项目。

The "Earth Engine Project ID" is provided to the model as context so it can generate code suitable for that project; it is also the target project of the REST direct connection.

### REST 直连（资产 / 任务）/ REST Direct Connection (Assets / Tasks)

本功能使用完全独立的 Google OAuth 客户端：不读取、不复用、不提取 Code Editor 的登录状态或网页令牌，只通过 `chrome.identity` 弹窗经用户授权获得 `https://www.googleapis.com/auth/earthengine` 范围的短期令牌。唯一例外是 Shapefile 云端上传的字节暂存段，见下文说明。

This feature uses a completely separate Google OAuth client: it never reads, reuses, or extracts the Code Editor's login state or web tokens, and only obtains a short-lived `https://www.googleapis.com/auth/earthengine`-scoped token through a `chrome.identity` popup with the user's authorization. The single exception is the byte-staging step of cloud shapefile upload, described below.

配置步骤：

1. 在 Google Cloud Console 中为你的 Earth Engine 项目创建一个 OAuth 客户端（应用类型选“Web 应用”）。
2. 在 OAuth 同意屏幕配置中，发布状态保持“测试”即可（`earthengine` 属于敏感范围，正式发布需通过 Google 验证）；但必须把将要使用扩展的 Google 账号加入“测试用户”列表，否则授权时会出现 `403: access_denied` / “Access blocked: …has not completed the Google verification process”。
3. 打开侧栏设置，把其中展示的只读重定向 URI（可点“复制”）添加到该 OAuth 客户端的“已获授权的重定向 URI”。
4. 把 OAuth 客户端 ID 填入设置的“Google OAuth 客户端 ID”，并在“Earth Engine Project ID”中填写同一云项目 ID。
5. 点击侧栏工具区的“资产/任务”。首次加载会弹出 Google 授权窗口；授权后令牌仅缓存在 `chrome.storage.session`，关闭浏览器即清除。

Setup steps:

1. In the Google Cloud Console, create an OAuth client for your Earth Engine project (application type "Web application").
2. In the OAuth consent screen configuration, the publishing status can stay "Testing" (`earthengine` is a sensitive scope; production distribution requires Google verification) — but you must add the Google account that will use the extension to the "Test users" list, otherwise authorization fails with `403: access_denied` / "Access blocked: …has not completed the Google verification process".
3. Open the side panel settings and add the read-only redirect URI shown there (click "Copy") to the OAuth client's "Authorized redirect URIs".
4. Enter the OAuth client ID into "Google OAuth client ID" in settings, and enter the same cloud project ID into "Earth Engine Project ID".
5. Click "Assets/Tasks" in the side panel's tool area. The first load opens a Google authorization popup; after authorization the token is cached in `chrome.storage.session` only and is cleared when the browser closes.

已知限制：

- 未打包（开发者模式加载）的扩展 ID 可能在重新安装或更换浏览器后变化，导致重定向 URI 改变；届时需要在 Google Cloud Console 更新该 OAuth 客户端的重定向 URI。
- REST 直连以资产与任务的只读浏览为主；写入仅支持「上传 Shapefile」经公开的 `table:import` 接口入库云端 Table 资产，不会发起导出或以扩展身份执行任何 Earth Engine 计算。入库前的字节暂存段借用 Code Editor 页面会话完成（与脚本注入同一 MAIN world 桥接机制，详见「安全边界」），入库段使用扩展自有 `earthengine` 范围的 Bearer 令牌。
- OAuth 同意屏幕处于“测试”状态时，Google 签发的访问令牌有效期受限（约 7 天）；过期后扩展会重新弹出授权窗口，重新授权即可，属预期行为。

Known limitations:

- The ID of an unpacked (developer-mode) extension may change after reinstalling or switching browsers, which changes the redirect URI; you then need to update the OAuth client's redirect URI in the Google Cloud Console.
- The REST direct connection is primarily read-only browsing of assets and tasks; the only write is "Upload Shapefile" via the public `table:import` endpoint to create a cloud Table asset — it never starts exports or runs any Earth Engine computation as the extension. The byte-staging step before import borrows the Code Editor page session (the same MAIN-world bridge as script injection; see "Security Boundaries"), while the import step itself uses the extension's own `earthengine`-scoped Bearer token.
- While the OAuth consent screen is in "Testing" status, access tokens issued by Google have a limited lifetime (about 7 days); when one expires the extension simply reopens the authorization popup — re-authorizing is expected behavior.

## 安全边界 / Security Boundaries

- 不要把通过“保存网页源码”得到的 HTML 上传或分享；其中可能含短期 OAuth token、XSRF token、账户邮箱和项目配置。
- 不要把服务账号 JSON、Google OAuth token 或 API Key 粘贴进对话框。
- 对话文字记录会保存在当前浏览器配置中；在共享设备上使用后请开始新对话，并取消未完成计划。
- 最近一次生成的完整代码会单独保存在当前浏览器配置的 `chrome.storage.local` 中；代码可能包含资产路径或研究参数，使用共享设备后请点击“关闭代码卡”清除。
- 多人或生产部署建议让扩展调用自建后端，由后端保管模型供应商密钥。
- 模型生成的代码可能创建导出任务或产生计算用量，因此扩展不会自动运行代码。
- 长期计划可能包含研究区域和分析需求；共享浏览器配置前请先取消计划并清除本地数据。
- Shapefile 云端上传的字节暂存段会在 Code Editor 页面上下文内借用页面会话完成（与脚本注入同一 MAIN world 桥接机制）：扩展不存储、不导出、不读取任何 Cookie / XSRF 凭证的明文，只在页面内发起带凭证的暂存请求；这意味着该段操作以当前登录账号的身份与权限执行。随后的入库段为标准公开 REST 接口（`table:import`），使用扩展自有 `earthengine` 范围的 Bearer 令牌；暂存通道本身为未文档化接口，可能随 Google 变更失效（详见「已知限制」）。

- Never upload or share HTML obtained via "Save page source"; it may contain short-lived OAuth tokens, XSRF tokens, account emails, and project configuration.
- Never paste service-account JSON, Google OAuth tokens, or API keys into the chat box.
- Conversation text logs are stored in the current browser profile; after using a shared device, start a new conversation and cancel unfinished plans.
- The last generated full script is kept separately in `chrome.storage.local` of the current browser profile; the code may contain asset paths or research parameters, so click "Close code card" to clear it after using a shared device.
- For multi-user or production deployments, we recommend pointing the extension at your own backend that holds the model-provider keys.
- Model-generated code may create export tasks or consume computation quota, so the extension never runs code automatically.
- Long-lived plans may contain study areas and analysis requirements; cancel plans and clear local data before sharing a browser profile.
- The byte-staging step of cloud shapefile upload borrows the page session inside the Code Editor page context (the same MAIN-world bridge as script injection): the extension does not store, export, or read any Cookie / XSRF credential in plaintext — it only issues credentialed staging requests from within the page, which means this step executes with the identity and permissions of the currently signed-in account. The subsequent import step uses the standard public REST endpoint (`table:import`) with the extension's own `earthengine`-scoped Bearer token; the staging channel itself is an undocumented API and may break if Google changes it (see "Known Limitations").

## Earth Engine 计算资源声明 / Computation Resource Notice

本插件生成的脚本可能在大范围、长时间序列、高空间分辨率或复杂聚合任务中触发 Google Earth Engine 的服务端计算限制，例如 `User memory limit exceeded`、`Computation timed out`、`Too many concurrent aggregations` 或 `Quota exceeded`。这类错误通常表示任务规模超过当前执行环境或账号配额，并不一定表示脚本存在语法错误。

插件的本地代码预检只检查 JavaScript 结构、常见 Earth Engine API 使用、数据集来源和已确认计划的一致性，不能预先保证脚本在 GEE 服务端的资源消耗一定处于配额以内。实际开销还取决于研究区大小、时间跨度、数据分辨率、`scale`、波段数量、聚合次数及账号配额。

遇到计算过载时，建议先用较小区域和较短时间范围验证脚本，再逐步扩大规模，并酌情采取以下措施：

- 增大 `scale`，避免对大范围直接使用原始最高分辨率。
- 按年份、时间段或子区域拆分任务。
- 尽早使用 `filterDate`、`filterBounds` 和 `select` 缩小数据量。
- 合理设置 `tileScale`、`maxPixels` 和 `bestEffort`，并了解这些参数对精度与资源消耗的影响。
- 优先使用批量 `Export` 处理大型任务，避免在交互请求中执行超大聚合。
- 避免在循环中频繁调用 `reduceRegion`、`getInfo()` 或创建大量并发统计任务。

Scripts generated by this extension may hit Google Earth Engine server-side computation limits when processing large regions, long time series, high-resolution imagery, or aggregation-heavy workflows. Typical errors include `User memory limit exceeded`, `Computation timed out`, `Too many concurrent aggregations`, and `Quota exceeded`. These errors generally indicate that the workload exceeds the current execution environment or account quota; they do not necessarily mean the script has a syntax error.

The extension's local preflight checks JavaScript structure, common Earth Engine API usage, dataset provenance, and alignment with the confirmed plan. It cannot guarantee that server-side resource consumption will remain within quota. Actual cost depends on region size, time span, spatial resolution, `scale`, band count, aggregation count, and account quota.

When a workload exceeds available resources, validate it first with a smaller region and shorter time range, then scale up gradually. Increase `scale` where appropriate, split work by time or region, filter and select data early, use `tileScale`, `maxPixels`, and `bestEffort` deliberately, prefer batch `Export` for large jobs, and avoid repeated `reduceRegion`, `getInfo()`, or many concurrent aggregations inside loops.

## 页面兼容性 / Page Compatibility

本扩展根据当前 Code Editor 的以下结构进行适配：

- Ace 编辑器容器：`.ace_editor`
- 运行按钮：`.run-button`
- Console 容器：`.console-entries`

This extension adapts to the following structure of the current Code Editor:

- Ace editor container: `.ace_editor`
- Run button: `.run-button`
- Console container: `.console-entries`

Earth Engine 没有公开的 Code Editor 插件接口。如果 Google 更新页面结构，需要调整 `page-bridge.js` 或 `content-script.js` 中的适配器。

Earth Engine offers no public Code Editor plugin API. If Google updates the page structure, the adapters in `page-bridge.js` or `content-script.js` must be adjusted.

## 已知限制 / Known Limitations

- Google Earth Engine 页面没有公开的插件接口，编辑器桥接与 Console 读取依赖当前页面 DOM 结构；Google 改版页面可能导致这些功能失效。
- 未打包（开发者模式加载）的扩展 ID 可能变化，届时需同步更新 GEE REST 直连 OAuth 客户端的重定向 URI（详见上文“REST 直连”一节的已知限制）。
- `compatibleStreaming` 是实验性开关：启用后对 OpenAI 兼容端点使用普通流式，但该路径不解析思考内容。
- Dataset Search 与 Docs Search 依赖 `developers.google.com` 可达；该站点不可达时检索功能无法使用。
- Shapefile 云端上传的字节暂存通道（`geturl` / `_ah/upload`）是未文档化接口，可能随 Google 变更而失效；失效时功能会自动引导降级到本地解析路径。
- Shapefile 上传各项上限：云端直传整套 8MB；本地解析整套 32MB、要素数 50000、注入片段 1MB；仅支持 2D 点/线/面（Z 值降维）与 dBase III 属性；`.prj` 非 EPSG:4326 会直接拒绝，不做重投影。

- The Google Earth Engine page has no public plugin API; the editor bridge and Console reading depend on the current page DOM structure, and a redesign by Google may break these features.
- The ID of an unpacked (developer-mode) extension may change; when it does, update the redirect URI of the GEE REST direct-connection OAuth client accordingly (see the known limitations in the "REST Direct Connection" section above).
- `compatibleStreaming` is an experimental switch: when enabled, OpenAI-compatible endpoints use plain streaming, but that path does not parse reasoning content.
- Dataset Search and Docs Search depend on `developers.google.com` being reachable; the search features are unavailable when that site cannot be reached.
- The byte-staging channel for cloud shapefile upload (`geturl` / `_ah/upload`) is an undocumented API and may break when Google changes it; when it fails, the feature automatically guides you to the local parsing fallback.
- Shapefile upload limits: cloud direct upload 8 MB per whole set; local parsing 32 MB per whole set, 50,000 features, 1 MB injection snippet; only 2D point/line/polygon (Z values dimension-reduced) with dBase III attributes; a `.prj` other than EPSG:4326 is rejected outright, with no reprojection.

## 开发与测试 / Development & Testing

无需构建步骤。修改源码后，在扩展管理页点击“重新加载”即可。

No build step is required. After changing the source, click "Reload" on the extensions page.

```bash
npm test
```

### Playwright 扩展诊断 / Playwright Extension Diagnostics

Playwright 仅作为开发依赖运行，不会打包进 MV3 扩展。诊断器会为启动、mock 和真实任务分别启动项目专属的隔离 Chromium 配置，加载当前源码，收集扩展侧栏、Service Worker、相关网络失败及白名单本地记录，并把脱敏 JSON 报告和截图写入 `artifacts/playwright/`。普通启动和 mock 诊断不会读取 `apiKey`、OAuth token、Cookie 或完整候选代码。

Playwright runs only as a development dependency and is never bundled into the MV3 extension. The diagnostic launches separate isolated project-specific Chromium profiles for boot, mock, and live-task runs, loads the current source, captures side-panel, service-worker, relevant network and allow-listed local records, then writes a redacted JSON report and screenshots under `artifacts/playwright/`. Boot and mock diagnostics never read API keys, OAuth tokens, cookies, or full candidate code.

```bash
# 首次安装对应的 Chromium / install the matching Chromium once
npm run diagnose:extension:install

# 无界面启动检查 / headless boot diagnostic
npm run diagnose:extension

# 不调用真实 API，模拟工具阶段与非法 TODO 综合，并验证本地补齐为 4 项
npm run diagnose:extension:mock

# 使用 DEEPSEEK_API_KEY 真实设计广州 2010–2025 年 NDVI 方案
npm run diagnose:extension:guangzhou-ndvi

# 不调用 API，只审计隔离配置中已保存的广州方案
npm run diagnose:extension:guangzhou-ndvi:audit

# 也可从纯文本、.env 或 JSON 文件读取本地密钥
node scripts/diagnose-extension.mjs --api-key-file=C:\安全目录\deepseek-key.txt --live-guangzhou-ndvi

# 显示隔离浏览器，留出 2 分钟手动复现 / headed two-minute reproduction window
node scripts/diagnose-extension.mjs --headed --wait-ms=120000
```

真实广州 NDVI 诊断优先读取 `--api-key-file` 指向的纯文本、`.env` 或 JSON 文件；未指定时读取进程环境变量 `DEEPSEEK_API_KEY`。密钥只写入隔离扩展的 `chrome.storage.session`，浏览器关闭后失效；报告只记录凭据来源和 `hasApiKey` 等非敏感状态。隔离配置保存在 `.playwright/`，不会读取或修改日常使用的 Chrome/Edge 配置，目录与所有报告均由 Git 忽略。

The live Guangzhou diagnostic reads a key from `--api-key-file` (plain text, `.env`, or JSON), or from `DEEPSEEK_API_KEY` when no file is specified. The key exists only in memory and the isolated extension's `chrome.storage.session`, which expires when Chromium closes; reports retain only the credential source and non-sensitive states such as `hasApiKey`. Profiles and reports stay under Git-ignored `.playwright/` and `artifacts/playwright/` directories and never touch the regular Chrome/Edge profile.

## 许可证 / License

[MIT](./LICENSE)
