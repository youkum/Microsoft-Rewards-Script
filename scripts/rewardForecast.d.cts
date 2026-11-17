export interface RewardGoal {
    name: string
    faceValue: number
    targetPoints: number | null
}

export interface ForecastDailyPoints {
    date: string
    earned: number
}

export type ForecastReason =
    'unknown_target' | 'unknown_balance' | 'insufficient_history' | 'zero_average' | 'reached' | null

export interface RewardForecastAccount {
    email: string
    balance: number | null
    currentRunEarned: number | null
    remainingPoints: number | null
    averageDailyPoints: number | null
    observationDays: number
    estimatedDays: number | null
    reason: ForecastReason
    daily: ForecastDailyPoints[]
}

export interface RewardForecast {
    generatedAt: string
    timeZone: string
    goal: RewardGoal
    window: { startDate: string; endDate: string; maxDays: 7; minDays: 3 }
    accounts: RewardForecastAccount[]
}

export interface ForecastCurrentStats {
    email: string
    balance?: number | null
    collected?: number | null
    finalPoints?: number | null
    collectedPoints?: number | null
}

export function buildRewardForecast(options?: {
    records?: unknown[]
    accounts?: (string | { email: string })[]
    currentStats?: ForecastCurrentStats[]
    rewardGoal?: Partial<RewardGoal>
    now?: number | string | Date
    timeZone?: string
}): RewardForecast

export function formatRewardForecast(forecast: RewardForecast): string
