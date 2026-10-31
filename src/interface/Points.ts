export interface BrowserEarnablePoints {
    desktopSearchPoints: number
    mobileSearchPoints: number
    dailySetPoints: number
    morePromotionsPoints: number
    totalEarnablePoints: number
}

export interface AppEarnablePoints {
    readToEarn: number
    checkIn: number
    totalEarnablePoints: number
}

export interface MissingSearchPoints {
    mobilePoints: number
    desktopPoints: number
    edgePoints: number
    totalPoints: number
}

export interface AccountAllPointsSummary {
    availablePoints: number
    lifetimePoints: number
    lifetimeRedeemed: number
    lifetimeGiving: number
    todayEarned: number
    pcSearch: { current: number; max: number; remaining: number }
    mobileSearch: { current: number; max: number; remaining: number }
    edgeSearch: { current: number; max: number; remaining: number }
    dailySet: { current: number; max: number; remaining: number }
    morePromotions: { current: number; max: number; remaining: number }
    appReadToEarn: { current: number; max: number; remaining: number }
    appCheckIn: { day: number; points: number }
    totalEarnableToday: number
    level: number
    pointsProgress: number
    pointsRemaining: number
    streakCount: number
    streakProtection: boolean
    streakProtectionDays: number
}

