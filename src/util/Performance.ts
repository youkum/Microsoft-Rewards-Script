import { performance } from 'node:perf_hooks'

/** Only fixed labels are accepted: never derive a stage from request or account data. */
export const PERFORMANCE_STAGES = [
    'overall',
    'account.overall',
    'browser.launch',
    'browser.create',
    'login.mobile',
    'login.desktop',
    'login.refresh',
    'login.app-token',
    'activity.streak-protection',
    'activity.punchcards-mobile',
    'activity.punchcards-desktop',
    'activity.visual-search',
    'activity.daily-set',
    'activity.search-perk',
    'activity.promotions',
    'activity.check-in',
    'activity.app-promotions',
    'activity.read-to-earn',
    'activity.edge-browsing',
    'activity.claim-bonus',
    'search.mobile',
    'search.desktop',
    'search.bonus',
    'search.session',
    'search.query',
    'navigation',
    'progress.read',
    'progress.measure',
    'session.save',
    'http.request',
    'http.attempt'
] as const

export type PerformanceStage = (typeof PERFORMANCE_STAGES)[number]
export type PerformanceSink = (message: string) => void

const stages = new Set<string>(PERFORMANCE_STAGES)
const noop = (): void => {}

/** Instance-local sink; no account identifiers, active-stage state, or timers are shared. */
export class Performance {
    constructor(private readonly sink?: PerformanceSink) {}

    get enabled(): boolean {
        return process.env.MRS_PERFORMANCE === 'true' && this.sink !== undefined
    }

    /** Explicit spans support event-driven completion and must be finished before process.exit. */
    start(stage: PerformanceStage): (error?: boolean) => void {
        if (!this.enabled || !stages.has(stage)) return noop

        const startedAt = performance.now()
        let finished = false
        return (error = false): void => {
            if (finished) return
            finished = true
            const durationMs = Math.max(0, performance.now() - startedAt).toFixed(3)
            try {
                this.sink?.(`stage=${stage} count=1 durationMs=${durationMs} error=${error === true}`)
            } catch {
                // Observability must never change the operation's result or error.
            }
        }
    }

    measure<T>(stage: PerformanceStage, operation: () => Promise<T>): Promise<T> {
        if (!this.enabled || !stages.has(stage)) return operation()
        return this.measureEnabled(stage, operation)
    }

    private async measureEnabled<T>(stage: PerformanceStage, operation: () => Promise<T>): Promise<T> {
        const finish = this.start(stage)
        let failed = true
        try {
            const result = await operation()
            failed = false
            return result
        } finally {
            finish(failed)
        }
    }

    measureSync<T>(stage: PerformanceStage, operation: () => T): T {
        if (!this.enabled || !stages.has(stage)) return operation()
        const finish = this.start(stage)
        let failed = true
        try {
            const result = operation()
            failed = false
            return result
        } finally {
            finish(failed)
        }
    }
}
