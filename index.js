/**
 * dsh-opencode-go-x-session — Host-only Harness plugin.
 *
 * OpenCode Go / Zen requires the `x-opencode-session` request header: a stable
 * identifier for one conversation, used for routing and prompt-cache affinity.
 * Since 2026-09-05 the gateway answers inference requests that lack it with
 * `400 {"type":"MissingSessionID"}`.
 *
 * Inside DSH two request shapes reach OpenCode without the header:
 *
 * 1. **Auto-review / other hand-built calls.** pi-ai's catalog provider
 *    (`opencode-go`) adds the header from `GenerateOptions.sessionId`, and
 *    `dsh-llm-pi-ai` forwards that field. The auto-review reviewer calls
 *    `ctx.llm.stream()` with no `sessionId`, so the header is missing and the
 *    review fails closed (`Auto review of tool "..." failed`).
 * 2. **Hand-declared OpenCode routes.** A route such as
 *    `opencode-go-audit-free-none` — a provider key pi-ai's installed catalog
 *    does not ship, or one that spells out `api`/`baseURL` — is built by
 *    `dsh-llm-pi-ai` itself over the plain protocol implementation, which never
 *    applies pi-ai's OpenCode session-header wrapper. Even its ordinary
 *    main-model requests lack the header.
 *
 * This plugin adds that missing header, and only for the provider routes named
 * in its config and the request hosts named in its config. It does not touch
 * pi-ai, the adapter configuration, any other provider's requests, or any
 * model-visible content (no prompt text, no session event).
 *
 * How it works, through the weakest extension points that suffice:
 *
 * 1. The supported `llm/stream` waterfall captures the conversation id of a
 *    request whose provider is configured. Resolution order: the request's own
 *    `sessionId`; the enclosing scope (nested model calls); the initiator
 *    Agent's session through `ctx.agents.currentInitiator()` — this is what
 *    gives an auto-review call, which runs inside the reviewed Agent's driver
 *    chain, its conversation's id; finally the configured stable fallback.
 *    The downstream chunk stream is wrapped so every pull runs inside an
 *    `AsyncLocalStorage` scope carrying that id.
 * 2. One transparent `globalThis.fetch` wrapper (the openai SDK's default
 *    transport, resolved per request when `options.fetch` is not set) adds the
 *    header while such a scope is active. Outside a scope, on another host, or
 *    when the header is already present, the request is forwarded unchanged.
 *    The wrapper is reference-counted, so HMR reloads and concurrent
 *    activations share exactly one patch and the original transport returns
 *    once the last activation unloads.
 *
 * Config fields (all optional, `enabled` is the live switch):
 *   enabled           boolean   master switch (default true)
 *   providers         string[]  provider routes to serve; entries may be exact
 *                               ids or trailing-`*` prefix patterns
 *                               (default: opencode-go*, the catalog route plus
 *                               every opencode-go-* variant)
 *   hosts             string[]  host allowlist, each also covering subdomains
 *                               (default: opencode.ai); empty = no host check
 *   fallbackSessionId string    stable id for calls that carry no session
 *                               anywhere (default: dsh-auto-review)
 *   debug             boolean   log every injection (default: false)
 *
 * @module dsh-opencode-go-x-session
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name used by Loader diagnostics. */
export const name = 'opencode-session-header'

/** The `llm` service must exist before the `llm/stream` waterfall can fire. */
export const inject = ['llm']

/** The request header OpenCode Go requires. */
export const SESSION_HEADER = 'x-opencode-session'

/** Global key so a reloaded module generation reuses one fetch patch and one scope store. */
const SHARED_STATE = Symbol.for('dsh.opencode-session-header.state')

/**
 * Provider routes that speak the OpenCode protocol and therefore need the
 * header. One trailing-`*` prefix pattern covers the catalog route and every
 * hand-declared variant, so a new `opencode-go-*` route is served without
 * touching this plugin. The dash before `*` is deliberately absent: the plain
 * catalog route is `opencode-go`, which `opencode-go-*` would not match.
 */
export const DEFAULT_PROVIDERS = Object.freeze(['opencode-go*'])

/** Hosts that may receive the header. An empty list means "no host check". */
export const DEFAULT_HOSTS = Object.freeze(['opencode.ai'])

