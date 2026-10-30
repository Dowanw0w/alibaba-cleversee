# multi-access

把 **阿里云 CleverSee（开析）** 收敛成一套统一的搜索与网页读取能力：

- **Search**：`POST /search/unified`，默认 `CNLiteBasic` 引擎。
- **Fetch**：`POST /readpage/basic`，可选降级到 `POST /readpage/scrape`（浏览器渲染）。
- 以 **Pi 扩展**（`multi_search` / `multi_fetch` 工具 + `/multi-access` 命令）和 **CLI** 两种形态提供。
- 零运行时依赖，只用 Node 内置模块。

> 本项目为**纯本地项目**，不使用 GitHub 或任何远程仓库管理。凭据只从环境变量读取，不写文件、不进日志、不进仓库。
>
> 2026-10-19 起不再使用 DeepSeek 搜索/抓取：DeepSeek provider 已删除，搜索与抓取全部走 CleverSee。

---

## 安装

### 1. 准备凭据

写入 `~/.config/fish/conf.d/multi-access.fish`（权限 600），变量名固定：

```fish
set -gx CLEVERSEE_API_KEY '<阿里云 CleverSee API Key>'
```

### 2. 安装为 Pi 扩展

```bash
pi install /data/Code/multi-access
```

Pi 直接从该目录加载（不复制），改动源码后重开 pi 会话即可生效，无需重新安装。

### 3. 直接使用 CLI

```bash
cd /data/Code/multi-access
node bin/multi-access.mjs status
node bin/multi-access.mjs search "Kubernetes 1.31 release notes" -n 3
node bin/multi-access.mjs fetch https://example.com/
```

---

## Pi 工具

### `multi_search`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 查询词；**不支持** `site:` / `after:` / `lang:` 等操作符，请用下面两个结构化参数 |
| `count` | integer 1–50 | 5 | 返回条数（受引擎上限约束） |
| `recency` | `day\|week\|month\|year` | — | 时间范围 |
| `include_domains` | string[] | — | 只保留这些域名（`CNLiteBasic` / `GlobalAdvanced` 支持） |
| `exclude_domains` | string[] | — | 排除这些域名（同上） |
| `need_content` | boolean | false | 请求正文（CleverSee `mainText` 上限约 3000 字） |

### `multi_fetch`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | 仅 http/https；默认拒绝回环/私网地址与 URL 内凭据 |
| `scrape` | boolean | false | 允许 `readpage/basic` 失败后降级到浏览器渲染的 `readpage/scrape`（更慢、更贵） |
| `refresh` | boolean | false | 跳过进程内缓存 |

成功结果会进入进程内 LRU 缓存（默认 10 分钟 / 100 条），避免同一 URL 重复计费。

### 命令

```
/multi-access status        # provider 配置、熔断状态、计数器、缓存
/multi-access doctor        # 发一次真实检索，报告实际服务 provider 与耗时
/multi-access clear-cache   # 清空 fetch 缓存
```

---

## 路由、限速与熔断

单上游，没有 provider 兜底；同一请求内只有 fetch 的 `basic → scrape` 一档降级。

| 上游结果 | 动作 |
|---|---|
| 搜索成功且非空 | 直接返回 |
| 搜索成功但 0 条 | 报 `empty` 错误（不会静默返回空列表） |
| fetch `readpage/basic` 失败且开了 `scrape` | 继续尝试 `readpage/scrape` |
| `401/403`（凭据未激活等） | 直接报 `auth`，不重试 |
| `402` 余额不足 / `429` 限流 / `5xx` / 超时 / 网络错误 | 报对应 kind；计入熔断 |
| 目标网页 404/403/反爬（`ReadPage.SecurityRestrict` 等） | 报 `target`；**不计入**熔断 |
| 本地限速排队超时 | 报 `local-throttle`；**不计入**熔断 |

其他机制：

- **熔断**：同一 provider 同一能力（fetch 按 basic/scrape 分开）连续失败 3 次 → open 120s，之后 half-open 放一个探针。只统计上游自身故障（鉴权/欠费/限流/超时/网络/响应异常）；`target`、`local-throttle`、`invalid` 不计入。
- **限速**：搜索 10 QPS、ReadPage 5 QPS；排队超过 1.5s 直接失败（`local-throttle`）。
- **成本**：结果里带 `estimatedCostCny`，只统计成功调用。

---

