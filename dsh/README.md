# 在 DeepSeek Harness (DSH) 中使用

Pi 扩展里的两个工具 `cleversee_search` / `cleversee_fetch` 在 DSH 里**不再以同名工具出现**。
DSH 的 web 能力是「服务 + provider」结构：`ctx.web` 负责选路，`web_search` / `web_fetch`
是稳定的模型侧契约。因此本目录把 CleverSee 注册成 `ctx.web` 的 search / fetch provider，
内置 web 工具会直接走 CleverSee，引用格式、截断、超时、错误渲染都沿用 DSH 的实现。

```
Pi:  cleversee_search  ─┐
     cleversee_fetch   ─┼─ Pi extension API
     /alibaba-cleversee ─┘

DSH: web_search  ─ ctx.web.search() ─→ [provider: cleversee]
     web_fetch   ─ ctx.web.fetch()  ─→ [provider: cleversee]（可选）
```

## 与 Pi 形态的对照

| Pi | DSH | 说明 |
|---|---|---|
| `cleversee_search` | `web_search` + `cleversee` search provider | 模型侧仍是 `web_search`；一次可传 1–4 个 query |
| `cleversee_fetch` | `web_fetch` + `cleversee` fetch provider | 需把 `fetchProvider` 指到 `cleversee` |
| `/alibaba-cleversee status\|doctor\|clear-cache` | `alibaba-cleversee` CLI | DSH 里不必注册同名命令 |
| `cleversee-search-gateway`（Tavily 兼容网关） | **不需要** | 那是给只会说 Tavily 的 `pi-web-access` 用的；DSH 的 `ctx.web` 可直接接 provider |
| `CLEVERSEE_API_KEY` 环境变量 | `~/.dsh/.env` 或启动环境 | 由 DSH 的 launch environment 读取 |

## 安装

本包同时是一个 DSH bundle（`dsh.bundle.patch` 指向 `dsh/cordis.patch.yml`）。
`dsh plugin add` 会把包装进 profile 并登记为 bundle，挂载与选路自动完成：

```bash
# 推荐：按 tag pin，升级时换成新 tag 重新 add
dsh plugin --profile dsh-tui add github:Dowanw0w/alibaba-cleversee#v1.1.0

# 跟随 main（版本会漂移，不推荐长期使用）
dsh plugin --profile dsh-tui add github:Dowanw0w/alibaba-cleversee

# 本地开发时才用 file:
dsh plugin --profile dsh-tui add file:/path/to/alibaba-cleversee
```

bundle patch 做两件事：

1. 插入 `web-cleversee` provider 行；
2. 把 `web.searchProvider` 指到 `cleversee`，`web.fetchProvider` 保持 `http`。

git 源按 ref 锁定：装了 tag 就固定在对应 commit，升级时重新 `add` 到新 tag 即可；
`#main` 只适合临时试用，版本会漂移。

然后配置凭据并重启 DSH：

```bash
# 不要写进仓库/日志；~/.dsh/.env 会被 DSH 读入 launch environment
echo 'CLEVERSEE_API_KEY=...' >> ~/.dsh/.env
chmod 600 ~/.dsh/.env

# 重启后验证
dsh headless "用 web_search 搜一下 Kubernetes 1.31 release notes，并给出来源链接"
```

启动时若 `CLEVERSEE_API_KEY` 缺失，插件仍会加载，但 provider 的 `available()` 为 false，
`web_search` 返回 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`；补上 key 后重启即可。

> 手动挂载：如果包只是普通依赖（没有登记为 bundle），在
> `~/.dsh/profiles/<profile>/cordis.patch.yml` 里补
> `- insert: [{ id: web-cleversee, name: '@dowanw0w/alibaba-cleversee/dsh' }]` 并覆盖
> `- id: web` 的 `searchProvider` 即可。注意 profile patch 必须写在该 profile 目录下，
> 不要写进全局 `~/.dsh/cordis.patch.yml`——全局层会作用于所有 profile，而包只装在其中一个。

## 自定义

profile 自己的 patch（`~/.dsh/profiles/dsh-tui/cordis.patch.yml`）在 bundle 之后应用，可覆盖选路与插件配置。
**patch 会整段替换该行的 `config`**，所以覆盖时要写全字段：

```yaml
# 让 web_fetch 也走 CleverSee ReadPage
- id: web
  config:
    searchProvider: cleversee
    fetchProvider: cleversee

# 改引擎 / 打开 scrape 兜底（整段重写）
- id: web-cleversee
  config:
    apiKeyEnv: CLEVERSEE_API_KEY
    engine: GlobalAdvanced
    fetch: true
    scrape: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiKey` | — | 直接给 key，适合临时调试；长期用 `apiKeyEnv` |
| `apiKeyEnv` | `CLEVERSEE_API_KEY` | 从 launch environment / `~/.dsh/.env` 解析 |
| `engine` | `CNLiteBasic` | 覆盖 `CLEVERSEE_ENGINE`；其余引擎见根 README |
| `scrape` | `false` | ReadPage basic 失败后降级 scrape（Cloudflare 挑战站需要） |
| `fetch` | `true` | 是否注册 fetch provider；不影响 search |
| `searchTimeoutMs` | 客户端默认 15000 | 单次搜索超时 |

其余行为（缓存、熔断、限速、私网拦截）完全复用 `src/` 的实现，环境变量与 CLI 相同。

## 与 Pi 的已知差异

- `web_search` 的模型侧 schema 只有 `queries` / `url`，**没有** `recency`、`include_domains`、
  `exclude_domains`、`scrape` 这些逐次参数。需要这些能力时用 CLI：
  `alibaba-cleversee search "..." --recency month --include docs.vllm.ai --json`。
  想保留 Pi 的完整参数面，可再加一个 `ctx.tools.register()` 的专用工具（未包含在本插件中）。
- Pi 的 `cleversee_fetch` 有 `refresh` 参数；DSH 侧由进程内缓存 + 重启控制。
- DSH 的 `web_fetch` 会把结果当正文渲染，ReadPage 的 `warning: redirected to …` 不再单独提示。

## 回滚

```bash
# 同时移除依赖与 bundle 条目；bundle patch 随之失效
dsh plugin --profile dsh-tui remove @dowanw0w/alibaba-cleversee
```

如果加过 profile patch 覆盖，删除对应行即可。全局 patch 不需要动。
