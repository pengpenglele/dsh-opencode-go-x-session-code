/**
 * Host-free tests for the OpenCode session-header plugin.
 *
 * They mount the real `apply()` on a minimal Cordis-like context with a fake
 * `globalThis.fetch`, then drive the exact shapes a model request and an
 * auto-review request take: the `llm/stream` waterfall, the `AsyncLocalStorage`
 * scope it leaves around each stream pull, and the fetch wrapper.
 *
 * Run with `npm test` (or `node --test test/`).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, apply, matchesHost, matchesProvider, resolveConfig } from '../index.js'

const HEADER = 'x-opencode-session'
const CATALOG = 'opencode-go'
const DECLARED = 'opencode-go-audit-free-none'
const OTHER = 'deepseek-chat'
const ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions'
const FOREIGN_ENDPOINT = 'https://gateway.example/v1/chat/completions'

/**
 * Minimal Cordis-like context: event listeners, effects, service lookup, and a
 * capturing logger. No real Host is needed.
 * @param config - the row config handed to `apply`.
 * @param options - `services` for `ctx.get` and `terminal` for the waterfall tail.
 * @returns the mounted plugin plus its runner, switch, and disposer.
 */
function setup(config, options = {}) {
  const listeners = new Map()
  const disposers = []
  const logs = { info: [], debug: [], warn: [] }
  const ctx = {
    logger: {
      info: (message) => logs.info.push(message),
      debug: (message) => logs.debug.push(message),
      warn: (message) => logs.warn.push(message),
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      const dispose = () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
      disposers.push(dispose)
      return dispose
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    get(key) {
      return options.services?.[key]
    },
  }
  apply(ctx, config)
  return {
    logs,
    /** Run one `llm/stream` dispatch through every registered listener. */
    run(streamOptions) {
      const list = listeners.get('llm/stream') ?? []
      const terminal = options.terminal
      const call = (index) =>
        index >= list.length ? terminal(streamOptions) : list[index](streamOptions, () => call(index + 1))
      return call(0)
    },
    /** Dispatch a volatile settings commit, as the Loader does. */
    volatile() {
      for (const listener of listeners.get('loader/volatile-update') ?? []) listener([])
    },
    dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {}
      }
    },
  }
}

/**
 * Replace `globalThis.fetch` with a recorder before the plugin installs its
 * wrapper, so the wrapper wraps this fake.
 * @returns the recorded calls, the fake transport, and the restore function.
 */
function installFakeFetch() {
  const original = globalThis.fetch
  const calls = []
  const fakeFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    calls.push({ url, headers })
    return new Response('{}', { status: 200 })
  }
  globalThis.fetch = fakeFetch
  return {
    calls,
    fakeFetch,
    restore() {
      globalThis.fetch = original
    },
  }
}

/**
 * A waterfall tail that performs exactly one fetch and yields one chunk.
 * @param headers - extra request headers for that fetch.
 * @param url - request URL; defaults to the OpenCode endpoint.
 * @returns an async generator handed to `llm/stream`.
 */
function fetchTerminal(headers = {}, url = ENDPOINT) {
  return (async function* terminalStream() {
    await globalThis.fetch(url, { method: 'POST', headers: new Headers(headers), body: '{}' })
    yield { type: 'text-delta', text: 'ok' }
  })()
}

/**
 * @param iterable - an async iterable.
 * @returns every yielded value.
 */
