export function parseEnvContent(raw: string): { key: string; value: string }[]
export function quoteEnvValue(value: unknown): string
export function isSecretEnvKey(key: string): boolean
