# 升级与回滚指南（2026-11-17，待发布）

## 1. 当前只更新 GitHub 源码，不升级现有部署

本次变更保存在 `youkum/Microsoft-Rewards-Script` 的独立更新分支 `improvements/webui-pushplus-platform-20261117`，以 [草稿 PR #1](https://github.com/youkum/Microsoft-Rewards-Script/pull/1) 提交到 `V4-china` 审查；**PR 尚未合并，尚未发布本次更新对应的容器镜像或 GitHub Release，现有旧部署保持不动**。推送分支、创建 PR 与生产发布是不同步骤。

- 现在不要在生产目录执行 `git pull`、重新构建、拉取移动镜像标签或自动升级。
- 不要把现有镜像的旧版本标签当成本次源码的构建结果。
- `package.json` 当前仍为 `4.3.2.4`，不是本次更新的新发布版本。
- 发布工作流目前要求三段稳定版本 `major.minor.patch`，并拒绝已存在的 Git tag、GitHub Release 或同版本镜像。**合并/发布前，维护者必须确定并写入一个未使用的新发布版本，同步锁文件，重新完成验证。**不能复用旧版本，也不能只覆盖旧镜像。
- 本指南后半部分的生产命令仅供未来批准并完成正式发布后使用；没有指定任何尚不存在的新 tag。

## 2. 这次更新改变了什么

### WebUI、性能与安全修复

- 浅色管理台、导航、登录页、窄屏布局和分模块前端；改进复选框、选项、弹窗销毁和日志回放/实时事件合并。
- SSE 在线时复用状态，减少重复 `/status` 请求；合并积分刷新，离开页面后取消请求及计时器，避免过期响应覆盖新视图。
- 账号列表一次聚合历史，避免逐账号重复扫描。模拟数据基准不代表真实 Rewards 任务会按同样比例提速。
- 修复账号文件特殊字符、换行注入、环境变量隔离、凭据空白保留与明确清除；修复异常 Cookie、请求异常、配置脱敏和打码占位符回写。
- 修复任务锁、容器内 API/cron 生命周期、健康检查和进程结束日志读取；阶段耗时日志默认关闭。

### 调度：生产 cron 与隔离演示不是一回事

生产 Linux Docker 中，调度页保存启用状态、五段 Cron 和排除账号列表，持久化到 `config/schedule.json` 并应用到 Linux cron；响应标记为 `application: "cron"`。应用失败会恢复旧文件并尝试恢复原 cron；若回滚也失败，需要管理员检查错误与实际计划，不能把保存失败视为“已经停用”。

`npm run preview` 是临时目录中的隔离演示，调度响应为 `application: "demo-storage"`：允许校验并保存演示计划，但不改宿主机 cron、不创建定时器、不自动执行任务。任务、账号、历史及代理检查均为模拟数据。演示保存成功不等于生产定时执行已验证；不要在演示中填写真实凭据。Windows 原生 API 不是 Linux cron 的替代品。

### PushPlus 与逐账号兑换预测

在“通知”页配置 `webhook.pushplus` 的启用状态、Token、标题、模板及渠道；模板为 `txt`、`html` 或 `markdown`。Token 留空表示保留旧值，明确勾选清除才会删除。不要把脱敏文本当作真实 Token 写回。

- 保存及 `GET /notifications/preview` 都不发送消息，预览端点需要认证。
- 新配置在下一次机器人进程启动时读取。若设有 `CONFIG_PUSHPLUS_*` 环境覆盖，容器重启还会重新应用，需先检查这些覆盖项。
- 真实运行结束摘要包含逐账号当前余额、本次获得、目标差额、历史日均和预计天数；优先使用最终读取的余额，不用“原余额 + 增量”冒充实际余额。
- PushPlus HTTP 成功且 JSON 的数字 `code` 为 `200` 才视为请求被接受；接受不等于送达或已读。

新增配置结构如下，这是局部示例，不是完整配置文件：

```json
{
    "rewardGoal": {
        "name": "100元礼品卡",
        "faceValue": 100,
        "targetPoints": null
    }
}
```

`name` 为非空名称，`faceValue` 为正数面值；`targetPoints` 只能为 `null` 或正的安全整数。旧配置缺少该对象时使用上述默认值。当前通知表单使用 100 元面值。

**100 元不是积分门槛。**请到自己的 Microsoft Rewards 兑换页核对实际所需积分，再填写 `targetPoints`；不预设门槛、不按人民币面值推导积分兑换率。

预测规则：

1. 每个账号独立计算，余额和历史不跨账号相加。
2. 按配置时区（Compose 默认 `Asia/Shanghai`）取最近最多 7 个完整自然日，不含今天。每个账号从首次有效历史观测日起计，窗口内缺失日计 0；同一天多次运行收益先相加。
3. 至少有 3 个完整观察日且日均大于 0，才按 `向上取整(剩余积分 / 日均积分)` 估算；已经达标显示 0 天。
4. 未设置门槛、缺少余额、历史不足、日均为 0 时明确显示未知/原因；本次收益不加入尚未结束的当天日均。
5. 数据来自 `config/points-history.jsonl` 与轮转文件 `.1`，通常由 API 管理的任务结束后写入。直接执行 `npm start` 不负责生成这份持久历史，可能一直缺少预测样本。当前运行历史也不会在结束前成为完整自然日样本。
6. 预测只是历史估算，不保证未来收益、兑换库存或门槛不变。

## 3. 安全边界：仍然是单管理员、明文持久化

本次**没有实现静态加密、用户注册或多用户权限隔离**。账号密码、TOTP、代理密码、通知 Token，以及会话 Cookie/存储状态等仍可能以明文存在于 `.env`、`config/`、SQLite 和备份中。

新增/收紧的 owner-only 文件权限和 API 脱敏只能减少误暴露，不能把这些数据变成密文；管理员、root、Docker 管理员以及能读取备份的人仍可能取得秘密。POSIX 下敏感文件使用 `0600`、会话目录使用 `0700` 等限制，Windows 下还必须检查实际 NTFS ACL，不能仅凭 chmod 调用认为权限已经隔离。

- 不提交真实 `.env`、`config/accounts.env`、会话数据库或含秘密的配置到 GitHub。
- 不将完整 `docker compose config`、环境变量、配置 reveal 响应或备份内容贴进日志/工单。
- 备份存放在受限位置；若需要静态加密，使用外部受控的加密备份工具及独立密钥管理。这不代表应用实现了加密。

## 4. 升级前必须核对的兼容点

### 4.1 凭据文件解析已变更，禁止 Shell source

应用共享的数据解析器处理 `.env` / `config/accounts.env`，写入需要转义的值时使用 JSON 双引号规则：

```dotenv
ACCOUNT_1_PASSWORD="a\"b\\c$literal"
```

此例表达的实际密码为 `a"b\c$literal`，其中 `$literal` 是普通文本，不做 Shell 变量展开。有效 JSON 双引号值会解析 `\"`、`\\` 等转义；单引号和无引号旧值保留字面内容；双引号值不是合法 JSON 时，兼容回退为去掉外层引号并保留内部内容。

兼容回退不是“所有旧转义一定不变”：旧文件如果恰好构成有效 JSON 转义（例如 `\n` 或 `\t`），新解析器会解释它。升级前请在受限环境用非真实样例核对引号、反斜杠、美元符号、空格和 `#`；必要时通过新版账号表单重新保存。账号字段仍会拒绝不允许的换行输入。

容器启动已移除对账号文件的 Shell 执行。**不要对账号文件执行 `source`、`.`、`eval` 或命令替换，也不要用 Shell 规则再次“解码”新文件。**这不是可执行脚本格式。容器内部由 Bash 生成、供 cron 恢复环境的 `/etc/container_env` 是另一用途，不应混同为用户凭据文件。

Compose 对 `.env` 的插值/读取与应用数据解析是两层机制；含特殊字符的值还需核对所用 Compose 版本的处理，不要假定二者完全相同。WebUI 仅管理 `config/accounts.env` 中的账号，基础 `.env` 账号仍需手工维护。

### 4.2 手动优先不覆盖既有计划

新版 Compose 默认 `RUN_ON_START=false`，初始 `CRON_SCHEDULE` 为空；新安装不会因启动而立即跑积分任务。cron 服务仍保持运行，方便随后从面板设置计划。

但 **`config/schedule.json` 中已经保存的计划优先于环境初始值**。空 `CRON_SCHEDULE` 或 `RUN_ON_START=false` 都不会自动停用已有计划。维护前需停用有效计划并确认任务已结束；不要为“重置计划”随意删配置文件。

### 4.3 认证、端口和 Compose override

- Compose 要求 `.env` 中有非空、足够长的随机 `API_TOKEN`，供 API、cron 触发和健康检查使用。可用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成，并保存到受限文件，不提交到仓库。
- 浏览器登录还必须配置独立的 `DASHBOARD_PASSWORD`，并核对 `DASHBOARD_USERNAME`；API Token 不能替代面板密码。
- 默认发布地址为宿主机 `127.0.0.1:8890`，容器内部监听 `0.0.0.0:3010`。这是两个不同层次；容器内部全接口监听不等于宿主机公网开放。
- 远程管理默认使用 SSH 隧道。把命令中的 SSH 目标替换为实际服务器，在自己的电脑执行：

```bash
ssh -N -L 8890:127.0.0.1:8890 YOUR_SSH_USER@YOUR_SERVER
```

然后访问自己电脑的 `http://127.0.0.1:8890`。本机端口被占用时可改隧道左侧端口。不要为了“方便访问”直接开放公网 8890；若另行部署反向代理，应有 TLS、认证和网络访问控制。

- 默认执行 `docker compose` 会自动合并 `compose.yaml` 与 `compose.override.yaml`；当前附带 override 将 `API_ALLOW_ENV_OVERRIDES` 设为 `false`。核对服务器上是否另有本地 override，不要把历史本地文件带来的行为误认为新版默认值。显式使用 `-f` 时应逐个列出需要的文件，不能假定仍会隐式加载 override。
- 用 `docker compose config --quiet` 检查插值和结构，避免输出展开后的敏感配置。

## 5. 停机一致性备份（只在获批维护窗口执行）

**现在不执行；现有部署按原样运行。**未来升级前，按以下顺序准备可恢复快照：

1. 记录旧源码提交、实际启动命令、Compose 文件/override、镜像 ID、容器挂载路径和端口。给旧镜像加独立本地回滚标签，保留旧源码，避免新构建覆盖 `microsoft-rewards-script:china` 后失去旧镜像引用。不要清理镜像。
2. 停用自动计划，阻止外部 cron/服务/CI 再触发任务；等待或通过面板停止活动任务。记录维护前原计划，供最终恢复使用。
3. 从旧部署目录停止容器，例如 `docker compose stop -t 60 microsoft-rewards-script`，确认容器和子进程确已停止。非 Docker 方式须停止 API、机器人、cron/服务等所有写入者。仅点击“停止任务”还不够：API 可能仍写配置或历史。
4. 在全部写入停止后，将以下内容作为**同一份快照**备份到项目目录之外的受限目录：
    - `.env`、实际使用的配置文件（含根目录 `config.json`，若有）；
    - 整个 `config/`：包括 `accounts.env`、`config.json`、`schedule.json`、积分历史及 `.1`；
    - 整个 `sessions/`，或配置的其他会话路径；
    - 实际使用的 Compose 文件/override，其他外置认证文件（例如使用中的 ClawBot 认证文件）。
5. SQLite 使用 WAL：备份不能只复制 `sessions.db`。正常关闭可能已做 checkpoint，但仍须保留当时存在的 `sessions.db-wal`、`sessions.db-shm`，最简单方式是停机后归档整个会话目录。不要边运行边逐文件复制，也不要单独删除 WAL/SHM。
6. 保留文件权限/归属，核对归档清单、校验和与可读性，在隔离目录演练恢复；不输出秘密。备份成功前不替换旧部署，不删除旧数据卷。

备份中的 `schedule.json` 可能仍为启用状态；恢复后第一次启动前必须重新核对。加密备份如有使用，必须验证外部解密及恢复过程；应用本身没有加密迁移或解密功能。

## 6. 发布前放行清单

- [ ] PR 完成审查，明确合并和发布批准；当前旧部署仍不变。
- [ ] 改为未使用的新三段稳定版本，同步 `package.json` / 锁文件，确认 tag、Release、镜像版本均未占用。
- [ ] API/Web、性能、隔离演示测试、构建、lint、格式、依赖审计和 shell fixture 重新通过。
- [ ] 四个原生容器 CI job 全部通过：`amd64` / `arm64` × `Dockerfile` / `Dockerfile.cn`。
- [ ] 完成真实浏览器交互走查、Linux cron 启停与故障恢复验收；如需生产 PushPlus，另获批准进行真实发送验证。
- [ ] 正式发布成功，核对 Git tag 对应提交、镜像 digest、双架构 manifest 和 OCI revision，记录准确版本。
- [ ] 维护窗口、停机快照和回滚演练获确认，才进入下面的部署步骤。

截至本次记录，已有本地验证为 **86 项 API/Web、8 项性能、5 项隔离预览测试通过，lint 0 错误/3 个既有警告，依赖审计 0 项，格式检查与构建通过**。这是此前实际检查结果，不表示本文编写时重新运行过。Windows 本地没有 Docker；四个原生 Linux 容器 job 只是已配置，不能记作已通过，须以 GitHub CI 实际结果为准。

## 7. 未来获批发布后的生产部署命令

下面是 **Linux、从已批准源码 tag 本地构建** 的路径，不是当前更新指令，也不会使用未经核验的 `latest`。已有生产部署须先完成第 5 节停机备份。新目录与旧目录分开，避免修改旧源码。

先在受控终端设置 `APPROVED_TAG` 为已发布且获批的真实 tag，`RELEASE_DIR` 为尚不存在的新绝对目录。不要把示例说明文字当作 tag：

```bash
: "${APPROVED_TAG:?请先设置已发布且获批的真实 Git tag}"
: "${RELEASE_DIR:?请先设置新的绝对部署目录}"

git clone --branch "$APPROVED_TAG" --depth 1 \
  https://github.com/youkum/Microsoft-Rewards-Script.git "$RELEASE_DIR"

test "$(git -C "$RELEASE_DIR" rev-parse HEAD)" = \
  "$(git -C "$RELEASE_DIR" rev-parse "refs/tags/$APPROVED_TAG^{commit}")"
```

将提交 ID 与正式 Release 核对。**随后暂停命令执行**：从同一停机快照恢复 `.env`、`config/`、`sessions/` 及必要外置认证文件到新目录，并保留权限；按第 4 节核对认证、特殊字符、override 和会话路径。不要只复制数据库而漏掉配套文件。

确认新目录中的 `config/schedule.json` 已停用，旧容器确已停止，且未设置其他自动触发；默认手动优先不代替这些检查。确认后才执行：

```bash
docker compose --project-directory "$RELEASE_DIR" config --quiet
docker compose --project-directory "$RELEASE_DIR" build microsoft-rewards-script
docker compose --project-directory "$RELEASE_DIR" up -d --no-build microsoft-rewards-script
docker compose --project-directory "$RELEASE_DIR" ps
```

此路径使用项目 Compose 的 `Dockerfile.cn` 本地构建。构建失败就停止，不启动旧缓存冒充新版本。若改走 registry 镜像，另按正式 Release 的真实 digest 制定部署配置，不将本地构建命令与镜像拉取命令混用。

通过 SSH 隧道登录，检查账号、配置、历史、通知预览、模块加载、健康检查和有效计划。先获批准手动验证，再恢复所需调度；不要因为容器显示 running 就认定 cron 和真实推送全部可用。

## 8. 回滚：旧程序与匹配快照一起恢复

1. 停用新调度、停止新任务与容器，确认没有进程写配置、历史或 SQLite。保留故障日志及新状态的受限副本以便排查。
2. 选回已记录的旧源码和旧镜像 ID/回滚标签，恢复原启动配置。新旧版本共用同名本地镜像标签时，必须明确恢复旧镜像引用；不要直接重新构建或拉取移动标签。
3. 在停机状态下将**匹配旧版本的同一快照**恢复到正确挂载路径：`.env`、配置、整个 `sessions/`（含快照中存在的 WAL/SHM）及其他认证文件。不要混用新数据库、旧 WAL、不同时间的配置或部分历史。恢复到干净的目标目录或先移开失败数据，避免残留 sidecar 混入。
4. 本次未引入应用静态加密，但仍不能假定后续版本的数据格式可向后兼容。没有“自动解密回旧版”的步骤；外部加密备份须先由外部工具解密。若不确定兼容，恢复停机快照而非让旧程序直接打开新状态。
5. 恢复权限、核对停用计划，启动已确认的旧镜像（不重新构建），验证账号、会话、历史和登录后再决定是否恢复原计划。回滚会舍弃快照后的状态，需要保留的变更另行人工核对。

**不要执行 `docker compose down -v`，不要删除数据卷、会话库或备份来“解决升级问题”。**保持旧镜像、旧源码与快照，直到新版本稳定且备份保留策略允许清理。
