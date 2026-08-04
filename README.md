# GEE AI Code Assistant v0.3.0

这是一个 Chrome / Edge Manifest V3 扩展，为 Google Earth Engine Code Editor 增加独立的 AI 侧边栏。它支持 DeepSeek，也支持其他提供 OpenAI Chat Completions 兼容接口的模型服务。

## 已实现

- 读取 Earth Engine Ace 编辑器中的完整脚本、选区和 Console 文本。
- 将任务与可选上下文发送到自定义模型接口。
- 提取模型返回的完整 JavaScript 脚本并显示逐行差异。
- 经用户确认后替换完整脚本，或在光标处插入代码。
- 写入前校验脚本版本，防止覆盖用户刚刚做出的修改。
- 用户确认后点击 Earth Engine 的 Run 按钮。
- API Key 默认只保存在浏览器会话中；可由用户选择在本机持久保存。
- API Key 不会传递给 Earth Engine 页面或 content script。
- Dataset Search：检索 Google Earth Engine 官方数据目录，核验数据集 ID、说明、波段和时间范围。
- Docs Search：检索 Google Earth Engine 官方指南、API 参考、REST 参考和教程。
- 检索结果会显示为可点击来源，并作为有边界的参考上下文传给模型。
- DeepSeek V4 Flash / Pro 支持实时展示思考过程，并可选择 High 或 Max 思考强度；最终回答开始后自动折叠思考内容。
- 计划模式会先检索官方资料、比较数据集、澄清分析口径，经用户确认后才生成代码。
- 模型与项目设置默认隐藏，通过侧栏左上角的齿轮按钮打开。

## 安装

1. 解压发布的 ZIP 文件。
2. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择本扩展目录。
5. 打开 `https://code.earthengine.google.com/`。
6. 点击浏览器工具栏中的扩展图标，打开侧边栏。
7. 点击侧栏左上角齿轮，在“模型与项目设置”中填写 API 地址、模型名称和 API Key。

DeepSeek 默认 API 地址为 `https://api.deepseek.com`。扩展会调用其 `/chat/completions` 路径。如果服务商要求完整路径，也可以直接把 API 地址填写为以 `/chat/completions` 结尾的地址。只有官方 DeepSeek V4 Flash / Pro 会启用流式思考参数；其他 OpenAI 兼容接口自动使用普通非流式模式。

## 使用方法

1. 点击“读取代码”，确认状态显示“已连接”。
2. 输入任务，例如“修复 Console 报错并返回完整脚本”。
3. 根据需要启用 Dataset Search、Docs Search；两者可以同时使用。
4. 检查官方资料来源、模型解释和差异预览。
5. 点击“替换完整脚本”或“插入到光标”。
6. 如需执行，点击“运行脚本”并再次确认。

第一次使用搜索工具时，扩展会从 Google 官方页面建立轻量索引并缓存 24 小时，因此可能比后续检索稍慢。Dataset Search 只使用官方 Earth Engine Data Catalog；Docs Search 只使用 `developers.google.com/earth-engine` 下的官方资料，不调用 Gemini 的内部工具接口。

### 思考模式

在齿轮设置中可以开启或关闭思考，并选择 `High` 或 `Max`。思考内容仅在当前请求期间显示，最终回答开始后自动折叠；它不会保存到对话历史或浏览器存储。关闭思考时仍使用流式最终回答，但不显示思考区域。

### 计划模式

1. 在输入区勾选“计划模式”。Dataset Search 和 Docs Search 会强制开启。
2. 输入计算需求，例如“计算 2000–2020 年广州市 NDVI 均值变化”。
3. 检查候选数据集的覆盖范围、空间分辨率、优势和限制，并回答计划中的澄清问题。
4. 当状态变为“等待确认”后，检查研究区、时间聚合、空间统计、质量控制和输出。
5. 点击“确认方案并生成代码”。没有点击此按钮前，计划模式不会生成或写入代码。
6. 检查生成脚本的差异并手动应用；成功应用后，长期保存的计划会自动清除。

未完成计划保存在 `chrome.storage.local`，关闭或重启浏览器后可以恢复。保存内容只包括原始需求、用户答复、官方来源和结构化方案，不包括完整编辑器代码、Console、API Key 或思考过程。点击“取消计划”可立即清除。

## Earth Engine API 说明

当前版本复用 Code Editor 自身已经完成的 Earth Engine 登录和运行环境，仅通过编辑器写入代码并由用户触发 Run；它不会读取登录 Cookie、OAuth token 或 XSRF token。

“Earth Engine Project ID”会作为模型上下文，帮助模型生成适用于该项目的代码，但本版本不会以该 Project ID 单独发起 Earth Engine REST 请求。若后续需要在扩展中直接列出资产、查询任务或调用 REST API，应为扩展创建独立的 Google OAuth 客户端，并通过用户授权获得 Earth Engine scope，不能复用或提取网页令牌。

## 安全边界

- 不要把通过“保存网页源码”得到的 HTML 上传或分享；其中可能含短期 OAuth token、XSRF token、账户邮箱和项目配置。
- 不要把服务账号 JSON、Google OAuth token 或 API Key 粘贴进对话框。
- 多人或生产部署建议让扩展调用自建后端，由后端保管模型供应商密钥。
- 模型生成的代码可能创建导出任务或产生计算用量，因此扩展不会自动运行代码。
- 长期计划可能包含研究区域和分析需求；共享浏览器配置前请先取消计划并清除本地数据。

## 页面兼容性

本扩展根据当前 Code Editor 的以下结构进行适配：

- Ace 编辑器容器：`.ace_editor`
- 运行按钮：`.run-button`
- Console 容器：`.console-entries`

Earth Engine 没有公开的 Code Editor 插件接口。如果 Google 更新页面结构，需要调整 `page-bridge.js` 或 `content-script.js` 中的适配器。

## 开发与测试

无需构建步骤。修改源码后，在扩展管理页点击“重新加载”即可。

```bash
npm test
```
