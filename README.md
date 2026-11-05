# alibaba-cleversee

把 **阿里云 CleverSee（开析）** 封装成 Pi 的搜索与网页读取能力，同时提供 CLI。

> **Unofficial project.** This package is not affiliated with, endorsed by, or sponsored by Alibaba Cloud. "CleverSee" / "开析" is a product of Alibaba Cloud; this project is an independent client for its public HTTP API.

- **Search**：`POST /search/unified`，默认 `CNLiteBasic` 引擎。
- **Fetch**：`POST /readpage/basic`，可选降级到浏览器渲染的 `POST /readpage/scrape`。
- 三种形态：Pi 扩展（`cleversee_search` / `cleversee_fetch` 工具 + `/alibaba-cleversee` 命令）、CLI，以及 [DeepSeek Harness (DSH) 插件](./dsh/README.md)（注册为 `ctx.web` 的 search / fetch provider）。
- 零运行时依赖，只用 Node 内置模块，无构建步骤。

## 安装

分发渠道只有本仓库（GitHub），**不再发布到公共 npm registry**；npmjs 上残留的 `1.0.0` 是历史版本，不再更新，请勿使用。

```bash
# Pi 扩展（推荐：按 tag pin 版本）
pi install git:github.com/Dowanw0w/alibaba-cleversee@v1.1.0

# 跟随 main 最新提交（版本会漂移，不推荐长期使用）
pi install git:github.com/Dowanw0w/alibaba-cleversee

# 仅安装 CLI：克隆后本地全局安装
git clone https://github.com/Dowanw0w/alibaba-cleversee.git
cd alibaba-cleversee
npm install -g .

# DSH 插件：装进 profile 即自动挂载（步骤见 dsh/README.md）
dsh plugin --profile dsh-tui add github:Dowanw0w/alibaba-cleversee#v1.1.0
```

Pi 会按包内 `pi.extensions` 自动注册工具与命令，并自动安装包依赖。git 源按 ref 锁定：安装时指定了 tag 或 commit 就固定不动，`pi update --extensions` 只重新同步该 ref；升级需重新 `pi install` 到新 tag。本包零运行时依赖、无构建步骤，Node ≥ 22。

## 准备 API Key

本项目**不内置任何 key、不提供共享额度**。使用前请在阿里云 CleverSee / 开析控制台自行开通并签发 API Key，费用按调用量计（见下方成本表）。

```bash
# Linux / macOS（fish 示例）
set -gx CLEVERSEE_API_KEY '<your-api-key>'

# bash / zsh
export CLEVERSEE_API_KEY='<your-api-key>'

# Windows PowerShell
$env:CLEVERSEE_API_KEY = '<your-api-key>'
```

Key 只从环境变量读取，不写文件、不进日志、不进仓库。请勿把 key 提交到任何地方；如需长期保存，建议放在 shell 的私有配置文件（权限 600）或系统的密钥管理工具里。

## Pi 工具

### `cleversee_search`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 查询词；**不支持** `site:` / `after:` / `lang:` 等操作符，请用下面两个结构化参数 |
| `count` | integer 1–50 | 5 | 返回条数（受引擎上限约束） |
| `recency` | `day\|week\|month\|year` | — | 时间范围 |
| `include_domains` | string[] | — | 只保留这些域名（`CNLiteBasic` / `GlobalAdvanced` 支持） |
| `exclude_domains` | string[] | — | 排除这些域名（同上） |
| `need_content` | boolean | false | 请求正文（CleverSee `mainText` 上限约 3000 字） |

### `cleversee_fetch`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | 仅 http/https；默认拒绝回环/私网地址与 URL 内凭据 |
| `scrape` | boolean | false | 允许 `readpage/basic` 失败后降级到浏览器渲染的 `readpage/scrape`（更慢、更贵）。**Cloudflare 挑战站（如 openai.com）与 JS 渲染站必须开** |
| `refresh` | boolean | false | 跳过进程内缓存 |

成功结果会进入进程内 LRU 缓存（默认 10 分钟 / 100 条），避免同一 URL 重复计费。

返回头部在页面被重定向到别处时会追加一行 `warning: redirected to …`（`details.meta.redirectedTo` 同时给出落地 URL），避免把 301→首页当成目标文章。

