# GitHub Copilot Instructions for Microsoft Rewards Script

- This is a TypeScript project targeting Node.js >= 24.
- Use ES modules syntax and ensure all types are strictly compatible with TypeScript 5.x/6.x.
- Do not introduce native dependencies that break in Docker or Windows without fallbacks.
- When generating point calculation logic, always handle null/undefined safely using `?.` and fallback to 0.
- Ensure log lines emitted by `this.logger.info()` match the regular expressions in `scripts/api/logParser.js`.
