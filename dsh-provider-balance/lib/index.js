// dsh-provider-balance — 供应商余额管家 (宿主侧)
// 功能：发现供应商、自动查询余额、识别按次/按量倍率、本地用量记账、悬浮面板
// 目标 dsh: 0.1.1-rc.2（DSHA 1.1.9.x）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ================================================================
// 常量
// ================================================================
export const PLUGIN_ID = 'dsh-provider-balance'
export const PLUGIN_NAME = '供应商余额管家'
export const PLUGIN_VERSION = '1.0.0'
export const NAME = PLUGIN_ID
export const INJECT = ['webServer', 'credentials', 'settings', 'llm']

const ROUTE_BASE = '/' + PLUGIN_ID
export const ONE_API_QUOTA_PER_USD = 500_000
export const BALANCE_TTL_MS = 60_000
export const PRICING_TTL_MS = 600_000
export const STATE_KEY = 'dsh-provider-balance.json'
export const DEFAULT_CUSTOM_CURRENCY_RELAY = 'USD'

// 解析 lib 目录绝对路径
const _libDir = path.dirname(fileURLToPath(import.meta.url))
const _panelJsPath = path.join(_libDir, 'panel.js')
const _panelCssPath = path.join(_libDir, 'panel.css')

// ================================================================
// 工具函数（导出供 smoke 测试）
// ================================================================

export function nowIso() { return new Date().toISOString() }
export function todayKey() { return new Date().toISOString().slice(0, 10) }
export function roundMoney(v, n = 2) { return Math.round(v * 10 ** n) / 10 ** n }
export function hostFromUrl(urlStr) {
  try { const u = new URL(urlStr); return u.host } catch { return String(urlStr) }
}
export function isDeepSeekOfficial(baseURL) {
  const h = (baseURL || '').toLowerCase()
  return h.includes('api.deepseek.com')
}

/**
 * 从 DeepSeek /user/balance 的 balance_infos 中选取货币。
 * 优先 CNY，其次第一个。
 */
export function pickBalanceInfo(infos) {
  if (!Array.isArray(infos)) return null
  const cny = infos.find(b => (b.currency || '').toUpperCase() === 'CNY')
  return cny || infos[0] || null
}

// ================================================================
// 文件 IO（同步用于高频路径）
// ================================================================
export function stateFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, STATE_KEY)
}

export function writeStateSync(file, obj) {
  try {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
  }
}

export function readStateSync(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

export function ensureStateSync(file) {
  return readStateSync(file) || { version: 1, custom: {}, books: {}, usage: {}, seenProviders: [] }
}

// ================================================================
// 异步缓存（单 key 单 promise，带 TTL；失败自动出队允许重试）
// ================================================================
// 异步缓存（单 key 单 promise，带 TTL；失败自动出队允许重试）
// ================================================================
const _cache = new Map()
export function cachedAsync(fn, key, ttlMs) {
  const entry = _cache.get(key)
  if (entry && Date.now() - entry.ts < ttlMs) return entry.val
  const p = fn()
    .then(v => { _cache.set(key, { val: v, ts: Date.now() }); return v })
    .catch(e => { _cache.delete(key); throw e })
  _cache.set(key, { val: p, ts: Date.now() })
  return p
}

// ================================================================
// HTTP 请求（带超时）
// ================================================================
export async function fetchJson(urlStr, opts = {}) {
  const { timeout = 10_000, headers = {}, method = 'GET', retries = 0, retryDelay = 500 } = opts
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  let lastError
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(urlStr, { ...opts, headers, method, signal: ctrl.signal })
      const text = await res.text()
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${urlStr}`), { status: res.status, text })
      try { return JSON.parse(text) } catch { return { _raw: text } }
    } catch (e) {
      lastError = e
      if (i < retries) await new Promise(r => setTimeout(r, retryDelay))
    }
  }
  throw lastError
}

// ================================================================
// 余额探测
// ================================================================

/**
 * DeepSeek 官方 /user/balance（返回 balance_infos[]）
 */
export async function fetchDeepSeekBalance(baseURL, apiKey) {
  const base = (baseURL || 'https://api.deepseek.com').replace(/\/$/, '')
  const res = await fetchJson(`${base}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  })
  const infos = Array.isArray(res.balance_infos) ? res.balance_infos : []
  const pick = pickBalanceInfo(infos)
  if (!pick) throw Object.assign(new Error('balance_infos 为空'), { infos })
  return {
    total: Number(pick.total_balance ?? 0),
    granted: Number(pick.granted_balance ?? 0),
    toppedUp: Number(pick.topped_up_balance ?? 0),
    currency: (pick.currency || 'CNY').toUpperCase(),
    updatedAt: nowIso()
  }
}

