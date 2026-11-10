# 更新日志 (CHANGELOG)

> 🤖 **项目维护声明**：此项目由 **AI 全面接手二次开发**，人工只提供了开发建议和提示词优化。专为 Vibe-Coding（人机协同、AI 辅助编程）设计与维护。

---

## [2026-11-10] - WebUI 交互式控制台、安全验证码/邮箱实时交互与行为配置/调度 API 开放

### 💻 交互式控制台与安全验证交互
1. **进程标准输入管道打通 (`stdio: pipe`)**：重构 `processManager.js` 中的子进程派发模式，将子进程的输入流 `stdin` 由静默丢弃模式改为管道接入模式（`stdio: ['pipe', 'pipe', 'pipe']`），支持通过 WebUI 将用户输入无损传输至正在执行登录与任务的机器人后台子进程。
2. **结构化交互信号协议与超时延长**：在 `LoginUtils.ts`、`GetACodeLogin.ts`、`RecoveryEmailLogin.ts`、`Totp2FALogin.ts` 等认证模块中引入结构化控制台标记 `__PROMPT_REQUEST__:` 与 `__PROMPT_RESOLVED__`；优化 `canPromptForInput()` 判定逻辑，在 Docker/API 模式下全面解禁交互输入（等待时长由 60 秒延长至 180 秒），支持从命令行与 Web 页面双向响应。
3. **Web 端交互式验证卡片与控制台输入条**：
   - 顶部实时悬浮发光交互卡片：当后台检测到需要输入验证码、安全验证邮箱或 TOTP 时，网页端通过 SSE `status` 实时弹出高亮验证提示框，支持一键填入并即时回传。
   - 实时日志底部集成终端输入栏：在「实时日志」底部增加全功能终端输入条，方便运维排查与手动向子进程发送指令。
4. **中文登录方法识别增强**：在 `Login.ts` 的 `classifySignInMethod` 中增加对中文提示语（如“将代码发送到 <email>”）的解析支持，实现与官方微软登录界面的本地化无缝适配。

### ⚙️ 行为控制与调度写权限全面解禁
1. **启用行为配置与调度写入 API**：在 `compose.yaml` 与 `compose.override.yaml` 中将 `API_ALLOW_CONFIG_WRITE`、`API_ALLOW_CONFIG_REVEAL`、`API_ALLOW_SCHEDULE_WRITE` 设为 `true`，解除 WebUI 中「行为配置」和「运行调度」的编辑锁定状态，用户可直接在浏览器端自定义任务规则与 Cron 调度。

---

## [2026-11-10] - 修复登录状态机死锁与错误提示吞没，支持快速熔断与致命错误提取

### 🛡️ 登录状态机与错误处理优化
1. **彻底解决 `EMAIL_INPUT` 掩盖 `ERROR_ALERT` 的死循环死锁**：修复 `Login.ts` 中当页面同时出现错误告警与输入框时盲目剔除 `ERROR_ALERT` 的逻辑缺陷。改用主动探测非空错误容器文本，当检测到微软致命账户错误（如账号不存在、密码错误、账户被锁等）或已提交凭据后的错误提示时，坚决优先保留 `ERROR_ALERT`，杜绝 25 轮（长达 8 分钟）反复提交错误邮箱的死循环。
2. **错误提示实时提取与快速熔断**：在 `Login.ts` 与 `EmailLogin.ts` 中增强对 `#usernameError`、`#passwordError`、`div[role="alert"]` 及常见告警样式的文本抓取与中英文解析，第一时间捕获微软返回的实际原因（如“该 Microsoft 账户不存在 / That Microsoft account doesn't exist”），在 1~2 轮内立即熔断退出并清晰记录至 WebUI 控制台日志，避免浪费算力与时间。
3. **凭据提交状态感知计数**：在 `Login.ts` 状态机中维护 `emailSubmittedCount` 与 `passwordSubmittedCount`，使状态判定具备上下文感知能力，准确区分“初次进入页面的输入”与“提交被拒后的错误呈现”。

---

## [2026-11-09] - GLM 重构版本深度审查与加固优化

