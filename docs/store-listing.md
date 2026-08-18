# Chrome Web Store 上架素材 — GEE AI Code Assistant v0.4.0

本文件汇总上架所需的全部文案，各节可直接复制粘贴进 Chrome Web Store 开发者后台对应表单。

- 商店名称（Name）：**GEE AI Code Assistant**
- 版本（Version）：0.4.0
- 单一语言主文案为中文，关键句附英文对照。
- 隐私政策单页见同目录 [`privacy-policy.md`](./privacy-policy.md)（可直接发布到 GitHub Pages）。

---

## 1. 逐项权限理由（Permission Justifications）

> 以下每段对应商店表单中一个权限的说明栏，可直接粘贴。

### tabs

中文：识别当前打开的 Google Earth Engine Code Editor 标签页，以便建立侧栏与编辑器的连接、读取脚本内容和在用户确认后执行脚本。扩展不会读取与该功能无关的标签页信息。
English: Identifies the currently active Google Earth Engine Code Editor tab so the side panel can connect to the editor, read the script, and run it only after the user confirms. The extension never reads information from tabs unrelated to this function.

### identity

中文：在用户配置了自己的 Google OAuth 客户端（client_id）后，弹出授权窗口以获取用户自有的 Earth Engine REST API 访问令牌，用于浏览用户自己项目中的资产与任务。令牌仅保存在浏览器会话中。
English: After the user configures their own Google OAuth client_id, this permission opens the authorization window so the user can grant access to their own Earth Engine REST API. The resulting token is kept only in the browser session.

### clipboardWrite

中文：让用户一键复制模型生成的代码、资产 ID 等文本到剪贴板，方便粘贴回 Earth Engine Code Editor。仅在用户点击复制按钮时写入剪贴板。
English: Lets the user copy generated code or asset IDs to the clipboard with one click, so they can be pasted back into the Earth Engine Code Editor. Clipboard is written only when the user clicks a copy button.

### unlimitedStorage

中文：在本地保存用户的对话记录、计划历史与代码卡快照，确保关闭或重新打开侧栏后内容可以恢复。所有数据仅存储在用户本机的浏览器中。
English: Stores the user's conversation history, plan history, and code-card snapshots locally so content can be restored after the side panel is closed or reopened. All data is stored only in the user's own browser.

### optional_host_permissions（`https://*/*`、`http://localhost/*`、`http://127.0.0.1/*`）

中文：这些是可选主机权限，扩展默认不预先获取。用户在设置面板中自行填写 OpenAI 兼容模型的 API 端点（可能指向本地模型服务，如 Ollama）时，扩展仅在用户保存设置的那一刻通过 `chrome.permissions.request` 按需申请对应端点的权限。扩展不预授权、不在后台静默申请，也不向这些端点发送用户未主动发起的请求。
English: These are optional host permissions and are never granted upfront. When the user enters their own OpenAI-compatible model endpoint in settings (which may point to a local model service such as Ollama), the extension requests permission for that specific endpoint on demand via `chrome.permissions.request`, only at the moment the user saves settings. There is no pre-authorization, no silent background request, and no request the user did not initiate.

---

## 2. 商店详细描述（Detailed Description）

> 长度要求 16–16000 字符；以下为中文版与英文版，两者合计仍在限额内，可按需选用或合并。

### 中文版

**GEE AI Code Assistant** 是专为 Google Earth Engine Code Editor 打造的 AI 代码助手侧栏。它只做一件事：帮助你在 Earth Engine 编辑器里更高效地编写、修复与理解地理空间分析代码。

**工作方式（自带密钥，数据不经第三方中转）**
- **BYO API Key**：在设置中填入你自己的模型 API Key（支持 DeepSeek 官方、智谱 GLM、Moonshot Kimi、阿里通义 Qwen，或任意 OpenAI Chat Completions 兼容端点，包括本地模型如 Ollama）。你的对话内容直接发送到你自行配置的模型服务商，不经过本扩展的任何服务器。
- **BYO OAuth client_id**：如需在侧栏浏览项目资产与任务，可配置你自己的 Google OAuth 客户端；授权令牌只保存在浏览器会话中。

**主要功能**
- 读取编辑器中的完整脚本、选区与 Console 输出，结合上下文生成或修复代码。
- 显示逐行差异预览，经你确认后才替换完整脚本或在光标处插入。
- Dataset Search 与 Docs Search：检索 Earth Engine 官方数据目录与开发者文档，核验数据集 ID、波段与时间范围，结果作为有边界的参考上下文。
- 计划模式：先检索官方资料、比较数据集、澄清分析口径，经确认后再生成代码。
- 对话记录、计划历史与代码卡快照本地保存，重新打开侧栏可恢复。
- 上传 Shapefile（`.shp`/`.shx`/`.dbf` 等）入库为云端 Table 资产。

**重要声明**
- 本扩展不是 Google 官方产品，与 Google 无关联。
  *This extension is not an official Google product and is not affiliated with or endorsed by Google.*
- 扩展不内嵌任何 Google OAuth 凭据；用户凭据仅在用户与 Google 之间流转。
  *The extension embeds no Google OAuth credentials; user credentials flow only between the user and Google.*

### English version

**GEE AI Code Assistant** is an AI coding-assistant side panel built exclusively for the Google Earth Engine Code Editor. It does one job: help you write, fix, and understand geospatial analysis code faster inside the Earth Engine editor.

