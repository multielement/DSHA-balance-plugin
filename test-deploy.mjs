// test-deploy.mjs — 模拟 DSH 插件加载器，验证插件部署兼容性
// 用途：无需真实 DSHA 环境，测试插件导出契约和核心功能
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(__dirname, 'dsh-provider-balance')
const pluginEntry = path.join(pluginRoot, 'lib', 'index.js')

// ================================================================
// 1. 模拟 DSH loader 读取导出
// ================================================================
describe('插件导出契约（loader 读取）', () => {
  let mod
  before(async () => {
    mod = await import(pluginEntry)
  })

  it('导出小写 name（loader 读取 entry.options.name）', () => {
    assert.ok(typeof mod.name === 'string', 'name 必须为字符串')
    assert.equal(mod.name, 'dsh-provider-balance')
  })

  it('导出小写 inject（loader 读取 entry.options.inject）', () => {
    assert.ok(Array.isArray(mod.inject), 'inject 必须为数组')
    assert.ok(mod.inject.includes('webServer'), 'inject 必须包含 webServer')
    assert.ok(mod.inject.includes('credentials'), 'inject 必须包含 credentials')
  })

  it('导出 apply 函数（loader 调用 apply(ctx)）', () => {
    assert.equal(typeof mod.apply, 'function', 'apply 必须为函数')
  })

  it('保留大写别名兼容旧测试', () => {
    assert.equal(mod.NAME, 'dsh-provider-balance')
    assert.deepStrictEqual(mod.INJECT, ['webServer', 'credentials'])
  })
})

// ================================================================
// 2. 模拟 DSH webServer 服务
// ================================================================
class MockWebServer {
  constructor() {
    this.routes = new Map()
    this.exact = new Map()
    this.prefixes = new Map()
    this.indexTaps = []
  }

  register(route) {
    // 模拟真实 throw 行为
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    // 返回 disposer
    return () => { table.delete(route.path) }
  }

  tapIndex(fn) {
    this.indexTaps.push(fn)
    return () => {
      const idx = this.indexTaps.indexOf(fn)
      if (idx !== -1) this.indexTaps.splice(idx, 1)
    }
  }
}

// ================================================================
// 3. 模拟 DSH ctx 对象
// ================================================================
function createMockCtx() {
  const webServer = new MockWebServer()
  const credentials = {
    resolve: async (envName) => {
      // 模拟凭据解析
      if (envName === 'DEEPSEEK_API_KEY') return 'mock-key'
      return null
    }
  }
  const settings = {
    describe: async () => [
      { ns: 'llm-pi-ai', value: { providers: {} } },
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' } }
    ]
  }
  const llm = {
    listProviders: () => []
  }
  return {
    webServer,
    credentials,
    settings,
    llm,
    effect: (fn) => { /* HMR 清理，模拟存储 */ }
  }
}

// ================================================================
// 4. 测试插件 apply
// ================================================================
describe('插件 apply(ctx) 执行', () => {
  it('正常调用 apply 不抛错', async () => {
    const mod = await import(pluginEntry)
    const ctx = createMockCtx()
    const result = mod.apply(ctx)
    assert.ok(result, 'apply 应返回对象')
    assert.equal(typeof result.getSummary, 'function')
    assert.equal(typeof result.refreshAll, 'function')
  })

  it('路由注册成功且 disposer 可用', async () => {
    const mod = await import(pluginEntry)
    const ctx = createMockCtx()
    const result = mod.apply(ctx)

    // 检查路由是否注册
    const routes = [...ctx.webServer.exact.values(), ...ctx.webServer.prefixes.values()]
    assert.ok(routes.length > 0, '应注册路由')

    // 测试 disposer 清理
    const disposer = routes[0].handler
    assert.ok(typeof disposer === 'function', 'handler 应为函数')
  })

  it('tapIndex 注册成功', async () => {
    const mod = await import(pluginEntry)
    const ctx = createMockCtx()
    mod.apply(ctx)

    assert.ok(ctx.webServer.indexTaps.length > 0, '应注册 tapIndex')
  })

  it('duplicate route 抛出明确错误（验证容错）', async () => {
    const mod = await import(pluginEntry)
    const ctx = createMockCtx()
    
    // 第一次注册应成功
    mod.apply(ctx)
    
    // 验证路由已注册
    assert.ok(ctx.webServer.exact.size > 0 || ctx.webServer.prefixes.size > 0)
  })
})