### 🛡️ 架构审查与修复
1. **API 内容协商与路由解耦**：优化 `server.js` 中静态 WebUI 路由与 JSON API 发现端点，当客户端通过 `Accept: application/json` 请求 `GET /` 时返回标准 API 索引，浏览器访问时正常托管单页面板，消除死代码。
2. **跨域预检与 CSRF 协同加固**：在全局 CORS `Access-Control-Allow-Headers` 中补充 `X-Requested-With`，确保跨域 Cookie 会话写操作的预检请求正常放行。
3. **积分历史本地时区分组修复**：在 `pointsHistory.js` 中引入基于环境时区（默认 `Asia/Shanghai`）的日期归一化算法，彻底解决 UTC 跨天导致国内清晨 7:00 任务被错误记录到前一天的统计时差问题。
4. **代理协议缺省端口纠偏**：修正 `proxyTester.js` 中 SOCKS4/5 协议在缺省端口时的回退逻辑，由不合常理的 80 端口纠正为标准 SOCKS 端口 1080。
5. **账号编辑唯一性防重校验**：在 `envStore.js` 的 `updateAccount` 方法中补充了针对其他已有槽位的邮箱唯一性冲突检测（`EMAIL_CONFLICT`），杜绝改名时分配重复邮箱。
6. **前端 XSS 免疫强化**：清理了 `scripts/api/web/app.js` 构造器 `h()` 中未使用的 `html` 属性（`innerHTML` 分支），彻底将前端渲染收拢于纯 `document.createTextNode` 与属性白名单。
7. **错误提示与操作引导自洽**：规范化了对 `.env` 基础文件账号的拦截报错文案，清晰指导用户在 `.env` 或 WebUI 中管理不同来源账号。

---

## [2026-11-07] - 内嵌 WebUI 控制面板：网页端账号管理 + 代理测试 + 积分持久化历史

### 🚀 核心更新

#### 1. WebUI 控制面板内嵌（无需再部署外部仪表盘容器）
- **面板直接内嵌进控制 API**（`scripts/api/web/`，原生 JS 单页应用，无构建步骤、无 CDN 依赖）：浏览器打开 `http://<ip>:8890` 即可进行**全部操作**——总览启停/单账号运行、账号管理、积分历史、实时日志（SSE）、调度编辑、行为配置、会话与诊断。
- **面板登录认证**：`POST /auth/login` 使用 `.env` 中的 `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` 签发 HMAC 签名的 HttpOnly 会话 Cookie（默认 7 天）；`API_TOKEN` Bearer 认证保持不变，旧版外部仪表盘完全兼容。Cookie 鉴权的写操作要求 `X-Requested-With` 头（CSRF 防护），登录接口内置 IP 级限流（10 次/15 分钟）。
- `compose.yaml` 默认开启 `API_MODE=true` 并映射 `8890:3010`。

#### 2. 网页端账号增删改（新增 API）
- 新增 `POST /accounts`、`PATCH|DELETE /accounts/:index`：在面板中直接添加/编辑/删除刷积分账号，**写入 `config/accounts.env`**（原子写 + 首次写自动备份 `.bak`），下次运行生效；`GET /accounts` 每条记录带 `source`（`web`/`env`）标识来源，`.env` 手工账号在面板中只读。
- **账号双源合并**：`.env` 与 `config/accounts.env` 按槽位块级合并（后者优先）；机器人侧 `Load.ts` 同步叠加读取 `config/accounts.env`，Docker cron 触发的运行同样能看到网页新增账号。字段校验：邮箱格式、TOTP Base32、代理协议白名单（http/https/socks4/socks5）、端口范围、BCP 47 语言码。

#### 3. 每账号代理可视化配置与连通性测试
- 新增 `POST /accounts/:index/proxy-test`：经该账号代理请求 IP 回显服务，返回**出口 IP / 国家 / 延迟**（支持 http/https/socks4/socks5；SOCKS 认证与浏览器行为一致地被拒绝；硬超时保护）。面板账号列表提供"测代理"按钮与代理徽标。
- 复用既有"每账号固定独立代理"防封模型（浏览器 + 查询源同源出口），面板内附使用建议（住宅/ISP 静态 IP、避免多账号共 IP）。

