# Microsoft Rewards Script - Vibe-Coding 专属工程指南

> 本文档专为 **Vibe-Coding**（人机协同、AI 辅助编程，如 Cursor、Trae、Windsurf、Claude Code、Devin 等）量身打造，系统梳理项目核心架构、扩展模式、开源引用与调试最佳实践。

- **官方主仓库**: [youkum/Microsoft-Rewards-Script](https://github.com/youkum/Microsoft-Rewards-Script)
- **主力维护分支**: `V4-china`
- **一键克隆命令**:
  ```bash
  git clone -b V4-china https://github.com/youkum/Microsoft-Rewards-Script.git
  ```

---

## 📑 目录
- [一、项目全景与架构设计](#一项目全景与架构设计)
  - [1. 整体流转体系](#1-整体流转体系)
  - [2. 关键核心模块](#2-关键核心模块)
- [二、六重积分探测降级体系（高可用）](#二六重积分探测降级体系高可用)
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
       +---> [4. 初始全量积分画像] (getAllAccountPoints 6重降级快照)
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

## 二、六重积分探测降级体系（高可用）

为了防止微软 Rewards 前端界面频繁迭代导致脚本崩溃，本项目实现了**6 级全自动积分降级探测**：

| 探测层级 | 实现方式 | 适用场景 |
| :--- | :--- | :--- |
| **Tier 1: 官方主接口** | `https://rewards.bing.com/api/getuserinfo` | 官方标准 API，速度最快，数据最全 |
| **Tier 2: Flyout 接口** | `https://www.bing.com/rewards/panelflyout/getuserinfo` | 桌面与移动端轻量悬浮窗接口 |
| **Tier 3: 浏览器内生 Fetch** | 在真实页面上下文调用 `page.evaluate()` 执行内部 API | 完美复用会话 Cookie，规避独立网络层代理指纹异常 |
| **Tier 4: DOM 元素抽取** | 抓取 `#id_rc`, `[data-bi-id="rewards-points"]` 等文本 | 接口全部失效时，直接从已渲染网页提取 |
| **Tier 5: React Flight 快照** | 解析现代 Bing 页面的 RSC 数据流 | 提取 React 虚拟 DOM 挂载的初始状态 |
| **Tier 6: 基础保底兜底** | 返回预置基础对象，数字全部置为安全值 | 保证流程 100% 不中断，WebUI 保持稳定 |

---

## 三、自适应认证与弹窗拦截状态机

在 `src/browser/auth/Login.ts` 中维护了一套健壮的认证状态机：
- `EMAIL_ENTRY`: 自动适配 `#i0116`, `input[name="loginfmt"]`, `#usernameEntry` 等所有新旧表单。
- `PASSWORD_ENTRY`: 适配 `#i0118`, `input[name="passwd"]`, `#passwordEntry`。
- `KMSI_PROMPT` (保持登录提示): 自动勾选“不再显示”并点击“是”。
- `INTERSTITIAL_SKIP`: 自动识别并跳过“体验无密码”、“保护你的账户”、“添加备用邮箱”等微软阶段性拦截页。
- `ERROR_ALERT`: 智能区分临时 Cookie 协议弹窗（自动点击同意关闭）与真正的密码错误/账号锁定。

---

## 四、WebUI 控制面板与 SSE 实时日志系统

项目配套了专用的 Web 控制面板（默认运行于 `http://<服务器IP>:8890`）：

1. **工作模式**:
   Docker 容器内以 `API_MODE=true` 启动，主脚本通过 `scripts/api/server.js` 启动 3010 端口。
2. **日志契约**:
   - WebUI 仪表盘通过 `scripts/api/logParser.js` 捕获控制台日志。
   - **关键输出示例**:
     ```text
     [2026-10-31 11:00:00] [user] [INFO] MAIN [FLOW] 积分已收集 | 获得积分=45 | 现余额=12350 | 账户=user@example.com
     ```
   - 任何涉及日志重构的操作，请勿修改 `FLOW`、`ACCOUNT-START`、`RUN-END` 等关键字。

---

## 五、致谢与引用的开源项目

本项目深度集成了开源社区的优秀项目，谨向以下开源作者与项目致以诚挚敬意：

1. **[TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script)**
   - **协议**: GNU General Public License v3.0 (GPL-3.0)
   - **贡献**: 项目的核心上游，确立了 TypeScript 模块化架构与基础任务执行体系。

2. **[chiihero/Microsoft-Rewards-Script](https://github.com/chiihero/Microsoft-Rewards-Script)**
   - **分支**: `V4-china`
   - **贡献**: 针对国内用户环境的深度汉化与优化，实现了基于中国热搜的随机词源引擎，集成了 PushPlus 与 ClawBot 等微信通知渠道。

3. **[mgrimace/rewards-dashboard](https://github.com/mgrimace/rewards-dashboard)**
   - **协议**: MIT License
   - **贡献**: 提供了现代化的 WebUI 监控面板，基于 SQLite 持久化多账户积分历史，并通过 SSE 实现与脚本核心的双向协同控制。

4. **[Kaliiiiiiiiii-Venyx/patchright](https://github.com/Kaliiiiiiiiii-Venyx/patchright)**
   - **贡献**: 深度修补 Playwright CDP 协议特征的反反爬无头浏览器内核，大幅降低微软 Bot 检测标记风险。

5. **[apify/fingerprint-suite](https://github.com/apify/fingerprint-suite)** (`fingerprint-generator` & `fingerprint-injector`)
   - **协议**: Apache-2.0
   - **贡献**: 生成高仿真真实设备指纹（Canvas/WebGL/音频/屏幕分辨率），规避机械化特征风控。

6. **[Xynon69/ghost-cursor-playwright-port](https://github.com/Xynon69/ghost-cursor-playwright-port)**
   - **协议**: MIT License
   - **贡献**: 基于贝塞尔曲线的拟人化鼠标移动与随机平滑滚动算法。

7. **[hectorm/otpauth](https://github.com/hectorm/otpauth)**
   - **协议**: MIT License
   - **贡献**: 高性能 RFC 6238 / RFC 4226 TOTP 双因素认证动态密码计算。

8. **[alextunbridge/impit](https://github.com/alextunbridge/impit)**
   - **协议**: MIT License
   - **贡献**: 高性能且支持 TLS 指纹定制的 HTTP 客户端。

---

## 六、AI / Vibe-Coding 常用提示词与调试命令

### 常用验证命令
```bash
# 1. 验证编译是否正常（0 报错即为健康）
npm run build

# 2. 验证 WebUI 日志正则解析器（全绿通过）
npm run test:log-parser

# 3. 校验代码格式规范
npm run format:check

# 4. 启动单次前台调试
npm run dev
```

### 推荐的 Vibe-Coding 提示词模板

#### 1. 增加新的活动打卡支持：
> “我想在 `src/browser/BrowserFunc.ts` 中增加一个针对微软新活动（如 Puzzle 拼图任务）的执行逻辑，请遵循现有的拟人化点击规范与 try-catch 降级机制，不要影响 `getAllAccountPoints` 的字段结构。”

#### 2. 优化登录异常处理：
> “请在 `src/browser/auth/Login.ts` 中针对微软出现的某种新型验证码/拦截页增加一种识别状态，确保处理完毕后通过状态机回退，严禁抛出致命未捕获错误导致进程退出。”

#### 3. 调整 WebUI 数据展示：
> “我想在 WebUI 中展示账户当前的连续签到天数，请检查 `scripts/api/logParser.js` 中的正则匹配与 `src/index.ts` 中的日志输出，确保中英文格式均能正确被解析。”
