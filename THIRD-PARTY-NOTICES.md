# 第三方声明 / Third-party notices

## 项目来源

- 原始项目：[TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script)。
- 直接上游：[chiihero/Microsoft-Rewards-Script](https://github.com/chiihero/Microsoft-Rewards-Script) 的国内适配分支。
- 本仓库是社区维护的派生项目，保留上游历史与 [GPL 许可证文本](LICENSE)；本项目的包元数据声明 `GPL-3.0-or-later`。上游历史与 AI 辅助开发声明不替代版权或许可声明。
- [mgrimace/rewards-dashboard](https://github.com/mgrimace/rewards-dashboard) 是通过 API 对接的独立第三方控制台，不随本镜像安装，不是 Microsoft 官方组件。

## 直接运行依赖

下表对应当前 `package-lock.json`；传递依赖及原生平台包以锁文件和安装包内的许可、版权与 NOTICE 文件为准。本表不替代这些原文。编译产物不应删除随包安装的许可文件。

| 包                                                                                         | 许可                                                                                                       |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| [chalk](https://www.npmjs.com/package/chalk)                                               | MIT                                                                                                        |
| [fast-xml-parser](https://www.npmjs.com/package/fast-xml-parser)                           | MIT                                                                                                        |
| [fingerprint-generator / fingerprint-injector](https://github.com/apify/fingerprint-suite) | Apache-2.0                                                                                                 |
| [ghost-cursor-playwright-port](https://github.com/DKprofile/ghost-cursor-playwright)       | ISC                                                                                                        |
| [https-proxy-agent / socks-proxy-agent](https://github.com/TooTallNate/proxy-agents)       | MIT                                                                                                        |
| [impit](https://github.com/apify/impit)                                                    | Apache-2.0                                                                                                 |
| [ms](https://www.npmjs.com/package/ms)                                                     | MIT                                                                                                        |
| [otpauth](https://github.com/hectorm/otpauth)                                              | MIT                                                                                                        |
| [p-queue](https://www.npmjs.com/package/p-queue)                                           | MIT                                                                                                        |
| [patchright](https://www.npmjs.com/package/patchright)                                     | Apache-2.0                                                                                                 |
| [qrcode-terminal](https://github.com/gtanner/qrcode-terminal)                              | 锁定包的 `LICENSE` 为 Apache-2.0；自带的 QRCode for JavaScript 标注 MIT，Copyright (c) 2009 Kazuhiko Arase |
| [semver](https://www.npmjs.com/package/semver)                                             | ISC                                                                                                        |
| [ts-node](https://www.npmjs.com/package/ts-node)                                           | MIT                                                                                                        |
| [zod](https://www.npmjs.com/package/zod)                                                   | MIT                                                                                                        |

镜像还包含基础系统组件和 Patchright 安装的 Chromium。它们不适用本项目的 GPL 声明；保留各自的许可和版权声明。对外发布镜像时，应记录 digest 与构建提交（OCI revision），并提供与其一致的 GPL 对应源码及构建脚本。源码入口为 [本项目仓库](https://github.com/youkum/Microsoft-Rewards-Script)；分支首页不是某一镜像的固定源码地址。
