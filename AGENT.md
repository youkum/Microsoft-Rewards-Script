# AGENT.md - AI Coding Agent Guide

This repository contains the optimized China edition of Microsoft Rewards Script with full WebUI control panel integration.

- Repository: https://github.com/youkum/Microsoft-Rewards-Script (Branch: `V4-china`)
- Mode: This project is completely secondary-developed and maintained by AI with human assistance, with humans providing prompts and architectural suggestions (此项目由 AI 在人类的帮助下全面接手二次开发，人工提供了开发建议和提示词优化).

> **AI reviewers / new agents: start with [`AI-HANDOFF.md`](./AI-HANDOFF.md)** — it documents the current
> points data-quality model, independent account login, WebUI contracts, and verification scope.
> User-facing changes are summarized in [`RELEASE_NOTES_20261119.md`](./RELEASE_NOTES_20261119.md).

## Essential Knowledge for AI Coding Agents

### 1. File Map

- `src/index.ts`: Application orchestrator, main loop, and notification dispatch.
- `src/interface/Points.ts`: Type definitions for rewards points (`AccountAllPointsSummary`, `Counters`, etc.).
- `src/browser/auth/Login.ts`: Microsoft authentication state machine.
- `src/browser/auth/methods/EmailLogin.ts`: Input and submit logic for emails and passwords.
- `src/browser/BrowserFunc.ts`: Task executions and points collection logic (`getAllAccountPoints`, `formatPointsSummary`).
- `src/browser/FlyoutDashboard.ts` and `src/interface/DashboardData.ts`: Regional response mapping and data-quality flags.
- `src/browser/BrowserUtils.ts`: Modal dismissers, random delay helpers, and humanizers.
- `scripts/api/logParser.js`: Regular expressions for parsing terminal logs to feed the WebUI dashboard.
- `scripts/api/processManager.js`: Task/login run modes, process lifetime, and run lock.
- `scripts/api/server.js`: HTTP API server powering the WebUI on port 3010.
- `compose.yaml` & `Dockerfile.cn`: Containerized orchestration with accelerated mirror support.

### 2. Modification Rules

1. **Never alter log markers without updating `scripts/api/logParser.js`**.
2. **Preserve data quality when falling back**. Dashboard lookup uses regional Flyout HTTP, browser `page.request`, legacy Rewards API, then an unverified compatible object. DOM/React balance probes are separate. Unknown quotas are not completed `0/0`; unknown balances cannot establish earnings. Handle unavailable data with a controlled error when a task needs verified inputs.
3. **Reset state per account**. Balances, activity context, and fallback flags must not leak between accounts. DEBUG activity responses and cumulative reading/search summaries must not double-count gains.
4. **Keep login maintenance independent**. `POST /accounts/:index/login` selects one account, validates upstream balance and search quotas before saving each platform, and exits after success or failure. Set `mode: "login"` before logs; exclude maintenance from earnings history, account statistics, and task notifications. Failed cleanup must not overwrite an old session.
5. **Verify code changes with `npm run build` and `npm test`**. Run `npm run test:log-parser` for log changes; use performance/preview checks when those paths change. Documentation-only edits need formatting and source/link checks.
6. **Do not modify `.env` or check in credentials, session cookies, production logs, or diagnostic artifacts**. Update `CHANGELOG.md` and relevant user/API/agent guidance alongside behavior changes.
7. **Preserve Docker config links and lifetime statistics**. Config writes use `scripts/atomicFile.cjs` to replace the real target. `scripts/api/runHistory.js` persists bounded records and independent account totals; import retained legacy points history without double counting, and exclude login maintenance from totals. Back up the old container's active root config before recreating it. Verify repeated restarts with synthetic settings/history and retain mounted `config/` and `sessions/`.