### 命令

```
/alibaba-cleversee status        # provider 配置、熔断状态、计数器、缓存
/alibaba-cleversee doctor        # 发一次真实检索，报告实际服务 provider 与耗时
/alibaba-cleversee clear-cache   # 清空 fetch 缓存
```

## CLI

```bash
alibaba-cleversee status
alibaba-cleversee search "Kubernetes 1.31 release notes" -n 3
alibaba-cleversee search "vLLM" --include docs.vllm.ai --recency month --json
alibaba-cleversee fetch https://example.com/
alibaba-cleversee doctor
```

## 引擎与成本

价格单位：元/千次（以官方最新价格为准，本表仅用于估算与展示）。

| 引擎 | 说明 | 单次上限 | 域名过滤 | 搜索单价 |
|---|---|---|---|---|
| `CNLiteBasic`（默认） | 国内极速版 | 50 | ✅ | 8 |
| `CNAuto` | 国内智能版 | 10 | ❌ | 18 |
| `LiteAdvanced` | 极速版（旧规格） | 50 | ✅ | 12 |
| `Generic` | 通用标准版 | 10 | ❌ | 42 |
| `GenericAdvanced` | 通用增强版 | 80 | ❌ | 44.8 |
| `GlobalAdvanced` | 国际版 | 20 | ✅ | 56 |
| `Deep` | 深度版 | 10 | ❌ | 按官方 |

ReadPage：`basic` 2 元/千次，`scrape` 10 元/千次；增强摘要 `summary` 另加 2.8 元/千次。搜索结果里会带 `estimatedCostCny`，只统计成功调用。

默认引擎面向国内信源。需要海外结果时请显式切换：

```bash
CLEVERSEE_ENGINE=GlobalAdvanced alibaba-cleversee search "..."
```

## 路由、限速与熔断

单上游，没有 provider 兜底；同一请求内只有 fetch 的 `basic → scrape` 一档降级 + 同档瞬时故障重试。

| 上游结果 | 动作 |
|---|---|
| 搜索成功且非空 | 直接返回 |
| 搜索成功但 0 条 | 报 `empty` 错误（不会静默返回空列表） |
| fetch `readpage/basic` 失败且开了 `scrape` | 继续尝试 `readpage/scrape` |
| `408` / `5xx` / 网络错误（`transient`、`network`） | 同档重试 1 次（`CLEVERSEE_FETCH_RETRIES`），仍失败才换档 |
| `401/403`（凭据未激活等） | 直接报 `auth`，不重试 |
| `402` 余额不足 / `429` 限流 / `5xx` / 超时 / 网络错误 | 报对应 kind；计入熔断 |
| 目标网页 404/403（`ReadPage.SecurityRestrict` 等） | 报 `target`；**不计入**熔断、不重试 |
| `basic` 返回反爬中间页（`Please wait` / `Just a moment` / 无标题且正文极短） | 按 `empty` 处理并提示开 `scrape`；开了则自动升级到 `scrape` |
| 本地限速排队超时 | 报 `local-throttle`；**不计入**熔断 |

> `data.statusCode = 408` 是上游对「单页渲染超出 `pageTimeout`」的表达，与目标站真实 408 无法区分，统一按 `transient` 重试。

- **熔断**：同一 provider 同一能力（fetch 按 basic/scrape 分开）连续失败 3 次 → open 120s，之后 half-open 放一个探针。只统计上游自身故障；`target`、`local-throttle`、`invalid` 不计入。
- **限速**：搜索 10 QPS、ReadPage 5 QPS；排队超过 1.5s 直接失败（`local-throttle`）。

