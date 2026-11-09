# AI-HANDOFF · 内嵌 WebUI 改造交接与审查指南

> **本文档面向后续接手/审查本代码库的 AI 编程代理(或人类工程师)。**
> 由上一轮 AI 改造会话生成,自包含、无需原始对话上下文。
> 审查者请先完整阅读本文档,再按 §7 复现验证、按 §8 逐项审查。
> 上游项目:[youkum/Microsoft-Rewards-Script](https://github.com/youkum/Microsoft-Rewards-Script) `V4-china` 分支(GPL-3.0-or-later)。

---

## 1. 改造任务(用户需求原文)

1. 「将 web 控制面板内嵌,可以直接在 web 上面进行所有操作」
2. 「添加刷取积分账号」(网页端增删改账号)
3. 「查看积分获取情况」
4. 「给这个项目加上代理 IP 的功能防止封号」

**范围约束**:机器人本体 TypeScript 仅改一处(`src/util/Load.ts`),其余改动全部位于免编译的 `scripts/api/` 与文档/配置;所有原有 HTTP 端点语义保持不变(旧外部面板 rewards-dashboard 完全兼容)。

## 2. 需求 → 实现映射

| 需求 | 实现 | 关键文件 |
| --- | --- | --- |
| 内嵌面板 | 控制 API 直接静态托管原生 JS 单页应用(无构建、无 CDN),登录 + 7 个功能页 | `scripts/api/web/*`、`server.js` |
| 网页操作全部能力 | 启停/重启(全部/单账号)、日志 SSE、调度编辑、配置编辑、会话与诊断(均对接既有端点) | `web/app.js` |
| 网页添加账号 | 账号 CRUD API,写入 `config/accounts.env`;与 `.env` 按**槽位块级合并**(网页优先);机器人侧叠加读取 | `envStore.js`、`accounts.js`、`src/util/Load.ts` |
| 查看积分 | 每次运行结束持久化到 `config/points-history.jsonl`,新增聚合端点;面板含 SVG 柱状图 | `pointsHistory.js`、`server.js`、`web/app.js` |
| 代理防封 | 每账号代理配置可视化(浏览器+查询源同源出口),新增代理连通性测试(出口 IP/国家/延迟) | `proxyTester.js`、`envStore.js`、`web/app.js` |

## 3. 文件变更清单

### 3.1 新增(8 个)

| 文件 | 职责 |
| --- | --- |
| `scripts/api/envStore.js` | `.env`/`accounts.env` 解析(格式兼容 `lib.js loadEnvFile` 与 `Load.ts`)、槽位块级合并读取、账号增删改(原子写+首次写 `.bak` 备份)、字段校验(邮箱/TOTP Base32/代理协议白名单/端口/BCP 47) |
| `scripts/api/proxyTester.js` | 经代理请求 IP 回显服务(`https-proxy-agent`/`socks-proxy-agent`),返回出口 IP/国家/延迟;SOCKS 认证按浏览器限制拒绝;硬超时保护 |
| `scripts/api/pointsHistory.js` | JSONL 追加(5MB 轮转)与按天/按账号聚合查询 |
| `scripts/api/envStore.test.js` | envStore 单元测试(合并语义、增删改、校验、槽位分配) |
| `scripts/api/pointsHistory.test.js` | pointsHistory 单元测试(聚合、过滤、轮转、坏行容错) |
| `scripts/api/web/index.html` | 面板外壳 |
| `scripts/api/web/app.js` | 全部前端逻辑(hash 路由、`h()` DOM 构建、SSE、7 个视图)。**渲染只用文本节点,`h()` 的 `html` 键分支从未使用** |
| `scripts/api/web/style.css`、`web/favicon.svg` | 样式与图标 |

### 3.2 修改(9 个)

| 文件 | 改动概要 |
| --- | --- |
| `scripts/api/server.js` | ①静态文件服务(白名单 Map,无目录穿越);②会话认证(`POST /auth/login|logout`、`GET /auth/me`,HMAC Cookie,登录限流 10 次/15 分钟);③全局鉴权改造(`authVia`: token/session/open)与 CSRF 头校验;④账号 CRUD + 代理测试 + `/points/history` 端点;⑤`pm.on('exit')` 持久化运行记录;⑥启动日志与索引更新 |
| `scripts/api/accounts.js` | 默认 env 源改为 `getMergedAccountEnv()`(合并 `.env` + `accounts.env`);`loadAccounts` 增加 `hasPassword`/`saveFingerprint`/`proxy.http` 字段(只增不改) |
| `src/util/Load.ts` | `ensureEnvLoaded()` 末尾新增 `applyAccountsEnvOverlay()`:读取 `config/accounts.env`,按槽位**整槽替换** `process.env` 中的 `ACCOUNT_*` 键。其余逻辑未动 |
| `compose.yaml` | `API_MODE: 'true'`、`ports: '8890:3010'`、`API_ALLOW_ACCOUNT_WRITE: 'true'` 默认开启;注释更新 |
| `env.example` | 面板登录、`API_ALLOW_ACCOUNT_WRITE`、`API_TOKEN` 说明重组 |
| `package.json` | 依赖 +`https-proxy-agent@^7`、`+socks-proxy-agent@^8`;脚本 +`test:api` |
| `README.md` | Docker 第 5 步改为内嵌面板;「控制 API 与面板」章节重写;特性列表更新 |
| `CHANGELOG.md` | 新增 2026-11-07 条目 |
| `AGENT.md`、`CLAUDE.md` | 各加一段指向本文档的指引(内容未改) |
| `scripts/api/README.md` | 新增「Embedded WebUI and account management」章节(会话认证、账号 CRUD、`GET /points/history` 文档) |

### 3.3 未动但审查时需对照的文件

- `scripts/api/processManager.js` / `logParser.js` — 运行状态与日志解析,**未改动**;持久化通过既有 `exit` 事件在 server.js 侧完成。
- `scripts/api/lib.js`、`../env.js` — env 解析约定(节选格式语义在 envStore 中有镜像实现)。
- `src/util/Proxy.ts` — `BROWSER_PROXY_PROTOCOLS` 在 envStore.js 中被镜像为 JS 常量(scripts 无法 import TS),**两处需同步维护**。
- `CLAUDE.md`/`AGENT.md`/`VIBECODING.md`/`.cursorrules` — 上游 AI 协作约定,§6 不变量摘自其中。

## 4. 架构与数据流

```
浏览器 ──(Cookie 会话 或 API_TOKEN)──▶ server.js (:3010, Docker 映射 8890)
                                          │
              ┌───────────────────────────┼──────────────────────────────┐
        静态: web/ 白名单文件        数据端点(既有,语义不变)          新增端点
                                    /status /points /logs /events    /auth/login|logout|me
                                    /config* /schedule* /sessions*   POST|PATCH|DELETE /accounts[/:index]
                                    /start /stop /restart /shutdown  POST /accounts/:index/proxy-test
                                    /history /diagnostics            GET  /points/history
                                          │
                                     ProcessManager(未改)
                                          │ spawn node dist/index.js
                                          ▼
                                    机器人(Load.ts)
                              .env ──叠加──▶ config/accounts.env(槽位块级替换)
                                          │
                              运行结束 exit 事件 ▶ pointsHistory.js ▶ config/points-history.jsonl
```

**账号双源合并语义(核心)**:源优先级 `config/accounts.env` > `.env`;以**槽位**(ACCOUNT_N_*)为单位整槽替换,不做字段级混合;编号不要求连续。API 侧(`envStore.getMergedAccountEnv`)与机器人侧(`Load.ts applyAccountsEnvOverlay`)实现同一语义。

## 5. 关键设计决策(审查重点)

| # | 决策 | 理由 | 审查关注点 |
| --- | --- | --- | --- |
| D1 | 面板内嵌进控制 API 进程,而非移植外部 React 面板 | 外部面板无账号 CRUD/代理测试能力;引入构建链维护成本高;单端口单容器符合用户「内嵌」诉求 | web/app.js 体量(~840 行)与可维护性;无框架的手写 DOM 是否可接受 |
| D2 | 账号写入独立文件 `config/accounts.env`,不改写 `.env` | `.env` 是用户手工域(Docker `env_file` 在容器启动时读取,容器内无此文件);`config/` 在 Docker 已挂载持久化 | 合并语义是否可能产生槽位歧义;`findEnvFile` 顺序(projectRoot 优先,cwd 兜底)与 `Load.ts`(cwd 优先)在 cwd≠root 时理论不一致——实际部署 cwd==root,已在代码注释说明 |
| D3 | 会话认证 + 保留 API_TOKEN;Cookie 写操作要求 `X-Requested-With` | 兼容旧工具;CSRF 防御(依赖自定义头 + SameSite=Lax + JSON Content-Type) | **open 模式**(TOKEN 与 DASHBOARD_PASSWORD 均未设置)下鉴权完全放开(维持上游行为,仅限回环默认绑定);登录限流按 socket 地址,反向代理后所有客户端共享限额 |
| D4 | 会话密钥:`DASHBOARD_SESSION_SECRET` > `API_TOKEN` > 持久化随机值(`config/.session-secret`) | 重启后会话不失效;无凭据时也可用 | 密钥文件权限(mode 0600,Windows 上等效性有限) |
| D5 | 代理测试用 `https-proxy-agent`+`socks-proxy-agent` 而非复用 impit | 与 `BROWSER_PROXY_PROTOCOLS` 对齐;SOCKS 认证被显式拒绝(与 Patchright 行为一致);硬超时(请求 timeout 之外再套 `withHardTimeout`) | TLS 校验对测试请求关闭(`rejectUnauthorized:false`)——仅用于连通性探测,不处理敏感数据 |
| D6 | 积分历史 JSONL 追加 + 5MB 轮转,置于 `config/` | Docker 挂载目录,升级重建不丢 | 记录含账号邮箱与错误文本(敏感级别与日志一致);无并发写(单进程) |
| D7 | `.env` 账号在面板中只读(source 标识) | 避免 WebUI 静默改写用户手工文件;职责清晰 | UX 代价:用户需手动同步 `.env` 账号 |

## 6. 不变量(上游 AI 协作文档要求,本次改造必须未破坏)

1. **日志关键字 `FLOW` / `RUN-END` 等解析关键字不得改动** —— 未改 `logParser.js`/机器人日志输出;server.js 侧仅消费。
2. **积分 API 字段结构保持** —— `toHistoryRecord` 仅**新增** `totals` 与 `accounts[].balance` 字段(加法);`GET /accounts` 响应仅新增 `hasPassword`/`saveFingerprint`/`proxy.http`/`source`/`webManaged`/`accountsEnvPath`。
3. **既有端点语义不变** —— 全部保留原路径/方法/状态码;写能力仍受 `API_ALLOW_CONFIG_WRITE`/`API_ALLOW_SCHEDULE_WRITE`/`API_ALLOW_ENV_OVERRIDES` 独立开关控制(默认不变);新增 `API_ALLOW_ACCOUNT_WRITE`(默认 true)。
4. **登录/调度/会话存储机制未动** —— `processManager.js`、`scheduleStore.js`、`sessionStore.js`、`configEditor.js` 零改动。

## 7. 构建与验证步骤(可复现)

> 前置:Node.js ≥ 24(本工作区用 v24.10.0 便携版)。`scripts/api` 全部为纯 JS,只有 `npm run build`(tsc)需要 devDependencies。

```bash
# 0) 运行时配置(仓库不含 config.json,由 example 复制)
#    Windows: copy config.example.json config.json   Linux/macOS: cp config.example.json config.json
cp config.example.json config.json

# 1) 安装与构建
npm install
npm run build            # rimraf dist && tsc && copyAssets —— 必须零错误

# 2) 单元测试(19 个用例)
node --test scripts/api/envStore.test.js scripts/api/pointsHistory.test.js scripts/api/logParser.test.js
# 期望:tests 19 / pass 19 / fail 0

# 3) lint(仅本次新增/改动文件;上游现有文件存在历史告警,不在本次范围)
npx eslint scripts/api/envStore.js scripts/api/pointsHistory.js scripts/api/proxyTester.js scripts/api/accounts.js scripts/api/server.js

# 4) API 冒烟(准备 .env:见 env.example;必须设置 DASHBOARD_PASSWORD)
npm run api              # 默认 127.0.0.1:3010;启动日志应含 "(WebUI: http://...)" 与账号写入开关状态

curl -s http://127.0.0.1:3010/health            # {"ok":true,...,"authRequired":true}
curl -s http://127.0.0.1:3010/auth/me           # authenticated:false + capabilities
curl -s -i -X POST -H "content-type: application/json" \
     -d '{"username":"admin","password":"<你的密码>"}' http://127.0.0.1:3010/auth/login
# → 200 + Set-Cookie: mrs_dashboard=...(HttpOnly; SameSite=Lax)
# 用 -c cookies.txt 保存后:
curl -s -b cookies.txt http://127.0.0.1:3010/accounts
curl -s -b cookies.txt -X POST -H "content-type: application/json" \
     -H "x-requested-with: XMLHttpRequest" \
     -d '{"email":"t1@example.com","password":"pw","proxy":{"url":"http://203.0.113.9:8080"}}' \
     http://127.0.0.1:3010/accounts              # 201 → 检查 config/accounts.env
# CSRF 负例:同请求去掉 x-requested-with 头 → 403 CSRF
# .env 账号删除负例:DELETE /accounts/<env槽位> → 409 NOT_WEB_MANAGED

# 5) 浏览器走查
# 打开 http://127.0.0.1:3010/ → 登录 → 总览(SSE 徽标变绿)→ 账号管理(新增弹窗/代理测试)
# → 积分历史 → 实时日志 → 调度(未开写开关时保存按钮禁用并提示)→ 配置 → 会话与诊断
```

本工作区已完成上述全部步骤(含假账号运行冒烟:启动→日志流→停止→`points-history.jsonl` 落盘),证据见交付包 `evidence/` 截图。

## 8. 审查清单(逐项核对)

**正确性**
- [ ] `envStore.js`:`loadAccountPairs` 块级合并是否可能丢槽位(注意:`.env` 中**空值键**如 `ACCOUNT_2_EMAIL=` 会被 `accountIndexesFromEnv` 过滤,两侧行为一致?)
- [ ] `envStore.js` `quoteValue`:含空格/引号值写入带双引号,读取端(`lib.js`/`Load.ts`)剥引号——特殊值(`#`、尾随空格、`"`)往返是否无损(参考 envStore.test.js)
- [ ] `updateAccount` 的「未提供字段保留、空串清除」语义与前端弹窗(编辑时密码留空=保持)是否一致
- [ ] `server.js` `authVia`:TOKEN 设置时 session-only 请求是否正确放行/拒绝;`/events` SSE 的 `?token=` 仅对 /events 生效(上游逻辑未动)
- [ ] `serveStatic`:白名单 Map,确认无路径拼接注入;`/diagnostics/` 路径校验未放松
- [ ] `proxyTester.js`:SOCKS+认证拒绝、硬超时、回显服务不可达时的降级链(ip-api.com → ipify)
- [ ] `Load.ts` `applyAccountsEnvOverlay`:整槽删除+覆写;对 `getAccountIndexes()`(正则 `ACCOUNT_(\d+)_EMAIL`)的影响
- [ ] 前端 XSS:全部渲染走 `createTextNode`;`esc()` 用于字符串插值处;`h()` 的 `html` 分支零使用(可考虑删除)

**安全**
- [ ] open 模式(无凭据)下账号写入仍可用——是否接受(回环默认 + 启动 ERROR/WARN 日志)
- [ ] 会话 Cookie 未设 `Secure`(本设计面向 HTTP 局域网);反向代理部署时审查者应建议在代理层加 TLS
- [ ] 登录限流的 IP 键在反代后的共享问题(见 D3)
- [ ] `/points/history`、`/accounts` 输出含邮箱与错误详情——与上游日志端点敏感级别一致,确认可接受

**兼容**
- [ ] 对旧 rewards-dashboard:响应只增字段,语义未变(可对照 `scripts/api/README.md` 上游章节)
- [ ] `package-lock.json` 仅新增 https-proxy-agent / socks-proxy-agent 依赖树
- [ ] `compose.yaml`:`8890:3010` 映射与 entrypoint(`API_HOST=0.0.0.0`)匹配;`API_ALLOW_ACCOUNT_WRITE` 默认开启已注明

## 9. 已知限制与未验证项(如实声明)

1. **未用真实 Microsoft 账号验证**——机器人主流程(登录/搜索/积分)未动,但端到端积分入账无法在本环境确认。
2. **Docker 构建未在本机执行**(环境无 Docker);仅静态核对 compose/entrypoint 逻辑。
3. 代理测试依赖公网回显服务(`ip-api.com`/`ipify`),被测网络阻断二者时返回错误而非误报成功。
4. 面板 UI 文案仅中文;`humanize.quietHours` 等少数配置项仍需 JSON 模式编辑(面板 JSON 编辑器需 `API_ALLOW_CONFIG_REVEAL=true`)。
5. 本工作区 `.env` 为**测试凭据**(admin/test123456 与 example.com 假账号),交付包已排除 `.env`。
6. eslint 检查仅覆盖本次新增/改动文件;上游既有文件的历史 lint 状态未处理。

## 10. 回滚方式

- 所有改动均为文件级,未改数据库/全局状态;将 §3.1 新增文件删除、§3.2 修改文件对照原始源码还原即可。
- 原始未改动的 `V4-china` 源码快照见交付包 `original-V4-china.zip`;逐文件差异见 `unified.diff`(由脚本生成,`\r\n` 已归一化为 `\n` 后对比)。

— 生成于 2026-11-07,由上一轮 AI 改造会话(ZCode / GLM)出具
