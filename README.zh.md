# dsh-opencode-go-x-session（OpenCode 会话头注入）

[![npm version](https://img.shields.io/npm/v/dsh-opencode-go-x-session.svg)](https://www.npmjs.com/package/dsh-opencode-go-x-session)
[![npm downloads](https://img.shields.io/npm/dm/dsh-opencode-go-x-session.svg)](https://www.npmjs.com/package/dsh-opencode-go-x-session)
[![license](https://img.shields.io/npm/l/dsh-opencode-go-x-session.svg)](./LICENSE)

中文 · [English](./README.md)

Host-only 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：为配置的
OpenCode provider 路由上的模型请求补上 OpenCode Go 必需的 `x-opencode-session` 头——包括官方
**自动审查**功能手写的审查请求——其他路由、其他主机、其他 provider 一概不碰。

## 你是否需要它

OpenCode Go / Zen 要求每个推理请求携带 `x-opencode-session`（一条会话一个稳定标识，用于路由
与提示词缓存亲和）。自 2026-09-05 起，缺这个头的请求会被拒绝：

```
400 {"type":"MissingSessionID","message":"... Request is missing x-opencode-session ..."}
```

在 DSH 里遇到下面任一情况，就该装这个插件：

- 走 `opencode-go` / `opencode-go-*` 路由时报 `400 MissingSessionID`；
- 被审查的会话用的是 OpenCode Go 路由时，工具调用报
  `Auto review of tool "..." failed`（审查器调用不带 `sessionId`，pi-ai 自带的 OpenCode 包装
  没有值可写）。

DSH 只会在**带 `sessionId` 的 pi-ai 目录路由请求**上原生发送这个头。自动审查的调用和手写的
路由（`opencode-go-free-none`、`opencode-go-audit-free-none`、自定义 key）都没有它。本插件在
两条路径实际都经过的传输层补上这个缺口。

## 前置条件

| 要求 | 值 |
|---|---|
| DSH | `>= 0.2.1-rc.2`（由 `dsh.engines.dsh` 声明） |
| Node.js | `>= 22.19.0` |
| 路由 | 已配置一条 OpenCode Go provider 路由（`opencode-go` 或 `opencode-go-*`），带自己的 `apiKeyEnv` / `baseURL` |
| 主机 | 请求目标是 `opencode.ai`（含子域） |

## 安装

### 方式 A — DSH Web 界面（推荐）

1. 打开 DSH → 左侧 **插件** → **添加插件**
2. 输入包名：

   ```
   dsh-opencode-go-x-session
   ```

3. 安装后**完全重启 DSH**。bundle 层是在启动时组合的，不重启插件不会加载。

### 方式 B — 命令行

```sh
dsh plugin --profile desktop add dsh-opencode-go-x-session
```

如果你启动的不是 `desktop` profile，把 `desktop` 换成你的 profile 名。装完**完全重启 DSH**。

### 方式 C — 从本仓库安装（开发）

```sh
git clone https://github.com/pengpenglele/dsh-opencode-go-x-session-code.git
```

把 clone 下来的目录作为 bundle 安装（Web：插件 → 安装 bundle；agent 工具：`install_bundle`，
target 为该目录绝对路径），或者按本地 link 安装：

```sh
dsh plugin --profile desktop add link:/absolute/path/to/dsh-opencode-go-x-session-code
```

按 `link:` 安装时，插件依赖从本目录真实路径解析，所以要先在该目录执行
`pnpm install --ignore-workspace`（需要 `@deepseek-ai/schemastery`）。

三种方式都会由 bundle patch 向 profile 插入一行 Host 插件 `opencode-session-header`，对该
profile 下所有会话生效。

## 使用

### 装完即用，无需配置

安装并重启后，`opencode-go` 及所有 `opencode-go-*` 路由发往 `opencode.ai` 的请求会自动带上
这个头。头的值是 DSH 会话 id：同一会话跨轮次稳定，并发会话之间互不相同。

自动审查的审查请求跑在被审查 Agent 的驱动链内，插件通过 `ctx.agents.currentInitiator()`
拿到该会话的 id，所以审查请求也能保持自己的缓存亲和，而不是退化成共享的固定值。

### 设置项

设置 → 插件 → **OpenCode Session Header**。所有字段均可选，且都是实时的（`volatile()`）：
保存后下一次请求就生效，无需重启。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 立即移除 fetch 补丁，所有请求原样放行 |
| `providers` | `['opencode-go*']` | 需要补头的 provider 路由；条目可写精确 id，也可用尾部 `*` 前缀匹配。默认覆盖目录路由 `opencode-go` 与所有 `opencode-go-*` 变体；空数组 = 不生效 |
| `hosts` | `['opencode.ai']` | 主机白名单（各条目含其子域）；空数组 = 不检查主机（路由指向代理端点时用） |
| `fallbackSessionId` | `dsh-auto-review` | 请求、外层作用域、发起会话都拿不到会话 id 时使用的稳定兜底 id |
| `debug` | `false` | 通过 Host logger 记录每次注入 |

### 自定义路由与代理端点

- 新增 `opencode-go-xxx` 路由会被默认通配自动覆盖，不用改配置。
- 裸 `opencode`（非 Go）路由**不在**默认范围内；需要的话把 `opencode` 加进 `providers`。
- 如果 OpenCode 端点走代理、域名不同：把该域名加到 `hosts`，或把 `hosts` 设为 `[]` 关闭主机
  检查。provider 列表仍然限制注入范围。

### 确认是否生效

1. DSH 启动日志出现：

   ```
   opencode-session-header: active (providers opencode-go*, hosts opencode.ai)
   ```

2. 打开 `debug`，在 OpenCode Go 路由上发一条消息，每次注入都会记录：

   ```
   [opencode-session-header] x-opencode-session: <session-id> -> <url>
   ```

3. 原来的症状消失：不再有 `400 MissingSessionID`；自动审查工具调用不再报
   `Auto review of tool "..." failed`。

## 关闭 / 卸载

- **设置页开关**：把 `enabled` 设为 `false`，fetch 补丁被移除，请求原样放行，无需重启。
- **插件行开关**：在插件管理器里禁用 `opencode-session-header` 行，整个插件卸载并恢复原始
  `fetch`。
- **profile patch**：在 profile 补丁层给 `- id: opencode-session-header` 加
  `disabled: true`。
- **卸载**：在插件管理器里移除，或执行：

  ```sh
  dsh plugin --profile desktop remove dsh-opencode-go-x-session
  ```

  然后重启 DSH。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 仍然 `400 MissingSessionID` | 路由没命中：把确切的 route id（或匹配的 `something*` 模式）加进 `providers` |
| 自定义端点仍然 400 | 主机没命中：把真实域名加进 `hosts`，或设 `hosts: []` |
| 设置页看不到插件 | 插件没加载：重启 DSH 并检查启动日志里有没有那行 `active` |
| 插件加载被拒 | DSH 低于 `0.2.1-rc.2`，升级 DSH |
| 已启用但始终没注入 | 有别的插件在本插件之后再包 `globalThis.fetch`、绕过了链路；或者路由里写死了静态 `x-opencode-session` 头（已有头优先，请删掉静态头） |
| 自动审查仍失败 | reviewer 用的是会话当前模型：确认该路由在 `providers` 内，且插件处于启用状态 |

## 工作原理

1. 监听官方支持的 `llm/stream` 瀑布。请求的 provider 命中 `providers` 时，按以下顺序确定会话
   id：请求自身的 `sessionId`；外层模型调用作用域（嵌套调用）；通过
   `ctx.agents.currentInitiator()` 取发起 Agent 的会话 id（自动审查正是靠这一步拿到被审查
   会话）；最后用配置的 `fallbackSessionId`。下游 chunk 流的每次拉取都放进携带该 id 的
   `AsyncLocalStorage` 作用域。
2. 包装 `globalThis.fetch`（`openai` SDK 的默认传输）。只在上述作用域生效、URL 主机命中
   `hosts`、且请求尚无该头时加头；其余请求原参数放行。包装器按引用计数共享，HMR 重载与并发
   激活不会重复包装，最后一个激活卸载时恢复原始 `fetch`。

插件不改任何模型可见内容：不增提示词、不写会话事件、不改对话记录。

## 说明与限制

- 依赖 `openai` SDK 每次请求解析 `globalThis.fetch`（当前安装版本每次模型调用都会新建
  client）。若未来版本在导入时固定传输实例，头就不会被补上，症状与修复前相同。
- 模型发现（`llm.discoverModels`）是模型调用之外的普通 fetch，不在本插件作用范围。
- 路由自身的凭据（`apiKeyEnv`）与 `baseURL` 仍由路由配置负责；本插件只补头。
- 完全拿不到会话上下文的调用会共用 `fallbackSessionId`：能正常发出去，但这些调用共享一个
  亲和 id，而不是各自一条会话。

## 开发

```sh
npm test    # 22 条无需 Host 的测试，针对 mock 的 fetch
```

测试覆盖：默认 `opencode-go*` 通配注入、自动审查形态（无 `sessionId`，经 initiator 解析）、
稳定兜底 id、已有头不覆盖、其他 provider（含裸 `opencode`）、其他主机、并发会话隔离、实时
开关、卸载后恢复 `fetch`。

## 许可证

MIT