## 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `CLEVERSEE_API_KEY` | — | 阿里云 CleverSee API Key（必填） |
| `CLEVERSEE_ENGINE` | `CNLiteBasic` | 引擎档位 |
| `CLEVERSEE_ALLOW_PRIVATE` | `0` | 置 1 允许抓取私网/回环地址 |
| `CLEVERSEE_CACHE_TTL` | `600` | fetch 缓存秒数，0 关闭 |
| `CLEVERSEE_CACHE_MAX` | `100` | 缓存条数上限 |
| `CLEVERSEE_QPS` | `10` | 搜索限速 |
| `CLEVERSEE_READPAGE_QPS` | `5` | ReadPage 限速 |
| `CLEVERSEE_SEARCH_TIMEOUT_MS` | `15000` | 搜索超时 |
| `CLEVERSEE_READPAGE_TIMEOUT_MS` | `pageTimeout + 5000` | 本地 HTTP 超时（须大于 `pageTimeout`） |
| `CLEVERSEE_PAGE_TIMEOUT_MS` | `20000` | 上游单页渲染预算；慢站（实测 6.7–18.5s）需调高，超时表现为 `statusCode=408` |
| `CLEVERSEE_SCRAPE_TIMEOUT_MS` | `max(30000, pageTimeout + 10000)` | Scrape 本地超时 |
| `CLEVERSEE_FETCH_RETRIES` | `1` | 同档瞬时故障重试次数（0–3） |
| `CLEVERSEE_FETCH_RETRY_BACKOFF_MS` | `400` | 重试退避基数（按第 n 次线性递增） |
| `CLEVERSEE_SUMMARY` | `0` | 置 1 开启 CleverSee 增强摘要（+2.8 元/千次） |
| `CLEVERSEE_SCRAPE` | `0` | 置 1 让 fetch 默认带 Scrape 兜底 |
| `CLEVERSEE_READPAGE_MAX_AGE` | `0` | ReadPage 服务端缓存秒数，0 表示不使用 |
| `CLEVERSEE_BREAKER_THRESHOLD` | `3` | 熔断失败阈值 |
| `CLEVERSEE_BREAKER_COOLDOWN_MS` | `120000` | 熔断冷却时间 |
| `CLEVERSEE_LIMITER_MAX_WAIT_MS` | `1500` | 限速最大排队时间 |
| `CLEVERSEE_DEBUG` | `0` | 置 1 输出每次调用的结构化日志（不含 query/URL/Key） |
| `CLEVERSEE_BASE_URL` | `https://cloud-iqs.aliyuncs.com` | 仅调试用 |

## 安全

- 凭据只从环境变量读取；任何输出、日志、错误信息都不包含 Key。
- 日志只记录 provider / 能力 / 结果 / 耗时 / 字符数，不记录 query 原文、URL 正文。
- Fetch 默认拒绝 `localhost`、回环、私网、链路本地与 `metadata.google.internal`；拒绝 URL 内嵌凭据；只允许 http/https。
- 不写文件、不起监听端口、不落盘缓存。

## 已知限制

- **没有 query 操作符**：`site:` / `after:` / `-site:` / `lang:` 不适用，请用 `include_domains` / `exclude_domains` / `recency`（`CNAuto`、`Generic` 等引擎不支持站点过滤，会返回 warning 并忽略）。
- **单上游无兜底**：CleverSee 不可用时直接失败，没有第二家可切。
- 返回条数受引擎上限约束（见上表）。
- `ReadPageScrape` 平均耗时可达 30s，默认关闭；Cloudflare 挑战站（openai.com 等）在 `basic` 下恒为 403，必须显式开 `scrape`。
- 不做重定向语义校验：301 到别的页面（如首页）只告警，不报错——正文可能是别的页面。
- 反爬中间页识别是启发式（关键词 + 无标题短正文），不保证覆盖所有厂商的挑战页。
- 不提供代理、cookie、PDF/YouTube 专项抓取。
- 不做模型内置搜索（`enable_search` / Responses `web_search`），只暴露独立 API 能力。
- 账号余额、配额、数据合规与计费由使用者与阿里云之间解决，与本项目无关。

## 开发

```bash
git clone https://github.com/Dowanw0w/alibaba-cleversee.git
cd alibaba-cleversee
node --test test/*.test.mjs                                  # 离线测试，无网络
CLEVERSEE_LIVE=1 node --test test/live.test.mjs              # 真实 API 联调（需 key）
```

离线用例覆盖参数/响应映射、错误分类、空结果、429/5xx/超时、熔断半开、ReadPage basic→scrape 链、缓存、URL 校验、引擎档位透传、扩展注册与格式化。

## License

[MIT](./LICENSE) © 2026 Dowanw0w