/**
 * one-api / new-api 中转站：硬额度 - 已用 = 余额（单位 USD，total_usage 为美分）
 */
export async function fetchRelayBalance(baseURL, apiKey) {
  const base = (baseURL || '').replace(/\/$/, '')
  if (!base) throw Object.assign(new Error('baseURL 缺失'), { key: 'baseURL' })
  const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  const [sub, usage] = await Promise.all([
    fetchJson(`${base}/v1/dashboard/billing/subscription`, { headers: auth, timeout: 8000 }),
    fetchJson(`${base}/v1/dashboard/billing/usage?start_date=2000-01-01&end_date=2099-01-01`, { headers: auth, timeout: 8000 })
  ])
  const hard = Number(sub?.hard_limit_usd ?? sub?.system_hard_limit_usd ?? 0)
  const used = Number(usage?.total_usage ?? 0)  // 单位：美分
  const remaining = roundMoney(hard - used / 100)
  return { total: roundMoney(hard), used: roundMoney(used / 100), remaining, currency: 'USD', updatedAt: nowIso() }
}

// ================================================================
// 价格倍率探测
// ================================================================

/**
 * 归一化 one-api /api/pricing 响应为内部 schema。
 * 返回 { groupRatio, items: [{model, billing, perCall, inputRatio, completionRatio}], currency }
 */
export function normalizeOneApiPricing(raw) {
  if (!raw) return null
  const d = raw.data ?? raw
  const list = Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : [])
  if (!list.length) return null
  const groupRaw = raw.group_ratio
  const groupRatio = typeof groupRaw === 'number' ? groupRaw : (typeof groupRaw?.default === 'number' ? groupRaw.default : 1)
  const items = list.map(m => {
    const modelName = String(m.model_name ?? m.model ?? m.id ?? '')
    const quotaType = Number(m.quota_type ?? (m.model_price > 0 ? 1 : 0))
    const perCall = Number(m.model_price ?? 0)
    const inputRatio = Number(m.model_ratio ?? 1)
    const completionRatio = Number(m.completion_ratio ?? 1)
    const billing = quotaType === 1 ? 'per-call' : 'per-token'
    return { model: modelName, billing, perCall, inputRatio, completionRatio, groupRatio }
  })
  return { groupRatio, items, currency: 'USD' }
}

/**
 * 按量成本估算（USD）。per-call 单独估算。
 * pricing: normalizeOneApiPricing 的输出；usage: TokenUsage；model: 模型名
 */
export function estimateCostFromUsage(pricing, usage, model, attribution) {
  if (!pricing) return null
  const p = pricing.items?.find(i => i.model === model) || null
  const input = Number(usage?.inputTokens || 0)
  const output = Number(usage?.outputTokens || 0)
  const reasoning = Number(usage?.reasoningTokens || 0)
  const cacheRead = Number(usage?.cacheReadTokens || 0)
  if (p?.billing === 'per-call') {
    const price = (p.perCall || 0) * (p.groupRatio || 1)
    return { cost: roundMoney(price), currency: 'USD' }
  }
  // per-token: 按 one-api 约定 $1 = 500000 quota
  // 缓存 token 保守地按全价计入
  const rate = p ? p.inputRatio * p.groupRatio : 1
  const cr = p ? p.completionRatio : 1
  const cost = roundMoney(((input + cacheRead) * rate + (output + reasoning) * rate * cr) / ONE_API_QUOTA_PER_USD, 6)
  return { cost, currency: 'USD' }
}

// ================================================================
// 供应商发现
// ================================================================

async function resolveApiKey(ctx, envName) {
  if (!envName) return null
  try {
    const r = await ctx.credentials.resolve(envName)
    return r ? { value: r.value, source: r.source } : null
  } catch { return null }
}

