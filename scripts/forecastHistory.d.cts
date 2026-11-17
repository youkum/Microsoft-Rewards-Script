/** Bounded, best-effort read of config/points-history.jsonl and its .1 rotation. */
export function readForecastHistory(projectRoot: string): unknown[]
