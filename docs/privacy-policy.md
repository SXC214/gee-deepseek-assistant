# GEE AI Code Assistant — Privacy Policy

_Last updated: 2026-08-19_

## 数据处理概览 / Data processing overview

GEE AI Code Assistant（下称「本扩展」）的开发者不运营数据收集或中转服务器，也无法访问你的数据。本扩展没有广告、统计或追踪组件。为提供明确展示的 Earth Engine 编程助手功能，本扩展会在你的设备上处理和保存部分数据，并仅在你主动操作时将必要内容直接发送到你选择的模型服务商或 Google Earth Engine。

The developer of GEE AI Code Assistant ("the extension") operates no data-collection or relay server and cannot access your data. The extension contains no advertising, analytics, or tracking component. To provide its disclosed Earth Engine coding-assistant features, it processes and stores some data on your device and, only in response to your actions, sends necessary content directly to the model provider you choose or to Google Earth Engine.

## 会话内容的去向 / Where your conversations go

你输入的提示词，以及你选择提供的 Earth Engine 脚本、选区、Console 输出、资产或任务上下文，只在你发起请求时直接传输到**你自行配置**的模型服务商（OpenAI Chat Completions 兼容端点，例如 DeepSeek、智谱、Moonshot、阿里通义，或本地模型如 Ollama）。模型服务商会按其自身隐私政策处理这些数据；扩展开发者不介入、不中转，也无法访问这些传输。

Your prompts and the Earth Engine script, selection, Console output, asset, or task context you choose to provide are sent directly to the model provider **you configure yourself**, only when you initiate a request. That provider processes the data under its own privacy policy; the extension developer does not relay and cannot access these transmissions.

模型返回的 GEE 源代码会先作为文本显示供你审阅。扩展不会通过 `eval`、`new Function` 或远程脚本把回复作为扩展逻辑执行；只有在你明确确认后，代码文本才会写入 Earth Engine 编辑器。如你另行确认运行，代码由 Earth Engine Code Editor 在其自身环境中执行。

GEE source code returned by the model is first displayed as text for your review. The extension does not use `eval`, `new Function`, or remote scripts to execute a response as extension logic. Code text is written to the Earth Engine editor only after your explicit confirmation. If you separately confirm Run, it is executed by the Earth Engine Code Editor in its own environment.

## 本地存储 / Local storage

设置、对话记录、计划历史、不含详细思维链的推理控制账本、代码卡及其本地预检快照、文档缓存以及可选的本地 Shapefile 条目保存在你本机的浏览器存储（`chrome.storage`）中。控制账本只记录目标、约束、验证覆盖、待解决项、下一动作和失败签名；实时 `reasoning_content` 不会保存。API Key 默认仅保存在浏览器会话中；如你选择持久保存，也仅存于本机。Google Earth Engine OAuth 访问令牌仅保存在当前浏览器会话中。你可通过扩展内的清除功能、移除扩展或清除浏览器扩展数据来删除这些数据。

Settings, conversation history, plan history, a reasoning-control ledger without detailed chain-of-thought, code-card and local-preflight snapshots, documentation caches, and optional local Shapefile entries are stored in your browser's `chrome.storage`. The control ledger contains only goals, constraints, verification coverage, open items, next actions, and failure signatures; live `reasoning_content` is never stored. API keys are session-only by default and remain on your device if you opt in to persistent storage. Google Earth Engine OAuth access tokens are kept only for the current browser session. You can delete this data using the extension's clearing controls, by removing the extension, or by clearing browser extension data.

## 第三方服务责任边界 / Third-party services

本扩展可能与你自行配置的第三方模型服务、Google Developers 公开文档以及 Google Earth Engine API 交互。你选择上传的 Shapefile 会直接发送到 Google Earth Engine。上述服务由各自提供方运营并适用其各自隐私政策。本扩展不是 Google 官方产品，与 Google 无关联，也不内嵌任何 Google OAuth 凭据；Google OAuth 令牌仅发送给 Google Earth Engine API。

The extension may interact with third-party model services you configure, public Google Developers documentation, and the Google Earth Engine API. Shapefiles you choose to upload are sent directly to Google Earth Engine. Those services operate under their own privacy policies. The extension is not a Google product, is not affiliated with Google, embeds no Google OAuth credentials, and Google OAuth tokens are sent only to Google Earth Engine APIs.

## 有限使用承诺 / Limited Use disclosure

从 Google API 获得的信息，其使用将遵守 Chrome Web Store 用户数据政策，包括 Limited Use（有限使用）要求。数据仅用于提供本扩展明确披露的单一用途，不用于个性化广告、信用评估、数据销售或任何无关用途。

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide the extension's disclosed single purpose and is not used for personalized advertising, credit assessment, data sales, or unrelated purposes.

## 联系 / Contact

如有隐私相关问题，请通过本项目的 GitHub 仓库 Issues 联系我们。

For privacy questions, please open an issue on this project's GitHub repository.
