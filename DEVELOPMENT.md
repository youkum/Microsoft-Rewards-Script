# 开发、验证与升级

## 平台范围与验证状态

当前容器目标为 Linux x86-64 (`linux/amd64`) 和 ARM64 (`linux/arm64`)，使用 Node.js 24 + Debian Bookworm/glibc。32 位 x86、ARMv7、Alpine/musl 不在这次支持范围内。Windows x64 可以本地构建；ARM64 推荐使用 Linux 容器，本次没有验证 Windows ARM 或 macOS ARM 的原生运行。

两个 Dockerfile 都按目标架构安装 npm optional 原生包，并由锁定版本的 Patchright CLI 安装 Chromium headless shell 和系统库。不要跨架构复制 `node_modules` 或浏览器缓存。

CI 的 `container-smoke` 矩阵在原生 amd64、ARM64 runner 分别构建 `Dockerfile` 和 `Dockerfile.cn`，共四个检查。运行自检时覆盖应用 entrypoint、禁用外网，只访问容器内部回环服务；检查 Node/浏览器 ELF 架构、impit HTTP 请求和 Chromium 页面渲染。自检不读取账号或启动 cron。

2026-11-19 本地 Windows 环境已验证构建、测试、lint 和格式；部署环境完成 Docker 构建与健康检查，并用已保存会话核实上游余额与搜索额度。修复提交 `bfb2bcd` 的 [CI](https://github.com/youkum/Microsoft-Rewards-Script/actions/runs/44448717681) 及四个原生容器任务全部通过，覆盖两架构与两 Dockerfile。后续发布仍需核对目标提交；单一部署环境的运行证据不能替代矩阵检查。

## 日常验证

```bash
npm ci --include=optional --ignore-scripts
npm run build
npm test
npm run test:performance
npm run test:preview
bash scripts/tests/docker-fixtures.sh
npm run lint
npm run format:check
npm run test:platform:lock
npm run benchmark:api
```

格式检查由 `Validate` 和 PR 的 `Formatting Check` 执行；合入 `V4-china` 后，`Formatting Repair` 工作流运行 `npm run format`，有差异时向同一分支创建或更新修复 PR。自动创建 PR 需要在仓库 Actions 设置中允许 GitHub Actions 创建和批准拉取请求。使用默认 `GITHUB_TOKEN` 创建的 PR 不会自动触发其他 PR 工作流，审查前应手动运行 `Validate` 和 `Formatting Check` 并选择修复分支，或推送修复提交触发检查。

`npm test` 自动包含 `scripts/api/*.test.js` 和 `scripts/api/web/*.test.js`。HTTP 合约测试复制代码到临时目录，使用假账号和有限本地 mock 进程。测试不需要真实凭证。

`benchmark:api` 使用 100 个模拟账号、20 次历史记录，先断言优化前后响应相等，再比较中位数。一次 Windows x64 测量约为 22.8ms → 0.39ms；结果随硬件变化，不代表真实账号任务的运行时长。SSE 在线时每 5 秒只请求 `/points`；断线时恢复 `/status` 兜底。刷新控制器保证单个视图无并行刷新，并在退出或路由切换时取消请求和计时器。

2026-11-19 已实际检查账号管理中的“保存登录会话”入口与登录交互流程，实测部分每日/推广/阅读活动入账。该检查未覆盖完整面板视觉验收、通知送达或全部活动。上线验收仍需按功能范围检查各页面、登录/退出、窄屏布局、弹窗 Tab/Escape/焦点恢复、SSE 重连、快速路由切换和错误重试。详细范围见 [本次更新说明](RELEASE_NOTES_20261119.md)。

## 积分与独立登录开发契约

- `getDashboardData()` 顺序为区域 Flyout HTTP → 浏览器 `page.request` → 旧 Rewards API → 未核实本地对象。旧接口同账号失败后不反复请求；DOM/React 仅属于独立的余额探测路径。CN 使用 `cn.bing.com`，其他地区使用 `www.bing.com`。
- 保留 `dataQuality` 的余额/搜索/活动标记及汇总的 `balanceVerified`；未知配额不算已完成，未知起止余额不结算成功收益。每账号重置余额、活动上下文与降级状态。
- DEBUG 响应不累计收益，阅读/搜索累计汇总与 INFO 增量不得重复计数。搜索额度变化及签到 HTTP 成功需与余额入账分开验证。
- `POST /accounts/:index/login` 只登录一个配置账号；`platform` 为 `mobile`、`desktop`、`both`（默认手机先行）。两端保存前都需核实上游余额和搜索额度。失败不保存未验证会话，关闭浏览器时不覆盖旧会话。
- 维护运行在日志前标记 `mode: "login"`，跳过活动上下文初始化、任务、App 令牌、每日/静默时间规则和任务通知；成功或失败均退出并释放锁。`/history` 保留维护记录，积分历史和账号战绩排除它们。

修改这些行为时更新对应核心/API/WebUI 合约测试，并同步 [更新日志](CHANGELOG.md)、README、API 文档和代理指导文件。纯文档修订检查格式、链接和源码一致性；代码回归检查按受影响路径运行，测试通过数以目标提交实际记录为准。

## 本地 WebUI 演示

```bash
npm run preview
```

默认地址 `http://127.0.0.1:4310`，演示登录为 `admin` / `Preview2026!`。仅用于本机预览。启动器复制当前面板和 API 到临时目录，生成演示账号、积分历史及配置；启停只调用有限的本地 mock，不调用 Rewards 或真实代理。账号、配置和调度可编辑；演示调度通过与生产相同的校验保存到临时目录，不调用宿主机 crontab，也不自动执行任务。生产 Docker 中调度保存会应用到受监督的 cron。所有编辑仅作用于本次演示数据，退出预览会清理临时目录。不要在演示页面输入真实账号凭据。

## PushPlus 通知与兑换预测

打开“通知”页面，填写 PushPlus Token、标题及可选模板/渠道，启用后保存；配置在下一次机器人进程启动时加载。Token 留空保留旧值，明确勾选清除才删除；保存与摘要预览不会发送消息。若 Docker 设置了 `CONFIG_PUSHPLUS_*`，容器重启时仍会重新应用这些环境覆盖值。

兑换目标名称可编辑，默认面值为 100 元，实际所需积分需从 Rewards 兑换页面填写；不按人民币面值推算积分。每个账号独立显示余额、本次/最近运行获得、剩余积分和预计天数。日均使用最近最多 7 个完整自然日，排除今天；从首次有效观测起，窗口内缺失日期计 0，同一天多次运行先求和。至少 3 个完整观测日且日均大于 0 才估计，天数向上取整；已达到目标显示 0 天。未设置门槛、余额未知或样本不足都会明确提示。预测不是兑换承诺，库存和门槛仍以 Rewards 页面为准。

历史读取 `config/points-history.jsonl` 及 `.1`，由 API 管理的积分任务结束时记录；仅登录维护不写入该历史，也不计入账号战绩或预测样本。直接运行 `npm start` 不负责持久化此历史；缺少有效历史时通知仍显示已核实余额和本次收益，但预测显示数据不足。当前运行收益只用于当前余额和本次获得，不进入尚未结束的当天日均。

`GET /notifications/preview` 需要登录，返回保存配置对应的摘要与预测，永不发送通知。预览账号及积分为模拟数据，不会联系 PushPlus；真实发送仍使用现有单进程/集群主进程的运行结束摘要位置。PushPlus 仅将 HTTP 成功且 JSON `code` 为数字 `200` 视为接受请求，失败会记录安全错误；接受请求也不保证用户已读。

调度 PUT/PATCH 在应用失败时恢复旧文件并尝试恢复原 cron，回滚失败会附带报错。Windows 原生 API 没有 Linux cron，真实定时运行请使用 Linux Docker；本地演示可以保存验证交互。

## 阶段耗时与依赖检查

设置 `MRS_PERFORMANCE=true` 后追加 `PERF` 计时日志。仅输出静态阶段名、耗时、计数和错误标记，不包含账号、URL、搜索词或错误正文。默认关闭，不改变重试、任务顺序或间隔。构建后可执行 `npm run test:performance` 验证计时器语义。

针对依赖漏洞升级 `zod`、`fast-xml-parser`、`adm-zip` 及兼容工具链补丁；本次更新后完整 `npm audit` 报告为 0。仍需在后续依赖更新时重新执行审计与回归测试。

## 双架构自检

分别在对应原生架构主机执行（`ARCH` 为 `amd64` 或 `arm64`）：

```bash
ARCH=amd64
docker buildx build --platform linux/$ARCH -f Dockerfile --load -t mrs-check:local .
docker run --rm --init --network none --shm-size=256m --entrypoint node \
  -e EXPECTED_ARCH=$ARCH mrs-check:local scripts/tests/platform-smoke.mjs
```

中国网络源使用 `-f Dockerfile.cn` 重复验证。跨架构本地构建需要 QEMU；发布前仍以 CI 原生架构结果为准。GitHub ARM runner 的可用性取决于仓库及账户类型；没有对应 runner 时配置受信任的 ARM64 自托管 runner。

## 面板迭代边界

- `scripts/api/web/app.js`：登录、SSE、导航和布局。
- `dashboard.js` + `refresh.js`：总览展示、请求生命周期与轮询。
- `accounts.js`、`points.js`、`logs.js`、`settings.js`：功能视图。
- `ui.js`：DOM、API、格式化公共工具。
- 新浏览器模块必须加入 `server.js` 的静态资源白名单；测试文件不应对外提供。
- 保持现有端点、响应和 SSE 事件格式；修改协议时先扩展 HTTP 合约测试。
- 账号凭据、配置文件和会话文件不得作为测试 fixture 或发布产物。

## 升级与回滚

1. 停止活动任务，并在安全位置备份 `.env`、`config/`、`sessions/`。备份含敏感数据，应限制访问。
2. 记录当前源码版本和镜像 ID。使用新版本执行上述构建、测试、lint、格式与双架构检查。
3. 检查 `compose.override.yaml`：默认随 Compose 自动加载，要求 `.env` 配置 `API_TOKEN`；浏览器登录还需要 `DASHBOARD_PASSWORD`。可以用 `docker compose config --quiet` 检查插值，避免把完整配置输出到日志。
4. 执行 `docker compose up -d --build`。默认 `RUN_ON_START=false` 且初始计划为空，先手动检查；已持久化的 `schedule.json` 仍优先，请在维护前停用已有调度。
5. 检查健康状态、静态模块加载与登录，并确认账号/历史/配置数据保留。Web 文件改变后刷新页面；在账号管理使用“保存登录会话”验证认证及上游余额/额度读取，确认只选择该账号、每端保存并退出，积分历史不新增维护记录。普通积分任务另行验证。
6. 回滚时使用此前记录的源码和镜像；如新版本更改了持久化格式，先停服务，再恢复相匹配的备份。本次没有迁移持久化数据格式。

发布工作流只在 `V4-china` 上发布，等待完整验证（包括四个容器检查）后才构建并推送双架构中国版镜像。发布前拒绝重复版本，发布后核验镜像 digest、amd64/arm64 子镜像的 revision 与当前提交一致，再创建 GitHub Release。修复或发布中断后的重发应提升版本，不能把当前源码关联到已有旧镜像。现有四段版本号仅用于维护分支和旧标签；正式发布工作流要求未占用的 `major.minor.patch` 稳定版本。