## 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `CLEVERSEE_API_KEY` | — | 阿里云 CleverSee API Key（必填） |
| `MULTI_ACCESS_ENGINE` | `CNLiteBasic` | CleverSee 引擎档位（搜索与 `status` 一致生效） |
| `MULTI_ACCESS_ALLOW_PRIVATE` | `0` | 置 1 允许抓取私网/回环地址 |
| `MULTI_ACCESS_CACHE_TTL` | `600` | fetch 缓存秒数，0 关闭 |
| `MULTI_ACCESS_CACHE_MAX` | `100` | 缓存条数上限 |
| `MULTI_ACCESS_CLEVERSEE_QPS` | `10` | 搜索限速 |
| `MULTI_ACCESS_CLEVERSEE_READPAGE_QPS` | `5` | ReadPage 限速 |
| `MULTI_ACCESS_CLEVERSEE_SEARCH_TIMEOUT_MS` | `15000` | 搜索超时 |
| `MULTI_ACCESS_CLEVERSEE_READPAGE_TIMEOUT_MS` | `15000` | ReadPage 超时 |
| `MULTI_ACCESS_CLEVERSEE_SCRAPE_TIMEOUT_MS` | `30000` | Scrape 超时 |
| `MULTI_ACCESS_CLEVERSEE_SUMMARY` | `0` | 置 1 开启 CleverSee 增强摘要（+2.8 元/千次） |
| `MULTI_ACCESS_CLEVERSEE_SCRAPE` | `0` | 置 1 让 fetch 默认带 Scrape 兜底 |
| `MULTI_ACCESS_CLEVERSEE_READPAGE_MAX_AGE` | `0` | ReadPage 服务端缓存秒数，0 表示不使用 |
| `MULTI_ACCESS_BREAKER_THRESHOLD` | `3` | 熔断失败阈值 |
| `MULTI_ACCESS_BREAKER_COOLDOWN_MS` | `120000` | 熔断冷却时间 |
| `MULTI_ACCESS_LIMITER_MAX_WAIT_MS` | `1500` | 限速最大排队时间 |
| `MULTI_ACCESS_DEBUG` | `0` | 置 1 输出每次调用的结构化日志（不含 query/URL/Key） |
| `CLEVERSEE_BASE_URL` | `https://cloud-iqs.aliyuncs.com` | 仅调试用 |

---

## 成本参考（元/千次）

| 能力 | 单价 |
|---|---|
| `CNLiteBasic`（默认） | 8 |
| `CNAuto` | 18 |
| `LiteAdvanced`（旧规格） | 12 |
| `Generic` | 42 起（阶梯） |
| `GenericAdvanced` | 44.8（含增值包） |
| `GlobalAdvanced` | 56（涉数据出境） |
| ReadPage Basic | 2 |
| ReadPage Scrape | 10 |
| 增强摘要（`summary`） | +2.8 |

---

## 安全

- 凭据只从环境变量读取；任何输出、日志、错误信息都不包含 Key。
- 日志只记录 provider / 能力 / 结果 / 耗时 / 字符数，不记录 query 原文、URL 正文。
- Fetch 默认拒绝 `localhost`、回环、私网、链路本地与 `metadata.google.internal`；拒绝 URL 内嵌凭据；只允许 http/https。
- 不写文件、不起监听端口、不落盘缓存。

---

## 测试

```bash
node --test test/*.test.mjs          # 36 项离线测试（无网络）
fish -lc 'MULTI_ACCESS_LIVE=1 node --test test/live.test.mjs'   # 真实 API 联调
```

离线覆盖：CleverSee 参数/响应映射、错误分类、空结果、429/5xx/超时、熔断半开、ReadPage basic→scrape 链、缓存、URL 校验、引擎档位透传、扩展注册与格式化。

联调覆盖：CleverSee 搜索、域名过滤、抓取。

---

## 已知限制

- **没有 query 操作符**：`site:` / `after:` / `-site:` / `lang:` / 精确短语只在旧的 DeepSeek 路径支持，CleverSee 没有等价语法。域名与时间范围请用 `include_domains` / `exclude_domains` / `recency`（`CNAuto`、`Generic` 等引擎不支持站点过滤，会返回 warning 并忽略）。
- **单上游无兜底**：CleverSee 不可用时直接失败，没有第二家可切。
- CleverSee 返回条数受引擎上限约束（`CNLiteBasic` 50、`CNAuto`/`Generic` 10、`GenericAdvanced` 80、`GlobalAdvanced` 20）。
- `ReadPageScrape` 平均耗时可达 30s，默认关闭。
- 不提供代理、cookie、PDF/YouTube 专项抓取。
- 不做模型内置搜索（`enable_search` / Responses `web_search`），只暴露独立 API 能力。

---

## 与旧项目的关系

本仓库取代 `cleversee-search-gateway`。旧项目是「CleverSee → Tavily 兼容网关」，依赖 pi-web-access 的 `tavilyBaseUrl`/`crawl4aiBaseUrl` 机制；本项目改为 Pi 扩展直接注册工具，不依赖任何第三方网关契约。旧项目及其 `CLEVERSEE_GW_TOKEN` 已不再使用。
