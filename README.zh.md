# dsh-opencode-go-x-session（OpenCode 会话头注入）

Host-only 的 DeepSeek Harness 插件：为配置的 OpenCode provider 路由上的模型请求补上
OpenCode Go 必需的 `x-opencode-session` 头，其他路由、其他主机、其他 provider 一概不碰。

## 为什么需要

OpenCode Go / Zen 要求每个推理请求携带 `x-opencode-session`（一条会话一个稳定标识，
用于路由与提示词缓存亲和）。自 2026-09-05 起，缺这个头的请求会被拒绝：

```
400 {"type":"MissingSessionID","message":"... Request is missing x-opencode-session ..."}
```

在 DSH 里，有两类请求到达 OpenCode 时没有这个头：

1. **自动审查（auto-review）及其他手写调用。** pi-ai 的目录 provider `opencode-go` 会从
   `GenerateOptions.sessionId` 生成该头，`dsh-llm-pi-ai` 也会转发该字段，所以普通主模型
   请求没问题。但自动审查的审查器调用 `ctx.llm.stream()` 时**不传** `sessionId`，目录
   provider 没有值可写，于是审查请求 400、自动审查失败（`Auto review of tool "..." failed`）。
2. **手写的 OpenCode 路由。** pi-ai 目录里没有的 provider key，或者写死 `api`/`baseURL`
   的路由（例如 `opencode-go-free-none` / `opencode-go-audit-free-none`），由
   `dsh-llm-pi-ai` 自己基于裸协议实现构建，不会套用 pi-ai 的 OpenCode 会话头包装，因此
   连普通主模型请求也缺头。

`llm-pi-ai` 没有按请求改头的入口：provider 的 `headers` 字段是配置里的静态字符串表，
且适配器每次请求都会重建 pi-ai 的头对象。本插件在两条路径实际都经过的传输层补上这个头，
并把作用范围限制在配置的路由与主机内。

插件不改任何模型可见内容：不增提示词、不写会话事件、不改对话记录。

## 工作原理

1. 监听官方支持的 `llm/stream` 瀑布。请求的 provider 命中 `providers` 时，按以下顺序确定
   会话 id：请求自身的 `sessionId`；外层模型调用作用域（嵌套调用）；通过
   `ctx.agents.currentInitiator()` 取发起 Agent 的会话 id —— 自动审查的请求跑在被审查
   Agent 的驱动链内，正是靠这一步拿到被审查会话的 id；最后才用配置的稳定
   `fallbackSessionId`。随后把下游 chunk 流的每次拉取都放进携带该 id 的
   `AsyncLocalStorage` 作用域。
2. 包装 `globalThis.fetch`（`openai` SDK 在未传 `options.fetch` 时按请求解析的默认传输）。
   只有当上面那种作用域生效、且 URL 主机命中 `hosts`、且请求尚无该头时才加头；其余请求
   原参数放行。插件卸载或开关关闭时恢复原始 `fetch`。

头里的值是 Harness 会话 id（`GenerateOptions.sessionId`）：同一会话跨轮次稳定、并发
会话之间互不相同。其他 provider 的请求根本不进入作用域，因此内置路由和所有其他模型配置
行为完全不变。

## 配置项

全部可选；每个字段都是 `volatile()`，这张表同时就是插件设置页。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关（统一插件开关）；`false` 立即移除 fetch 补丁，所有请求原样放行 |
| `providers` | `['opencode-go*']` | 需要补头的 provider 路由；条目支持尾部 `*` 前缀匹配。默认一条 `opencode-go*`，覆盖目录路由 `opencode-go` 与所有 `opencode-go-*` 变体（新增变体无需改配置）；空数组 = 不生效 |
| `hosts` | `['opencode.ai']` | 主机白名单（各条目含其子域）；空数组 = 不检查主机（路由指向代理端点时用） |
| `fallbackSessionId` | `dsh-auto-review` | 请求、作用域、发起会话都拿不到会话 id 时使用的稳定兜底 id |
| `debug` | `false` | 通过 Host logger 记录每次注入 |

可以在插件设置页（设置 → 插件）里改，也可以覆盖 profile `cordis.patch.yml` 中插入的行：

```yaml
- id: opencode-session-header
  config:
    enabled: true
    providers:
      - 'opencode-go*'
    hosts:
      - opencode.ai
    fallbackSessionId: dsh-auto-review
    debug: false
```

## 安装

从 npm 安装（推荐）：

```sh
dsh plugin --profile desktop add dsh-opencode-go-x-session
```

或从本仓库安装：先 clone，再用 Harness 插件管理器安装本目录（Web：插件 → 安装 bundle；
工具：`install_bundle`，target 为本目录绝对路径）。

```sh
git clone https://github.com/pengpenglele/dsh-opencode-go-x-session-code.git
```

两种方式都会由 bundle patch 插入一行 Host 插件 `opencode-session-header`，对 profile
下所有会话生效。

按 `link:` / 本地目录安装时，插件依赖从本目录真实路径解析；先在本目录执行
`pnpm install --ignore-workspace` 安装 `schemastery` 依赖。

## 关闭插件（三种等价方式）

- **设置页开关**：把 `enabled` 设为 `false`，下一次设置提交即移除 fetch 补丁，所有请求
  原样放行，无需重启。
- **插件行开关**：在插件管理器里禁用 `opencode-session-header` 行，整个插件卸载并恢复
  原始 `fetch`。
- **profile patch**：在补丁层给 `- id: opencode-session-header` 加 `disabled: true`。

## 验证

- 插件清单显示 **OpenCode Session Header / OpenCode 会话头注入** 及本图标与描述（en/zh）。
- 插件设置页显示上表五个字段及默认值。
- `npm test`（纯 Node，不需要 Host）用 mock 的 `fetch` 断言：默认 `opencode-go*` 覆盖
  目录路由与所有 `opencode-go-*` 变体（各按请求自身会话 id 注入）；自动审查形态（无
  `sessionId`）经 `currentInitiator` 取到会话 id；无上下文时用稳定兜底 id；已有头、
  其他 provider（含同前缀以外的 `opencode`）、其他主机、关闭开关时全部原样放行；并发
  会话隔离；实时开关；卸载后恢复 `fetch`。
- Host 内启用后确认日志
  `opencode-session-header: active (providers ..., hosts ...)`；`debug: true` 时每次注入
  记录 `[opencode-session-header] x-opencode-session: <id> -> <url>`。插件自身测试无法
  证明真实 provider 往返。

## 说明与限制

- 包装器安装在进程级，但在作用域外完全惰性；按引用计数共享一份补丁，HMR 重载与并发激活
  不会重复包装，最后一个激活卸载时恢复原始 `fetch`。
- 依赖 `openai` SDK 每次请求解析 `globalThis.fetch`（当前安装版本如此）。若未来 SDK 在
  导入时固定传输实例，头就不会被补上，症状与修复前相同。
- 模型发现（`llm.discoverModels`）是模型调用之外的普通 fetch，不在本插件作用范围。
- 路由自身的凭据（`apiKeyEnv`）与 `baseURL` 仍由路由配置负责；本插件只补头。