**How it works (Bring-Your-Own keys; no third-party relay)**
- **BYO API Key**: Enter your own model API key in settings. Supports official DeepSeek, Zhipu GLM, Moonshot Kimi, Alibaba Qwen, or any OpenAI Chat Completions-compatible endpoint, including local models such as Ollama. Your prompts are sent directly to the provider you configure — they never pass through any server owned by this extension.
- **BYO OAuth client_id**: To browse your project's assets and tasks in the side panel, configure your own Google OAuth client. The resulting token is stored only in the browser session.

**Key features**
- Reads the full script, selection, and Console output from the editor to generate or fix code with context.
- Shows a line-by-line diff and replaces the script or inserts at the cursor only after you confirm.
- Dataset Search and Docs Search against the official Earth Engine data catalog and developer docs, verifying dataset IDs, bands, and time ranges.
- Plan mode: research official sources, compare datasets, and clarify the analysis before generating code.
- Conversation history, plan history, and code-card snapshots are stored locally and restored when you reopen the side panel.
- Upload Shapefiles (`.shp`/`.shx`/`.dbf`, etc.) as cloud Table assets.

**Important disclosures**
- This extension is not an official Google product and is not affiliated with or endorsed by Google.
- The extension embeds no Google OAuth credentials; user credentials flow only between the user and Google.

---

## 3. 数据用途申报要点（Data Use Disclosures）

供填写商店「数据用途 / Data use」与隐私实践问卷时参考。

- **不收集任何个人数据**：扩展不收集、不上传、不留存任何用户个人身份信息或遥测数据。
  *Collects no personal data; no telemetry of any kind.*
- **出站网络请求仅三类，且均由用户主动发起**：
  1. 用户自行配置的模型 API（OpenAI 兼容端点，含本地模型）。
  2. `developers.google.com`：检索 Earth Engine 官方公开文档与数据目录（无需凭据）。
  3. `earthengine.googleapis.com`：使用用户自有 OAuth 令牌访问用户自己的 Earth Engine REST 资源。
- **API Key 仅存本机**：默认保存在浏览器会话中；用户可选择在本机 `chrome.storage` 持久保存。Key 从不发送给 Earth Engine 页面、content script 或任何第三方服务器。
- **无远程代码执行**：扩展不从远程加载或执行任何代码；全部逻辑为本地静态脚本。

---

## 4. 简易隐私政策（Privacy Policy）

以下 Markdown 单页可直接发布到 GitHub Pages（建议发布后将其 URL 填入商店「隐私政策」栏）。同目录下已同步生成 [`privacy-policy.md`](./privacy-policy.md)，内容与本段一致。

```markdown
# GEE AI Code Assistant — Privacy Policy

_Last updated: 2026-08-18_

## 我们不收集、不留存任何数据 / We collect and retain no data

GEE AI Code Assistant（下称「本扩展」）不收集、不上传、不向任何第三方转发你的个人数据、代码、对话内容或遥测信息。本扩展没有自己的服务器，也没有任何统计或追踪组件。

GEE AI Code Assistant ("the extension") does not collect, upload, or forward your personal data, code, conversations, or telemetry to any third party. It operates entirely in your browser and has no server or analytics component.

## 会话内容的去向 / Where your conversations go

你输入的提示词与生成的代码，只在你点击发送时直接传输到**你自行配置**的模型服务商（OpenAI Chat Completions 兼容端点，例如 DeepSeek、智谱、Moonshot、阿里通义，或本地模型如 Ollama）。这些数据由该第三方模型服务商按其自身隐私政策处理，本扩展不介入、不中转、不留存。

Prompts and generated code are sent, only when you press send, directly to the model provider **you configure yourself**. That provider handles the data under its own privacy policy; the extension neither relays nor stores it.

## 本地存储 / Local storage

对话记录、计划历史、代码卡快照保存在你本机的浏览器存储（`chrome.storage`）中。API Key 默认仅保存在浏览器会话中；如你选择持久保存，也仅存于本机。你可随时通过清除浏览器数据或扩展内的「清空对话」删除这些数据。

Conversation history, plan history, and code-card snapshots are stored in your browser's local storage. API keys are kept in the browser session by default and, if you opt in to persist them, remain on your device only. You can delete this data at any time.

## 第三方服务责任边界 / Third-party services

本扩展可能与你自行配置的第三方模型服务、以及 Google 的公开文档与 Earth Engine API 交互。这些服务由各自提供方运营并适用其各自隐私政策。本扩展不是 Google 官方产品，与 Google 无关联，也不内嵌任何 Google OAuth 凭据；你的 Google 凭据仅在你与 Google 之间流转。

The extension may interact with third-party model services you configure, Google's public documentation, and the Earth Engine API. Those services are operated under their own privacy policies. The extension is not a Google product, is not affiliated with Google, embeds no Google OAuth credentials, and your Google credentials flow only between you and Google.

## 联系 / Contact

如有隐私相关问题，请通过本项目的 GitHub 仓库 Issues 联系我们。

For privacy questions, please open an issue on this project's GitHub repository.
```

---

## 附：打包与提交对照

- 商店 zip：`f:\Qoder\GEE\gee-deepseek-assistant-v0.4.0-store.zip`（仓库外，不提交）。
- 打包内容（30 项）：`manifest.json`、`service-worker.js`、`content-script.js`、`page-bridge.js`、`sidepanel.js`、`sidepanel.html`、`styles.css`、`LICENSE`、`lib/`（20 个模块）、`icons/`（16/32/48/128）。
- 已排除：`tests/`、`docs/`、`node_modules/`、`package.json`、`package-lock.json`、`eslint.config.js`、`.gitignore`、`README.md`、`.git/`。
- 图标：`icons/icon16.png`、`icons/icon32.png`、`icons/icon48.png`、`icons/icon128.png`，并在 `manifest.json` 的 `icons` 与 `action.default_icon` 中声明。
