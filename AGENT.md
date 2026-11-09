# AGENT.md - AI Coding Agent Guide

This repository contains the optimized China edition of Microsoft Rewards Script with full WebUI control panel integration.
- Repository: https://github.com/youkum/Microsoft-Rewards-Script (Branch: `V4-china`)
- Mode: This project is completely secondary-developed and maintained by AI with human assistance, with humans providing prompts and architectural suggestions (此项目由 AI 在人类的帮助下全面接手二次开发，人工提供了开发建议和提示词优化).

> **AI reviewers / new agents: start with [`AI-HANDOFF.md`](./AI-HANDOFF.md)** — it documents the latest
> embedded-WebUI modification (account CRUD, proxy testing, points history), the exact invariants that must
> not break, and reproducible build/test/verification steps.

## Essential Knowledge for AI Coding Agents

### 1. File Map
- `src/index.ts`: Application orchestrator, main loop, and notification dispatch.
- `src/interface/Points.ts`: Type definitions for rewards points (`AccountAllPointsSummary`, `Counters`, etc.).
- `src/browser/auth/Login.ts`: Microsoft authentication state machine.
- `src/browser/auth/methods/EmailLogin.ts`: Input and submit logic for emails and passwords.
- `src/browser/BrowserFunc.ts`: Task executions and points collection logic (`getAllAccountPoints`, `formatPointsSummary`).
- `src/browser/BrowserUtils.ts`: Modal dismissers, random delay helpers, and humanizers.
- `scripts/api/logParser.js`: Regular expressions for parsing terminal logs to feed the WebUI dashboard.
- `scripts/api/server.js`: HTTP API server powering the WebUI on port 3010.
- `compose.yaml` & `Dockerfile.cn`: Containerized orchestration with accelerated mirror support.

### 2. Modification Rules
1. **Never alter log markers without updating `scripts/api/logParser.js`**.
2. **Never allow `getAllAccountPoints()` or `getCurrentPoints()` to crash**. Use optional chaining and fallbacks.
3. **Always verify compilation with `npm run build`** and tests with `npm run test:log-parser`.
4. **Do not modify `.env` or check in session cookies**.
