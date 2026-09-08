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
export const PLUGIN_VERSION = '1.1.1'

// DSH 插件加载契约：必须导出小写 name / inject（loader 读取 entry.options.name）
// 仅声明必需服务，缺失的会被置 null（collectProviders 已做容错）
export const name = PLUGIN_ID
export const inject = ['webServer', 'credentials']

// 向后兼容旧测试引用
export const NAME = PLUGIN_ID
export const INJECT = inject
const ROUTE_BASE = '/' + PLUGIN_ID
export const ONE_API_QUOTA_PER_USD = 500_000
export const BALANCE_TTL_MS = 60_000
export const PRICING_TTL_MS = 600_000
export const STATE_KEY = 'dsh-provider-balance.json'
export const DEFAULT_CUSTOM_CURRENCY_RELAY = 'USD'

// DeepSeek 官方内置价格参考（单位换算：one-api quota，$1 = 500000 quota）
// 价格来源：DeepSeek 官方定价页（deepseek-chat: $0.27/M in, $1.10/M out;
// deepseek-reasoner: $0.55/M in, $2.19/M out）。可能过时，可通过 /overrides.json 覆盖。
export const DEEPSEEK_BUILTIN_PRICING = {
  groupRatio: 1,
  currency: 'USD',
  items: [
    { model: 'deepseek-chat',     billing: 'per-token', perCall: 0, inputRatio: 0.135,  completionRatio: 4.0740741, groupRatio: 1 },
    { model: 'deepseek-reasoner', billing: 'per-token', perCall: 0, inputRatio: 0.275,  completionRatio: 3.9818182, groupRatio: 1 }
  ]
}

/** 用量历史保留天数（超过的日归档 bucket 会被裁剪，防止状态文件膨胀） */
export const HISTORY_RETENTION_DAYS = 30

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
  // 首次运行时 $DSH_HOME 目录可能不存在，写入前先确保父目录已创建
  try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch {}
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
const _cache = new Map()
export function cachedAsync(fn, key, ttlMs) {
  const entry = _cache.get(key)
  if (entry && Date.now() - entry.ts < ttlMs) return entry.val
  const p = fn()
    .then(v => {
      if (_cache.get(key)?.val === p) _cache.set(key, { val: v, ts: Date.now() })
      return v
    })
    .catch(e => {
      if (_cache.get(key)?.val === p) _cache.delete(key)
      throw e
    })
  _cache.set(key, { val: p, ts: Date.now() })
  return p
}

export function invalidateCached(prefix) {
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key)
  }
}

