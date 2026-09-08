// dsh-provider-balance — 悬浮余额面板 (浏览器侧，零依赖 ESM)
// 功能：展示供应商余额、计费倍率表、自定义余额编辑
// 轮询 /dsh-provider-balance/summary.json 每 60s
'use strict'

const API_BASE = '/dsh-provider-balance'
let lastData = null
let pollTimer = null
let refreshAbort = null

// 面板关闭时清理定时器
window.addEventListener('beforeunload', stopPolling)
window.addEventListener('pageshow', () => { if (!pollTimer) start() })

// ================================================================
// 工具
// ================================================================
function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: decimals })
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ================================================================
// 渲染
// ================================================================
function renderCard(p) {
  const bal = p.balance || {}
  const mode = bal.mode || 'auto'
  const available = bal.available !== false
  const priceItems = (p.pricing?.items || []).slice(0, 20)
  const today = p.usage?.todayCalls ?? 0
  const todayCost = fmt(p.usage?.todayCost ?? 0, 4)
  const todayTokens = fmt(p.usage?.todayTokens ?? 0, 0)

  const badge = mode === 'custom'
    ? `<span class="badge custom">自定义余额</span>`
    : mode === 'auto'
    ? `<span class="badge auto">${available ? '自动查询' : '查询失败'}</span>`
    : `<span class="badge off">官方接口</span>`

  const balLine = available
    ? `<div class="bal-num">${fmt(bal.remaining ?? 0, 4)} <span class="curr">${esc(bal.currency)}</span></div>
       <div class="bal-meta">${mode === 'custom' ? `原始余额 ${fmt(bal.total)} / 已耗 ${fmt(p.books?.spent ?? 0)}` : `总额 ${fmt(bal.total)} / 已用 ${fmt(bal.used ?? 0)}`}</div>`
    : `<div class="bal-num bal-err">不可用</div>
       <div class="bal-meta err">${esc(bal.error || '未知错误')}</div>`

  const pricingRows = priceItems.length > 0
    ? `<table class="ptable">
        <thead><tr><th>模型</th><th>计费</th><th>输入倍率</th><th>输出倍率</th><th>分组倍率</th></tr></thead>
        <tbody>${priceItems.map(m => `<tr>
          <td>${esc(m.model)}</td>
          <td>${m.billing === 'per-call' ? '按次' : '按量'}</td>
          <td>${fmt(m.inputRatio, 4)}</td>
          <td>${fmt(m.completionRatio, 4)}</td>
          <td>${fmt(m.groupRatio, 4)}</td>
        </tr>`).join('')}
        </tbody>
       </table>`
    : `<div class="no-pricing">暂无倍率数据</div>`

  const customBtn = mode === 'custom'
    ? `<button class="btn-set" data-provider="${esc(p.id)}" data-mode="custom">修改余额</button>`
    : `<button class="btn-set" data-provider="${esc(p.id)}" data-mode="${mode}">设置余额</button>`

  const refreshBtn = `<button class="btn-r" data-provider="${esc(p.id)}">刷新</button>`

  return `
    <div class="pcard" data-id="${esc(p.id)}">
      <div class="phead">
        <div class="pname">${esc(p.name)} <span class="phost">${esc(p.host)}</span></div>
        <div class="pbadges">${badge}${p.credential === 'missing' ? '<span class="badge miss">缺密钥</span>' : ''}</div>
      </div>
      <div class="pbalance">${balLine}</div>
      <div class="ptoday">今日：${today} 次 / ${todayTokens} tokens / <span class="cost">${todayCost}</span></div>
      <div class="pactions">${refreshBtn}${customBtn}</div>
      <details class="ppricing">
        <summary>计费倍率表 (${priceItems.length})</summary>
        ${pricingRows}
      </details>
    </div>`
}

function renderPanel(data) {
  if (!data?.ok) return `<div class="err">数据加载失败：${esc(data?.error || '')}</div>`
  const providers = (data.providers || []).map(renderCard).join('\n')
  const time = new Date(data.now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return `
    <div class="panel-root">
      <div class="pheader">
        <div class="ptitle">供应商余额管家</div>
        <div class="ptime">更新于 ${time}</div>
      </div>
      <div class="plist">${providers || '<div class="empty">未发现供应商</div>'}</div>
      <div class="pfooter">
        <button id="pb-refresh-all" class="btn-refresh-all">全部刷新</button>
        <button id="pb-close" class="btn-close">关闭</button>
      </div>
    </div>`
}

// ================================================================
// 悬浮按钮 & 面板
// ================================================================
function mount() {
  // 幂等：pageshow（bfcache 恢复）可能再次触发 start，避免重复挂载
  if (document.getElementById('dsh-pb-root')) return
  const root = document.createElement('div')
  root.id = 'dsh-pb-root'
  root.innerHTML = `
    <div id="dsh-pb-pill" class="pill" title="供应商余额管家">
      <span id="dsh-pb-pill-dot" class="dot"></span>
      <span id="dsh-pb-pill-label">余额</span>
    </div>
    <div id="dsh-pb-panel" class="panel hidden">加载中...</div>
  `
  document.body.appendChild(root)

  const pill = root.querySelector('#dsh-pb-pill')
  const panel = root.querySelector('#dsh-pb-panel')

  // 事件委托到 root，避免全局监听器泄漏
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    if (btn?.dataset.provider) {
      if (btn.classList.contains('btn-r')) {
        refreshProvider(btn.dataset.provider)
        return
      }
      if (btn.classList.contains('btn-set')) {
        showSetBalance(btn.dataset.provider, btn.dataset.mode || 'auto', lastData)
        return
      }
    }
    if (e.target.id === 'pb-refresh-all') {
      doRefresh()
      return
    }
    if (e.target.id === 'pb-close') {
      panel.classList.add('hidden')
      stopPolling()
    }
  })

  pill.addEventListener('click', () => {
    panel.classList.toggle('hidden')
    if (!panel.classList.contains('hidden')) poll()
  })
}

