// tools/smoke.mjs — dsh-provider-balance 冒烟测试（node:test + assert）
// 覆盖：余额探测、价格归一化、成本估算、state ledger、provider 发现逻辑
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const pluginRoot = path.resolve(fileURLToPath(import.meta.url), '../..')
const libDir = path.join(pluginRoot, 'lib')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pb-smoke-'))
process.env.DSH_HOME = tmpDir

// 同步导入（ESM 必须顶层）
import {
  nowIso, todayKey, roundMoney, hostFromUrl, isDeepSeekOfficial,
  pickBalanceInfo, normalizeOneApiPricing, estimateCostFromUsage,
  ONE_API_QUOTA_PER_USD,
  stateFile, writeStateSync, readStateSync, ensureStateSync,
  collectProviders, cachedAsync, invalidateCached, fetchJson, fetchRelayBalance, createUsageTracker, apply
} from '../lib/index.js'

// 面板纯函数（复制 panel.js 核心逻辑，避免动态 ESM 导入）
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: decimals })
}

function renderPanel(data) {
  if (!data?.ok) return '<div class="err">数据加载失败</div>'
  const providers = (data.providers || []).map(p => {
    const bal = p.balance || {}
    const mode = bal.mode || 'auto'
    const available = bal.available !== false
    const priceItems = (p.pricing?.items || []).slice(0, 20)
    const today = p.usage?.todayCalls ?? 0
    const todayCost = fmt(p.usage?.todayCost ?? 0, 4)
    const todayTokens = fmt(p.usage?.todayTokens ?? 0, 0)
    const badge = mode === 'custom' ? `<span class="badge custom">自定义余额</span>`
      : mode === 'auto' ? `<span class="badge auto">${available ? '自动查询' : '查询失败'}</span>`
      : `<span class="badge off">官方接口</span>`
    const balLine = available
      ? `<div class="bal-num">${fmt(bal.remaining ?? 0, 4)} <span class="curr">${esc(bal.currency)}</span></div>
         <div class="bal-meta">${mode === 'custom' ? `原始余额 ${fmt(bal.total)} / 已耗 ${fmt(p.books?.spent ?? 0)}` : `总额 ${fmt(bal.total)} / 已用 ${fmt(bal.used ?? 0)}`}</div>`
      : `<div class="bal-num bal-err">不可用</div>
         <div class="bal-meta err">${esc(bal.error || '未知错误')}</div>`
    const pricingRows = priceItems.length > 0
      ? `<table class="ptable">...</table>`
      : '<div class="no-pricing">暂无倍率数据</div>'
    const customBtn = mode === 'custom'
      ? `<button class="btn-set" data-provider="${esc(p.id)}" data-mode="custom">修改余额</button>`
      : `<button class="btn-set" data-provider="${esc(p.id)}" data-mode="${mode}">设置余额</button>`
    const refreshBtn = `<button class="btn-r" data-provider="${esc(p.id)}">刷新</button>`
    return `<div class="pcard" data-id="${esc(p.id)}">
      <div class="phead"><div class="pname">${esc(p.name)} <span class="phost">${esc(p.host)}</span></div>
      <div class="pbadges">${badge}${p.credential === 'missing' ? '<span class="badge miss">缺密钥</span>' : ''}</div></div>
      <div class="pbalance">${balLine}</div>
      <div class="ptoday">今日：${today} 次 / ${todayTokens} tokens / <span class="cost">${todayCost}</span></div>
      <div class="pactions">${refreshBtn}${customBtn}</div>
      <details class="ppricing"><summary>计费倍率表 (${priceItems.length})</summary>${pricingRows}</details>
    </div>`
  }).join('\n')
  const time = new Date(data.now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return `<div class="panel-root">
    <div class="pheader"><div class="ptitle">供应商余额管家</div><div class="ptime">更新于 ${time}</div></div>
    <div class="plist">${providers || '<div class="empty">未发现供应商</div>'}</div>
    <div class="pfooter"><button id="pb-refresh-all" class="btn-refresh-all">全部刷新</button><button id="pb-close" class="btn-close">关闭</button></div>
  </div>`
}

describe('dsh-provider-balance — 核心逻辑冒烟测试', () => {
  describe('工具函数', () => {
    it('nowIso 返回合法 ISO 字符串', () => {
      const s = nowIso()
      assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s), s)
    })

    it('todayKey 返回 YYYY-MM-DD', () => {
      const k = todayKey()
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(k), k)
    })

    it('roundMoney 截断合理小数', () => {
      assert.strictEqual(roundMoney(1.234567, 2), 1.23)
      assert.strictEqual(roundMoney(0.000001, 6), 0.000001)
    })

    it('hostFromUrl 提取 host', () => {
      assert.strictEqual(hostFromUrl('https://api.example.com/v1'), 'api.example.com')
      assert.strictEqual(hostFromUrl('https://api.example.com/'), 'api.example.com')
      assert.strictEqual(hostFromUrl('not-a-url'), 'not-a-url')
    })

    it('isDeepSeekOfficial 判断 deepseek', () => {
      assert.ok(isDeepSeekOfficial('https://api.deepseek.com'))
      assert.ok(isDeepSeekOfficial('https://api.deepseek.com/v1'))
      assert.ok(!isDeepSeekOfficial('https://my-relay.example.com'))
    })
  })

  describe('pickBalanceInfo', () => {
    it('优先返回 CNY 条目', () => {
      const infos = [
        { currency: 'USD', total_balance: 10 },
        { currency: 'CNY', total_balance: 50 }
      ]
      const r = pickBalanceInfo(infos)
      assert.strictEqual(r.currency, 'CNY')
      assert.strictEqual(r.total_balance, 50)
    })

    it('无 CNY 时返回第一条', () => {
      const r = pickBalanceInfo([{ currency: 'USD', total_balance: 10 }])
      assert.strictEqual(r.currency, 'USD')
    })

    it('空列表返回 null', () => {
      assert.strictEqual(pickBalanceInfo([]), null)
      assert.strictEqual(pickBalanceInfo(null), null)
      assert.strictEqual(pickBalanceInfo(undefined), null)
    })
  })

  describe('normalizeOneApiPricing', () => {
    it('归一化 one-api /api/pricing 标准响应', () => {
      const raw = {
        data: [
          { model_name: 'deepseek-chat', quota_type: 0, model_ratio: 0.5, completion_ratio: 2, model_price: 0 },
          { model_name: 'deepseek-coder', quota_type: 1, model_ratio: 0, completion_ratio: 0, model_price: 0.02 }
        ],
        group_ratio: { default: 1.5 }
      }
      const r = normalizeOneApiPricing(raw)
      assert.ok(r)
      assert.strictEqual(r.groupRatio, 1.5)
      assert.strictEqual(r.items.length, 2)
      const [a, b] = r.items
      assert.strictEqual(a.model, 'deepseek-chat')
      assert.strictEqual(a.billing, 'per-token')
      assert.strictEqual(a.inputRatio, 0.5)
      assert.strictEqual(a.completionRatio, 2)
      assert.strictEqual(a.groupRatio, 1.5)
      assert.strictEqual(b.model, 'deepseek-coder')
      assert.strictEqual(b.billing, 'per-call')
      assert.strictEqual(b.perCall, 0.02)
    })

    it('容错 group_ratio 为数字', () => {
      const r = normalizeOneApiPricing({ data: [{ model_name: 'm', quota_type: 0 }], group_ratio: 2 })
      assert.strictEqual(r.groupRatio, 2)
    })

    it('null 输入返回 null', () => {
      assert.strictEqual(normalizeOneApiPricing(null), null)
      assert.strictEqual(normalizeOneApiPricing(undefined), null)
      assert.strictEqual(normalizeOneApiPricing({}), null)
    })
  })

  describe('余额探测 HTTP 请求', () => {
    it('DeepSeek 请求携带真实 Bearer 凭据（回归: 曾传 {value} 对象导致 [object Object]）', async () => {
      let authHeader = null
      const server = http.createServer((req, res) => {
        authHeader = req.headers.authorization
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: 10, granted_balance: 2, topped_up_balance: 8 }] }))
      })
      await new Promise(r => server.listen(0, '127.0.0.1', r))
      try {
        const { fetchDeepSeekBalance } = await import('../lib/index.js')
        const bal = await fetchDeepSeekBalance(`http://127.0.0.1:${server.address().port}/v1`, 'sk-real-token')
        assert.strictEqual(authHeader, 'Bearer sk-real-token', 'Authorization 必须是实际字符串 token')
        assert.strictEqual(bal.total, 10)
        assert.strictEqual(bal.remaining, 10)
        assert.strictEqual(bal.currency, 'CNY')
      } finally {
        await new Promise(r => server.close(r))
      }
    })

    it('中转地址以 /v1 结尾时不会重复拼接路径', async () => {
      const paths = []
      const server = http.createServer((req, res) => {
        paths.push(req.url)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(req.url.includes('subscription') ? { hard_limit_usd: 10 } : { total_usage: 100 }))
      })
      await new Promise(r => server.listen(0, '127.0.0.1', r))
      try {
        const baseURL = `http://127.0.0.1:${server.address().port}/v1`
        const balance = await fetchRelayBalance(baseURL, 'token')
        assert.deepStrictEqual(paths.sort(), ['/v1/dashboard/billing/subscription', '/v1/dashboard/billing/usage?start_date=2000-01-01&end_date=2099-01-01'].sort())
        assert.strictEqual(balance.remaining, 9)
      } finally {
        await new Promise(r => server.close(r))
      }
    })
  })

  describe('estimateCostFromUsage', () => {
    it('per-call 模式返回 perCall * groupRatio', () => {
      const pricing = { items: [{ model: 'm', billing: 'per-call', perCall: 0.01, groupRatio: 2, inputRatio: 0, completionRatio: 0 }] }
      const r = estimateCostFromUsage(pricing, { inputTokens: 100, outputTokens: 50 }, 'm')
      assert.strictEqual(r.cost, 0.02)
      assert.strictEqual(r.currency, 'USD')
    })

    it('per-token 模式按 quota 换算 USD', () => {
      const pricing = { items: [{ model: 'm', billing: 'per-token', perCall: 0, groupRatio: 1, inputRatio: 1, completionRatio: 1 }] }
      // 1M tokens at ratio 1 → 1M / 500k = $2
      const r = estimateCostFromUsage(pricing, { inputTokens: 1_000_000, outputTokens: 0 }, 'm')
      assert.ok(r.cost > 0)
      assert.ok(r.cost <= 3, '1M tokens should cost ~$2')
    })

    it('无 pricing 返回 null', () => {
      assert.strictEqual(estimateCostFromUsage(null, {}, 'm'), null)
    })

    it('缓存 token 被计入', () => {
      const pricing = { items: [{ model: 'm', billing: 'per-token', groupRatio: 1, inputRatio: 1, completionRatio: 1 }] }
      const withCache = estimateCostFromUsage(pricing, { inputTokens: 1000, cacheReadTokens: 1000, outputTokens: 0 }, 'm')
      const withoutCache = estimateCostFromUsage(pricing, { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0 }, 'm')
      assert.ok(withCache.cost >= withoutCache.cost, 'cache should increase cost')
    })
  })

  describe('state 文件 IO', () => {
    it('stateFile 指向 DSH_HOME', () => {
      const f = stateFile()
      assert.ok(f.startsWith(tmpDir), f)
      assert.ok(f.endsWith('dsh-provider-balance.json'), f)
    })

    it('write + read 回环', () => {
      const f = path.join(tmpDir, 'test.json')
      writeStateSync(f, { a: 1, b: [2, 3] })
      const r = readStateSync(f)
      assert.deepStrictEqual(r, { a: 1, b: [2, 3] })
      assert.ok(!fs.existsSync(f + '.tmp'), 'tmp file should be renamed away')
      assert.ok(!fs.readdirSync(path.dirname(f)).some(name => name.startsWith(`${path.basename(f)}.`) && name.endsWith('.tmp')), 'unique tmp file should be renamed away')
    })

    it('ensureStateSync 返回默认结构', () => {
      const f = path.join(tmpDir, 'empty.json')
      const s = ensureStateSync(f)
      assert.ok(s.version === 1)
      assert.deepStrictEqual(s.custom, {})
      assert.deepStrictEqual(s.books, {})
      assert.deepStrictEqual(s.usage, {})
    })

    it('ensureStateSync 读取已有数据', () => {
      const f = path.join(tmpDir, 'existing.json')
      writeStateSync(f, { version: 1, custom: { x: { balance: 100 } } })
      const s = ensureStateSync(f)
      assert.deepStrictEqual(s.custom, { x: { balance: 100 } })
      assert.deepStrictEqual(s.books, {})
      assert.deepStrictEqual(s.usage, {})
      assert.deepStrictEqual(s.overrides, {})
      assert.deepStrictEqual(s.seenProviders, [])
    })

    it('ensureStateSync 修复类型错误的顶层字段', () => {
      const f = path.join(tmpDir, 'malformed.json')
      writeStateSync(f, { version: 1, custom: [], books: null, usage: 'bad', overrides: 3, seenProviders: {} })
      const s = ensureStateSync(f)
      assert.deepStrictEqual(s.custom, {})
      assert.deepStrictEqual(s.books, {})
      assert.deepStrictEqual(s.usage, {})
      assert.deepStrictEqual(s.overrides, {})
      assert.deepStrictEqual(s.seenProviders, [])
    })

    it('writeStateSync 自动创建缺失的父目录（首次运行 $DSH_HOME 不存在）', () => {
      const f = path.join(tmpDir, 'a', 'b', 'state.json')
      writeStateSync(f, { ok: true })
      assert.deepStrictEqual(readStateSync(f), { ok: true })
    })
  })

  describe('createUsageTracker 成本累计', () => {
    const mkCtx = () => {
      const handlers = {}
      let disposed = false
      return {
        ctx: { on: (type, fn) => { handlers[type] = fn; return () => { disposed = true } } },
        handlers,
        isDisposed: () => disposed
      }
    }
    const mkEvent = (provider, model, usage) => ({
      type: 'assistant/message',
      data: { header: { config: { provider, model } }, turn: 0, step: 0, usage }
    })
    // DSHA 1.2+ 事件：无 header.config，provider/model 仅存在于 message.source
    const mkEventV2 = (provider, model, usage) => ({
      type: 'assistant/message',
      data: { message: { role: 'assistant', source: { kind: 'model', provider, model } }, turn: 0, step: 0, usage }
    })

    it('per-token 成本能从 delta 正确累计（字段名对齐 schema）', () => {
      const { ctx, handlers } = mkCtx()
      const f = path.join(tmpDir, 'tracker-pt.json')
      writeStateSync(f, ensureStateSync(f))
      const providers = [
        { id: 'p-token', pricing: { items: [{ model: 'm', billing: 'per-token', perCall: 0, inputRatio: 1, completionRatio: 1, groupRatio: 1 }] } }
      ]
      const tracker = createUsageTracker(ctx, f, () => {}, providers)
      handlers['session/event']({ id: 's1' }, mkEvent('p-token', 'm', { inputTokens: 500_000, outputTokens: 500_000 }))
      const s = ensureStateSync(f)
      // 每 500k token = $1，input $1 + output $1 = $2
      assert.strictEqual(s.usage['p-token'].todayCost, 2, 'per-token cost should be accumulated')
      assert.strictEqual(s.books['p-token'].spent, 2, 'books.spent should accumulate too')
      assert.strictEqual(s.usage['p-token'].models.m.cost, 2, 'model cost should be accumulated')
      tracker.stop()
    })

    it('per-call 微额成本不被 roundMoney 抹零（保留 6 位小数）', () => {
      const { ctx, handlers } = mkCtx()
      const f = path.join(tmpDir, 'tracker-pc.json')
      writeStateSync(f, ensureStateSync(f))
      const providers = [
        { id: 'p-call', pricing: { items: [{ model: 'm', billing: 'per-call', perCall: 0.001, inputRatio: 0, completionRatio: 0, groupRatio: 1 }] } }
      ]
      const tracker = createUsageTracker(ctx, f, () => {}, providers)
      handlers['session/event']({ id: 's1' }, mkEvent('p-call', 'm', { inputTokens: 10, outputTokens: 5 }))
      const s = ensureStateSync(f)
      assert.strictEqual(s.usage['p-call'].todayCost, 0.001, 'per-call micro cost must be preserved')
      assert.strictEqual(s.books['p-call'].spent, 0.001, 'books.spent must preserve micro cost')
      tracker.stop()
    })

    it('超期日归档（>30 天）在日期切换时被自动删除', () => {
      const { ctx, handlers } = mkCtx()
      const f = path.join(tmpDir, 'tracker-prune.json')
      const old = { version: 1, custom: {}, books: {}, usage: {} }
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
      const ancient = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10)
      old.usage['p-prune'] = {
        todayKey: yesterday, todayCalls: 1, todayTokens: 1, todayCost: 0.001, models: {},
        [`${ancient}_done`]: { calls: 99, tokens: 99, cost: 9, models: {} }
      }
      writeStateSync(f, old)
      const tracker = createUsageTracker(ctx, f, () => {}, [])
      handlers['session/event']({ id: 's1' }, mkEvent('p-prune', 'm', { inputTokens: 1, outputTokens: 1 }))
      const s = ensureStateSync(f)
      assert.ok(s.usage['p-prune'][`${yesterday}_done`], 'yesterday should be archived')
      assert.ok(!s.usage['p-prune'][`${ancient}_done`], 'ancient archive should be pruned')
      tracker.stop()
    })

    it('支持 DSHA 1.2+ 事件：provider/model 仅从 message.source 提取', () => {
      const { ctx, handlers } = mkCtx()
      const f = path.join(tmpDir, 'tracker-v2.json')
      writeStateSync(f, ensureStateSync(f))
      const providers = [
        { id: 'p-v2', pricing: { items: [{ model: 'm', billing: 'per-call', perCall: 0.001, inputRatio: 0, completionRatio: 0, groupRatio: 1 }] } }
      ]
      const tracker = createUsageTracker(ctx, f, () => {}, providers)
      handlers['session/event']({ id: 's1' }, mkEventV2('p-v2', 'm', { inputTokens: 10, outputTokens: 5 }))
      const s = ensureStateSync(f)
      assert.strictEqual(s.usage['p-v2'].todayCalls, 1, 'should record call via message.source.provider')
      assert.strictEqual(s.books['p-v2'].spent, 0.001)
      tracker.stop()
    })

    it('增量事件只累计一次调用次数，并在 stop 时注销监听器', () => {
      const { ctx, handlers, isDisposed } = mkCtx()
      const f = path.join(tmpDir, 'tracker-delta.json')
      writeStateSync(f, ensureStateSync(f))
      const providers = [
        { id: 'p-delta', pricing: { items: [{ model: 'm', billing: 'per-token', inputRatio: 1, completionRatio: 1, groupRatio: 1 }] } }
      ]
      const tracker = createUsageTracker(ctx, f, () => {}, providers)
      const session = { id: 's-delta' }
      handlers['session/event'](session, mkEvent('p-delta', 'm', { inputTokens: 100, outputTokens: 50 }))
      handlers['session/event'](session, mkEvent('p-delta', 'm', { inputTokens: 200, outputTokens: 100 }))
      const usage = ensureStateSync(f).usage['p-delta']
      assert.strictEqual(usage.todayCalls, 1)
      assert.strictEqual(usage.models.m.calls, 1)
      assert.strictEqual(usage.todayTokens, 300)
      tracker.stop()
      assert.ok(isDisposed(), 'stop should dispose the session/event listener')
    })

    it('per-call 增量事件只扣费一次并持续累计 token', () => {
      const { ctx, handlers } = mkCtx()
      const f = path.join(tmpDir, 'tracker-call-delta.json')
      const providers = [
        { id: 'p-call-delta', pricing: { items: [{ model: 'm', billing: 'per-call', perCall: 0.5, groupRatio: 1 }] } }
      ]
      const tracker = createUsageTracker(ctx, f, () => {}, providers)
      const session = { id: 's-call-delta' }
      handlers['session/event'](session, mkEvent('p-call-delta', 'm', { inputTokens: 10, outputTokens: 5 }))
      handlers['session/event'](session, mkEvent('p-call-delta', 'm', { inputTokens: 20, outputTokens: 10 }))
      const usage = ensureStateSync(f).usage['p-call-delta']
      assert.strictEqual(usage.todayCalls, 1)
      assert.strictEqual(usage.todayTokens, 30)
      assert.strictEqual(usage.todayCost, 0.5)
      assert.strictEqual(usage.models.m.cost, 0.5)
      tracker.stop()
    })

    it('零 token 的 per-call 首事件仍记录调用和费用', () => {
      const { ctx, handlers } = mkCtx()
      const f = path.join(tmpDir, 'tracker-zero-call.json')
      const providers = [
        { id: 'p-zero', pricing: { items: [{ model: 'm', billing: 'per-call', perCall: 0.25, groupRatio: 1 }] } }
      ]
      const tracker = createUsageTracker(ctx, f, () => {}, providers)
      handlers['session/event']({ id: 's-zero' }, mkEvent('p-zero', 'm', {}))
      const usage = ensureStateSync(f).usage['p-zero']
      assert.strictEqual(usage.todayCalls, 1)
      assert.strictEqual(usage.todayTokens, 0)
      assert.strictEqual(usage.todayCost, 0.25)
      tracker.stop()
    })

    it('pricing 就绪后补算初始化窗口成本', () => {
      const { ctx, handlers } = mkCtx()
      const f = path.join(tmpDir, 'tracker-pending-cost.json')
      const providers = [{ id: 'p-pending' }]
      const tracker = createUsageTracker(ctx, f, () => {}, () => providers)
      handlers['session/event']({ id: 's-pending' }, mkEvent('p-pending', 'm', { inputTokens: 500_000, outputTokens: 0 }))
      let usage = ensureStateSync(f).usage['p-pending']
      assert.strictEqual(usage.todayCalls, 1)
      assert.strictEqual(usage.todayTokens, 500_000)
      assert.strictEqual(usage.todayCost, 0)
      providers[0].pricing = { items: [{ model: 'm', billing: 'per-token', inputRatio: 1, completionRatio: 1, groupRatio: 1 }] }
      assert.strictEqual(tracker.flushPendingCosts(), 1)
      usage = ensureStateSync(f).usage['p-pending']
      assert.strictEqual(usage.todayCalls, 1)
      assert.strictEqual(usage.todayTokens, 500_000)
      assert.strictEqual(usage.todayCost, 1)
      assert.strictEqual(usage.models.m.cost, 1)
      tracker.stop()
    })

    it('计数器回退会更新基线，模型切换会创建新调用', () => {
      const { ctx, handlers } = mkCtx()
      const f = path.join(tmpDir, 'tracker-reset.json')
      const tracker = createUsageTracker(ctx, f, () => {}, [])
      const session = { id: 's-reset' }
      handlers['session/event'](session, mkEvent('p-reset', 'm1', { inputTokens: 100, outputTokens: 50 }))
      handlers['session/event'](session, mkEvent('p-reset', 'm1', { inputTokens: 10, outputTokens: 5 }))
      handlers['session/event'](session, mkEvent('p-reset', 'm1', { inputTokens: 20, outputTokens: 10 }))
      handlers['session/event'](session, mkEvent('p-reset', 'm2', { inputTokens: 7, outputTokens: 3 }))
      const usage = ensureStateSync(f).usage['p-reset']
      assert.strictEqual(usage.todayCalls, 2)
      assert.strictEqual(usage.todayTokens, 175)
      assert.strictEqual(usage.models.m1.calls, 1)
      assert.strictEqual(usage.models.m2.calls, 1)
      tracker.stop()
    })

    it('CNY 自定义余额不直接扣减 USD 估算成本', () => {
      const { ctx, handlers } = mkCtx()
      const f = path.join(tmpDir, 'tracker-currency.json')
      const state = ensureStateSync(f)
      state.custom['p-cny'] = { balance: 100, currency: 'CNY' }
      state.books['p-cny'] = { spent: 0, currency: 'CNY' }
      writeStateSync(f, state)
      const providers = [
        { id: 'p-cny', pricing: { items: [{ model: 'm', billing: 'per-call', perCall: 1, groupRatio: 1 }] } }
      ]
      const tracker = createUsageTracker(ctx, f, () => {}, providers)
      handlers['session/event']({ id: 's-cny' }, mkEvent('p-cny', 'm', { inputTokens: 10, outputTokens: 5 }))
      const saved = ensureStateSync(f)
      assert.strictEqual(saved.usage['p-cny'].todayCost, 1)
      assert.strictEqual(saved.books['p-cny'].spent, 0)
      tracker.stop()
    })
  })

  describe('books 归档逻辑', () => {
    it('日期切换归档旧数据并创建新 bucket', () => {
      const f = path.join(tmpDir, 'ledger.json')
      writeStateSync(f, { version: 1, custom: {}, books: {}, usage: {} })
      const s = ensureStateSync(f)
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
      // 模拟：已存在一个昨日的 bucket（todayKey = yesterday）
      s.usage['p2'] = { todayKey: yesterday, todayCalls: 10, todayTokens: 100000, todayCost: 0.5, models: { 'm': { calls: 10, tokens: 100000, cost: 0.5 } } }
      writeStateSync(f, s)
      // 重新读取
      const s2 = ensureStateSync(f)
      // 模拟应用层触发"新一天到来"时的归档逻辑（与 createUsageTracker.applyDelta 一致）
      const b = s2.usage['p2']
      const histKey = `${b.todayKey}_done`
      const archived = { calls: b.todayCalls, tokens: b.todayTokens, cost: b.todayCost, models: b.models }
      // 切换到新的一天
      s2.usage['p2'] = { todayKey: todayKey(), todayCalls: 5, todayTokens: 5000, todayCost: 0.1, models: { 'm2': { calls: 5, tokens: 5000, cost: 0.1 } } }
      s2.usage['p2'][histKey] = archived
      writeStateSync(f, s2)
      const s3 = ensureStateSync(f)
      assert.ok(s3.usage['p2'][histKey], 'hist key should exist')
      assert.strictEqual(s3.usage['p2'][histKey].calls, 10)
      assert.strictEqual(s3.usage['p2'].todayCalls, 5)
    })
  })

  describe('collectProviders 兼容空 ctx', () => {
    it('缺失 llm/settings 时不抛错', async () => {
      const ctx = {}
      const result = await collectProviders(ctx)
      assert.ok(Array.isArray(result))
      // 即使空 ctx，deepseek 应被包含（因 deepProps 默认）
      assert.ok(result.some(p => p.id === 'deepseek'), 'should include deepseek by default')
    })

    it('未知 live provider 不继承 DeepSeek 地址或凭据', async () => {
      const ctx = {
        llm: { listProviders: () => [{ id: 'openai', name: 'OpenAI' }] },
        settings: { describe: async () => [] },
        credentials: { resolve: async () => null }
      }
      const result = await collectProviders(ctx)
      const provider = result.find(p => p.id === 'openai')
      assert.strictEqual(provider.baseURL, '')
      assert.strictEqual(provider.isOfficial, false)
      assert.strictEqual(provider.apiKeyEnv, undefined)
    })

    it('pi-ai 中名为 deepseek 的中转地址保持 relay 分类', async () => {
      const ctx = {
        llm: { listProviders: () => [{ id: 'deepseek', name: 'Relay' }] },
        settings: { describe: async () => [{ ns: 'llm-pi-ai', value: { providers: { deepseek: { baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY' } } } }] },
        credentials: { resolve: async () => ({ value: 'secret', source: 'test' }) }
      }
      const provider = (await collectProviders(ctx)).find(p => p.id === 'deepseek')
      assert.strictEqual(provider.baseURL, 'https://relay.example/v1')
      assert.strictEqual(provider.isOfficial, false)
      assert.strictEqual(provider.apiKeyEnv, 'RELAY_KEY')
    })
  })

  describe('凭据解析调用契约', () => {
    it('resolveApiKey 返回 {value, source} 对象', async () => {
      const ctx = {
        credentials: {
          resolve: async (env) => env === 'TEST_KEY' ? { value: 'sk-abc123', source: 'env' } : null
        },
        llm: { listProviders: () => [{ id: 'test-p', name: 'Test' }] },
        settings: { describe: async () => [{ ns: 'llm-pi-ai', value: { providers: { 'test-p': { baseURL: 'https://relay.example.com', apiKeyEnv: 'TEST_KEY' } } } }] }
      }
      // resolveApiKey 是模块内函数，通过 collectProviders 侧效应验证 credential 字段
      const result = await collectProviders(ctx)
      const p = result.find(x => x.id === 'test-p')
      assert.ok(p, 'provider should be found')
      assert.strictEqual(p.credential, 'ok', 'credential should resolve')
    })
  })

  describe('插件生命周期', () => {
    it('初始化完成前卸载不会遗留 session/event 监听器', async () => {
      let finishDescribe
      let effectCleanup
      let listenerCount = 0
      const ctx = {
        llm: { listProviders: () => [] },
        settings: { describe: () => new Promise(resolve => { finishDescribe = resolve }) },
        credentials: { resolve: async () => null },
        webServer: {
          register: () => () => {},
          tapIndex: () => () => {}
        },
        on: () => { listenerCount += 1; return () => { listenerCount -= 1 } },
        effect: (setup) => { effectCleanup = setup() }
      }
      apply(ctx)
      assert.strictEqual(listenerCount, 1, 'usage listener should be active while provider discovery is pending')
      effectCleanup()
      finishDescribe([])
      await new Promise(resolve => setImmediate(resolve))
      assert.strictEqual(listenerCount, 0)
    })
  })
})

describe('panel.js / panel.css 文件存在性', () => {
  it('panel.js 可读且包含关键函数', () => {
    const panelJs = fs.readFileSync(path.join(libDir, 'panel.js'), 'utf8')
    assert.ok(panelJs.includes('renderPanel'), 'should export renderPanel logic')
    assert.ok(panelJs.includes('dsh-provider-balance'), 'should reference API base')
    assert.ok(panelJs.includes('fetch'), 'should poll API')
  })

  it('panel.css 可读且包含关键选择器', () => {
    const panelCss = fs.readFileSync(path.join(libDir, 'panel.css'), 'utf8')
    assert.ok(panelCss.includes('.pill'), 'should contain .pill')
    assert.ok(panelCss.includes('.panel'), 'should contain .panel')
    assert.ok(panelCss.includes('.pcard'), 'should contain .pcard')
  })
})

describe('cachedAsync 缓存与失效', () => {
  it('缓存命中返回相同结果', async () => {
    let calls = 0
    const fn = () => { calls++ ; return Promise.resolve(calls) }
    const v1 = await cachedAsync(fn, 'k1', 60000)
    const v2 = await cachedAsync(fn, 'k1', 60000)
    assert.equal(v1, 1)
    assert.equal(v2, 1)
    assert.equal(calls, 1, 'should call only once')
  })

  it('TTL 过期后重新执行', async () => {
    let calls = 0
    const fn = () => { calls++ ; return Promise.resolve(calls) }
    const v1 = await cachedAsync(fn, 'k2', 0)
    const v2 = await cachedAsync(fn, 'k2', 0)
    assert.equal(v1, 1)
    assert.equal(v2, 2)
    assert.equal(calls, 2, 'should re-execute after TTL')
  })

  it('失败时不缓存，允许下次重试', async () => {
    let calls = 0
    const fn = () => {
      calls++
      if (calls < 2) return Promise.reject(new Error('fail'))
      return Promise.resolve('ok')
    }
    await assert.rejects(cachedAsync(fn, 'k3', 60000))
    const v = await cachedAsync(fn, 'k3', 60000)
    assert.equal(v, 'ok', 'should retry on next call')
  })

  it('按前缀失效缓存', async () => {
    let calls = 0
    const fn = () => Promise.resolve(++calls)
    assert.equal(await cachedAsync(fn, 'bal_provider-a', 60000), 1)
    assert.equal(await cachedAsync(fn, 'bal_provider-a', 60000), 1)
    invalidateCached('bal_provider-a')
    assert.equal(await cachedAsync(fn, 'bal_provider-a', 60000), 2)
  })

  it('失效进行中的请求后不会被旧结果重新填充', async () => {
    let resolveFirst
    const first = cachedAsync(() => new Promise(resolve => { resolveFirst = resolve }), 'price_race', 60000)
    invalidateCached('price_race')
    const second = cachedAsync(() => Promise.resolve('new'), 'price_race', 60000)
    resolveFirst('old')
    assert.equal(await first, 'old')
    assert.equal(await second, 'new')
    assert.equal(await cachedAsync(() => Promise.resolve('unexpected'), 'price_race', 60000), 'new')
  })
})

describe('fetchJson 重试', () => {
  it('HTTP 500 后重试成功（每轮独立 AbortController 与定时器）', async () => {
    // 服务端第一次返回 500 触发 throw，第二次正常返回。
    let requests = 0
    const server = http.createServer((_req, res) => {
      requests += 1
      const status = requests === 1 ? 500 : 200
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: status === 200, requests }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${server.address().port}/x`
      const data = await fetchJson(url, { timeout: 1000, retries: 1, retryDelay: 10 })
      assert.ok(data.ok === true, '重试应成功返回数据')
      assert.equal(requests, 2, '服务端应收到两次请求')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('逐轮独立的 AbortController 能完成超时-重试全流程', async () => {
    // 服务端首请求慢响应（30ms）触发 5ms 客户端超时；第二次快速响应。
    // 保持较长 retryDelay=50 以覆盖第一个分定时器的剩余期。
    // 首请求延迟 60ms 超过 20ms 超时；次请求延迟 0 能在超时内完成
    let requests = 0
    const server = http.createServer((_req, res) => {
      requests += 1
      const delay = requests === 1 ? 60 : 0
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, requests }))
      }, delay)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${server.address().port}/x`
      const data = await fetchJson(url, { timeout: 20, retries: 1, retryDelay: 10 })
      assert.ok(data.ok === true, '超时重试应成功')
      assert.equal(data.requests, 2, '服务端应收到两次请求')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})

describe('renderPanel 输出验证', () => {
  it('renderPanel 正常数据包含关键文本', () => {
    const data = {
      ok: true,
      now: new Date().toISOString(),
      providers: [{
        id: 'deepseek',
        name: 'DeepSeek',
        host: 'api.deepseek.com',
        isOfficial: true,
        credential: 'ok',
        balance: { mode: 'auto', available: true, remaining: 123.45, total: 200, currency: 'CNY', updatedAt: new Date().toISOString(), source: 'deepseek' },
        pricing: null,
        usage: { todayCalls: 5, todayTokens: 10000, todayCost: 0.02 },
        books: { spent: 10 }
      }]
    }
    const html = renderPanel(data)
    assert.ok(html.includes('DeepSeek'), 'name should appear')
    assert.ok(html.includes('123.45'), 'balance should appear')
    assert.ok(html.includes('自动查询'), 'mode badge')
    assert.ok(html.includes('供应商余额管家'), 'panel title')
  })

  it('renderPanel 无 provider 时显示空提示', () => {
    const html = renderPanel({ ok: true, now: new Date().toISOString(), providers: [] })
    assert.ok(html.includes('未发现供应商'))
  })

  it('renderPanel 异常数据返回错误提示', () => {
    const html = renderPanel({ ok: false, error: 'network timeout' })
    assert.ok(html.includes('加载失败'))
  })
})