/** Stable id for calls whose conversation cannot be identified. */
export const DEFAULT_FALLBACK_SESSION_ID = 'dsh-auto-review'

/**
 * Plugin config. Every field is `volatile()`: the Host serves exactly these as
 * this plugin's settings page (the unified plugin switch is `enabled`) and
 * commits a settings write into the running activation without a remount.
 */
export const Config = z.object({
  /** Master switch: false removes the fetch patch and stops all injection. */
  enabled: z.boolean().default(true).volatile(),
  /**
   * Provider routes eligible for the header. An entry is an exact route id, or
   * a trailing-`*` pattern (`"opencode-go*"`) matching a route-id prefix. The
   * default is one pattern — `opencode-go*` — so the catalog route and every
   * hand-declared `opencode-go-*` variant are covered without a list to keep.
   */
  providers: z.array(z.string()).default([...DEFAULT_PROVIDERS]).volatile(),
  /**
   * Host allowlist (host itself or any subdomain). Defaults to `opencode.ai`;
   * an empty array removes the check, for routes pointed at a proxy endpoint.
   */
  hosts: z.array(z.string()).default([...DEFAULT_HOSTS]).volatile(),
  /** Session id used only when neither the request nor a context carries one. */
  fallbackSessionId: z.string().default(DEFAULT_FALLBACK_SESSION_ID).volatile(),
  /** Log every injected request URL and session id (diagnostics). */
  debug: z.boolean().default(false).volatile(),
})

/** Schema defaults for a bare mount (profile patch or test context). */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  providers: [...DEFAULT_PROVIDERS],
  hosts: [...DEFAULT_HOSTS],
  fallbackSessionId: DEFAULT_FALLBACK_SESSION_ID,
  debug: false,
})

/**
 * Read one activation field. The Loader hands volatile fields over as
 * references, so a read goes through `get()`; a plain value (profile patch,
 * test context) passes through, and an absent field falls back to its default.
 * @param field - the config field as the Host handed it over.
 * @param fallback - the schema default.
 * @returns the effective value.
 */
function readField(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined ? fallback : value
  }
  return field
}

/**
 * Normalize a configured string list. A non-array (or absent) value falls back
 * to the default; an explicitly empty array is kept, because it means
 * "nothing"/"no host check" and must not silently restore a default.
 * @param value - raw config value.
 * @param fallback - schema default list.
 * @returns a clean string list.
 */
function readStringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Resolve the effective settings of this activation. Called at every use site,
 * so a settings write or a profile-patch edit applies to the next request.
 * @param config - the config the Host passed to the activation.
 * @returns every field resolved against the schema defaults.
 */
export function resolveConfig(config) {
  return {
    enabled: readField(config?.enabled, DEFAULT_CONFIG.enabled) !== false,
    providers: readStringList(readField(config?.providers, DEFAULT_CONFIG.providers), DEFAULT_PROVIDERS),
    hosts: readStringList(readField(config?.hosts, DEFAULT_CONFIG.hosts), DEFAULT_HOSTS).map((host) =>
      host.toLowerCase().replace(/^\*?\./, ''),
    ),
    fallbackSessionId: (() => {
      const value = readField(config?.fallbackSessionId, DEFAULT_CONFIG.fallbackSessionId)
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : DEFAULT_FALLBACK_SESSION_ID
    })(),
    debug: readField(config?.debug, DEFAULT_CONFIG.debug) === true,
  }
}

/**
 * Whether one provider route is covered by the configured patterns.
 * @param provider - the route the request selects.
 * @param patterns - exact route ids and/or trailing-`*` prefix patterns.
 * @returns true when the route is covered.
 */
export function matchesProvider(provider, patterns) {
  if (typeof provider !== 'string' || provider.length === 0) return false
  return patterns.some(
    (pattern) => pattern === provider || (pattern.endsWith('*') && provider.startsWith(pattern.slice(0, -1))),
  )
}

/**
 * Whether one request URL's host is on the allowlist. An empty list allows
 * every host, because the provider match already scopes the injection.
 * @param url - the request URL.
 * @param hosts - lowercased host names; each also covers its subdomains.
 * @returns true when the URL may receive the header.
 */
export function matchesHost(url, hosts) {
  if (hosts.length === 0) return true
  let hostname
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
}