export async function collectProviders(ctx) {
  const providers = []
  let routeList = []
  try { routeList = Array.isArray(ctx.llm?.listProviders) ? ctx.llm.listProviders() : [] } catch {}
  const knownIds = new Set(routeList.map(p => p.id))

  let piProps = {}
  let deepProps = { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' }
  try {
    const descs = await ctx.settings.describe()
    for (const d of descs) {
      if (d.ns === 'llm-pi-ai') piProps = d.value ?? {}
      if (d.ns === 'llm-deepseek') deepProps = d.value ?? deepProps
    }
  } catch {}
  const piRoutes = piProps?.providers ?? {}
  const allRouteIds = new Set([...knownIds, ...Object.keys(piRoutes), 'deepseek'])

  for (const routeId of allRouteIds) {
    const routeInfo = routeList.find(p => p.id === routeId)
    const profile = piRoutes[routeId] ?? null
    const baseURL = (profile?.baseURL || deepProps.baseURL || '').replace(/\/$/, '')
    const isOfficial = routeId === 'deepseek' || isDeepSeekOfficial(baseURL)
    const displayName = profile?.displayName || routeInfo?.name || routeId
    const apiKeyEnv = profile?.apiKeyEnv || (isOfficial ? deepProps.apiKeyEnv : undefined)
    const cred = await resolveApiKey(ctx, apiKeyEnv)
    providers.push({
      id: routeId,
      name: displayName,
      host: hostFromUrl(baseURL),
      baseURL,
      isOfficial,
      credential: cred ? 'ok' : (apiKeyEnv ? 'missing' : 'unknown'),
      live: knownIds.has(routeId),
      apiKeyEnv
    })
  }
  return providers
}

// ================================================================
// 用量跟踪器
// ================================================================

/**
 * 创建用量跟踪器：监听 session/event 事件，按 (session, turn, step) 去重，
 * 计算 delta 并累加到 state books.usage[providerId]
 * @param {object} ctx - cordis context
 * @param {string} stateFilePath - 状态文件路径
 * @param {function} onUpdated - 状态变更回调
 */
export function createUsageTracker(ctx, stateFilePath, onUpdated) {
  const prev = new Map()  // bucketKey → {provider, model, usage}
  function bucketKey(sid, turn, step) { return `${sid}|${turn}|${step}` }

  function applyDelta(providerId, model, delta) {
    const tk = todayKey()
    const state = ensureStateSync(stateFilePath)
    if (!state.usage[providerId]) {
      state.usage[providerId] = { todayKey: tk, todayCalls: 0, todayTokens: 0, todayCost: 0, total: {}, models: {} }
    }
    const bucket = state.usage[providerId]
    if (bucket.todayKey !== tk) {
      const histKey = `${bucket.todayKey}_done`
      bucket[histKey] = { calls: bucket.todayCalls, tokens: bucket.todayTokens, cost: bucket.todayCost, models: bucket.models }
      bucket.todayKey = tk
      bucket.todayCalls = 0
      bucket.todayTokens = 0
      bucket.todayCost = 0
      bucket.models = {}
    }
    const totalTokens = (delta.input || 0) + (delta.output || 0) + (delta.cacheRead || 0) + (delta.cacheWrite || 0) + (delta.reasoning || 0)
    bucket.todayCalls += 1
    bucket.todayTokens += totalTokens
    if (!bucket.models[model]) bucket.models[model] = { calls: 0, tokens: 0, cost: 0 }
    bucket.models[model].calls += 1
    bucket.models[model].tokens += totalTokens
    state.seenProviders = [...new Set([...(state.seenProviders || []), providerId])]
    writeStateSync(stateFilePath, state)
    onUpdated()
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'assistant/message') return
      const sessionId = session?.id ?? session?.sessionId ?? String(session?.seq ?? 0)
      const d = event.data?.header?.config
      const provider = d?.provider
      const model = d?.model ?? event.data?.message?.source?.model
      if (!provider || !model) return
      const usage = event.data?.usage
      if (!usage) return
      const turn = event.data?.turn ?? 0
      const step = event.data?.step ?? 0
      const key = bucketKey(sessionId, turn, step)
      const prevEntry = prev.get(key)
      const cur = {
        input: Number(usage.inputTokens || 0),
        output: Number(usage.outputTokens || 0),
        cacheRead: Number(usage.cacheReadTokens || 0),
        cacheWrite: Number(usage.cacheWriteTokens || 0),
        reasoning: Number(usage.reasoningTokens || 0)
      }
      let delta
      if (prevEntry) {
        delta = {
          input: cur.input - (prevEntry.usage?.input || 0),
          output: cur.output - (prevEntry.usage?.output || 0),
          cacheRead: cur.cacheRead - (prevEntry.usage?.cacheRead || 0),
          cacheWrite: cur.cacheWrite - (prevEntry.usage?.cacheWrite || 0),
          reasoning: cur.reasoning - (prevEntry.usage?.reasoning || 0)
        }
      } else {
        delta = cur
      }
      if (Object.values(delta).every(v => v <= 0)) return
      prev.set(key, { provider, model, usage: cur, at: Date.now() })
      applyDelta(provider, model, delta)
    } catch (e) {
      console.error('[provider-balance] usage tracking error:', e)
    }
  })

  return { seen: prev }
}

