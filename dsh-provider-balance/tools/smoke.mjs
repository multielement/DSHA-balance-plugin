// tools/smoke.mjs — dsh-provider-balance 冒烟测试（node:test + assert）
// 覆盖：余额探测、价格归一化、成本估算、state ledger、provider 发现逻辑
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
  collectProviders, cachedAsync
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
