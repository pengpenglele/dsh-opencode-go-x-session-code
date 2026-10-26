# dsh-opencode-go-x-session

[![npm version](https://img.shields.io/npm/v/dsh-opencode-go-x-session.svg)](https://www.npmjs.com/package/dsh-opencode-go-x-session)
[![npm downloads](https://img.shields.io/npm/dm/dsh-opencode-go-x-session.svg)](https://www.npmjs.com/package/dsh-opencode-go-x-session)
[![license](https://img.shields.io/npm/l/dsh-opencode-go-x-session.svg)](./LICENSE)

[中文文档](./README.zh.md) · English

A host-only [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds
OpenCode Go's required `x-opencode-session` request header to model requests on
the configured OpenCode provider routes — including the requests the official
auto-review feature builds by hand — and to no other route or host.

## Do you need it?

OpenCode Go / Zen requires every inference request to carry
`x-opencode-session`: a stable identifier per conversation, used for routing and
prompt-cache affinity. Since 2026-09-05 requests without it are rejected:

```
400 {"type":"MissingSessionID","message":"... Request is missing x-opencode-session ..."}
```

Install this plugin if you see either of these inside DSH:

- `400 MissingSessionID` on an `opencode-go` / `opencode-go-*` route, or
- `Auto review of tool "..." failed` when the reviewed session uses an OpenCode Go
  route (the reviewer call carries no `sessionId`, so pi-ai's own OpenCode
  wrapper has nothing to write).

DSH sends the header natively only on pi-ai catalog requests that carry a
`sessionId`. Auto-review calls and hand-declared routes
(`opencode-go-free-none`, `opencode-go-audit-free-none`, custom keys) lack it.
This plugin fills that gap at the transport layer both paths actually use.

## Requirements

| Requirement | Value |
|---|---|
| DSH | `>= 0.2.1-rc.2` (declared as `dsh.engines.dsh`) |
| Node.js | `>= 22.19.0` |
| Route | an OpenCode Go provider route (`opencode-go` or `opencode-go-*`) configured with its own `apiKeyEnv` / `baseURL` |
| Host | requests go to `opencode.ai` (subdomains included) |

## Install

### Option A — DSH Web UI (recommended)

1. Open DSH → **Plugins** (插件) → **Add plugin** (添加插件).
2. Enter the package name:

   ```
   dsh-opencode-go-x-session
   ```

3. Install, then **fully restart DSH**. Bundle layers are composed at startup, so
   the plugin does not load until DSH restarts.

### Option B — CLI

```sh
dsh plugin --profile desktop add dsh-opencode-go-x-session
```

Use your own profile name instead of `desktop` if you boot another one. Then
fully restart DSH.

### Option C — from this repository (development)

```sh
git clone https://github.com/pengpenglele/dsh-opencode-go-x-session-code.git
```

Then install the cloned directory as a bundle (Web: Plugins → Install bundle;
agent tool: `install_bundle` with the directory's absolute path), or install it
as a local link:

```sh
dsh plugin --profile desktop add link:/absolute/path/to/dsh-opencode-go-x-session-code
```

A `link:` installation resolves the plugin's dependencies from its real path, so
run `pnpm install --ignore-workspace` in that directory first (it needs
`@deepseek-ai/schemastery`).

Either way the bundle patch inserts one host row, `opencode-session-header`,
into the profile. It applies to every session in that profile.

## Usage

### It works with no configuration

After installation and a restart, requests on `opencode-go` and every
`opencode-go-*` route to `opencode.ai` receive the header automatically. The
value is the DSH session id, so it is stable across the turns of one conversation
and distinct between concurrent conversations.

For auto-review, the reviewer request runs inside the reviewed agent's driver
chain, so the plugin resolves that conversation's id through
`ctx.agents.currentInitiator()` — the review keeps its prompt-cache affinity
instead of falling back to a shared id.

### Settings

Settings → Plugins → **OpenCode Session Header**. All fields are optional and
every field is live (`volatile()`): a settings save applies to the next request
without a restart.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` removes the fetch patch immediately and every request passes through untouched |
| `providers` | `['opencode-go*']` | Provider routes served by the plugin; entries may be exact ids or trailing-`*` prefix patterns. The default covers the `opencode-go` catalog route and every `opencode-go-*` variant. An empty list disables injection |
| `hosts` | `['opencode.ai']` | Host allowlist; each entry also covers its subdomains. An empty list removes the host check (for a proxy endpoint) |
| `fallbackSessionId` | `dsh-auto-review` | Stable id used only when neither the request, the enclosing scope, nor an initiator session id exists |
| `debug` | `false` | Log every injection through the host logger |

### Custom routes and proxy endpoints

- A new `opencode-go-something` route is covered automatically — no config change.
- The plain `opencode` (non-Go) route is **not** covered by the default pattern;
  add `opencode` to `providers` if you use it.
- If your OpenCode endpoint is a proxy with another hostname, either add that
  hostname to `hosts` or set `hosts` to `[]` to disable the host check. The
  provider list still scopes injection.

### Check that it is working

1. The DSH startup log shows:

   ```
   opencode-session-header: active (providers opencode-go*, hosts opencode.ai)
   ```

2. Turn on `debug` and start a conversation on an OpenCode Go route; every
   injected request logs:

   ```
   [opencode-session-header] x-opencode-session: <session-id> -> <url>
   ```

3. The original symptom disappears: no more `400 MissingSessionID`, and
   auto-review on an OpenCode Go model no longer fails with
   `Auto review of tool "..." failed`.

## Disable / uninstall

- **Settings switch** — set `enabled: false`; the fetch patch is removed and
  requests pass through untouched. No restart.
- **Plugin row** — disable the `opencode-session-header` row in the plugin
  manager; the whole plugin unloads and the original `fetch` is restored.
- **Profile patch** — add `- id: opencode-session-header` with
  `disabled: true` under your profile patch layer.
- **Uninstall** — remove it in the plugin manager, or run:

  ```sh
  dsh plugin --profile desktop remove dsh-opencode-go-x-session
  ```

  Then restart DSH.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Still `400 MissingSessionID` | Route not covered: add the exact route id (or a matching `something*` pattern) to `providers` |
| Still `400` on a custom endpoint | Host not allowlisted: add the real hostname to `hosts`, or set `hosts: []` |
| Settings page missing the plugin | The plugin is not loaded: restart DSH and check the startup log line |
| Plugin refuses to load | DSH is older than `0.2.1-rc.2`; upgrade DSH |
| Header never injected although enabled | Another plugin wraps `globalThis.fetch` after this one and bypasses the chain; or the route already carries a static `x-opencode-session` header (existing headers always win — remove the static one) |
| Auto-review still fails | The reviewer uses the session's model; make sure that route is in `providers`, and that the plugin is enabled |

## How it works

1. It listens on the supported `llm/stream` waterfall. For a request whose
   provider matches `providers`, it resolves the conversation id in this order:
   the request's own `sessionId`; the enclosing model-call scope (nested calls);
   the initiator agent's session through `ctx.agents.currentInitiator()` (this is
   what gives an auto-review request the conversation it is reviewing); finally
   the configured `fallbackSessionId`. The downstream chunk stream is re-emitted
   so every pull runs inside an `AsyncLocalStorage` scope carrying that id.
2. It wraps `globalThis.fetch` (the `openai` SDK's default transport). Inside a
   captured scope it adds the header when it is absent and the URL host is
   allowlisted; every other request keeps the original arguments. The wrapper is
   reference-counted, so HMR reloads and concurrent activations share one patch,
   and it is removed when the last activation unloads.

The plugin changes no model-visible content: no prompt text, no session event,
no transcript entry.

## Notes and limits

- It relies on the `openai` SDK resolving `globalThis.fetch` per request (the
  installed SDK constructs one client per model call). If a future version pins a
  transport instance at import time, the header would not be added and the route
  would fail as before.
- Model discovery (`llm.discoverModels`) is a plain fetch outside a model call
  and is left untouched.
- Routes still need their own credential (`apiKeyEnv`) and `baseURL`; this plugin
  only adds the header.
- Calls with no session context share the stable `fallbackSessionId`. That keeps
  them working, but those calls share one affinity id rather than one per
  conversation.

## Development

```sh
npm test    # 22 host-free tests against a mocked fetch
```

The tests cover injection for the default `opencode-go*` pattern, the
auto-review shape (no `sessionId`, resolved through the initiator), the stable
fallback, existing headers, other providers (including the sibling `opencode`),
other hosts, concurrent session isolation, live switching, and fetch restoration
on dispose.

## License

MIT
