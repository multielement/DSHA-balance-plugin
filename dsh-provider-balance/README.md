# dsh-provider-balance（供应商余额管家）

> DSHA / DeepSeek Harness 上的供应商余额管家插件。自动查询各供应商余额、识别按次/按量计费倍率、支持自定义余额本地记账。

- **DSHA 版本**：1.1.9.x ~ 1.2.x（dsh `0.1.1-rc.2` ~ `0.1.3-alpha.2`，已逐包比对 API）
- **Node 要求**：>= 22.19.0
- **依赖**：零依赖（纯 ESM）
- **许可证**：MIT

## 功能

1. **供应商余额管理**
   - 自动发现 DSH LLM 注册的所有供应商（DeepSeek 官方、pi-ai 中转站）
   - DeepSeek 官方：`GET /user/balance`（优先 CNY 币种）
   - one-api / new-api 系中转站：`/v1/dashboard/billing/subscription` + `/v1/dashboard/billing/usage`（USD）
   - 自定义余额：用户手动设定，本地按 session 事件估算扣减
   - 余额缓存 60s，单供应商刷新按需

2. **按次/按量倍率自动识别**
   - one-api / new-api 中转站：`GET {base}/api/pricing`（支持匿名与 Bearer 认证）
   - 归一化 schema：`{model, billing:'per-call'|'per-token', perCall, inputRatio, completionRatio, groupRatio, currency:'USD'}`
   - 自定义 DeepSeek 官方 API：内置价格参考表（可能过期，需手动更新）

3. **本地用量记账**
   - 监听 `session/event` 事件（`assistant/message`）
   - 按 `(session, turn, step)` 去重，delta 模式避免重复计数
   - 估算成本（USD）：按次 = `perCall × groupRatio`；按量 = `(input × r + output × r × cr) / 500000`
   - 每日归档到 `history/YYYY-MM-DD_done`，保留 30 天
   - 状态持久化至 `$DSH_HOME/dsh-provider-balance.json`

4. **悬浮 Web 面板**
   - 右下角悬浮 pill：总余额展示 + 状态点
   - 点击展开底部面板（移动端适配，max-height 70vh）
   - 供应商卡片：余额、币种、今日用量、计费倍率表、自定义余额编辑
   - 每 60s 自动轮询，手动刷新即时刷新
   - 暗黑/亮色自适应（`prefers-color-scheme`）

5. **安全**
   - API Key 仅在宿主机侧通过 `ctx.credentials.resolve()` 解析，永不回传浏览器
   - 面板只返回余额数字、倍率、host 名称；不暴露密钥

## 安装（DSHA 1.1.9.x）

### 方式一：npm 安装（推荐）

```bash
dsha-plugin install dsh-provider-balance@1.1.3
```

或本地路径：

```bash
dsha-plugin install /workspace/dsh-provider-balance/dsh-provider-balance-1.1.3.tgz
```

### 方式二：GitHub 仓库链接

将本仓库发布为 GitHub 公开仓库，在 DSHA 插件市场粘贴 `https://github.com/OWNER/dsh-provider-balance`。

### 方式三：手动目录导入

```bash
# 将 /workspace/dsh-provider-balance 目录导入 DSHA
dsha-plugin install /workspace/dsh-provider-balance
```

## 使用说明

1. **首次启动**：DSHA 启动后，插件自动发现供应商（DeepSeek 官方 + pi-ai 中转站）
2. **查看余额**：点击右下角悬浮 pill，展开余额面板
3. **刷新余额**：点击供应商卡片「刷新」按钮或面板底部「全部刷新」
4. **设置自定义余额**：
   - 自动查询失败的供应商显示「设置余额」
   - 输入当前余额 + 选择货币（USD/CNY）
   - 保存后按 session 事件自动记账扣减
5. **查看计费倍率**：点击「计费倍率表」展开，显示按次/按量识别结果
6. **查看用量历史**：`/dsh-provider-balance/usage.json` 返回完整 ledger

## 目录结构

```
dsh-provider-balance/
├── package.json           # bundle 声明 (dsh.bundle.patch)
├── cordis.patch.yml       # DSH bundle 插入声明
├── LICENSE                # MIT
├── README.md
├── lib/
│   ├── index.js           # 宿主插件（ESM，零依赖）
│   ├── panel.js           # 悬浮面板（浏览器 ESM，零依赖）
│   └── panel.css          # 面板样式
└── tools/
    └── smoke.mjs          # node:test 冒烟测试
```

## API 路由（插件注册）

| 路由 | 方法 | 说明 |
|------|------|------|
| `/dsh-provider-balance/summary.json` | GET | 全部供应商余额 + 倍率 + 用量 |
| `/dsh-provider-balance/refresh.json` | POST | 刷新指定供应商（body `{provider}`）或全部 |
| `/dsh-provider-balance/custom.json` | GET/POST | 获取/设置自定义余额 |
| `/dsh-provider-balance/usage.json` | GET | 用量 ledger |
| `/dsh-provider-balance/overrides.json` | GET/POST | 自定义价格覆盖 |
| `/dsh-provider-balance/panel.js` | GET | 悬浮面板 JS |
| `/dsh-provider-balance/panel.css` | GET | 悬浮面板 CSS |
| `/dsh-provider-balance/health.json` | GET | 健康检查 |

## 状态文件

`$DSH_HOME/dsh-provider-balance.json`

```json
{
  "version": 1,
  "custom": {
    "deepseek": { "balance": 200, "currency": "CNY", "updatedAt": "2026-09-07T00:00:00Z" }
  },
  "books": {
    "deepseek": { "spent": 10.5, "currency": "CNY", "updatedAt": "..." }
  },
  "usage": {
    "deepseek": {
      "todayKey": "2026-09-07",
      "todayCalls": 5,
      "todayTokens": 10000,
      "todayCost": 0.02,
      "total": {},
      "models": { "deepseek-v4": { "calls": 5, "tokens": 10000, "cost": 0.02 } }
    }
  },
  "seenProviders": ["deepseek", "my-relay"],
  "overrides": {}
}
```

## 测试

```bash
node --test tools/smoke.mjs
```

覆盖：余额探测、价格归一化、成本估算、state 文件 IO、books 归档、collectProviders。

## 协议兼容性

- **DSH 0.1.1-rc.2**（DSHA 1.1.9.x）：已验证 API 形态
- **DSH 0.1.2-rc.1**（DSHA 1.2.x）：`ctx.settings.describe()` 签名兼容
- **DSH 0.1.3-alpha.2**（DSHA 1.2.x 最新）：逐包比对通过——`webServer.register/tapIndex`、`settings`、`credentials`、`llm.listProviders`、`TokenUsage` 不变；`assistant/message` 事件新增 `stream` 字段与 `assistant/attempt` 类型，插件不依赖。provider/model 提取兼容 `header.config` 与 `message.source`（AssistantProvenance）双通道
- **Node >= 22**：require

## 致谢

- `dsh-whale` (MeteorNOX) —— 悬浮面板架构参考
- `dsh-billing` (Wanbinyu) —— one-api 余额/倍率探测逻辑参考

## License

MIT
