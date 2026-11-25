# CLAUDE.md - Instructions for Claude Code / Anthropic Assistant

## Project Summary

Microsoft Rewards Script (China Edition with WebUI Dashboard).

- Repository: https://github.com/youkum/Microsoft-Rewards-Script (Branch: `V4-china`)
- Maintenance: Fully secondary-developed by AI with human assistance, where humans provided prompts and architectural guidance (此项目由 AI 在人类的帮助下全面接手二次开发，人工提供了开发建议和提示词优化).
  A TypeScript & Patchright-based automated agent for Microsoft Rewards tasks, featuring regional points lookup with explicit data quality, an adaptive login state machine, and an embedded WebUI with independent account-session saving.

> **Review/handoff note:** read [`AI-HANDOFF.md`](./AI-HANDOFF.md) before changing points, login, persistence, proxies, or API
> behavior. Current deployment and proxy guidance is in [`RELEASE_NOTES_20261125.md`](./RELEASE_NOTES_20261125.md).
> Keep [`CHANGELOG.md`](./CHANGELOG.md), user instructions, and the API contract synchronized. Handoff uses the current checkout and repository docs; the offline AI distribution has been withdrawn.

## Common Developer Commands

```bash
# Install dependencies
npm ci

# Compile TypeScript
npm run build

# Start bot directly (Windows/Node local)
npm start

# Run API Server for WebUI
npm run api

# Run Log Parser Unit Tests (Verify WebUI Compatibility)
npm run test:log-parser

# Core, API, and WebUI regression checks
npm test
npm run test:performance
npm run test:preview

# Format & Lint
npm run lint
npm run format
```

## Architectural Guidelines

- **Core Loop**: `src/index.ts` coordinates accounts, calls `src/browser/auth/Login.ts` for authentication, and executes activities via `src/browser/BrowserFunc.ts`.
- **Points Architecture**: `getDashboardData()` tries regional Flyout through HTTP, browser `page.request` with shared cookies, the legacy Rewards API (at most two attempts until it fails for the account), then a compatible local fallback. Use `cn.bing.com` for CN and `www.bing.com` otherwise. DOM and React snapshots are separate balance probes, not additional dashboard stages.
- **Data Quality**: Preserve `DashboardData.dataQuality` and `AccountAllPointsSummary.balanceVerified`. Missing quotas/activity lists are unknown, and unverified starting/final balances cannot establish successful earnings. Reset account state and preserve controlled failures for tasks requiring unavailable data.
- **Independent Login**: Account management exposes **保存登录会话** via `POST /accounts/:index/login`. `platform` is `mobile`, `desktop`, or `both` (default, mobile first). Validate upstream balance and quotas before each save; skip reward workers, activity-context bootstrap, daily/quiet-hour rules, and task notifications. Exit and release the run lock on either result. Maintenance stays in `/history` but is excluded from points history and account statistics.
- **WebUI Logging**: `scripts/api/logParser.js` parses stdout. Preserve log patterns such as:
  `积分已收集 | 获得积分=${collectedPoints} | 现余额=${finalPoints} | 账户=${accountEmail}`
- **Browser Automation**: Always use Patchright with anti-fingerprinting. Avoid plain Playwright or Puppeteer.
- **Gain Accounting**: Keep DEBUG responses diagnostic; reconcile INFO increments with cumulative search/reading summaries without double-counting. Search quota growth and check-in HTTP 200 do not by themselves prove balance credit.
- **Private Data**: Never publish `.env`, credentials, cookies, production logs, or deployment diagnostics.
