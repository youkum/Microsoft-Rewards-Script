# Microsoft Rewards Script (V4-china) 验收指南

本文件用于复现验收，不是生产部署证明。项目关系及许可见 [第三方声明](THIRD-PARTY-NOTICES.md)，公开变更与发布状态分别见 [更新日志](CHANGELOG.md) 和 [GitHub Releases](https://github.com/youkum/Microsoft-Rewards-Script/releases)。

## 1. 构建与自动化验证

在待验收提交的干净检出中，使用 Node.js 24：

```sh
git rev-parse HEAD
npm ci --include=optional --ignore-scripts
npm run build
npm test
npm run test:performance
npm run test:preview
npm run test:platform:lock
npm run lint
npm run format:check
```

`npm test` 包含 API 和 WebUI 单元测试；记录实际通过数及退出码，不固定测试数量。另在 [GitHub Actions](https://github.com/youkum/Microsoft-Rewards-Script/actions/workflows/validate.yml) 检查**相同提交**的两个 Dockerfile × amd64/arm64 容器任务。离线自检不访问 Rewards 或发送真实通知。

| 核验项               | 代码或证据                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 单账号／排除账号隔离 | [账户环境构造](scripts/api/accounts.js) 与 [配置加载](src/util/Load.ts)；在隔离测试环境确认只选择预期槽位                                        |
| 登录流程             | [登录状态机](src/browser/auth/Login.ts)；夹具或经批准的测试账号验证，区分读取保存会话和实际登录成功                                              |
| 独立登录维护         | [运行入口](src/index.ts)、[进程管理](scripts/api/processManager.js)；核对单账号、平台、严格保存、退出与维护统计隔离                              |
| 积分可信度与计数     | [区域映射](src/browser/FlyoutDashboard.ts)、[积分读取](src/browser/BrowserFunc.ts)、[日志解析](scripts/api/logParser.js)；核对未知数据与重复汇总 |
| WebUI 与 API         | [API 文档](scripts/api/README.md) 与 [静态模块](scripts/api/web/)；检查控制台、鉴权、模块加载及 SSE                                              |
| 预测与通知           | [预测逻辑](scripts/rewardForecast.cjs)；先用不发送通知的预览，再单独记录经授权的送达验证                                                         |
| 调度与回滚           | [容器入口](scripts/docker/entrypoint.sh)；用测试容器检查 cron 启停和无任务启动，生产中已保存的计划另行核对                                       |

配置/统计持久化需另外核对 [持久运行统计](scripts/api/runHistory.js) 与 [回归测试](scripts/api/persistence.test.js)，覆盖符号链接、配置、历史、累计值与登录隔离。

## 2. 积分与独立登录验收

在隔离测试环境，或已有授权的账号维护范围内验证：

1. `POST /accounts/:index/login` 仅选择指定账号；默认 `both` 按手机端、电脑端执行，另外验证单端选择。非法平台为 400、活动运行冲突为 409，Cookie 写请求保留 CSRF 头要求。
2. 面板“账号管理”显示 **保存登录会话**，验证码/安全邮箱在实时日志页提交。读取已有 Cookie、停留在 Bing 页面或返回 HTTP 200 均不单独证明认证成功；两端需收到可映射的已登录余额与搜索额度，再分别保存。
3. 成功或失败后子进程退出并释放锁；验证失败不保存未核实会话，失败清理不覆盖旧会话。部分平台成功保存时按平台报告，不把后续失败写成两端成功。
4. `mode: "login"` 在首条日志前设置，覆盖早期失败。`/history` 可见维护记录，积分历史、账号战绩及任务通知排除维护；不执行积分 workers、App 令牌或每日/静默时间规则。
5. 上游缺少搜索额度或活动列表时保留未核实标记，不能当作已完成 `0/0`；起始/最终余额未知时收益未知。有效的零余额与缺失余额需分别验证。
6. 切换账号重置余额、活动上下文及旧接口失败标记；重复 DEBUG/INFO 与阅读/搜索累计汇总不得双计。分别核对搜索额度进度、签到响应与可用余额入账。

用合成数据保存通知和积分配置，重启 API 并重建根配置链接，确认真实挂载文件及设置保留；设置小的 `API_RUN_HISTORY`，确认账号累计不随记录截断、JSONL 轮转或重复重启清零/双计。实际容器复验前先导出旧容器配置并停止活动任务、备份持久目录。只比较已结算记录，不宣称突然断电可恢复进行中的任务。

源码契约测试、模拟 HTTP/UI 与真实上游证据分别记录；源码检查通过不能代替已登录接口响应。当前变更及验证范围见 [更新日志](CHANGELOG.md) 与 [2026-11-19 更新说明](RELEASE_NOTES_20261119.md)。

## 3. 已运行实例的只读核验

在宿主机执行，或按 [升级与回滚指南](UPGRADE_GUIDE.md) 使用 SSH 隧道。默认仅宿主机回环可访问：

```sh
docker compose config --quiet
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:8890/health
docker inspect --format '{{.Image}}' microsoft-rewards-script
```

记录检查时间与时区、镜像 ID / digest、OCI revision（若存在）和源码提交。HTTP 200 与 `ok: true` 只表示 API 可达；应用自报版本不是源码 SHA，也不是 Docker 健康状态或正式发布凭证。

账号、会话、定时任务与通知分别记录为「通过」「失败」或「未验证」，并保存在私有验收记录里。验证迁移需在维护窗口进行，先停任务并保留可恢复备份；仅从会话数据库读到 Cookie 不等于已登录或所有账号无损迁移。不要在公网实例上直接开放管理端口。

## 4. 公开文档与分发检查

- 行为变更同步更新日志、README、API 文档、升级/开发指南及 AI 指导文件；按钮名称、平台默认值、状态码、历史隔离与区域域名保持一致。
- Dashboard 顺序应为区域 Flyout HTTP → 浏览器 `page.request` → 旧 Rewards API → 未核实本地对象；DOM/React 余额探测另行描述。历史更新说明标记日期，不当作当前接口契约。
- 使用示例地址及脱敏数据；不要发布真实邮箱、代理配置、内网拓扑、服务器路径或生产日志。
- 从审核过的提交生成源码包，不从工作目录打包。检查归档路径与内容，排除 `.env`、运行配置、凭据、会话、备份和诊断输出；保留 `LICENSE` 和第三方声明。
- 正式发布需有与提交匹配的标签、镜像 digest、通过的验证记录和对应源码获取方式。不要将源码合入、生产部署和 GitHub Release 混写为同一状态。