async function poll() {
  try {
    const res = await fetch(`${API_BASE}/summary.json`)
    const data = await res.json()
    lastData = data
    const panel = document.querySelector('#dsh-pb-panel')
    if (panel) panel.innerHTML = renderPanel(data)
    const dot = document.querySelector('#dsh-pb-pill-dot')
    if (dot) dot.className = 'dot' + (data.ok ? '' : ' err')
    const label = document.querySelector('#dsh-pb-pill-label')
    if (label && data.providers?.length) {
      // 余额单位混杂（CNY/USD），不做跨币种平均——只显示可用数量与分组总计
      const available = data.providers.filter(p => p.balance?.available !== false)
      const byCurrency = new Map()
      for (const p of available) {
        const cur = p.balance?.currency || 'USD'
        byCurrency.set(cur, (byCurrency.get(cur) || 0) + (p.balance?.remaining ?? 0))
      }
      const parts = [...byCurrency.entries()].map(([c, v]) => `${fmt(v, 2)} ${c}`)
      label.textContent = available.length > 0
        ? (parts.length > 1 ? parts.join(' / ') : `余额 ${parts[0] || ''}`)
        : '不可用'
    }
  } catch (e) {
    console.error('[dsh-pb] poll error:', e)
    const dot = document.querySelector('#dsh-pb-pill-dot')
    if (dot) dot.className = 'dot err'
  }
}

async function refreshProvider(providerId) {
  try {
    const res = await fetch(`${API_BASE}/refresh.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId })
    })
    const data = await res.json()
    lastData = data
    const panel = document.querySelector('#dsh-pb-panel')
    if (panel) panel.innerHTML = renderPanel(data)
  } catch (e) { console.error('[dsh-pb] refresh provider error:', e) }
}

async function doRefresh() {
  refreshAbort?.abort()
  refreshAbort = new AbortController()
  try {
    const res = await fetch(`${API_BASE}/refresh.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: refreshAbort.signal
    })
    const data = await res.json()
    lastData = data
    const panel = document.querySelector('#dsh-pb-panel')
    if (panel) panel.innerHTML = renderPanel(data)
  } catch (e) {
    if (e.name !== 'AbortError') console.error('[dsh-pb] refresh error:', e)
  } finally {
    refreshAbort = null
  }
}

// ================================================================
// 设置余额对话框
// ================================================================
function showSetBalance(providerId, mode, data) {
  const existing = data?.providers?.find(p => p.id === providerId)
  const curBal = existing?.balance
  const name = existing?.name || providerId
  const curVal = mode === 'custom' ? (curBal?.total ?? '') : ''
  const defaultCur = curBal?.currency || 'USD'
  const dlg = document.createElement('div')
  dlg.className = 'dlg'
  dlg.innerHTML = `
    <div class="dlg-mask"></div>
    <div class="dlg-box">
      <div class="dlg-title">设置 ${esc(name)} 余额</div>
      <div class="dlg-body">
        <label>当前余额 <input id="dlg-bal" type="number" step="0.01" value="${esc(String(curVal))}" placeholder="输入当前余额"></label>
        <label>货币
          <select id="dlg-cur">
            <option value="USD" ${defaultCur === 'USD' ? 'selected' : ''}>USD</option>
            <option value="CNY" ${defaultCur === 'CNY' ? 'selected' : ''}>CNY</option>
          </select>
        </label>
        <div class="dlg-hint">${mode === 'custom' ? '重置后将重新计算已耗费用' : '自定义余额将在本设备本地记账中使用'}</div>
      </div>
      <div class="dlg-footer">
        <button id="dlg-ok" class="btn-ok">保存</button>
        <button id="dlg-cancel" class="btn-cancel">取消</button>
      </div>
    </div>`
  document.body.appendChild(dlg)
  
  const cleanup = () => {
    document.body.removeChild(dlg)
    dlg.removeEventListener('click', handleClick)
  }
  
  async function handleClick(e) {
    if (e.target.id === 'dlg-ok') {
      const bal = parseFloat(dlg.querySelector('#dlg-bal').value)
      const cur = dlg.querySelector('#dlg-cur').value
      if (isNaN(bal) || bal < 0) { alert('请输入非负数字'); return }
      try {
        const res = await fetch(`${API_BASE}/custom.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: providerId, balance: bal, currency: cur, resetBooks: mode === 'custom' })
        })
        const json = await res.json()
        if (!json.ok) { alert('保存失败: ' + (json.error || '')); return }
        cleanup()
        await poll()
      } catch (err) {
        alert('网络错误: ' + (err.message || '请求失败'))
      }
    } else if (e.target.id === 'dlg-cancel' || e.target.classList.contains('dlg-mask')) {
      cleanup()
    }
  }
  
  dlg.addEventListener('click', handleClick)
}

// ================================================================
// 启动
// ================================================================
let started = false
function start() {
  if (started) { if (!pollTimer) pollTimer = setInterval(poll, 60_000); return }
  started = true
  mount()
  poll()
  pollTimer = setInterval(poll, 60_000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}

// 导出给测试用
export { API_BASE, renderPanel, fmt, esc, stopPolling }
