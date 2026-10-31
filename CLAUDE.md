# CLAUDE.md - Instructions for Claude Code / Anthropic Assistant

## Project Summary
Microsoft Rewards Script (China Edition with WebUI Dashboard).
A TypeScript & Patchright-based automated agent for Microsoft Rewards tasks, featuring a resilient 6-tier points fallback system, adaptive login state machine, and a companion WebUI control panel.

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

# Format & Lint
npm run lint
npm run format
```

## Architectural Guidelines
- **Core Loop**: `src/index.ts` coordinates accounts, calls `src/browser/auth/Login.ts` for authentication, and executes activities via `src/browser/BrowserFunc.ts`.
- **Points Architecture**: `getAllAccountPoints()` gathers a complete breakdown (`availablePoints`, `lifetimePoints`, `todayEarned`, sub-quotas, level, streaks). It falls back smoothly through 6 layers and never throws fatal errors.
- **WebUI Logging**: `scripts/api/logParser.js` parses stdout. Preserve log patterns such as:
  `积分已收集 | 获得积分=${collectedPoints} | 现余额=${finalPoints} | 账户=${accountEmail}`
- **Browser Automation**: Always use Patchright with anti-fingerprinting. Avoid plain Playwright or Puppeteer.