async function collect(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

/**
 * Run one scenario with the fake transport and a mounted plugin.
 * @param options - config, services, and an optional terminal factory.
 * @param fn - receives the plugin handle and the fake transport record.
 */
async function withHarness(options, fn) {
  const fake = installFakeFetch()
  const plugin = setup(options.config ?? {}, {
    services: options.services,
    terminal: options.terminal ?? (() => fetchTerminal(options.terminalHeaders, options.endpoint)),
  })
  try {
    await fn(plugin, fake)
  } finally {
    plugin.dispose()
    fake.restore()
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('the Config schema is the plugin switch and carries the defaults', () => {
  const defaults = resolveConfig(Config({}))
  assert.equal(defaults.enabled, true)
  assert.deepEqual(defaults.providers, ['opencode-go*'])
  assert.deepEqual(defaults.hosts, ['opencode.ai'])
  assert.equal(defaults.fallbackSessionId, 'dsh-auto-review')
  assert.equal(defaults.debug, false)
  assert.equal(resolveConfig(Config({ enabled: false })).enabled, false)
})

test('resolveConfig reads plain values and volatile references', () => {
  const plain = resolveConfig({ enabled: false, providers: ['x'], hosts: ['.Opencode.AI'], fallbackSessionId: '  ' })
  assert.equal(plain.enabled, false)
  assert.deepEqual(plain.providers, ['x'])
  assert.deepEqual(plain.hosts, ['opencode.ai'])
  assert.equal(plain.fallbackSessionId, 'dsh-auto-review')
  const volatile = resolveConfig({
    enabled: { get: () => true },
    providers: { get: () => ['opencode-go*'] },
  })
  assert.equal(volatile.enabled, true)
  assert.deepEqual(volatile.providers, ['opencode-go*'])
})

test('provider patterns: exact ids and trailing-* prefixes', () => {
  const patterns = [CATALOG, 'opencode-go*']
  assert.equal(matchesProvider(CATALOG, patterns), true)
  assert.equal(matchesProvider(DECLARED, patterns), true)
  assert.equal(matchesProvider('opencode-go-free-none', patterns), true)
  assert.equal(matchesProvider(OTHER, patterns), false)
  assert.equal(matchesProvider(undefined, patterns), false)
  assert.equal(matchesProvider(CATALOG, []), false)
  // One default pattern covers the bare catalog route and every variant, while
  // a sibling provider such as `opencode` is not swept in.
  assert.equal(matchesProvider(CATALOG, ['opencode-go*']), true)
  assert.equal(matchesProvider('opencode-go-some-future-route', ['opencode-go*']), true)
  assert.equal(matchesProvider('opencode', ['opencode-go*']), false)
})

test('host allowlist: exact host, subdomains, foreign host, empty list', () => {
  assert.equal(matchesHost(ENDPOINT, ['opencode.ai']), true)
  assert.equal(matchesHost('https://api.opencode.ai/zen/go/v1', ['opencode.ai']), true)
  assert.equal(matchesHost('https://notopencode.ai/zen/go/v1', ['opencode.ai']), false)
  assert.equal(matchesHost(ENDPOINT, []), true)
  assert.equal(matchesHost('not a url', ['opencode.ai']), false)
})

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

test('injects the request session id for the catalog route', async () => {
  await withHarness({}, async (plugin, fake) => {
    assert.deepEqual(await collect(plugin.run({ provider: CATALOG, sessionId: 'session-1' })), [
      { type: 'text-delta', text: 'ok' },
    ])
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].headers.get(HEADER), 'session-1')
  })
})

test('injects the request session id for a hand-declared route', async () => {
  await withHarness({}, async (plugin, fake) => {
    await collect(plugin.run({ provider: DECLARED, sessionId: 'session-free' }))
    assert.equal(fake.calls[0].headers.get(HEADER), 'session-free')
  })
})

test('a wildcard providers entry covers the OpenCode family', async () => {
  await withHarness({ config: { providers: ['opencode-go*'] } }, async (plugin, fake) => {
    await collect(plugin.run({ provider: 'opencode-go-free-none', sessionId: 'session-2' }))
    assert.equal(fake.calls[0].headers.get(HEADER), 'session-2')
  })
})

test('the default mount covers the catalog route and every declared variant', async () => {
  const providers = [CATALOG, 'opencode-go-free-none', DECLARED, 'opencode-go-some-future-route']
  await withHarness({}, async (plugin, fake) => {
    for (const provider of providers) {
      await collect(plugin.run({ provider, sessionId: `session-${provider}` }))
    }
    assert.deepEqual(
      fake.calls.map((call) => call.headers.get(HEADER)),
      providers.map((provider) => `session-${provider}`),
    )
    assert.equal(fake.calls.length, providers.length)
  })
})

test('the default mount leaves a sibling opencode provider untouched', async () => {
  await withHarness({}, async (plugin, fake) => {
    await collect(plugin.run({ provider: 'opencode', sessionId: 'session-plain' }))
    assert.equal(fake.calls[0].headers.get(HEADER), null)
  })
})

test('auto-review (no sessionId) takes the initiator session id', async () => {
  const services = {
    agents: { currentInitiator: () => ({ session: { id: 'initiator-session' } }) },
  }
  await withHarness({ services }, async (plugin, fake) => {
    await collect(plugin.run({ provider: CATALOG }))
    assert.equal(fake.calls[0].headers.get(HEADER), 'initiator-session')
  })
})

test('a call with no session context uses the stable fallback id', async () => {
  await withHarness({}, async (plugin, fake) => {
    await collect(plugin.run({ provider: CATALOG }))
    assert.equal(fake.calls[0].headers.get(HEADER), 'dsh-auto-review')
  })
})

test('does not overwrite a header the route already configured', async () => {
  await withHarness(
    { terminalHeaders: { [HEADER]: 'from-profile-config' } },
    async (plugin, fake) => {
      await collect(plugin.run({ provider: CATALOG, sessionId: 'session-1' }))
      assert.equal(fake.calls[0].headers.get(HEADER), 'from-profile-config')
    },
  )
})

test('a Request object input is rewritten too', async () => {
  await withHarness(
    {
      terminal: () =>
        (async function* requestInput() {
          await globalThis.fetch(new Request(ENDPOINT, { method: 'POST', body: '{}' }))
          yield { type: 'text-delta', text: 'ok' }
        })(),
    },
    async (plugin, fake) => {
      await collect(plugin.run({ provider: CATALOG, sessionId: 'session-request' }))
      assert.equal(fake.calls[0].headers.get(HEADER), 'session-request')
    },
  )
})

test('concurrent sessions keep their own ids', async () => {
  let arrivals = 0
  let releaseGate
  const gate = new Promise((resolve) => {
    releaseGate = resolve
  })
  const arrive = () => {
    arrivals += 1
    if (arrivals === 2) releaseGate()
    return gate
  }
  const taggedTerminal = (streamOptions) =>
    (async function* tagged() {
      await arrive()
      await globalThis.fetch(ENDPOINT, {
        method: 'POST',
        headers: new Headers({ 'x-test-stream': streamOptions.tag }),
        body: '{}',
      })
      yield streamOptions.tag
    })()

  await withHarness({ terminal: taggedTerminal }, async (plugin, fake) => {
    const a = plugin.run({ provider: CATALOG, sessionId: 'session-a', tag: 'a' })
    const b = plugin.run({ provider: CATALOG, sessionId: 'session-b', tag: 'b' })
    const results = await Promise.all([collect(a), collect(b)])
    assert.deepEqual(results.flat().sort(), ['a', 'b'])
    for (const [tag, session] of [
      ['a', 'session-a'],
      ['b', 'session-b'],
    ]) {
      const call = fake.calls.find((entry) => entry.headers.get('x-test-stream') === tag)
      assert.ok(call, `missing request tagged ${tag}`)
      assert.equal(call.headers.get(HEADER), session)
    }
  })
})

// ---------------------------------------------------------------------------
// Scope: what must stay untouched
// ---------------------------------------------------------------------------

test('leaves every other provider untouched', async () => {
  await withHarness({}, async (plugin, fake) => {
    await collect(plugin.run({ provider: OTHER, sessionId: 'session-1' }))
    assert.equal(fake.calls[0].headers.get(HEADER), null)
  })
})

test('leaves a foreign host untouched', async () => {
  await withHarness({ endpoint: FOREIGN_ENDPOINT }, async (plugin, fake) => {
    await collect(plugin.run({ provider: CATALOG, sessionId: 'session-1' }))
    assert.equal(fake.calls[0].headers.get(HEADER), null)
  })
})

test('an empty hosts list removes the host check', async () => {
  await withHarness({ config: { hosts: [] }, endpoint: FOREIGN_ENDPOINT }, async (plugin, fake) => {
    await collect(plugin.run({ provider: CATALOG, sessionId: 'session-1' }))
    assert.equal(fake.calls[0].headers.get(HEADER), 'session-1')
  })
})

test('an empty providers list disables injection', async () => {
  await withHarness({ config: { providers: [] } }, async (plugin, fake) => {
    await collect(plugin.run({ provider: CATALOG, sessionId: 'session-1' }))
    assert.equal(fake.calls[0].headers.get(HEADER), null)
  })
})

// ---------------------------------------------------------------------------
// Switch and lifecycle
// ---------------------------------------------------------------------------

test('enabled: false leaves the transport unpatched', async () => {
  const fake = installFakeFetch()
  try {
    const before = globalThis.fetch
    const plugin = setup({ enabled: false }, { terminal: () => fetchTerminal() })
    try {
      assert.equal(globalThis.fetch, before)
      await collect(plugin.run({ provider: CATALOG, sessionId: 'session-1' }))
      assert.equal(fake.calls[0].headers.get(HEADER), null)
    } finally {
      plugin.dispose()
    }
  } finally {
    fake.restore()
  }
})

test('a live settings write switches injection on and off', async () => {
  const fake = installFakeFetch()
  let enabled = false
  const plugin = setup({ enabled: { get: () => enabled } }, { terminal: () => fetchTerminal() })
  try {
    assert.equal(globalThis.fetch, fake.fakeFetch, 'disabled: no middleware')
    enabled = true
    plugin.volatile()
    assert.notEqual(globalThis.fetch, fake.fakeFetch, 'enabled: middleware installed')
    await collect(plugin.run({ provider: CATALOG, sessionId: 'session-live' }))
    assert.equal(fake.calls.at(-1).headers.get(HEADER), 'session-live')
    enabled = false
    plugin.volatile()
    assert.equal(globalThis.fetch, fake.fakeFetch, 'disabled again: middleware removed')
    await collect(plugin.run({ provider: CATALOG, sessionId: 'session-live' }))
    assert.equal(fake.calls.at(-1).headers.get(HEADER), null)
  } finally {
    plugin.dispose()
    fake.restore()
  }
})

test('debug logs each injection through the Host logger', async () => {
  await withHarness({ config: { debug: true } }, async (plugin, fake) => {
    await collect(plugin.run({ provider: CATALOG, sessionId: 'session-debug' }))
    assert.equal(fake.calls[0].headers.get(HEADER), 'session-debug')
    assert.ok(plugin.logs.debug.some((line) => line.includes('session-debug')), 'expected a debug line')
  })
})

test('disposing the plugin restores the original fetch', async () => {
  const fake = installFakeFetch()
  const plugin = setup({}, { terminal: () => fetchTerminal() })
  try {
    assert.notEqual(globalThis.fetch, fake.fakeFetch)
    plugin.dispose()
    assert.equal(globalThis.fetch, fake.fakeFetch)
  } finally {
    plugin.dispose()
    fake.restore()
  }
})