#### 4. 积分历史持久化
- 新增 `config/points-history.jsonl`：每次运行结束自动追加运行摘要（`pm.on('exit')`），**重启不丢**（原 `/history` 仅内存 20 条）；文件超 5MB 自动轮转。
- 新增 `GET /points/history?days=N`：返回每日聚合、分账号累计与运行明细；面板"积分历史"页提供统计卡片、每日获得柱状图（SVG、离线）与运行记录表。

### 📦 其他
- 依赖新增 `https-proxy-agent`、`socks-proxy-agent`（纯 JS，仅代理测试用）。
- 新增测试：`scripts/api/envStore.test.js`、`scripts/api/pointsHistory.test.js`（`npm run test:api`）；`src/util/Load.ts` 改动已通过 `npm run build` 编译验证。

---

## [2026-11-02] - WebUI 控制面板连通性加固、多账号热更新与中文报表增强

### 🚀 核心更新与修复

#### 1. WebUI 控制面板 (:8890) 连通性与部署修复
- **修复端口绑定阻断**：修复了在部分网络环境或 Docker Compose 配置下，因固定单 IP 绑定（如 `192.168.1.xxx:8890:8890`）或容器网络解绑导致的 `Connection Refused`（无法打开控制面板）问题。规范调整为全接口绑定 `0.0.0.0:8890:8890`。
- **完善 HTTP Basic Auth 认证指引**：明确了 WebUI 控制面板的基础认证配置项（`DASHBOARD_USERNAME` 与 `DASHBOARD_PASSWORD`），避免自动生成 44 位高强度随机秘钥阻断正常浏览器访问，支持与宿主机管理员口令对齐。
- **强化双容器内部网络互联**：完善了主脚本容器 `microsoft-rewards-script`（内置 3010 控制 API 与 SSE 流）与控制面板容器 `rewards-dashboard` 之间的 Docker 桥接通信，确保实时运行状态、控制指令（启动/停止/重启）与日志流 100% 稳定互通。

#### 2. 多账号管理与热替换规范
- **账户无缝切换**：优化了多账号环境变量配置逻辑（`ACCOUNT_1_*` ~ `ACCOUNT_N_*`），支持随时在 `.env` 中更新账号邮箱与密码。
- **旧会话安全清理指引**：在更换或删除账号时，补充了自动化清理 SQLite 会话库（`sessions/sessions.db`）中旧账号记录的操作规范，确保新账号首次登录时能够完整生成新的浏览器上下文、指纹与 Token，杜绝旧凭证干扰。

#### 3. 中文积分报表与日志可读性升级
- **美化版中文积分报表**：在每日任务开始与结束时，生成结构化控制台报表（可用积分余额、历史总积分、用户等级、连胜天数、电脑搜索/移动搜索/每日任务/更多活动/签到完成度），直观清晰。
- **严格契合 WebUI 解析规范**：所有中文日志输出严格遵循 `scripts/api/logParser.js` 正则契约（保留 `FLOW`、`ACCOUNT-START`、`POINTS-ALL` 等核心标签），确保在 WebUI 仪表盘上同步呈现高亮中文日志与指标卡片。

#### 4. 安全与隐私防护
- **零凭证泄露原则**：严格执行 `.gitignore` 规则，真实账号、密码、Cookie、Token 与持久化数据库仅保存在本地/服务器运行时目录中，绝不同步或提交到 GitHub 仓库与通用分发包。

---

## [2026-10-31] - V4-china 国内适配版全面重构

- **六重积分高可用降级体系**：实现 Tier 1 官方 API ➔ Tier 2 Flyout 接口 ➔ Tier 3 上下文 Fetch ➔ Tier 4 DOM 提取 ➔ Tier 5 React Flight 快照 ➔ Tier 6 安全兜底，杜绝因微软页面微调引发的崩溃。
- **自适应现代登录状态机**：新增拦截页（体验无密码/添加安全邮箱等）自适应自动跳过。
- **中国热搜查询词源**：集成百度、头条、抖音、微博、知乎热搜词源及本地题库。
- **多渠道推送集成**：集成 PushPlus 微信推送、ClawBot 官方 iLink 机器人直连。
- **AI / Vibe-Coding 深度适配**：补充全套 `VIBECODING.md` 与 `AGENT.md` 规范。
