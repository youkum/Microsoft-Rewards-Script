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

| 核验项               | 代码或证据                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| 单账号／排除账号隔离 | [账户环境构造](scripts/api/accounts.js) 与 [配置加载](src/util/Load.ts)；在隔离测试环境确认只选择预期槽位  |
| 登录流程             | [登录状态机](src/browser/auth/Login.ts)；夹具或经批准的测试账号验证，区分读取保存会话和实际登录成功        |
| WebUI 与 API         | [API 文档](scripts/api/README.md) 与 [静态模块](scripts/api/web/)；检查控制台、鉴权、模块加载及 SSE        |
| 预测与通知           | [预测逻辑](scripts/rewardForecast.cjs)；先用不发送通知的预览，再单独记录经授权的送达验证                   |
| 调度与回滚           | [容器入口](scripts/docker/entrypoint.sh)；用测试容器检查 cron 启停和无任务启动，生产中已保存的计划另行核对 |

## 2. 已运行实例的只读核验

在宿主机执行，或按 [升级与回滚指南](UPGRADE_GUIDE.md) 使用 SSH 隧道。默认仅宿主机回环可访问：

```sh
docker compose config --quiet
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:8890/health
docker inspect --format '{{.Image}}' microsoft-rewards-script
```

记录检查时间与时区、镜像 ID / digest、OCI revision（若存在）和源码提交。HTTP 200 与 `ok: true` 只表示 API 可达；应用自报版本不是源码 SHA，也不是 Docker 健康状态或正式发布凭证。

账号、会话、定时任务与通知分别记录为「通过」「失败」或「未验证」，并保存在私有验收记录里。验证迁移需在维护窗口进行，先停任务并保留可恢复备份；仅从会话数据库读到 Cookie 不等于已登录或所有账号无损迁移。不要在公网实例上直接开放管理端口。

## 3. 公开文档与分发检查

- 使用示例地址及脱敏数据；不要发布真实邮箱、代理配置、内网拓扑、服务器路径或生产日志。
- 从审核过的提交生成源码包，不从工作目录打包。检查归档路径与内容，排除 `.env`、运行配置、凭据、会话、备份和诊断输出；保留 `LICENSE` 和第三方声明。
- 正式发布需有与提交匹配的标签、镜像 digest、通过的验证记录和对应源码获取方式。不要将源码合入、生产部署和 GitHub Release 混写为同一状态。