/**
 * The process-wide transport state shared by every plugin generation.
 * @returns the shared state, creating it on first use.
 */
function sharedState() {
  const holder = globalThis
  if (holder[SHARED_STATE] === undefined) {
    holder[SHARED_STATE] = {
      /** Scope of the model request the current async chain belongs to. */
      storage: new AsyncLocalStorage(),
      /** Live activations that installed the middleware. */
      refs: 0,
      original: undefined,
      patched: undefined,
    }
  }
  return holder[SHARED_STATE]
}

// ---------------------------------------------------------------------------
// Session-id resolution
// ---------------------------------------------------------------------------

/**
 * Read the session id of the Agent whose driver chain is running this call.
 * Auto-review is exactly such a call: it is built inside the reviewed Agent's
 * tool execution and carries no `sessionId` of its own.
 * @param ctx - the plugin context.
 * @returns the initiator session id, or `undefined` when none is available.
 */
function initiatorSessionId(ctx) {
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents === undefined || agents === null) return undefined
    const initiator = typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined
    const id = initiator?.session?.id
    if (typeof id === 'string' && id.length > 0) return id
    const headerId = initiator?.session?.header?.id
    return typeof headerId === 'string' && headerId.length > 0 ? headerId : undefined
  } catch {
    // No agents service, a disposed service, or no initiator boundary.
    return undefined
  }
}

/**
 * Pick the stable per-conversation id for one model call.
 * @param ctx - the plugin context (initiator fallback).
 * @param options - resolved plugin settings.
 * @param request - the `llm/stream` request options.
 * @param inherited - the enclosing scope, when one model call nests inside another.
 * @returns the id to send, or `undefined` to leave the call untouched.
 */
function resolveSessionId(ctx, options, request, inherited) {
  const direct = request?.sessionId
  if (direct !== undefined && direct !== null) {
    const text = String(direct)
    if (text.length > 0) return text
  }
  if (inherited !== undefined && typeof inherited.sessionId === 'string' && inherited.sessionId.length > 0) {
    return inherited.sessionId
  }
  return initiatorSessionId(ctx) ?? options.fallbackSessionId
}

// ---------------------------------------------------------------------------
// Stream wrapping
// ---------------------------------------------------------------------------

/**
 * Re-enter the captured scope for every pull of the downstream chunk stream, so
 * the fetch calls that produce those chunks see the session id. The inner
 * iterator is created inside the scope as well, which covers transports that
 * start their request at iteration time.
 * @param produced - whatever the next waterfall listener returned.
 * @param store - the scope value for this call.
 * @param storage - the shared AsyncLocalStorage.
 * @returns an iterable that behaves like `produced`.
 */
function wrapIterable(produced, store, storage) {
  if (produced === null || produced === undefined) return produced
  if (typeof produced[Symbol.asyncIterator] !== 'function') return produced
  const iterator = produced[Symbol.asyncIterator]()
  const bind = (method) => {
    const fn = iterator[method]
    return typeof fn === 'function' ? (...args) => storage.run(store, () => fn.apply(iterator, args)) : undefined
  }
  const wrapped = {
    [Symbol.asyncIterator]() {
      return this
    },
    next: bind('next'),
  }
  const returnMethod = bind('return')
  if (returnMethod !== undefined) wrapped.return = returnMethod
  const throwMethod = bind('throw')
  if (throwMethod !== undefined) wrapped.throw = throwMethod
  return wrapped
}

// ---------------------------------------------------------------------------
// Fetch interception
// ---------------------------------------------------------------------------

/** Extract the target URL of a `fetch` call without consuming the input. */
export function requestUrl(input) {
  if (typeof input === 'string') return input
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  return undefined
}

/**
 * Build the fetch call that carries the session header, or `undefined` when the
 * request must be forwarded unchanged.
 * @param input - fetch's first argument (URL string, URL, or Request).
 * @param init - fetch's second argument.
 * @param store - the active scope.
 * @returns the arguments to pass to the real fetch, or undefined to forward.
 */
