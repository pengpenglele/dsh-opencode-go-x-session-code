# @local/dsh-opencode-session-header

Host-only DeepSeek Harness bundle that adds OpenCode Go's required
`x-opencode-session` request header to the model requests of the configured
OpenCode provider routes, and nowhere else.

## Why

OpenCode Go / Zen requires `x-opencode-session`: a stable identifier for one
conversation, used for routing and prompt-cache affinity. Since 2026-09-05 the
gateway rejects inference requests without it:

```
400 {"type":"MissingSessionID","message":"... Request is missing x-opencode-session ..."}
```

Inside DSH two request shapes reach OpenCode without the header:

1. **Auto-review (and other hand-built calls).** pi-ai's catalog provider
   `opencode-go` adds the header from `GenerateOptions.sessionId`, and
   `dsh-llm-pi-ai` forwards that field — so ordinary main-model requests are
   fine. The auto-review reviewer calls `ctx.llm.stream()` with **no**
   `sessionId`, so the catalog provider has nothing to write and the review
   fails closed (`Auto review of tool "..." failed`).
2. **Hand-declared OpenCode routes.** A provider key pi-ai's installed catalog
   does not ship, or one that spells out `api`/`baseURL` (such as
   `opencode-go-free-none` / `opencode-go-audit-free-none`), is built by
   `dsh-llm-pi-ai` itself over the plain protocol implementation. That path
   never applies pi-ai's OpenCode session-header wrapper, so even ordinary
   main-model requests lack the header.

`llm-pi-ai` has no per-request header hook: its per-route `headers` field is a
static `Record<string, string>` from config, and the adapter rebuilds pi-ai's
header object on every call. This plugin bridges the gap at the transport both
paths actually use, scoped to the configured routes and hosts.

It changes no model-visible content: no prompt text, no session event, no
transcript entry.

## How it works

1. It listens on the supported `llm/stream` waterfall. When the request's
   provider is one of the configured routes, it resolves the conversation id in
   this order: the request's own `sessionId`; the enclosing model-call scope
   (nested calls); the initiator Agent's session through
   `ctx.agents.currentInitiator()` — this is what gives an auto-review request,
   which runs inside the reviewed Agent's driver chain, the conversation id it
   is reviewing; finally the configured stable `fallbackSessionId`. The
   downstream chunk stream is wrapped so every pull runs inside an
   `AsyncLocalStorage` scope carrying that id.
2. It wraps `globalThis.fetch` (the `openai` SDK's default transport, resolved
   per request when `options.fetch` is not set). Inside a captured scope the
   wrapper adds the header when it is absent and the URL host is allowlisted;
   every other request gets the original arguments untouched, and the wrapper is
   removed when the plugin unloads or is switched off.

The value is the Harness session id (`GenerateOptions.sessionId`), so it is
stable across the turns of one session and distinct between concurrent
sessions. Requests for any other provider never enter the scope, so built-in
routes and every other model configuration behave exactly as before.

## Config

All fields are optional; every field is `volatile()`, so this table is also the
plugin's settings page.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch (the unified plugin switch); `false` removes the fetch patch immediately and leaves every request untouched |
| `providers` | `['opencode-go*']` | Provider routes that receive the header; an entry may be a trailing-`*` prefix pattern. The default pattern covers the `opencode-go` catalog route and every `opencode-go-*` variant, so a new variant needs no config change; an empty list disables injection |
| `hosts` | `['opencode.ai']` | Host allowlist, each entry also covering its subdomains; an empty list removes the host check (for a proxy endpoint) |
| `fallbackSessionId` | `dsh-auto-review` | Stable id used only when no request, scope, or initiator session id is available |
| `debug` | `false` | Log each injection through the Host logger |

Edit them in the plugin's settings page (Settings → Plugins), or override the
inserted row in the profile's `cordis.patch.yml`:

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

## Install

```sh
git clone https://github.com/pengpenglele/dsh-opencode-go-x-session-code.git
```

Install the directory as a bundle through the Harness plugin manager (Web:
Plugins → Install bundle; tool: `install_bundle` with this directory's absolute
path as the target). The bundle patch inserts one Host row,
`opencode-session-header`; the change applies to every session in the profile.

The package directory needs its own `node_modules` for the `schemastery`
dependency (`pnpm install --ignore-workspace` in this directory) because a
`link:` installation resolves the plugin's dependencies from its real path.

## Turning it off (three equivalent ways)

- **Settings switch** — set `enabled: false` on the plugin's settings page; the
  fetch patch is removed at the next settings commit and every request passes
  through untouched. No restart.
- **Plugin row** — disable the `opencode-session-header` row in the Plugin
  Manager; the whole fiber unloads and the original `fetch` is restored.
- **Profile patch** — add `- id: opencode-session-header` with
  `disabled: true` under your patch layer.

## Verify

- Plugin inventory shows **OpenCode Session Header / OpenCode 会话头注入** with
  this icon and the description above (en/zh).
- The plugin settings page shows the five fields above with their defaults.
- `npm test` (plain Node, no Host) asserts against a mocked `fetch`:
  injection for the default `opencode-go*` pattern (the catalog route and every
  declared variant) with the request's own session id; the
  auto-review shape (no `sessionId`) resolving through `currentInitiator`; the
  stable fallback when no context exists; existing headers, other providers
  (including the sibling `opencode` route), other hosts, and the disabled
  switch all passing through untouched; concurrent session isolation; live
  switching; fetch restoration on dispose.
- In the Host, activate the row and confirm the log line
  `opencode-session-header: active (providers ..., hosts ...)`; with
  `debug: true` each injected request logs
  `[opencode-session-header] x-opencode-session: <id> -> <url>`. A live
  provider round-trip cannot be proven from inside the plugin's own tests.

## Notes and limits

- The wrapper is installed process-wide but inert outside a captured stream
  scope; it is reference-counted so HMR reloads and concurrent activations share
  one patch, and it is removed when the last activation unloads.
- It relies on the `openai` SDK defaulting to `globalThis.fetch` per request,
  which the installed SDK does. If a future SDK pins a transport instance at
  import time, the header would not be added and the route would fail as before.
- Model discovery (`llm.discoverModels`) is a plain fetch outside a model call
  and is left untouched.
- The routes still need their own credential (`apiKeyEnv`) and `baseURL`; this
  plugin only adds the header.