// ================================================================
// HTTP 请求（带超时）
// ================================================================
export async function fetchJson(urlStr, opts = {}) {
  const { timeout = 10_000, headers = {}, method = 'GET', retries = 0, retryDelay = 500 } = opts
  let lastError
  // 每次重试使用独立 AbortController，避免超时后复用已中止的信号导致重试必然失败
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const res = await fetch(urlStr, { ...opts, headers, method, signal: ctrl.signal })
      const text = await res.text()
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${urlStr}`), { status: res.status, text })
      try { return JSON.parse(text) } catch { return { _raw: text } }
    } catch (e) {
      lastError = e
      if (i < retries) await new Promise(r => setTimeout(r, retryDelay))
    } finally {
      clearTimeout(timer)
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
  // 支持 overrides 覆盖
  const overrides = pricing.overrides || {}
  const p = overrides[model] || pricing.items?.find(i => i.model === model) || null
  const input = Number(usage?.inputTokens || 0)
  const output = Number(usage?.outputTokens || 0)
  const reasoning = Number(usage?.reasoningTokens || 0)
  const cacheRead = Number(usage?.cacheReadTokens || 0)
  if (p?.billing === 'per-call') {
    const price = (p.perCall || 0) * (p.groupRatio || 1)
    // 单价可能低于 0.005（如 $0.001/次），保留 6 位小数避免抹零
    return { cost: roundMoney(price, 6), currency: 'USD' }
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
  try {
    routeList = typeof ctx.llm?.listProviders === 'function' ? ctx.llm.listProviders() : []
    if (!Array.isArray(routeList)) routeList = []
  } catch {}
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
    const baseURL = (profile?.baseURL || (routeId === 'deepseek' ? deepProps.baseURL : '') || '').replace(/\/$/, '')
    const isOfficial = isDeepSeekOfficial(baseURL) || (routeId === 'deepseek' && !profile)
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
 * @param {object} [providersRef] - 当前 providers 数组（用于价格估算）
 */
export function createUsageTracker(ctx, stateFilePath, onUpdated, providersRef = null) {
  const prev = new Map()  // bucketKey → {provider, model, usage}
  function bucketKey(sid, turn, step) { return `${sid}|${turn}|${step}` }

  function applyDelta(providerId, model, delta, countCall) {
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
      // 裁剪超过保留期的日归档，防止状态文件无限膨胀
      const cutoff = new Date(Date.now() - HISTORY_RETENTION_DAYS * 86400_000).toISOString().slice(0, 10)
      for (const k of Object.keys(bucket)) {
        if (k.endsWith('_done') && k.slice(0, 10) < cutoff) delete bucket[k]
      }
    }
    const totalTokens = (delta.input || 0) + (delta.output || 0) + (delta.cacheRead || 0) + (delta.cacheWrite || 0) + (delta.reasoning || 0)
    if (countCall) bucket.todayCalls += 1
    bucket.todayTokens += totalTokens

    // 估算成本并更新 usage.todayCost 和 books.spent
    let estimatedCost = 0
    try {
      const currentProviders = providersRef || []
      const provider = currentProviders.find(p => p.id === providerId)
      if (provider?.pricing) {
        // delta 字段与 estimateCostFromUsage 的 TokenUsage schema 对齐
        const { cost } = estimateCostFromUsage(provider.pricing, {
          inputTokens: delta.input,
          outputTokens: delta.output,
          cacheReadTokens: delta.cacheRead,
          cacheWriteTokens: delta.cacheWrite,
          reasoningTokens: delta.reasoning
        }, model, 'session/event')
        if (cost != null && cost > 0) {
          estimatedCost = cost
          // 保留 6 位小数，避免 per-call 微额计价被 roundMoney(2) 抹零
          bucket.todayCost = roundMoney(bucket.todayCost + cost, 6)
          const customCurrency = state.custom[providerId]?.currency
          const booksCurrency = state.books[providerId]?.currency || customCurrency || 'USD'
          // 内置/中转定价均为 USD；跨币种缺少汇率时不修改自定义余额账本。
          if (booksCurrency === 'USD') {
            if (!state.books[providerId]) {
              state.books[providerId] = { spent: 0, currency: 'USD', updatedAt: nowIso() }
            }
            state.books[providerId].spent = roundMoney((state.books[providerId].spent || 0) + cost, 6)
            state.books[providerId].updatedAt = nowIso()
          }
        }
      }
    } catch (e) {
      console.error(`[${PLUGIN_ID}] usage cost estimation error:`, e.message)
    }

    if (!bucket.models[model]) bucket.models[model] = { calls: 0, tokens: 0, cost: 0 }
    if (countCall) bucket.models[model].calls += 1
    bucket.models[model].tokens += totalTokens
    bucket.models[model].cost = roundMoney((bucket.models[model].cost || 0) + estimatedCost, 6)
    state.seenProviders = [...new Set([...(state.seenProviders || []), providerId])]
    writeStateSync(stateFilePath, state)
    onUpdated()
  }

  const dispose = ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'assistant/message') return
      const sessionId = session?.id ?? session?.sessionId ?? String(session?.seq ?? 0)
      // 路由信息双通道：request/header 世界用 header.config.provider；DSHA 1.2+
      // 同时可直接从 message.source（AssistantProvenance）读取 provider/model。
      const d = event.data?.header?.config
      const src = event.data?.message?.source
      const provider = d?.provider ?? src?.provider
      const model = d?.model ?? src?.model
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
      if (prev.size > 10_000) prev.delete(prev.keys().next().value)
      applyDelta(provider, model, delta, !prevEntry)
    } catch (e) {
      console.error('[provider-balance] usage tracking error:', e)
    }
  })

  return {
    seen: prev,
    stop: () => {
      if (typeof dispose === 'function') dispose()
      prev.clear()
    }
  }
}

// ================================================================
// 宿主插件：apply
// ================================================================
export function apply(ctx) {
  const stateFilePath = stateFile()
  let providers = []
  let lastSummary = null
  let stopUsageTracker = () => {}
  const disposers = []
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
      const spent = books.currency === custom.currency ? Number(books.spent || 0) : 0
      const rem = roundMoney(Number(custom.balance) - spent, 6)
      return { mode: 'custom', available: true, remaining: rem, total: Number(custom.balance), currency: custom.currency || books.currency, updatedAt: custom.updatedAt, source: 'custom', error: null }
    }
    if (provider.credential !== 'ok') {
      return { mode: 'auto', available: false, error: '未配置 API Key', source: provider.isOfficial ? 'deepseek' : 'relay' }
    }
    const cacheKey = `bal_${provider.id}`
    if (bust) invalidateCached(cacheKey)
    return cachedAsync(async () => {
      const cred = await resolveProviderKey(provider)
      if (!cred?.value) throw Object.assign(new Error('凭据解析失败'), { provider: provider.id })
      // resolveProviderKey 返回 {value, source}，只取 value 组装 Authorization
      if (provider.isOfficial) return fetchDeepSeekBalance(provider.baseURL, cred.value)
      return fetchRelayBalance(provider.baseURL, cred.value)
    }, cacheKey, BALANCE_TTL_MS)
  }

  async function probePricing(provider, bust = false) {
    if (provider.credential !== 'ok') return null
    const cacheKey = `price_${provider.id}`
    if (bust) invalidateCached(cacheKey)
    return cachedAsync(async () => {
      const overrides = ensureStateSync(stateFilePath).overrides || {}
      // DeepSeek 官方：使用内置价格参考表（可被用户 overrides 覆盖）
      let base = null
        if (provider.isOfficial) {
          base = DEEPSEEK_BUILTIN_PRICING
        } else if (provider.baseURL) {
          const cred = await resolveProviderKey(provider)
          try { base = normalizeOneApiPricing(await fetchJson(`${provider.baseURL}/api/pricing`, { timeout: 6000 })) } catch {}
          if (!base) {
            try { base = normalizeOneApiPricing(await fetchJson(`${provider.baseURL}/api/pricing`, { headers: { Authorization: `Bearer ${cred?.value ?? ''}` }, timeout: 6000 })) } catch {}
          }
          if (!base) return null
        }
      // 将用户 overrides（按模型名索引）合入 pricing，estimateCostFromUsage 优先取 overrides
      const provOverrides = overrides[provider.id] || {}
      return base ? { ...base, overrides: provOverrides } : null
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
      p.pricing = price
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
    stopUsageTracker = createUsageTracker(ctx, stateFilePath, () => { lastSummary = null }, providers)
    lastSummary = await buildSummary()
    console.log(`[${PLUGIN_ID}] ready — providers=${providers.length}`)
  }
  init().catch(e => console.error('[provider-balance] init failed:', e))

  // 路由注册（注册失败由下方 try/catch 兜底，这里保留统一入口便于后续加观测）
  function registerRoute(kind, route, handler) {
    const disposer = ctx.webServer.register({ kind, path: route, handler })
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
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
      if (provider) {
        invalidateCached(`bal_${provider}`)
        invalidateCached(`price_${provider}`)
      } else {
        invalidateCached('bal_')
        invalidateCached('price_')
      }
      lastSummary = await buildSummary()
      for (const cb of subscribers) { try { cb(lastSummary) } catch {} }
      await sendJson(res, lastSummary)
    } catch (e) {
      console.error(`[${PLUGIN_ID}] refresh failed:`, e.message)
      await sendJson(res, { ok: false, error: e.message })
    }
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
        const balanceNum = Number(balance)
        if (!Number.isFinite(balanceNum) || balanceNum < 0) throw new Error('balance 必须是非负数字')
        const cur = String(currency || '').toUpperCase() || (state.books[provider]?.currency || DEFAULT_CUSTOM_CURRENCY_RELAY)
        const previous = state.custom[provider]
        state.custom[provider] = { balance: balanceNum, currency: cur, updatedAt: nowIso() }
        if (resetBooks || !previous || state.books[provider]?.currency !== cur) {
          state.books[provider] = { spent: 0, currency: cur, updatedAt: nowIso() }
        }
        writeStateSync(stateFilePath, state)
        lastSummary = null
        await sendJson(res, { ok: true, updated: provider })
      } catch (e) {
        console.error(`[${PLUGIN_ID}] custom balance update failed:`, e.message)
        await sendJson(res, { ok: false, error: e.message })
      }
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
        // overrides 变更后旧 pricing 缓存仍然有效 10 分钟，主动失效让修改立即生效
        invalidateCached('price_')
        lastSummary = null
        await sendJson(res, { ok: true })
      } catch (e) { await sendJson(res, { ok: false, error: e.message }) }
    } else { await sendJson(res, { ok: false, error: 'method not allowed' }, 405) }
  }

  // ============================================================
  // HTTP 路由（数据驱动注册表）
  // ============================================================
  const routeTable = [
    { kind: 'exact', path: `${ROUTE_BASE}/summary.json`,  fn: handleSummary },
    { kind: 'exact', path: `${ROUTE_BASE}/refresh.json`,  fn: handleRefresh },
    { kind: 'exact', path: `${ROUTE_BASE}/custom.json`,   fn: handleCustom },
    { kind: 'exact', path: `${ROUTE_BASE}/usage.json`,    fn: handleUsage },
    { kind: 'exact', path: `${ROUTE_BASE}/overrides.json`,fn: handleOverrides },
    { kind: 'exact', path: `${ROUTE_BASE}/health.json`,   fn: (req, res) => sendJson(res, { ok: true, plugin: PLUGIN_ID, version: PLUGIN_VERSION, providers: providers.length }) },
    { kind: 'exact', path: `${ROUTE_BASE}/panel.js`,      fn: (req, res) => sendText(res, panelJsContent, panelJsContent ? 200 : 404, 'application/javascript; charset=utf-8') },
    { kind: 'exact', path: `${ROUTE_BASE}/panel.css`,     fn: (req, res) => sendText(res, panelCssContent, panelCssContent ? 200 : 404, 'text/css; charset=utf-8') },
  ]

  for (const { kind, path, fn } of routeTable) {
    try {
      registerRoute(kind, path, fn)
    } catch (e) {
      // duplicate route 等异常不应阻断 DSH web ui 启动
      console.error(`[${PLUGIN_ID}] route register failed (${path}):`, e.message)
    }
  }

  // 注入 panel.js + panel.css 到 index.html
  try {
    const tapDisposer = ctx.webServer.tapIndex((html) => {
      if (!html || html.indexOf(ROUTE_BASE) !== -1) return html
      const css = `<link rel="stylesheet" href="${ROUTE_BASE}/panel.css">`
      const js = `<script type="module" src="${ROUTE_BASE}/panel.js"></script>`
      return (html || '').replace('</head>', `${css}\n${js}\n</head>`)
    })
    if (typeof tapDisposer === 'function') disposers.push(tapDisposer)
  } catch (e) {
    console.error(`[${PLUGIN_ID}] tapIndex failed:`, e.message)
  }

  // HMR/重载时清理路由和注入，避免重复注册导致 web ui 无法启动
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const d of disposers) {
        try { d() } catch {}
      }
      stopUsageTracker()
    })
  }

  // 暴露内部接口（供测试、其他插件）
  return {
    getSummary: () => lastSummary,
    refreshAll: () => buildSummary(true),
    subscribeSummary: (cb) => { subscribers.add(cb); return () => subscribers.delete(cb) }
  }
}