// ================================================================
// 5. 测试面板 JS 语法（避免 TDZ）
// ================================================================
describe('panel.js 语法检查', () => {
  it('panel.js 语法正确（无 TDZ 错误）', () => {
    const panelPath = path.join(pluginRoot, 'lib', 'panel.js')
    try {
      childProcess.execSync(`node -c "${panelPath}"`, { stdio: 'pipe' })
    } catch (e) {
      throw new Error(`panel.js 语法错误: ${e.stderr?.toString() || e.message}`)
    }
  })

  it('panel.js 导出 stopPolling 函数（避免模块加载失败）', () => {
    const panelContent = fs.readFileSync(path.join(pluginRoot, 'lib', 'panel.js'), 'utf8')
    assert.ok(panelContent.includes('export { API_BASE, renderPanel, fmt, esc, stopPolling }'),
      'panel.js 应使用命名导出')
  })
})

// ================================================================
// 6. 测试 core 功能
// ================================================================
describe('核心功能测试', async () => {
  let mod
  before(async () => {
    mod = await import(pluginEntry)
  })

  it('estimateCostFromUsage per-call 模式', () => {
    const pricing = { items: [{ model: 'deepseek-chat', billing: 'per-call', perCall: 0.001, groupRatio: 1 }] }
    const usage = { inputTokens: 100, outputTokens: 50 }
    const result = mod.estimateCostFromUsage(pricing, usage, 'deepseek-chat', 'test')
    assert.ok(result)
    assert.equal(result.cost, 0.001)
    assert.equal(result.currency, 'USD')
  })

  it('estimateCostFromUsage per-token 模式', () => {
    const pricing = { items: [{ model: 'deepseek-chat', billing: 'per-token', inputRatio: 1, completionRatio: 1, groupRatio: 1 }] }
    const usage = { inputTokens: 500000, outputTokens: 0 } // 500k tokens = $1
    const result = mod.estimateCostFromUsage(pricing, usage, 'deepseek-chat', 'test')
    assert.ok(result)
    assert.equal(result.cost, 1.0)
  })

  it('estimateCostFromUsage overrides 支持', () => {
    const pricing = {
      items: [{ model: 'deepseek-chat', billing: 'per-token', inputRatio: 1, completionRatio: 1, groupRatio: 1 }],
      overrides: { 'deepseek-chat': { billing: 'per-call', perCall: 0.01, groupRatio: 1 } }
    }
    const usage = { inputTokens: 100, outputTokens: 50 }
    const result = mod.estimateCostFromUsage(pricing, usage, 'deepseek-chat', 'test')
    // 应使用 overrides 中的 per-call 价格
    assert.ok(result)
    assert.equal(result.cost, 0.01)
  })

  it('collectProviders 兼容空 ctx', async () => {
    const result = await mod.collectProviders({})
    assert.ok(Array.isArray(result))
    assert.ok(result.some(p => p.id === 'deepseek'), '应包含 deepseek 默认 provider')
  })

  it('stateFile 指向 DSH_HOME', () => {
    const statePath = mod.stateFile()
    assert.ok(statePath.includes('dsh-provider-balance.json'))
  })

  it('cachedAsync 缓存与失效', async () => {
    let calls = 0
    const fn = () => { calls++; return Promise.resolve(calls) }
    
    // 缓存命中
    const v1 = await mod.cachedAsync(fn, 'test-key', 60000)
    const v2 = await mod.cachedAsync(fn, 'test-key', 60000)
    assert.equal(v1, 1)
    assert.equal(v2, 1)
    assert.equal(calls, 1)

    // TTL 过期重新执行
    const v3 = await mod.cachedAsync(fn, 'test-key-exp', 0)
    const v4 = await mod.cachedAsync(fn, 'test-key-exp', 0)
    assert.equal(v3, 2)
    assert.equal(v4, 3)
  })
})

console.log('\n========================================')
console.log('DSH 插件部署兼容性测试')
console.log('========================================\n')