# Microsoft Rewards Script - Vibe-Coding 专属工程指南

> 🤖 **核心声明**：**此项目由 AI 在人类的帮助下全面接手二次开发，人工提供了开发建议和提示词优化。**
> 本文档专为 **Vibe-Coding**（人机协同、AI 辅助编程，如 Cursor、Trae、Windsurf、Claude Code、Devin 等）量身打造，系统梳理项目核心架构、扩展模式、开源引用与调试最佳实践。

- **本项目仓库**: [youkum/Microsoft-Rewards-Script](https://github.com/youkum/Microsoft-Rewards-Script)
- **主力维护分支**: `V4-china`
- **当前交接入口**: [AI 交接指南](AI-HANDOFF.md)、[2026-11-25 更新说明](RELEASE_NOTES_20261125.md) 与 [开发验证指南](DEVELOPMENT.md)。离线 AI 分发包已撤下，接手使用当前源码和仓库文档。
- **一键克隆命令**:
    ```bash
    git clone -b V4-china https://github.com/youkum/Microsoft-Rewards-Script.git
    ```

---

## 📑 目录

- [一、项目全景与架构设计](#一项目全景与架构设计)
    - [1. 整体流转体系](#1-整体流转体系)
    - [2. 关键核心模块](#2-关键核心模块)
- [二、区域积分读取与数据可信度](#二区域积分读取与数据可信度)
- [三、自适应认证与弹窗拦截状态机](#三自适应认证与弹窗拦截状态机)
- [四、WebUI 控制面板与 SSE 实时日志系统](#四webui-控制面板与-sse-实时日志系统)
- [五、致谢与引用的开源项目](#五致谢与引用的开源项目)
- [六、AI / Vibe-Coding 常用提示词与调试命令](#六ai--vibe-coding-常用提示词与调试命令)

---

## 一、项目全景与架构设计

### 1. 整体流转体系

```
+--------------------------------------------------------------------------+
|                       Microsoft Rewards Script (V4-china)                |
+--------------------------------------------------------------------------+
       |
       +---> [1. 初始化与配置加载] (loadAccounts, ConfigSync, HttpClient)
       |
       +---> [2. 浏览器与反反爬引擎] (Patchright + Fingerprint + GhostCursor)
       |
       +---> [3. 自适应智能登录] (Login.ts 状态机: 自动处理 KMSI/2FA/拦截页)
       |
       +---> [运行模式分支]
       |         ├── 仅登录：核实上游余额/额度 → 每端保存 → 退出
       |         └── 常规任务：继续下列积分流程
       |
       +---> [4. 初始全量积分画像] (getAllAccountPoints + balanceVerified)
       |
       +---> [5. 自动化任务流水线]
       |         ├── 必应桌面搜索 (国内热搜/本地题库/聚类扩展)
       |         ├── 必应移动端搜索 (模拟真实移动 UA)
       |         ├── 每日签到与阅读赚取 (DailyCheckIn / ReadToEarn)
       |         └── 促销活动打卡 (DailySet / MorePromotions)
       |
       +---> [6. 终态积分结算与报表] (formatPointsSummary 格式化输出)
       |
       +---> [7. 多渠道通知与 WebUI] (PushPlus / ClawBot / WebUI:8890)
```

### 2. 关键核心模块

- **任务中枢**: `src/index.ts`
  负责账户调度、并发/串行队列、进程信号捕获及全局通知分发。
- **浏览器交互**: `src/browser/BrowserFunc.ts`
  所有与页面交互、活动打卡、搜索执行、积分抓取的集中实现。
- **认证中心**: `src/browser/auth/Login.ts`
  驱动完整的 Microsoft 登录流程，处理密码、无密码、TOTP 2FA 及安全提示页。
- **控制 API 与日志解析**: `scripts/api/`
  提供独立的 HTTP 服务 (`server.js`) 与日志正则提取器 (`logParser.js`)，将终端日志实时结构化并送达 WebUI 面板。

---

## 二、区域积分读取与数据可信度

`getDashboardData()` 按以下顺序读取 Dashboard。CN 账号使用 `cn.bing.com`，其他地区使用 `www.bing.com`，Cookie、Referer、Origin 与目标域名匹配。

| 顺序 | 实现方式                                                    | 判定要求                                           |
| :--- | :---------------------------------------------------------- | :------------------------------------------------- |
| 1    | 区域 `/rewards/panelflyout/getuserinfo`，配置的 HTTP 客户端 | 映射认证状态与可用字段，记录数据质量               |
| 2    | 同一区域接口，浏览器 `page.request.get`                     | 共享浏览器 Cookie，避免页面跨域 Fetch 的 CORS 问题 |
| 3    | 旧 `rewards.bing.com/api/getuserinfo`                       | 同账号未失败时最多尝试两次，失败后跳过该旧接口     |
| 4    | 本地兼容对象                                                | `dataQuality` 的余额、搜索、活动均为未核实         |

余额读取另有浏览器 Flyout、DOM 文本与 React 快照探测；这些不是完整 Dashboard 的额外线性阶段。读取到余额也不能证明搜索额度或活动列表可用。

`DashboardData.dataQuality` 保存 `source`、`balance`、`search`、`activities`，`AccountAllPointsSummary.balanceVerified` 表示余额是否核实。未知额度或活动列表不能解释为已完成的 `0/0`；未知起始或最终余额不能结算成功收益。缺少任务所需数据时受控报错，保留兼容结构不代表可以成功执行所有任务。

账号入口重置余额、活动上下文和旧接口失败标记。日志解析时 DEBUG 活动响应不累计收益，INFO 增量与阅读/搜索累计汇总只补足差额；搜索额度增长或签到 HTTP 200 不能单独证明可用余额已入账。

---

## 三、自适应认证与弹窗拦截状态机

在 `src/browser/auth/Login.ts` 中维护了一套健壮的认证状态机：

- `EMAIL_INPUT`: 自动适配 `#i0116`, `input[name="loginfmt"]`, `#usernameEntry` 等新旧表单。
- `PASSWORD_INPUT`: 适配 `#i0118`, `input[name="passwd"]`, `#passwordEntry`。
- `KMSI_PROMPT` (保持登录提示): 自动勾选“不再显示”并点击“是”。
- `INTERSTITIAL_SKIP`: 自动识别并跳过“体验无密码”、“保护你的账户”、“添加备用邮箱”等微软阶段性拦截页。
- `ERROR_ALERT`: 智能区分临时 Cookie 协议弹窗（自动点击同意关闭）与真正的密码错误/账号锁定。

---

## 四、WebUI 控制面板与 SSE 实时日志系统

项目配套内嵌 Web 控制面板。Docker 默认仅宿主机 `http://127.0.0.1:8890` 可访问，远程使用 [SSH 隧道](UPGRADE_GUIDE.md#43-认证端口和-compose-override)；原生 API 默认使用 `http://127.0.0.1:3010`。

1. **工作模式**:
   Docker 容器内以 `API_MODE=true` 启动，主脚本通过 `scripts/api/server.js` 启动 3010 端口。
2. **日志契约**:
    - WebUI 仪表盘通过 `scripts/api/logParser.js` 捕获控制台日志。
    - **关键输出示例**:
        ```text
        [2026-10-31 11:00:00] [user] [INFO] MAIN [FLOW] 积分已收集 | 获得积分=45 | 现余额=12350 | 账户=user@example.com
        ```
    - 任何涉及日志重构的操作，请勿修改 `FLOW`、`ACCOUNT-START`、`RUN-END` 等关键字。
3. **单账号保存登录会话**：
    - 在“账号管理”点击目标账号的 **保存登录会话**，默认手机端先行、电脑端随后；需要安全邮箱或验证码时在“实时日志”提交。
    - `POST /accounts/:index/login` 的 `platform` 支持 `mobile`、`desktop`、`both`（默认），仅使用该账号既有配置。无效平台返回 400，已有任务运行返回 409。
    - 复用已有会话，保存前两端都必须核实上游余额与搜索额度，每端立即保存。失败不保存未验证会话，失败清理不覆盖旧会话。
    - 仅登录跳过活动上下文初始化、积分任务、App 活动令牌、每日/静默时间跳过规则及任务通知，成功或失败均退出并释放运行锁。
    - `ProcessManager` 在首条日志前设置 `mode: "login"`。`/history` 保留维护记录，`/points/history` 和账号战绩排除维护记录；账号增删改仍受账号写权限开关控制，登录使用运行控制权限。

---

## 五、致谢与引用的开源项目

本项目深度集成了开源社区的优秀项目，谨向以下开源作者与项目致以诚挚敬意：

上游、兼容面板与依赖许可统一维护在 [第三方声明](THIRD-PARTY-NOTICES.md)。

## 六、AI / Vibe-Coding 常用提示词与调试命令

### 常用验证命令

```bash
# 1. 验证编译是否正常（0 报错即为健康）
npm run build

# 2. 验证 WebUI 日志正则解析器（全绿通过）
npm run test:log-parser

# 3. 核心/API/WebUI 回归与相关模块验证
npm test
npm run test:performance
npm run test:preview

# 4. 校验代码格式规范
npm run format:check

# 5. 启动单次前台调试（会执行配置中的任务）
npm run dev
```

### 推荐的 Vibe-Coding 提示词模板

#### 1. 增加新的活动打卡支持：

> “我想在 `src/browser/BrowserFunc.ts` 中增加一个针对微软新活动（如 Puzzle 拼图任务）的执行逻辑，请遵循现有的拟人化点击规范与 try-catch 降级机制，不要影响 `getAllAccountPoints` 的字段结构。”

#### 2. 优化登录异常处理：

> “请在 `src/browser/auth/Login.ts` 中识别新的验证码或拦截页，保持上游余额与额度验证。仅登录失败应清晰报错、保留旧会话并退出释放运行锁，成功后按平台立即保存。”

#### 3. 调整 WebUI 数据展示：

> “我想在 WebUI 中展示账户当前的连续签到天数，请检查 `scripts/api/logParser.js` 中的正则匹配与 `src/index.ts` 中的日志输出，确保中英文格式均能正确被解析。”

行为变更应同时维护 [更新日志](CHANGELOG.md)、[用户指南](README.md)、[API 文档](scripts/api/README.md) 和 [交接指南](AI-HANDOFF.md)。验证范围与发布条件见 [开发指南](DEVELOPMENT.md) 和 [验收指南](CODEX_INSPECTION_GUIDE.md)；原始账号日志和会话保存在私有记录中。
