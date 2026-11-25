<div align="center">

# 微软奖励自动化脚本（V4-china 优化增强版）

[![Repository](https://img.shields.io/badge/GitHub-youkum%2FMicrosoft--Rewards--Script-blue.svg)](https://github.com/youkum/Microsoft-Rewards-Script)
[![Branch](https://img.shields.io/badge/branch-V4--china-orange.svg)](https://github.com/youkum/Microsoft-Rewards-Script/tree/V4-china)
[![Version](https://img.shields.io/badge/version-4.3.2.4-blue.svg)](./package.json)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-green.svg)](./package.json)
[![WebUI](https://img.shields.io/badge/WebUI-Supported-brightgreen.svg)](./scripts/api/README.md)
[![Vibe Coding](https://img.shields.io/badge/100%25-AI%20Secondary%20Developed-8A2BE2.svg)](./VIBECODING.md)
[更新日志](./CHANGELOG.md) · [2026-11-25 更新说明](./RELEASE_NOTES_20261125.md) · [构建与部署验收](./CODEX_INSPECTION_GUIDE.md)
[![Upstream](https://img.shields.io/badge/上游-TheNetsky/Microsoft--Rewards--Script-informational.svg)](https://github.com/TheNetsky/Microsoft-Rewards-Script)

**基于 TypeScript · Patchright(Playwright) · 区域积分读取与可信度校验 · 独立登录保存 · WebUI 控制面板**

针对国内用户深度本地化：✅ 中国热搜查询源（百度/头条/抖音/微博/知乎） · ✅ 区域 Flyout 与余额核实 · ✅ 单账号保存登录会话 · ✅ 微软安全拦截页自动跳过 · ✅ 日志中文化 · ✅ PushPlus / 微信 ClawBot 推送 · ✅ 内嵌 WebUI (:8890) · ✅ AI/Vibe-Coding 指导文档

</div>

> [!IMPORTANT]
> **`V4-china` 是默认维护分支。** 当前源码包含配置与累计统计持久化、代理握手异常处理、出口 IP 备用查询及完整代理地址显示。部署时核对源码提交与对应 [验证记录](https://github.com/youkum/Microsoft-Rewards-Script/actions/workflows/validate.yml)，操作说明见 [2026-11-25 更新说明](RELEASE_NOTES_20261125.md)，升级或迁移见 [升级与回滚指南](UPGRADE_GUIDE.md)。

> [!NOTE]
> 🤖 **项目维护与开发声明**：**此项目由 AI 在人类的帮助下全面接手二次开发，人工提供了开发建议和提示词优化。**
> 区域积分读取、登录流程与干扰页处理、WebUI 实时日志及 Docker 配置由 AI 在开发者指导下维护，验证范围与未验证项记录在更新说明和验收文档中。

> ℹ️ **分支与项目说明**
>
> - **本分支（`V4-china`）**：维护国内适配和内嵌控制台。本项目是社区维护的 fork，不隶属于 Microsoft 或 Rewards 官方。
> - 本分支账号改用 `.env` 环境变量与 `config/accounts.env` 统一配置（不再使用旧版 `accounts.json`）。
> - 2026-11-23 起统一保留 `V4-china` 作为维护分支。旧 `main` 的 v3 提交历史已整合至本分支，部署与更新请使用当前 v4 文件及本分支指南。

> [!TIP]
> 派生关系和依赖许可见 [第三方声明](THIRD-PARTY-NOTICES.md)。

---

## 📑 目录

- [📝 最近更新日志 (CHANGELOG)](#-最近更新日志)
- [✨ 核心特性](#-核心特性)
- [🚀 快速开始](#-快速开始)
- [📦 Windows 部署](#-windows-部署)
- [🐳 Linux / Docker 部署](#-linux--docker-部署生产推荐)
- [🖥️ 控制 API 与内嵌面板](#️-控制-api-与内嵌面板)
- [⚙️ 配置参考](#️-配置参考)
- [🔔 通知渠道](#-通知渠道)
- [❓ 常见问题](#-常见问题)
- [⚠️ 注意事项](#️-注意事项)
- [📜 开源引用与致谢](#-开源引用与致谢)
- [⚠️ 免责声明](#️-免责声明)

---

## 📝 最近更新日志

> 完整历史记录见 📄 [CHANGELOG.md](./CHANGELOG.md)。

- **2026-11-25**：
    - **代理测试异常修复**：捕获 CONNECT/TLS 握手断开与超时，避免测试失败导致 API 或容器重启；补充认证、权限及协议错误提示。
    - **出口 IP 与地址显示**：增加 HTTPS 回显备用服务，区分代理连接失败与 IP 查询失败；账号表格完整显示协议、主机及端口。
    - **指导文档同步**：更新代理配置、网页部署、数据保留及 AI 交接说明，详见 [更新说明](RELEASE_NOTES_20261125.md)。
- **2026-11-23**：统一保留 `V4-china` 维护分支，整合旧 `main` 历史。
- **2026-11-21**：修复配置保存覆盖挂载符号链接的问题，持久保存运行记录与独立账号累计统计；重启及重建复用原目录保留数据。
- **2026-11-19**：
    - **保存登录会话**：账号管理可独立登录一个账号，默认手机端、电脑端依次核实并立即保存，无需执行完整积分任务；维护不计收益，结束后释放任务占用。
    - **区域接口与收益核实**：优先区域 Flyout，浏览器备用请求共享 Cookie；未核实额度不算完成，未知余额不结算成功收益，每账号重置状态。
    - **日志与文档同步**：修复 DEBUG/INFO 及阅读/搜索汇总重复累计；用户、API、升级、开发和 AI 指南同步当前行为，详见 [更新说明](RELEASE_NOTES_20261119.md)。
- **2026-11-18**：
    - **WebUI 现代化与性能跃升**：前端全面重构为原生 ES Modules（无需额外构建），合并 SSE 状态与积分刷新，大幅降低面板轮询开销。
    - **PushPlus 逐账号收益与兑换预测**：新增 `rewardGoal` 配置，支持自动汇总各账号每日实际收益，并基于历史均值预测达成兑换目标所需天数。
    - **单账号运行隔离与安全修复**：修复 WebUI「只跑此号」及排除账号调度时被磁盘全量账号覆盖的缺陷（引入 `ACCOUNTS_FILTERED` 保护）；加固密码输入引导语与 KMSI 登录流程。
- **2026-11-11**：
    - **修复密码引导文案误判致命错误**：在 `Login.ts` 中增加引导语识别器，防止在密码框出现时误触发致命异常中断。
    - **WebUI 统一全账号可编辑**：支持在线统一查看和编辑全部账号的密码、代理、TOTP 密钥与指纹设置。
- **2026-11-10**：
    - **WebUI 交互式控制台**：支持验证码与辅助邮箱实时交互弹窗回传，解禁行为配置与调度写入 API。
- **2026-11-07**：
    - **控制面板直接内嵌**：无需额外部署外部 WebUI 容器，单容器单端口（8890）直接托管极速原生 JS 控制台。
    - **网页端账号管理**：支持在 Web 端直接添加/编辑/删除刷积分账号，独立写入 `config/accounts.env`。
    - **每账号独立代理与测速**：集成独立代理配置与连通性测试（回显出口 IP、国家与延迟）。
    - **积分历史持久化与图表**：新增 `points-history.jsonl` 自动轮转存储，提供历史每日积分柱状图与明细。
- **2026-11-02**：
    - **WebUI 控制面板连通性加固**：优化端口映射与 Docker 桥接网络配置，解决 `8890` 端口无法从外部浏览器打开的问题；完善 HTTP Basic Auth 管理员密码配置指引。
    - **多账号热替换与清理**：完善多账号配置规范，提供热更新账号并清理 SQLite 旧会话（`sessions.db`）的无痛迁移方案。
    - **中文积分报表升级**：新增结构化中文积分报表输出，全面适配 WebUI 正则解析器与实时指标卡片展示。

---

## ✨ 核心特性

**增强版亮点（最新优化）**

- 🌟 **积分画像与数据可信度**：
    - 支持抓取完整账户积分视图：可用余额、历史总计、今日已得、PC/移动/Edge各子项剩余配额、等级、升级进度、连击天数与保护。
    - Dashboard 依次请求区域 Flyout HTTP、共享 Cookie 的浏览器 `page.request`、旧 Rewards API，最后返回标记为未核实的兼容结构。DOM/React 余额探测独立处理；缺失额度不算完成，未知起止余额不结算成功收益。
- 🌟 **单账号保存登录会话**：
    - 账号管理独立完成手机/电脑认证，核实上游余额及搜索额度后每端立即保存；验证码在实时日志页提交，不运行积分任务或任务通知，不计收益和账号战绩。
- 🌟 **自适应认证与无感跳过拦截页**：
    - 自动识别并跳过“体验无密码”、“保护你的账户”、“添加备用安全信息”等阶段性弹窗阻碍。
    - 智能过滤 Cookie 条款与协议弹窗，支持回车键底层键盘提交兜底。
- 🌟 **Vibe-Coding 亲和支持**：
    - 预置 `.cursorrules`、`CLAUDE.md`、`AGENT.md`、`VIBECODING.md`，兼容 Cursor / Trae / Windsurf / Claude Code / Devin 等人机协同工具。

**账户管理**

- ✅ 多账户支持（`.env` 中 `ACCOUNT_N_*` 环境变量，编号无需连续）
- ✅ 会话存储与持久化（`sessions/`，含指纹持久化）
- ✅ 2FA 支持（TOTP 自动生成并填入验证码）
- ✅ 无密码登录支持
- ✅ 每账户独立代理（HTTP/HTTPS/SOCKS4/SOCKS5）

**自动化与控制**

- ✅ 无头浏览器操作（Patchright 反检测内核）
- ✅ 集群支持（同时多个账户）
- ✅ 可配置任务开关
- ✅ 控制 API + **内嵌 Web 面板**（启动/停止/日志/积分/调度管理 + 网页端账号增删改 + 每账号代理配置与测试,端口 8890,无需额外容器）
- ✅ 自动调度（Docker 内置 cron）

**搜索与活动**

- ✅ 桌面与移动搜索（配额独立跟踪，互不阻塞）
- ✅ 加成搜索（超过上限后继续刷，可选）
- ✅ 每日集 / 更多促销 / 打卡 / App 活动 / 每日签到 / 阅读赚取（Read-to-Earn）
- ✅ 搜索加成 perk 激活（"再搜 N 次得积分"）/ 视觉搜索（可选）
- ✅ 连击保护 & 自动领取 dashboard 奖励积分
- ✅ 模拟滚动与随机点击，降低风控风险

**搜索词来源（国内推荐 china + local）**

- ✅ 中国热搜（百度/头条/抖音/微博/知乎，gmya.net 聚合，多源随机 + 限流退避）
- ✅ 本地查询词兜底（`search-queries.json` 中文词库）
- ✅ Bing 建议聚类扩展（`clusterSearch`，每个主词扩展一组相关词再搜索）
- ✅ 亦可选 google / wikipedia / reddit / hackernews / RSS 源（国内需代理）

**通知与监控**

- ✅ PushPlus 微信推送（国内推荐，无需翻墙）
- ✅ Server酱 微信推送（Turbo 版，扫码获取 SendKey 即用）
- ✅ 微信 ClawBot 推送（腾讯官方 iLink 直连，免费无第三方服务）
- ✅ Discord / Telegram / ntfy 推送
- ✅ 全面日志记录（日志过滤 + 落盘 `logs/` 按天分文件，自动清理 90 天前旧日志）

---

## 🚀 快速开始

本脚本支持两种部署方式，**按你的场景二选一即可**：

| 维度           | 📦 Windows 直跑                       | 🐳 Docker                                            |
| -------------- | ------------------------------------- | ---------------------------------------------------- |
| **配置方式**   | `.env`（账号）+ `config.json`（行为） | `.env`（账号）+ `compose.yaml` 的 `CONFIG_*`（行为） |
| **调度**       | 手动 / 计划任务                       | 内置 cron + API 改调度                               |
| **headless**   | 可选（可见窗口）                      | 强制 `true`（无显示器）                              |
| **数据持久化** | `sessions/` 目录                      | `./config/` + `./sessions/` 挂载                     |
| **升级方式**   | `git pull` + `npm run build`          | `docker compose up -d --build`                       |
| **前置要求**   | Node.js 24+                           | Docker + Docker Compose                              |

> ⚠️ 与 v3（`main` 分支）不同：**账号统一在 `.env` 中配置**（`ACCOUNT_1_EMAIL` 等），不再使用 `accounts.json`；行为配置仍在 `config.json`（Docker 下用 `CONFIG_*` 环境变量）。

---

## 📦 Windows 部署

> ⚠️ 本项目所有改动基于 Win11 系统测试，其他系统请参考[原项目](https://github.com/TheNetsky/Microsoft-Rewards-Script)相关配置。

<details>
<summary><b>🔧 自动设置（推荐，一键部署）</b></summary>

1. 下载或克隆源代码：

    ```bash
    git clone -b V4-china https://github.com/youkum/Microsoft-Rewards-Script.git
    cd Microsoft-Rewards-Script
    ```

    > 国内无法直连 GitHub 时可用镜像加速：在 URL 前加 `https://gh-proxy.com/`，或在本项目页面 "Code → Download ZIP" 下载。

2. 双击运行 `setup.bat`：自动安装 Node.js 24、生成 `.env` 与 `config.json`、安装依赖并构建
3. 编辑 `.env`，填入账户信息（`ACCOUNT_1_EMAIL` / `ACCOUNT_1_PASSWORD` 等）
4. 按需修改 `config.json`
5. 运行 `run.bat` 或执行 `npm start` 启动脚本

</details>

<details>
<summary><b>🛠 手动设置（自动设置失败时使用）</b></summary>

1. 克隆源代码：

    ```bash
    git clone -b V4-china https://github.com/youkum/Microsoft-Rewards-Script.git
    cd Microsoft-Rewards-Script
    ```

2. 安装 Node.js 24+
3. 安装依赖包（根据 lockfile 固定版本）：

    ```bash
    npm ci
    ```

4. 若出现 `Error: browserType.launch: Executable doesn't exist` 报错，执行：

    ```bash
    npx patchright install chromium
    ```

5. 复制 `env.example` 为 `.env`，填入账户信息；国内账号推荐保留默认的 `ACCOUNT_1_LANG_CODE=zh-CN`、`ACCOUNT_1_GEO_LOCALE=CN`
6. 复制 `config.example.json` 为 `config.json`（项目根目录），按需修改
7. 预构建（安装依赖与浏览器）：

    ```bash
    npm run pre-build
    ```

8. 构建：

    ```bash
    npm run build
    ```

9. 启动：

    ```bash
    npm start
    ```

开发验证可运行 `npm test`、`npm run build`、`npm run lint` 和 `npm run format:check`。CI 会在 `V4-china` 的 Pull Request 中执行相同检查。

双架构目标为 **Linux x86-64（amd64）与 ARM64**；32 位 x86/ARMv7 不在范围内。CI 分别构建两个 Dockerfile 并执行原生客户端/浏览器自检。本地尚未验证 ARM64 容器运行，需以原生 CI 通过为准。详见 [开发、验证与升级说明](DEVELOPMENT.md)。

> 💡 调试时可直接源码运行：`npm run dev`（带 `-dev` 参数输出 DEBUG 日志）。

</details>

---

## 🐳 Linux / Docker 部署（生产推荐）

<details open>
<summary><b>完整部署步骤（含 WebUI 面板）</b></summary>

> [!IMPORTANT]
> 本仓库 `compose.yaml` 默认使用 `dockerfile: Dockerfile.cn` 本地构建（内置阿里云源与 IPv4 优化，构建速度极快）。**请勿**使用官方镜像，否则不含国内热搜源与 WebUI 日志增强适配。

### 1. 克隆本项目代码

```bash
git clone -b V4-china https://github.com/youkum/Microsoft-Rewards-Script.git
cd Microsoft-Rewards-Script
```

### 2. 准备账号配置文件（.env）

```bash
cp env.example .env
```

编辑 `.env`，设置控制面板认证（默认 Compose 必须同时配置 API 令牌和面板登录密码）：

```dotenv
API_TOKEN=replace_with_a_random_64_character_token
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=replace_with_a_strong_dashboard_password
# 默认仅允许本机回环访问；需要局域网直连时设为受信任网卡地址。
# API_BIND_ADDRESS=127.0.0.1
```

生成随机 API 令牌：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。账号可以启动后在面板在线添加，也可以直接在 `.env` 中预填 `ACCOUNT_1_EMAIL` 等环境变量。

> `compose.yaml` 要求设置 `API_TOKEN`，缺失会在启动前报错。面板密码用于浏览器登录，API 令牌用于外部程序调用。默认宿主机端口为 `127.0.0.1:8890`，远程管理优先用 SSH 隧道。

### 3. 构建并启动主容器

```bash
docker compose up -d --build
```

> **重要**：后续代码拉取更新（`git pull`）后，加 `--build` 重新构建镜像生效：
>
> ```bash
> git pull origin V4-china
> docker compose up -d --build
> ```

### 4. 数据持久化与查看日志

容器挂载了两个关键目录，配置、已结束运行的统计与登录状态保存在宿主机：

- `./config/`：`config.json` 保存行为/通知/兑换目标设置，`accounts.env` 保存 Web 管理账号，`schedule.json` 保存调度；`run-history.json` 保存最近运行与账号累计统计，`points-history.jsonl` 及 `.1` 保存按时间查询的积分报表。
- `./sessions/`：账户会话与浏览器指纹（首次成功登录后复用 Cookie 与 SQLite 状态）

2026-11-21 修复配置保存覆盖符号链接和运行统计仅存内存的问题。账号累计不受最近运行记录上限（默认 20 次）或积分报表轮转影响；首次升级只可恢复仍在旧积分历史中的记录。旧容器重建前需备份容器层的最新配置，操作见 [升级指南](UPGRADE_GUIDE.md#2026-11-21设置与统计持久化)。实时日志和未结束任务不会在突然断电后自动恢复。

```bash
docker compose logs -f          # 实时查看运行日志
docker compose down             # 停止容器
docker compose restart          # 快捷重启
```

### 5. 打开内嵌 WebUI 控制面板（端口 8890）

`compose.yaml` 已默认开启 `API_MODE=true` 并映射 `8890` 端口，**控制面板直接内嵌在主容器中，无需再部署任何额外容器**。

1. 在 `.env` 中设置面板登录账号（默认必须同时设置 `API_TOKEN` 和 `DASHBOARD_PASSWORD`）：

    ```dotenv
    DASHBOARD_USERNAME=admin
    DASHBOARD_PASSWORD=your_dashboard_password
    ```

2. 启动后在宿主机访问 `http://127.0.0.1:8890`。远程优先使用 [SSH 隧道](UPGRADE_GUIDE.md#43-认证端口和-compose-override)；确需局域网直连时，显式设置 `API_BIND_ADDRESS` 为服务器的受信任网卡地址，并以防火墙限制来源，不要将 `8890` 暴露到公网。登录后可以：

    | 页面          | 能力                                                                                                                           |
    | ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
    | 📊 总览       | 运行状态、启停/重启、**单账号运行（只跑此号）**、各账号实时积分（SSE 推送）                                                    |
    | 👤 账号管理   | **网页端增/删/改账号**（写入 `config/accounts.env`，下次运行生效）、独立代理与测速、**保存登录会话**（单账号仅登录，默认两端） |
    | 🔔 通知与预测 | **PushPlus 微信通知**配置、**`rewardGoal` 兑换目标**积分设置、逐账号积分收益与达成天数智能预测预览                             |
    | 💰 积分历史   | **持久化积分报表**（重启不丢）：每日获得柱状图、分账号累计、运行记录明细                                                       |
    | 📜 实时日志   | SSE 实时日志流、级别过滤、自动滚动、**控制台交互式输入条**（支持验证码/辅助邮箱实时交互）                                      |
    | ⏰ 运行调度   | Cron 编辑、启用开关、排除账号（失败自动安全回滚）                                                                              |
    | ⚙️ 行为配置   | 任务开关表单 + 原始 config.json 编辑（受 `API_ALLOW_CONFIG_WRITE` 控制）                                                       |
    | 🧰 会话与诊断 | 登录会话管理（删除需重新登录）、错误诊断截图/快照查看                                                                          |

> 说明：网页账号写入 `config/accounts.env`（已挂载持久化），与 `.env` 按槽位合并，Web 配置同槽位优先。尚未被 Web 配置覆盖的 `.env` 账号在面板中只读，需在基础文件修改；两种来源均可使用“保存登录会话”。旧的外部仪表盘 [mgrimace/rewards-dashboard](https://github.com/mgrimace/rewards-dashboard) 可按 [API 文档](scripts/api/README.md) 验证对接。

</details>

---

## 🖥️ 控制 API 与内嵌面板

`API_MODE=true` 时( compose.yaml 已默认开启),脚本自带**内嵌 WebUI 控制面板**与控制 API(同一端口,Docker 下 8890):

- 宿主机打开 `http://127.0.0.1:8890`，远程使用 [SSH 隧道](UPGRADE_GUIDE.md#43-认证端口和-compose-override)；面板支持账号管理、保存登录会话、代理测试、启停/调度/配置、实时日志与积分历史
- 面板登录使用 `.env` 中的 `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`(会话 Cookie,HttpOnly + HMAC 签名)
- 外部工具可用 `API_TOKEN` 走 `Authorization: Bearer` / `X-API-Key` 调用同一套 API
- API 支持账号 CRUD、代理测试(`POST /accounts/:index/proxy-test`)、保存登录会话(`POST /accounts/:index/login`)与持久化积分历史(`GET /points/history`，排除仅登录维护)
- Windows 本地运行:`npm run api` 后访问 `http://127.0.0.1:3010`
- 完整文档见 [`scripts/api/README.md`](scripts/api/README.md)

> 兼容性提示：可按 [API 文档](scripts/api/README.md) 验证第三方面板的对接；外部面板不是内嵌面板的必装组件。

---

## ⚙️ 配置参考

> 编辑 `config.json`（Windows）或通过 `CONFIG_*` 环境变量（Docker）自定义行为。数组类 `CONFIG_*` 值用逗号分隔（如 `"china,local"`）；正则类只能写在 `config.json`。
> 下面按功能分组，**点击各 summary 展开详情**。

<details>
<summary><b>🔵 Core / 核心配置</b></summary>

| 设置                        | 描述                                                                                                                                                                                                                      | 默认值          | Docker 环境变量                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------- |
| `sessionPath`               | 存储浏览器会话的目录                                                                                                                                                                                                      | `sessions`      | —                                     |
| `headless`                  | 在后台运行浏览器                                                                                                                                                                                                          | `false`（可见） | Docker 强制 `true`                    |
| `browserChannel`            | `chromium`（内置补丁版，推荐）或 `msedge`（系统真实 Edge；⚠️ 实验性：Edge 152 + Playwright 1.6x 访问 rewards.bing.com 会崩溃，见 [playwright#41438](https://github.com/microsoft/playwright/issues/41438)，修复后可重试） | `chromium`      | `CONFIG_BROWSER_CHANNEL`              |
| `clusters`                  | 并发账户集群数                                                                                                                                                                                                            | `1`             | `CONFIG_CLUSTERS`                     |
| `errorDiagnostics`          | 出错时保存诊断信息到 `diagnostics/`                                                                                                                                                                                       | `false`         | `CONFIG_ERROR_DIAGNOSTICS`            |
| `ensureStreakProtection`    | 确保连击保护已开启                                                                                                                                                                                                        | `true`          | `CONFIG_ENSURE_STREAK_PROTECTION`     |
| `autoClaimPunchcardRewards` | 自动领取已完成的打卡奖励                                                                                                                                                                                                  | `false`         | `CONFIG_AUTO_CLAIM_PUNCHCARD_REWARDS` |
| `skipNonPointTasks`         | 跳过无积分奖励的任务                                                                                                                                                                                                      | `true`          | `CONFIG_SKIP_NON_POINT_TASKS`         |
| `prewarmDesktopLogin`       | 移动端登录后立即完成桌面端登录并保存会话（需要手机批准的账户可把两次批准集中在运行开头），之后桌面阶段直接复用会话                                                                                                        | `false`         | `CONFIG_PREWARM_DESKTOP_LOGIN`        |
| `accountDelay.min` / `.max` | 下一账户开始前的延迟                                                                                                                                                                                                      | `1min` - `3min` | `CONFIG_ACCOUNT_DELAY_MIN` / `_MAX`   |
| `searchOnBingLocalQueries`  | ExploreOnBing 活动使用本地词库                                                                                                                                                                                            | `false`         | `CONFIG_SEARCH_ON_BING_LOCAL`         |
| `globalTimeout`             | 所有操作的超时时间                                                                                                                                                                                                        | `30sec`         | `CONFIG_GLOBAL_TIMEOUT`               |

</details>

<details>
<summary><b>🗂 Workers / 任务开关</b></summary>

| 设置                           | 描述                         | 默认值  | Docker 环境变量                      |
| ------------------------------ | ---------------------------- | ------- | ------------------------------------ |
| `workers.doDailySet`           | 完成每日集活动               | `true`  | `CONFIG_WORKER_DAILY_SET`            |
| `workers.doClaimBonusPoints`   | 领取 dashboard 奖励积分      | `true`  | `CONFIG_WORKER_CLAIM_BONUS_POINTS`   |
| `workers.doMorePromotions`     | 完成更多促销活动             | `true`  | `CONFIG_WORKER_MORE_PROMOTIONS`      |
| `workers.doPunchCards`         | 完成打卡活动                 | `true`  | `CONFIG_WORKER_PUNCH_CARDS`          |
| `workers.doAppPromotions`      | 完成 App 端活动              | `true`  | `CONFIG_WORKER_APP_PROMOTIONS`       |
| `workers.doDesktopSearch`      | 执行桌面搜索                 | `true`  | `CONFIG_WORKER_DESKTOP_SEARCH`       |
| `workers.doMobileSearch`       | 执行移动搜索                 | `true`  | `CONFIG_WORKER_MOBILE_SEARCH`        |
| `workers.doBonusSearches`      | 超过上限后继续刷加成搜索     | `false` | `CONFIG_WORKER_BONUS_SEARCHES`       |
| `workers.doDailyCheckIn`       | 完成每日签到                 | `true`  | `CONFIG_WORKER_DAILY_CHECKIN`        |
| `workers.doReadToEarn`         | 完成阅读赚取（Read-to-Earn） | `true`  | `CONFIG_WORKER_READ_TO_EARN`         |
| `workers.doActivateSearchPerk` | 激活"再搜 N 次"加成 perk     | `true`  | `CONFIG_WORKER_ACTIVATE_SEARCH_PERK` |
| `workers.doVisualSearch`       | 视觉搜索连击与搜索           | `false` | `CONFIG_WORKER_VISUAL_SEARCH`        |

| 设置（activities）        | 描述                    | 默认值 | Docker 环境变量                  |
| ------------------------- | ----------------------- | ------ | -------------------------------- |
| `activities.urlReward`    | 完成 URL 奖励活动       | `true` | `CONFIG_ACTIVITY_URL_REWARD`     |
| `activities.searchOnBing` | 完成 ExploreOnBing 活动 | `true` | `CONFIG_ACTIVITY_SEARCH_ON_BING` |

</details>

<details>
<summary><b>🔍 Search / 搜索配置</b></summary>

| 设置                                      | 描述                              | 默认值               | Docker 环境变量                         |
| ----------------------------------------- | --------------------------------- | -------------------- | --------------------------------------- |
| `searchSettings.scrollRandomResults`      | 随机滚动搜索结果                  | `true`               | `CONFIG_SEARCH_SCROLL_RANDOM`           |
| `searchSettings.clickRandomResults`       | 点击随机结果链接                  | `true`               | `CONFIG_SEARCH_CLICK_RANDOM`            |
| `searchSettings.runOnZeroPoints`          | 无剩余搜索积分时仍执行搜索        | `false`              | `CONFIG_SEARCH_RUN_ON_ZERO_POINTS`      |
| `searchSettings.maxBonusSearches`         | 单次运行最多加成搜索数            | `110`                | `CONFIG_SEARCH_MAX_BONUS_SEARCHES`      |
| `searchSettings.parallelSearching`        | 桌面/移动搜索并行执行             | `false`              | `CONFIG_SEARCH_PARALLEL`                |
| `searchSettings.clusterSearch`            | Bing 建议聚类扩展主词             | `true`               | `CONFIG_SEARCH_CLUSTER`                 |
| `searchSettings.queryEngines`             | 查询源数组                        | `["china", "local"]` | `CONFIG_SEARCH_QUERY_ENGINES`           |
| `searchSettings.searchResultVisitTime`    | 搜索结果页停留时间                | `20sec`              | `CONFIG_SEARCH_VISIT_TIME`              |
| `searchSettings.searchDelay.min` / `.max` | 搜索之间的延迟                    | `6min` - `12min`     | `CONFIG_SEARCH_DELAY_MIN` / `_MAX`      |
| `searchSettings.readDelay.min` / `.max`   | 阅读赚取的阅读间隔                | `6min` - `11min`     | `CONFIG_SEARCH_READ_DELAY_MIN` / `_MAX` |
| `searchSettings.chinaApi.appkey`          | gmya.net appkey（解除免费档限流） | `""`                 | `CONFIG_CHINA_API_APPKEY`               |

> 📌 **注**：以上默认值为本仓库 `config.example.json` 的国内防风控调优值（官方上游默认更激进：30sec-1min 间隔、并行开启）。

#### 国内推荐配置

```jsonc
// config.json 关键项（.env 中账号 LANG_CODE=zh-CN、GEO_LOCALE=CN）
{
    "searchSettings": {
        "queryEngines": ["china", "local"],
        "chinaApi": { "appkey": "" } // 留空走免费档；填 appkey 解除限流
    }
}
```

</details>

<details>
<summary><b>🌐 queryEngines 查询源说明（含国内可用性）</b></summary>

`searchSettings.queryEngines` 决定搜索主词来源，多源词池合并去重；开启 `clusterSearch` 时每个主词再经 Bing 建议扩展成一组，完成一组才进入下一主词。

**核心源：**

| 值           | 来源                                           | 国内可用性    |
| ------------ | ---------------------------------------------- | ------------- |
| `china`      | 中国热搜（gmya.net：百度/头条/抖音/微博/知乎） | ✅ 直连，推荐 |
| `local`      | 本地查询词（`search-queries.json` 中文词库）   | ✅ 离线       |
| `google`     | Google Trends 热搜                             | ❌ 需代理     |
| `wikipedia`  | 维基百科热门条目                               | ❌ 需代理     |
| `wikirandom` | 随机维基百科条目                               | ❌ 需代理     |
| `hackernews` | Hacker News 首页                               | ❌ 需代理     |
| `reddit`     | Reddit r/popular                               | ❌ 需代理     |

**RSS 源**（点分路径：`rss` 全部 / `rss.<site>` 站点 / `rss.<site>.<endpoint>` 单源）：

| 值                                 | 内容                                                        |
| ---------------------------------- | ----------------------------------------------------------- |
| `rss.googleTrends`                 | Google Trends（`gb`、`us`）                                 |
| `rss.googleNews`                   | Google News（`gb`/`us`/`world`/`technology`/`business`）    |
| `rss.bbc`                          | BBC News（`top`/`world`/`technology`/`business`/`science`） |
| `rss.guardian`                     | The Guardian（`international`/`world`/`technology`）        |
| `rss.theVerge` / `rss.arsTechnica` | The Verge / Ars Technica 全部                               |
| `rss.reddit`                       | Reddit 列表源（`popular`/`worldnews`/`technology`）         |

自定义 RSS 源在 `src/constants/rssFeeds.ts` 中添加。

**china 源策略：**

- 随机选取热榜源聚合（免费档 1 个、配置 appkey 2 个），单源失败自动 fallback 到其余源
- 命中免费档限流（403）时自动退避，并提示配置 `chinaApi.appkey`
- 主源优先：主源原始词累计达 20 即停止请求后续源；主源不足时后续源随机抽样 50 条补充

> [!NOTE]
> `google` / `wikipedia` / `reddit` / `hackernews` 源及多数 RSS 源在国内网络不可直连，选了也会静默失败降级到其他源；无代理环境直接用 `china,local` 即可。

</details>

<details>
<summary><b>🧪 Experimental / 实验特性（默认关闭，可能变化）</b></summary>

| 设置                           | 描述                                 | 默认值  | Docker 环境变量                          |
| ------------------------------ | ------------------------------------ | ------- | ---------------------------------------- |
| `experimental.apiSearch`       | 用 HTTP 请求代替浏览器执行 Bing 搜索 | `false` | `CONFIG_EXPERIMENTAL_API_SEARCH`         |
| `experimental.apiSearchOnBing` | 用 HTTP 完成 ExploreOnBing 活动      | `false` | `CONFIG_EXPERIMENTAL_API_SEARCH_ON_BING` |
| `experimental.blockMedia`      | 拦截浏览器图片/媒体请求省流量        | `false` | `CONFIG_EXPERIMENTAL_BLOCK_MEDIA`        |
| `experimental.edgeBrowsing`    | 后台 HTTP 上报 30 分钟 Edge 浏览活动 | `false` | `CONFIG_EXPERIMENTAL_EDGE_BROWSING`      |

> 💡 API 路径更快但依赖新版面板接口；若 ExploreOnBing 活动积分未到账，关闭 `apiSearchOnBing` 回退浏览器路径。

</details>

<details>
<summary><b>📝 Logging / 日志</b></summary>

| 设置                             | 描述                                | 默认值                 | Docker 环境变量              |
| -------------------------------- | ----------------------------------- | ---------------------- | ---------------------------- |
| `debugLogs`                      | 输出 DEBUG 级别日志                 | `false`                | `CONFIG_DEBUG_LOGS`          |
| `consoleLogFilter.enabled`       | 启用控制台日志过滤                  | `false`                | `CONFIG_LOG_FILTER_ENABLED`  |
| `consoleLogFilter.mode`          | 过滤模式（`whitelist`/`blacklist`） | `whitelist`            | `CONFIG_LOG_FILTER_MODE`     |
| `consoleLogFilter.levels`        | 过滤的日志级别                      | `["error", "warn"]`    | `CONFIG_LOG_FILTER_LEVELS`   |
| `consoleLogFilter.keywords`      | 过滤关键词                          | `["starting account"]` | `CONFIG_LOG_FILTER_KEYWORDS` |
| `consoleLogFilter.regexPatterns` | 过滤正则                            | `[]`                   | 仅 config.json               |

> 📌 日志默认全量写入 `logs/YYYY-MM-DD.log`（按本地日期分文件），进程启动时自动清理 90 天前的旧文件（`src/logging/Logger.ts` 中的 `LOG_RETENTION_DAYS` 可调整）。

</details>

<details>
<summary><b>🧬 Humanize / 拟人化运行策略（V4-china 特有，默认关闭）</b></summary>

降低风控特征的运行策略集合。`humanize.enabled=false`（默认）时以下全部不生效，行为与原版一致。

| 设置                                       | 描述                                                                                                  | 默认值         | Docker 环境变量                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------- |
| `humanize.enabled`                         | 总开关                                                                                                | `false`        | `CONFIG_HUMANIZE_ENABLED`                          |
| `humanize.skipWhenCompletedToday`          | 当天已成功运行过（`logs/last-success.txt`）则再次启动时直接退出，配合早晚两次定时实现"兜底轮自动跳过" | `false`        | `CONFIG_HUMANIZE_SKIP_WHEN_COMPLETED`              |
| `humanize.quietHours`                      | 静默时段数组；运行中进入时段自动挂起到结束，启动时落在时段内也等待后再跑。支持 `start > end` 跨午夜   | `[]`           | 仅 config.json                                     |
| `humanize.searchTargetRatio.min` / `.max`  | 每轮搜索目标完成度随机区间（移动/桌面各自抽取），保留分向下取整到 3 的倍数                            | `0.85` - `1.0` | `CONFIG_HUMANIZE_SEARCH_TARGET_RATIO_MIN` / `_MAX` |
| `humanize.readToEarnArticles.min` / `.max` | Read-to-Earn 每轮随机阅读篇数上限区间                                                                 | `7` - `10`     | `CONFIG_HUMANIZE_READ_TO_EARN_MIN` / `_MAX`        |

`quietHours` 规则示例（days 支持全名或缩写，未列出的天不静默）：

```json
"quietHours": [
    { "days": ["monday", "tuesday", "wednesday", "thursday", "friday"], "start": "12:00", "end": "14:30" },
    { "days": ["saturday"], "start": "12:00", "end": "19:00" }
]
```

> 💡 想手动强制重跑当天已成功的任务：临时把 `skipWhenCompletedToday` 改为 `false`（或删除 `logs/last-success.txt`）。
> 拟人化参数不分轮次：无论第几次运行都用同一套随机规则，作用于"当时的剩余额度"。

</details>

<details>
<summary><b>🌍 Proxy / 代理</b></summary>

| 设置                            | 描述                                | 默认值  | Docker 环境变量                          |
| ------------------------------- | ----------------------------------- | ------- | ---------------------------------------- |
| `proxy.queryEngine`             | 查询源 HTTP 请求走账户代理          | `true`  | `CONFIG_PROXY_QUERY_ENGINE`              |
| `proxy.ignoreCertificateErrors` | 关闭浏览器 TLS 校验（拦截型代理用） | `false` | `CONFIG_PROXY_IGNORE_CERTIFICATE_ERRORS` |

**账户级代理**（`.env` 中按账号配置）：

- 浏览器代理：`ACCOUNT_N_PROXY_URL`（支持 `http://`、`https://`、`socks4://`、`socks5://`，裸主机名视为 HTTP）
- HTTP 代理认证：`ACCOUNT_N_PROXY_USERNAME` / `ACCOUNT_N_PROXY_PASSWORD`（Patchright 不支持 SOCKS 浏览器认证）
- 查询源请求代理：`ACCOUNT_N_PROXY_HTTP=true` 并配置 `ACCOUNT_N_PROXY_*`

代理商标注“支持 HTTPS”通常表示支持 HTTPS 网站的 CONNECT 转发，此时代理地址使用 `http://主机`；仅当入口本身提供 TLS 时使用 `https://主机`。端口按供应商提供的代理端口填写，用户名/密码认证填写独立字段，IP 白名单认证需放行服务器实际出口 IP。

账号列表显示已配置的完整代理地址，例如 `http://203.0.113.7:10809`；旧裸 IP 同样按 HTTP 显示。单独填写的端口优先于地址中的端口，认证凭据只显示锁图标。点击“测代理”后，结果中的出口 IP 由回显服务查询。

“测代理”优先使用 HTTPS 回显并尝试备用服务。连接可用但回显服务被限制时，面板提示“代理已连通，但出口 IP 查询失败”；测试得到的 IP 来自回显服务，代理主机地址无法替代出口 IP。HTTPS 握手失败会返回错误，修复后的测试组件会捕获断开和超时异常。

地址仍只显示协议或旧格式时，核对源码是否包含 `f5818a2` 或后续提交，重建镜像后按 `Ctrl + F5` 刷新面板。代理配置及故障提示对照见 [2026-11-25 更新说明](RELEASE_NOTES_20261125.md)。

> ⚠️ `ignoreCertificateErrors` 会削弱整个浏览器上下文的 TLS 保护，仅在受信拦截代理无法出示有效证书时开启。

</details>

---

## 🔔 通知渠道

均在 `webhook` 对象下，**可同时开启多个**：

| 设置                                                                        | 描述                                            | 默认值  | Docker 环境变量                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------- | ------- | --------------------------------------------------- |
| `webhook.discord.enabled` / `.url`                                          | Discord 推送                                    | `false` | `CONFIG_DISCORD_ENABLED` / `_URL`                   |
| `webhook.telegram.enabled` / `.botToken` / `.chatId`                        | Telegram 推送                                   | `false` | `CONFIG_TELEGRAM_ENABLED` / `_BOTTOKEN` / `_CHATID` |
| `webhook.ntfy.enabled` / `.url` / `.topic` / `.token` 等                    | ntfy 推送                                       | `false` | `CONFIG_NTFY_*`                                     |
| `webhook.pushplus.enabled` / `.token` / `.title` / `.template` / `.channel` | PushPlus 微信推送                               | `false` | `CONFIG_PUSHPLUS_*`                                 |
| `webhook.serverchan.enabled` / `.sendKey` / `.title`                        | Server酱 微信推送（Turbo）                      | `false` | `CONFIG_SERVERCHAN_ENABLED` / `_SENDKEY` / `_TITLE` |
| `webhook.clawbot.enabled` / `.authFile`                                     | 微信 ClawBot 推送                               | `false` | `CONFIG_CLAWBOT_ENABLED` / `_AUTHFILE`              |
| `webhook.webhookLogFilter.*`                                                | Webhook 逐条日志过滤（结构同 consoleLogFilter） | `false` | `CONFIG_WEBHOOK_LOG_FILTER_*`                       |

> 💡 **国内推荐**：**PushPlus** 或 **微信 ClawBot**（均直达微信，无需翻墙）。Discord / Telegram / ntfy 需要能访问对应服务。
> 运行结束的中文积分摘要会一次性推送（不逐条推日志）。

<details>
<summary><b>🤖 微信 ClawBot 推送（V4-china 特有）</b></summary>

基于腾讯官方微信 ClawBot（iLink 灰度接口）直连推送，**免费、无第三方服务、消息直达微信聊天列表**。需要你的微信号有 ClawBot 灰度资格（微信 → 我 → 设置 → 插件）。

使用只需三步：

1. `config.json` 中开启：`"webhook": { "clawbot": { "enabled": true } }`
2. 正常启动脚本（如 `npm start`）——检测到未登录时，终端会**自动弹出二维码**，手机微信扫码确认（等待 5 分钟，超时则本次跳过推送，任务照常运行）
3. 登录后终端提示激活时，在手机微信里给「微信 ClawBot」**发送一条任意消息**（等待 2 分钟）——脚本会自动抓取激活凭证并回发一条"✅ 通知已接通"

之后每次运行结束，积分摘要会自动推送到你的微信。凭证保存在项目根 `clawbot-auth.json`（已加入 .gitignore），多台机器可直接复制该文件共用。也可用 `npm run clawbot:login` 手动完成登录+激活。凭证过期（服务端 -14）时自动清除、下次运行重新扫码；推送上下文失效（-2）时下次运行会重新等待激活消息。

</details>

---

## ❓ 常见问题

<details>
<summary><b>报错 <code>Error: browserType.launch: Executable doesn't exist</code> 怎么办？</b></summary>

Chromium 没装上，手动安装：

```bash
npx patchright install chromium
```

</details>

<details>
<summary><b>登录失败 / 卡住 / 每次都要重新登录？</b></summary>

可在控制面板「账号管理」点击对应账号的 **保存登录会话**，依次完成手机端和电脑端认证；验证码或安全邮箱通过「实时日志」页面输入。该操作仅登录并保存会话，结束后自动退出，不执行积分任务、不发送任务通知，也不计入积分历史或账号战绩。已有会话会先尝试复用，登录失败不会在关闭浏览器时覆盖旧会话。

保存前会通过账号所在地区的 Bing 接口核实登录状态、余额和搜索额度；验证失败会提示错误，不把未验证会话当作成功保存。删除会话后可重复上述操作，无需跑完每日任务、阅读和搜索。控制 API 也支持 `POST /accounts/:index/login`，请求体的 `platform` 可选 `mobile`、`desktop` 或 `both`（默认）。已有任务运行时返回 409，请先停止该任务。登录后的 cookie 会保存到 `sessions/` 目录，后续运行自动复用。

若账号管理未显示按钮，核对部署是否包含本次更新，重建镜像后强制刷新面板。**只跑此号** 会执行配置中的积分任务；保存会话请使用 **保存登录会话**。逐平台保存结果和进程退出需分别确认，详见 [升级验收步骤](UPGRADE_GUIDE.md#步骤-d验证控制台与账号)。

⚠️ `sessions/` 目录**需要多备份**，丢了就要重新登录。

也可用会话管理命令查看/清理：

```bash
npm run clear-sessions -- list          # 列出所有账户会话
npm run clear-sessions -- email user@example.com   # 删除指定账户会话
npm run clear-sessions -- all           # 删除全部会话
```

也可以用 `manual-login` 命令手动登录指定账户：它会打开有界面的浏览器（不走自动登录流程），你手动完成微软登录后，脚本检测到浏览器在 `rewards.bing.com` 停留 5 秒即自动保存会话并关闭浏览器：

```bash
npm run manual-login -- --email user@example.com                # 创建/刷新移动端会话
npm run manual-login -- --email user@example.com --platform desktop   # 仅桌面端会话
npm run manual-login -- --email user@example.com --platform both      # 桌面+移动依次创建
npm run manual-login -- --email user@example.com --fresh        # 忽略已有 cookie 全新登录
```

**需要手机 Authenticator 批准登录的账户**，桌面端会话失效时第二次批准会出现在运行后段（几小时后），容易错过。开启 `"prewarmDesktopLogin": true` 后，桌面端登录会提前到移动端登录完成后立刻执行并保存会话（两次批准集中在运行开头几分钟内），后续桌面任务直接复用会话不再触发批准：

```json
{
    "prewarmDesktopLogin": true
}
```

</details>

<details>
<summary><b>修改 <code>.env</code> / <code>config.json</code> 后怎么生效？</b></summary>

- **Win 环境**：`.env` 在脚本启动时读取，改完重新 `npm start` 即可；`config.json` 改完建议 `npm run build` 后再启动
- **Docker 环境**：改 `.env` 或 `compose.yaml` 后用 `docker compose up -d --build` 生效；不要手动改容器内配置文件

</details>

<details>
<summary><b>Docker 改了配置为什么不生效？</b></summary>

改完 `compose.yaml` 或代码后，必须加 `--build` 重建镜像：

```bash
docker compose up -d --build
```

不加 `--build` 跑的是旧镜像。

</details>

<details>
<summary><b>国内查询词被限流（403）怎么办？</b></summary>

gmya.net 免费档对连续请求有频率限制。解决方法：

到 [gmya.net](https://gmya.net) 申请 appkey，填入 `searchSettings.chinaApi.appkey`（Docker 用 `CONFIG_CHINA_API_APPKEY` 环境变量），即可解除限流。

</details>

<details>
<summary><b>v3 的 <code>accounts.json</code> / <code>config.json</code> 能直接用吗？</b></summary>

不能。本分支与 v3 及更早版本**均不兼容**：

- 账号迁移到 `.env`（`ACCOUNT_1_EMAIL` 等，参考 `env.example`）
- 配置文件基于本分支 `config.example.json` 重新生成

</details>

<details>
<summary><b>ClawBot 推送没收到 / 提示凭证过期？</b></summary>

- 确认微信号有 ClawBot 灰度资格（微信 → 我 → 设置 → 插件），且首次扫码后给「微信 ClawBot」发过一条消息激活
- 凭证过期（服务端 -14）会自动清除，下次运行重新扫码；或手动 `npm run clawbot:login`
- iLink 服务端限频约 7 条 / 5 分钟，摘要为一次性推送，一般不会触发

</details>

---

## ⚠️ 注意事项

- `.env` 含账户密码，**严禁提交或分享**（已加入 `.gitignore`）；`clawbot-auth.json` 含推送凭证，同样勿提交。
- 如果出现无法自动登录的情况，请在代码执行登录过程中**手动完成网页登录**，等待代码自动完成剩余流程。登录信息保存在 `sessions/` 目录（需要多备份）。
- **Win 环境**：复制或重命名 `config.example.json` 为 `config.json`（项目根目录）并自定义偏好；修改后运行 `npm run build` 重新构建。
- **Docker 环境**：账号和行为配置通过 `.env` 和 `compose.yaml` 传入；`CONFIG_*` 每次启动都会覆盖 `./config/config.json`。
- 之前的 `accounts.json` 和旧版 `config.json` 与本分支不兼容。

---

## 📜 开源引用与致谢

感谢原始项目 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) 与直接上游 [chiihero/Microsoft-Rewards-Script](https://github.com/chiihero/Microsoft-Rewards-Script)。派生关系、兼容项目和锁定依赖许可见 [第三方声明](THIRD-PARTY-NOTICES.md)。

---

## ⚠️ 免责声明

**风险自负！** 使用自动化脚本时，您的 Microsoft Rewards 账户可能会被暂停或禁止。

此脚本仅供教育目的。作者对 Microsoft 采取的任何账户操作不承担责任。
