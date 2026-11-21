# AI-HANDOFF · 当前实现交接与审查指南

本文面向接手或审查本仓库的工程师与 AI 编程代理，无需原始对话上下文。包括 2026-11-19 积分接口/独立登录与 2026-11-21 设置/累计统计持久化修复；早期 WebUI 改造记录见 Git 历史及 [更新日志](CHANGELOG.md)。仓库为 [youkum/Microsoft-Rewards-Script](https://github.com/youkum/Microsoft-Rewards-Script) 的 `V4-china` 分支，许可为 GPL-3.0-or-later，派生关系见 [第三方声明](THIRD-PARTY-NOTICES.md)。

## 1. 当前范围与入口

内嵌 WebUI 提供账号管理、代理测试、任务控制、交互日志、积分历史、通知预测、调度与会话诊断。常规任务负责执行积分活动；独立登录负责单账号认证和按平台保存会话。两种运行共用进程管理器，统计与通知分开处理。

| 模块         | 关键文件与职责                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| 运行入口     | `src/index.ts`：账号/集群调度、账号状态重置、`saveLoginOnly()`、任务结算与通知                                      |
| 积分数据     | `src/browser/BrowserFunc.ts`、`FlyoutDashboard.ts`：区域数据读取、映射、余额探测与会话 checkpoint                   |
| 类型与域名   | `src/interface/DashboardData.ts`、`Points.ts`、`src/constants/urls.ts`：数据可信度与区域 URL                        |
| 登录认证     | `src/browser/auth/Login.ts` 及 `methods/`：状态机、安全邮箱/验证码交互、上游会话验证                                |
| 账号配置     | `src/util/Load.ts`、`scripts/credentialEnv.cjs`、`scripts/api/envStore.js`、`accounts.js`：凭据解析、槽位合并与筛选 |
| API/运行管理 | `scripts/api/server.js`、`processManager.js`：鉴权、维护入口、子进程生命周期与运行锁                                |
| 积分展示     | `scripts/api/logParser.js`、`pointsHistory.js`、`scripts/rewardForecast.cjs`：实时增量、持久历史和预测              |
| 前端         | `scripts/api/web/`：原生 ES modules，无独立构建；新模块需加入静态资源白名单                                         |
| 部署         | `compose.yaml`、`compose.override.yaml`、两个 Dockerfile、`scripts/docker/entrypoint.sh`：API/cron 与持久目录       |

## 2. 区域接口与数据可信度

`getDashboardData()` 的实际顺序：

1. 配置的 HTTP 客户端请求区域 Flyout。
2. 同一区域 Flyout，经浏览器 `page.request.get` 共享 Cookie 请求。
3. 旧 `rewards.bing.com/api/getuserinfo`：同账号尚未失败时最多尝试两次；失败后跳过旧接口，下一账号重置。
4. 本地兼容对象，余额、搜索、活动数据明确标记为未核实。

CN 使用 `cn.bing.com`，其他地区使用 `www.bing.com`。请求 Cookie 按目标 URL 过滤，Referer、Origin 及登录回跳域名保持一致。浏览器备用请求采用 `page.request`，避免页面跨域 Fetch 的 CORS 问题。

余额读取另外可以探测浏览器 Flyout、DOM 文本与 React 快照，不应将它们写成完整 Dashboard 的统一六级流水线。余额可读不代表任务列表或配额可用。

- `DashboardData.dataQuality` 标记 `source`、`balance`、`search`、`activities`。
- `AccountAllPointsSummary.balanceVerified` 表示汇总余额是否核实。
- 缺失额度或活动列表不能当作完成的 `0/0`。依赖该数据的任务必须受控报错。
- 未知起始或最终余额不能结算成功收益。搜索额度增长和签到 HTTP 200 不单独证明入账。
- 每账号重置余额、活动上下文与降级状态，避免跨账号污染。

## 3. 单账号保存登录会话

面板“账号管理”的 **保存登录会话** 调用 `POST /accounts/:index/login`。请求体的 `platform` 支持 `mobile`、`desktop`、`both`（默认，手机端先行）。返回 202，包含 `mode: "login"`、平台与所选账号；无效平台返回 400，已有运行返回 409。完整契约见 [API 文档](scripts/api/README.md#post-accountsindexlogin)。

`buildSingleAccountEnv()` 只选择一个配置账号，并设置 `ACCOUNTS_FILTERED`；通过 `REWARDS_LOGIN_ONLY` 进入维护分支。使用已有账号的密码、代理和指纹，先尝试复用会话，安全邮箱/验证码继续通过实时日志页输入。

维护调用 `login(page, account, true)`，手机端和电脑端都必须通过上游认证余额及搜索额度验证才能保存。每端立即保存并 checkpoint；失败不保存未核实会话，浏览器失败清理不覆盖旧会话。部分平台已成功保存、后续平台失败时，应如实显示结果。

仅登录跳过 Rewards 活动上下文初始化、奖励 workers、App 活动令牌、每日/静默时间跳过规则和任务通知。成功或失败均显式退出，释放面板运行锁。

`ProcessManager` 在第一条日志前标记 `mode: "login"`，包括早期失败。`GET /history` 保留维护运行；`GET /points/history`、账号运行战绩、收益与预测样本排除维护运行。该端点使用运行控制权限和既有配置，不受账号增删改写入开关限制。

## 4. 账号、鉴权与调度契约

- `config/accounts.env` 优先于 `.env`，按 `ACCOUNT_N_*` 整槽替换，不按字段混合；编号可不连续。API 与机器人使用一致语义，筛选运行禁止重新载入全量账号。
- WebUI 写入 `config/accounts.env`，不改写 `.env`。未被 Web 配置覆盖的基础槽位显示为 `.env` 来源，编辑/删除返回 `NOT_WEB_MANAGED`；不要承诺所有基础账号可直接编辑。
- 凭据文件按数据解析，禁止 Shell `source`、`.`、`eval`。特殊字符与 JSON 双引号转义的兼容要求见 [升级指南](UPGRADE_GUIDE.md#41-凭据文件解析已变更禁止-shell-source)。编辑时空白凭据保留旧值，清除需明确操作。
- API Token 与面板 HMAC/HttpOnly Cookie 认证并存，Cookie 写操作要求 `X-Requested-With`。`/events` 可使用查询参数 token，其余端点不接受该方式。未配置两种凭据时原生 API 可进入 open 模式；默认 Compose 要求 Token，并应配置面板密码。
- Docker 宿主机默认绑定 `127.0.0.1:8890`；容器内为 `0.0.0.0:3010`。远程访问按升级指南使用 SSH 隧道。
- 账号、行为配置、调度及环境覆盖写入开关独立；默认 Compose 会合并 override，当前禁用 `API_ALLOW_ENV_OVERRIDES`。
- 生产调度持久化并应用 Linux cron；失败恢复旧文件并尝试恢复旧 cron。预览仅保存临时演示计划。已保存的计划优先于初始环境，维护前显式停用它。
- 会话与配置仍可能明文存储。POSIX 权限限制不代表应用加密；Windows 需检查 NTFS ACL。不得发布运行凭据或私有证据。

## 5. 日志、历史与前端契约

保持 `FLOW`、`ACCOUNT-START`、`RUN-END`、`POINTS-ALL` 等解析标记。改日志时同步 `logParser.js` 与测试。DEBUG 活动响应只作诊断；INFO 增量与阅读/搜索累计汇总按同账号、平台、来源补足差额，不能双计。

API 管理的运行结束后，`runHistory.js` 原子保存 `config/run-history.json`：最近记录有数量上限，账号累计统计独立保存；`/history` 跨重启恢复且 `inMemoryOnly: false`，`/accounts` 标记 `statsScope: "lifetime"`。首次从现存积分 JSONL 及 `.1` 导入任务记录，使用时间水位和同时间运行标识去重；后续报表轮转不清零累计。`.bak` 支持恢复，双方损坏时拒绝无声重置。仅登录进入最近运行记录，排除累计收益和账号统计。

积分任务另外追加 `config/points-history.jsonl`，约 5 MB 轮转；直接 `npm start` 不负责 API 持久历史。实时日志及未结束任务仍为内存状态。配置写入共用 `scripts/atomicFile.cjs`，必须解析符号链接真实目标后替换；新 Dockerfile 需携带该模块。旧容器重建前保留根目录活动配置与挂载目录，避免遗漏旧版本写入容器层的最新设置，见升级指南。未知余额及不足样本不能产生确定的兑换预测。

前端用文本节点构建内容，保持静态资源白名单、配置脱敏、凭据保留/清除语义、SSE 合并与刷新取消。保存通知设置和摘要预览不发送消息；真实通知送达需要独立验证。

## 6. 可复现验证与已验证范围

使用 Node.js 24，在目标提交干净检出中执行：

```bash
npm ci --include=optional --ignore-scripts
npm run build
npm test
npm run test:log-parser
npm run test:performance
npm run test:preview
npm run test:platform:lock
npm run lint
npm run format:check
```

需要本地浏览器运行时安装 `npm run install:browser`；Docker 按各 Dockerfile 安装对应浏览器与原生依赖。使用 `npm run preview` 验证模拟面板，不输入真实凭据。具体测试职责和跨架构检查见 [开发指南](DEVELOPMENT.md) 与 [验收指南](CODEX_INSPECTION_GUIDE.md)。

2026-11-19 源码修复验证记录：构建通过，核心/API/WebUI 105 项、性能 8 项、预览 5 项通过；日志解析器 11 项包含在 105 项中。全仓 ESLint 为 0 错误、3 个既有 `any` 警告，已跟踪且支持的文件格式检查通过。测试数量是该次记录，后续以目标提交实际结果为准。文档修订只需格式、链接及源码一致性检查。

修复提交 `bfb2bcd` 的 [CI](https://github.com/youkum/Microsoft-Rewards-Script/actions/runs/44448717681) 已全部通过，包含 validate 与两架构 × 两 Dockerfile 的四个原生容器任务。后续发布需重新核对目标提交。

部署环境完成 Docker 构建、健康检查，已保存会话的上游余额/额度读取通过；实测部分每日/推广/阅读活动入账，面板实际检查限于账号管理与登录交互。未据此确认完整 UI 视觉验收、通知送达或全部活动。分支源码更新、部署和正式 tag/Release 是不同状态，详见 [本次更新说明](RELEASE_NOTES_20261119.md)。

`scripts/api/rewardsData.test.js` 覆盖区域 Cookie、数据可信度、账号重置、严格保存与退出；HTTP/UI 测试覆盖账号过滤、平台校验、按钮及维护统计隔离。部分核心回归是源码契约检查，不能代替真实上游响应验证。账号、日志、会话与截图仅存私有记录，不属于分发产物。

## 7. 审查与后续修改

- 按 [验收指南](CODEX_INSPECTION_GUIDE.md) 检查未知数据、重复累计、账号隔离、维护运行退出与历史隔离。
- 核对 API 文档、按钮文案、平台默认值、状态码、区域域名及降级顺序一致。
- 行为改动同步 `CHANGELOG.md`、README、API 文档和相关工程/代理指导文件；正式发布核验相同提交 CI、tag 与镜像 revision。
- 升级或回滚先停止写入，保留旧源码、镜像及匹配的配置/完整会话快照；按 [升级与回滚指南](UPGRADE_GUIDE.md) 操作，不通过删除会话或数据卷解决问题。
