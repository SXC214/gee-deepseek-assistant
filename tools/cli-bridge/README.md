# cli-bridge：Qoder CLI → OpenAI 兼容本地桥接

把本机 Qoder CLI（默认 `qoderclicn`）包装为 OpenAI 兼容端点，供 GEE AI 辅助助手扩展以
`baseUrl http://127.0.0.1:3000/v1` 接入。**单文件、零 npm 依赖**（仅 `node:` 内置模块），
HTTP 服务**仅监听 127.0.0.1 回环地址**。

## 启动方式

默认必须带鉴权启动（未设置 `PROXY_API_KEY` 时服务会拒绝启动并在 stderr 提示）：

```powershell
# 在扩展仓库根目录（gee-deepseek-assistant/）执行
$env:PROXY_API_KEY = "sk-local-任意自定字符串"
node tools/cli-bridge/server.mjs
```

逃生门（仅供本地快速试用，**不推荐**）：

```powershell
# ⚠ 无鉴权模式：本机任何进程均可调用桥接，消耗你的 Qoder Credits
$env:BRIDGE_ALLOW_NO_AUTH = "1"
node tools/cli-bridge/server.mjs
```

启动成功后输出：

```
[cli-bridge] listening on http://127.0.0.1:3000/v1 (CLI: qoderclicn)
```

前置条件：已安装并登录 Qoder CLI（见下方「安装与登录」）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BRIDGE_PORT` | `3000` | 监听端口（仅绑定 127.0.0.1）。扩展预设使用 3000，改动后需在扩展设置中手填 baseUrl。 |
| `BRIDGE_CLI` | `qoderclicn` | 要 spawn 的 CLI 命令名（服务端配置，HTTP 请求无法注入）。 |
| `BRIDGE_CLI_ARGS` | 空 | 附加参数白名单，按空白分隔，追加在固定参数之后（服务端配置，HTTP 请求无法注入）。 |
| `PROXY_API_KEY` | 空 | Bearer 鉴权密钥。**未设置且未开逃生门时拒绝启动**；设置后 `Authorization: Bearer <key>` 必须精确匹配。 |
| `BRIDGE_ALLOW_NO_AUTH` | 未设置 | 设为 `1` 时允许无 `PROXY_API_KEY` 启动（仅供本地快速试用的显式逃生门，不安全，不推荐）。 |
| `BRIDGE_TIMEOUT_MS` | `300000` | CLI 单次调用超时（毫秒），超时 kill 子进程并返回 OpenAI 风格错误 JSON。 |

每次请求固定执行（prompt 为唯一动态部分，由 messages 拼接而来）：

```
<BRIDGE_CLI> -q -p <prompt> --output-format stream-json --max-turns=1 [<BRIDGE_CLI_ARGS>...]
```

## API

- `POST /v1/chat/completions`：OpenAI 兼容。`stream: true` → 标准 SSE（`data: {choices:[{delta:{content}}]}` …，结尾 `data: [DONE]`）；`stream: false` → 聚合最终文本后一次性 JSON 返回。CLI 退出码非 0 或超时 → OpenAI 风格错误 JSON。
- `GET /v1/models`：返回 `{data:[{id:"qoder-cli"}]}`，供扩展端探测连通性（不鉴权）。
- 其余路径 → 404。

## 安全须知

- **默认拒绝零鉴权**：未设置 `PROXY_API_KEY` 时服务拒绝启动；`BRIDGE_ALLOW_NO_AUTH=1` 仅是本地快速试用的显式逃生门，切勿长期或对外使用。
- **loopback-only**：服务只绑定 `127.0.0.1`，不要通过端口转发/代理暴露到局域网或公网。
- **CORS 白名单**：`Access-Control-Allow-Origin` 仅对 `chrome-extension://` 来源回显，其他 Origin 不下发该头；扩展持 host_permissions 访问回环端点不依赖 CORS。
- **PROXY_API_KEY**：防止本机其他进程冒用桥接。扩展端在设置中填入相同字符串即可。
- **费用由你承担**：每次对话都会实际调用 Qoder CLI，消耗你的 **Qoder Credits**；请自行确认该用法符合 Qoder 服务条款与你的订阅/额度约束，合规责任在使用者本人。
- CLI 命令与参数全部来自服务端环境变量，HTTP 请求侧只能影响 prompt 内容，无法注入命令行参数。

## 与扩展的配合

1. 启动桥接：先设置 `PROXY_API_KEY` 再 `node tools/cli-bridge/server.mjs`（仅本地快速试用可用 `BRIDGE_ALLOW_NO_AUTH=1` 免密启动）。
2. 打开扩展侧栏 → 设置：
   - 方式一：服务商预设选择 **「本地 Qoder CLI 桥接」（local-qoder）**，模型默认 `qoder-cli`；
   - 方式二：手填 `baseUrl = http://127.0.0.1:3000/v1`，并勾选「兼容端点流式」（OpenAI 兼容 SSE）。
3. 若桥接设置了 `PROXY_API_KEY`，在扩展 API Key 输入框填入相同值；若以 `BRIDGE_ALLOW_NO_AUTH=1` 免密启动则留空（扩展对 localhost 端点豁免空 Key 校验）。
4. 回到对话页发起提问即可；`GET /v1/models` 可用于先验证连通性。

## 安装与登录 Qoder CLI

```powershell
npm install -g @qodercn-ai/qoderclicn
qoderclicn login   # 按提示完成 PAT 登录
```

## 单元测试

```powershell
node tests/cli-bridge-tests.mjs
```