export function addSessionHeader(input, init, store) {
  const url = requestUrl(input)
  if (url === undefined || !matchesHost(url, store.hosts)) return undefined
  const isRequest = typeof Request !== 'undefined' && input instanceof Request
  // Reproduce fetch's own precedence: init.headers replaces a Request's headers
  // entirely; without init.headers the Request's headers are the base.
  const headers =
    init?.headers !== undefined
      ? new Headers(init.headers)
      : new Headers(isRequest ? input.headers : undefined)
  if (headers.has(store.headerName)) return undefined
  headers.set(store.headerName, store.sessionId)
  if (isRequest) return [new Request(input, { ...(init ?? {}), headers })]
  return [input, { ...(init ?? {}), headers }]
}

/**
 * Install the transparent fetch wrapper once and count live owners.
 * @param state - the shared state.
 * @returns the release function for this owner.
 */
function acquireFetchPatch(state) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('dsh-opencode-go-x-session: globalThis.fetch is unavailable')
  }
  if (state.refs === 0) {
    state.original = globalThis.fetch
    state.patched = createPatchedFetch(state.original, state.storage)
    globalThis.fetch = state.patched
  }
  state.refs += 1
  let released = false
  return () => {
    if (released) return
    released = true
    state.refs -= 1
    if (state.refs > 0) return
    state.refs = 0
    if (globalThis.fetch === state.patched) globalThis.fetch = state.original
    state.patched = undefined
    state.original = undefined
  }
}

/**
 * Build the fetch wrapper. It only changes a request while a scope created by
 * this plugin is active, so every other caller sees the original transport.
 * @param originalFetch - the transport captured at install time.
 * @param storage - the shared AsyncLocalStorage.
 * @returns the wrapper.
 */
function createPatchedFetch(originalFetch, storage) {
  return function fetchWithOpenCodeSessionHeader(input, init) {
    let store
    try {
      store = storage.getStore()
    } catch {
      store = undefined
    }
    if (store === undefined || store === null) return Reflect.apply(originalFetch, this, [input, init])
    let rewritten
    try {
      rewritten = addSessionHeader(input, init, store)
    } catch {
      // Header bookkeeping must never break a model call.
      return Reflect.apply(originalFetch, this, [input, init])
    }
    if (rewritten === undefined) return Reflect.apply(originalFetch, this, [input, init])
    store.log?.(`${store.headerName}: ${store.sessionId} -> ${String(requestUrl(input) ?? '?')}`)
    return Reflect.apply(originalFetch, this, rewritten)
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Mount the plugin: keep one fetch patch in step with the effective config and
 * scope every covered model call.
 * @param ctx - the plugin context (carries `llm`).
 * @param config - the row config, with volatile fields as references.
 */
export function apply(ctx, config) {
  const state = sharedState()
  const settings = () => resolveConfig(config)
  let release

  /** Install the fetch patch while enabled, remove it while disabled. */
  const sync = () => {
    const current = settings()
    if (current.enabled && release === undefined) {
      release = acquireFetchPatch(state)
      ctx.logger?.info?.(
        `opencode-session-header: active (providers ${current.providers.join(', ')}, hosts ${current.hosts.join(', ') || '*'})`,
      )
    } else if (!current.enabled && release !== undefined) {
      release()
      release = undefined
      ctx.logger?.info?.('opencode-session-header: disabled by config; requests pass through')
    }
  }

  ctx.effect(() => {
    sync()
    return () => {
      release?.()
      release = undefined
    }
  }, 'opencode-session-header: fetch transport')

  // Volatile settings writes commit in place; re-evaluate the switch.
  ctx.on('loader/volatile-update', () => sync())

  ctx.on('llm/stream', (request, next) => {
    if (request === null || typeof request !== 'object') return next()
    const current = settings()
    if (!current.enabled) return next()
    if (!matchesProvider(request.provider, current.providers)) return next()
    let inherited
    try {
      inherited = state.storage.getStore()
    } catch {
      inherited = undefined
    }
    const sessionId = resolveSessionId(ctx, current, request, inherited)
    if (sessionId === undefined) return next()
    const store = {
      sessionId,
      headerName: SESSION_HEADER,
      hosts: current.hosts,
      provider: request.provider,
      log: current.debug ? (message) => ctx.logger?.debug?.('[opencode-session-header] ' + message) : undefined,
    }
    const produced = state.storage.run(store, () => next())
    return wrapIterable(produced, store, state.storage)
  })
}