// ================================================================
// 宿主插件：apply
// ================================================================
export function apply(ctx) {
  const stateFilePath = stateFile()
  let providers = []
  const balanceCache = new Map()
  const pricingCache = new Map()
  let lastSummary = null
  const subscribers = new Set()

  // 读取面板文件（启动时）
  let panelJsContent = ''
  let panelCssContent = ''
  try { panelJsContent = fs.readFileSync(_panelJsPath, 'utf8') } catch {}
  try { panelCssContent = fs.readFileSync(_panelCssPath, 'utf8') } catch {}

  async function resolveProviderKey(provider) {
    return resolveApiKey(ctx, provider.apiKeyEnv)
  }

  async function probeBalance(provider, bust = false) {
    const state = ensureStateSync(stateFilePath)
    const custom = state.custom[provider.id]
    if (custom && custom.balance != null) {
      const books = state.books[provider.id] || { spent: 0, currency: custom.currency || DEFAULT_CUSTOM_CURRENCY_RELAY }
      const rem = roundMoney(Number(custom.balance) - Number(books.spent || 0))
      return { mode: 'custom', available: true, remaining: rem, total: Number(custom.balance), currency: custom.currency || books.currency, updatedAt: custom.updatedAt, source: 'custom', error: null }
    }
    if (provider.credential !== 'ok') {
      return { mode: 'auto', available: false, error: '未配置 API Key', source: provider.isOfficial ? 'deepseek' : 'relay' }
    }
    const cacheKey = `bal_${provider.id}`
    if (bust) balanceCache.delete(cacheKey)
    return cachedAsync(async () => {
      const key = await resolveProviderKey(provider)
      if (!key) throw Object.assign(new Error('凭据解析失败'), { provider: provider.id })
      if (provider.isOfficial) return fetchDeepSeekBalance(provider.baseURL, key)
      return fetchRelayBalance(provider.baseURL, key)
    }, cacheKey, BALANCE_TTL_MS)
  }

  async function probePricing(provider, bust = false) {
    if (provider.isOfficial || provider.credential !== 'ok') return null
    const cacheKey = `price_${provider.id}`
    if (bust) pricingCache.delete(cacheKey)
    return cachedAsync(async () => {
      const key = await resolveProviderKey(provider)
      const base = provider.baseURL
      if (!base) return null
      try { return normalizeOneApiPricing(await fetchJson(`${base}/api/pricing`, { timeout: 6000 })) } catch {}
      try { return normalizeOneApiPricing(await fetchJson(`${base}/api/pricing`, { headers: { Authorization: `Bearer ${key}` }, timeout: 6000 })) } catch {}
      return null
    }, cacheKey, PRICING_TTL_MS)
  }

  async function buildSummary(bustAll = false) {
    const state = ensureStateSync(stateFilePath)
    // 并行探测所有供应商，单家失败降级为 available:false 而不阻塞整体
    const results = await Promise.all(providers.map(async p => {
      const [bal, price] = await Promise.all([
        probeBalance(p, bustAll).catch(e => ({ mode: 'auto', available: false, error: e.message, source: p.isOfficial ? 'deepseek' : 'relay' })),
        probePricing(p, bustAll).catch(() => null)
      ])
      const usage = state.usage[p.id] || { todayKey: '', todayCalls: 0, todayTokens: 0, todayCost: 0, total: {}, models: {} }
      const books = state.books[p.id] || { spent: 0, currency: 'USD', updatedAt: '' }
      return {
        id: p.id, name: p.name, host: p.host, isOfficial: p.isOfficial,
        credential: p.credential, balance: bal, pricing: price, usage, books
      }
    }))
    return { ok: true, now: nowIso(), providers: results }
  }

  async function init() {
    try { providers = await collectProviders(ctx) } catch (e) { console.error('[provider-balance] collectProviders failed:', e) }
    createUsageTracker(ctx, stateFilePath, () => { lastSummary = null })
    lastSummary = await buildSummary()
    console.log(`[${PLUGIN_ID}] ready — providers=${providers.length}`)
  }
  init().catch(e => console.error('[provider-balance] init failed:', e))

  // 路由注册
  function registerRoute(kind, route, handler) {
    ctx.webServer.register({ kind, path: route, handler })
  }

  // 请求体解析工具
  function parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')) }
        catch (e) { reject(new Error('JSON 解析失败: ' + e.message)) }
      })
      req.on('error', reject)
    })
  }

  async function sendJson(res, obj, status = 200) {
    const body = JSON.stringify(obj, null, 2)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
    res.end(body)
  }

  function sendText(res, text, status = 200, mime = 'text/plain; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': mime })
    res.end(text)
  }

  async function handleSummary(req, res) { await sendJson(res, await buildSummary()) }

  async function handleRefresh(req, res) {
    try {
      const body = await parseBody(req)
      const { provider } = body
      if (provider) { balanceCache.delete(`bal_${provider}`); pricingCache.delete(`price_${provider}`) }
      else { balanceCache.clear(); pricingCache.clear() }
      lastSummary = await buildSummary()
      for (const cb of subscribers) { try { cb(lastSummary) } catch {} }
      await sendJson(res, lastSummary)
    } catch (e) { await sendJson(res, { ok: false, error: e.message }) }
  }

  async function handleCustom(req, res) {
    const state = ensureStateSync(stateFilePath)
    if (req.method === 'GET') { await sendJson(res, state.custom || {}) }
    else if (req.method === 'POST') {
      try {
        const body = await parseBody(req)
        const { provider, balance, currency, resetBooks = false } = body
        if (!provider) throw new Error('provider 必填')
        if (balance == null) throw new Error('balance 必填')
        const cur = String(currency || '').toUpperCase() || (state.books[provider]?.currency || DEFAULT_CUSTOM_CURRENCY_RELAY)
        state.custom[provider] = { balance: Number(balance), currency: cur, updatedAt: nowIso() }
        if (resetBooks) state.books[provider] = { spent: 0, currency: cur, updatedAt: nowIso() }
        writeStateSync(stateFilePath, state)
        lastSummary = null
        await sendJson(res, { ok: true, updated: provider })
      } catch (e) { await sendJson(res, { ok: false, error: e.message }) }
    } else { await sendJson(res, { ok: false, error: 'method not allowed' }, 405) }
  }

  async function handleUsage(req, res) {
    const state = ensureStateSync(stateFilePath)
    await sendJson(res, state.usage || {})
  }

  async function handleOverrides(req, res) {
    const state = ensureStateSync(stateFilePath)
    if (req.method === 'GET') { await sendJson(res, state.overrides || {}) }
    else if (req.method === 'POST') {
      try {
        const body = await parseBody(req)
        const overrides = body
        if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) throw new Error('overrides 应为对象')
        state.overrides = overrides
        writeStateSync(stateFilePath, state)
        lastSummary = null
        await sendJson(res, { ok: true })
      } catch (e) { await sendJson(res, { ok: false, error: e.message }) }
    } else { await sendJson(res, { ok: false, error: 'method not allowed' }, 405) }
  }

  // ============================================================
  // HTTP 路由（数据驱动注册表）
  // ============================================================
  const routeTable = [
    { kind: 'prefix', path: `${ROUTE_BASE}/summary.json`,  fn: (req, res) => sendJson(res, buildSummary()) },
    { kind: 'prefix', path: `${ROUTE_BASE}/refresh.json`,  fn: handleRefresh },
    { kind: 'prefix', path: `${ROUTE_BASE}/custom.json`,   fn: handleCustom },
    { kind: 'prefix', path: `${ROUTE_BASE}/usage.json`,    fn: (req, res) => { const s = ensureStateSync(stateFilePath); sendJson(res, s.usage || {}) } },
    { kind: 'prefix', path: `${ROUTE_BASE}/overrides.json`,fn: handleOverrides },
    { kind: 'prefix', path: `${ROUTE_BASE}/health.json`,   fn: (req, res) => sendJson(res, { ok: true, plugin: PLUGIN_ID, version: PLUGIN_VERSION, providers: providers.length }) },
    { kind: 'prefix', path: `${ROUTE_BASE}/panel.js`,      fn: (req, res) => sendText(res, panelJsContent, panelJsContent ? 200 : 404) },
    { kind: 'prefix', path: `${ROUTE_BASE}/panel.css`,     fn: (req, res) => sendText(res, panelCssContent, panelCssContent ? 200 : 404) },
  ]

  for (const { kind, path, fn } of routeTable) {
    ctx.webServer.register({ kind, path, handler: fn })
  }

  // 注入 panel.js + panel.css 到 index.html
  ctx.webServer.tapIndex(async (html) => {
    const css = `<link rel="stylesheet" href="${ROUTE_BASE}/panel.css">`
    const js = `<script type="module" src="${ROUTE_BASE}/panel.js"></script>`
    return (html || '').replace('</head>', `${css}\n${js}\n</head>`)
  })

  // 暴露内部接口（供测试、其他插件）
  return {
    getSummary: () => lastSummary,
    refreshAll: () => buildSummary(true),
    subscribeSummary: (cb) => { subscribers.add(cb); return () => subscribers.delete(cb) }
  }
}
