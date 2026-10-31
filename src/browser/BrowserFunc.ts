import { URLs } from '../constants/urls'
import { BING_APP_USER_AGENT } from '../constants/userAgents'
import type { BrowserContext, Cookie, Page } from 'patchright'
import type { HttpRequestConfig } from '../util/Http'

import type { MicrosoftRewardsBot } from '../index'
import type { PageSnapshot, ParsedOffer } from './ReactFunc'
import { loadSession, saveStorageState } from '../util/SessionStore'
import { isBrowserClosedError } from '../util/Utils'

import type { DashboardData } from './../interface/DashboardData'
import type { AppUserData } from '../interface/AppUserData'
import type { AccountAllPointsSummary, AppEarnablePoints, BrowserEarnablePoints } from '../interface/Points'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import { detectFlyoutBotWarning, mapFlyoutToDashboard, type RewardsFlyoutData } from './FlyoutDashboard'

export default class BrowserFunc {
    private bot: MicrosoftRewardsBot

    private rewardsDeploymentId = ''

    private useFlyoutDashboardFallback = false

    private botMetricsLoggedPlatforms = new Set<string>()

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    async getDashboardData(cookies?: Cookie[]): Promise<DashboardData> {
        const fingerprintHeaders = { ...(this.bot.fingerprint?.headers ?? {}) }
        delete fingerprintHeaders['Cookie']
        delete fingerprintHeaders['cookie']

        if (!this.useFlyoutDashboardFallback) {
            let primaryError: unknown

            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const response = await this.bot.http.request<DashboardData>({
                        url: URLs.rewards.userInfoApi,
                        method: 'GET',
                        headers: {
                            ...fingerprintHeaders,
                            Cookie: this.buildCookieHeader(this.getCachedCookies(cookies, URLs.rewards.userInfoApi)),
                            Referer: URLs.rewards.referer,
                            Origin: URLs.rewards.origin
                        },
                        retries: 0
                    })

                    await this.applyResponseCookies(URLs.rewards.userInfoApi, response.headers['set-cookie'])

                    if (response.data?.dashboard) {
                        this.logBotDetectionMetrics(response.data)
                        return response.data
                    }
                    throw new Error('Dashboard data missing from API response')
                } catch (error) {
                    primaryError = error
                    if (attempt === 1) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'GET-DASHBOARD-DATA',
                            `主接口请求失败，正在重试一次 | 信息=${this.errorMessage(error)}`
                        )
                        await new Promise(resolve => setTimeout(resolve, 1000))
                    }
                }
            }

            this.useFlyoutDashboardFallback = true
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                `重试后主接口仍不可用，改用 Bing flyout 兜底 | 信息=${this.errorMessage(primaryError)}`
            )
        }

        try {
            return await this.getFlyoutDashboardData(cookies, fingerprintHeaders)
        } catch {
            // 尝试通过浏览器页面内原生执行 fetch 获取 Flyout
            const inPageData = await this.getInPageFlyoutData()
            if (inPageData) return inPageData

            // 兜底返回本地安全降级数据，保证绝不抛错阻断任务
            return this.createFallbackDashboardData()
        }
    }

    private async getInPageFlyoutData(): Promise<DashboardData | null> {
        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        if (!page || page.isClosed()) return null

        try {
            this.bot.logger.info(this.bot.isMobile, 'GET-DASHBOARD-DATA', '正在尝试通过真实浏览器内部执行 Flyout 请求兜底')
            const flyoutData = await page.evaluate(async (url: string) => {
                try {
                    const res = await fetch(url, {
                        method: 'GET',
                        headers: { Accept: 'application/json' },
                        credentials: 'include'
                    })
                    if (!res.ok) return null
                    return await res.json()
                } catch {
                    return null
                }
            }, URLs.bing.rewardsFlyoutUserInfo)

            if (flyoutData && !flyoutData.isError) {
                const mapped = mapFlyoutToDashboard(flyoutData)
                this.logBotDetectionMetrics(mapped)
                this.bot.logger.info(this.bot.isMobile, 'GET-DASHBOARD-DATA', '通过浏览器内部 Flyout 兜底获取仪表板成功')
                return mapped
            }
        } catch (err) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                `浏览器内部 Flyout 请求失败: ${err instanceof Error ? err.message : String(err)}`
            )
        }
        return null
    }

    public createFallbackDashboardData(): DashboardData {
        const snapshot = this.bot.reactSnapshot
        const points =
            snapshot?.account?.availablePoints ??
            this.bot.userData?.currentPoints ??
            this.bot.userData?.initialPoints ??
            0

        const lifetime = snapshot?.account?.lifetimeEarn ?? 0

        this.bot.logger.warn(
            this.bot.isMobile,
            'GET-DASHBOARD-DATA',
            `使用本地安全降级仪表板数据 | 当前积分=${points} | 历史总分=${lifetime}`
        )

        return {
            dashboard: {
                userStatus: {
                    availablePoints: points,
                    lifetimePoints: lifetime,
                    lifetimePointsRedeemed: 0,
                    lifetimeGivingPoints: 0,
                    isRewardsUser: true,
                    counters: {
                        pcSearch: [],
                        mobileSearch: [],
                        activityAndQuiz: [],
                        dailyPoint: []
                    }
                },
                userWarnings: [],
                userProfile: {
                    attributes: {
                        country: this.bot.userData.geoLocale || 'US'
                    }
                },
                dailySetPromotions: {},
                morePromotions: [],
                punchCards: []
            } as any,
            profile: {
                attributes: {
                    country: this.bot.userData.geoLocale || 'US'
                }
            } as any
        } as DashboardData
    }

    private async getFlyoutDashboardData(
        cookies: Cookie[] | undefined,
        fingerprintHeaders: Record<string, string>
    ): Promise<DashboardData> {
        try {
            const response = await this.bot.http.request<RewardsFlyoutData>({
                url: URLs.bing.rewardsFlyoutUserInfo,
                method: 'GET',
                headers: {
                    ...fingerprintHeaders,
                    Accept: 'application/json',
                    Cookie: this.buildCookieHeader(this.getCachedCookies(cookies, URLs.bing.rewardsFlyoutUserInfo)),
                    Referer: `${URLs.bing.origin}/`,
                    Origin: URLs.bing.origin
                },
                retries: 0
            })

            await this.applyResponseCookies(URLs.bing.rewardsFlyoutUserInfo, response.headers['set-cookie'])

            const detection = detectFlyoutBotWarning(response.data)
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                `使用 Bing flyout 部分仪表板 | 疑似受限=${detection.likelyLimited} | bot标记=${detection.hasBotProfileMarkers} | 活动折叠=${detection.hasCollapsedActivities}`
            )
            const mappedDashboard = mapFlyoutToDashboard(response.data)
            this.logBotDetectionMetrics(mappedDashboard)
            return mappedDashboard
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                `获取 Bing flyout 仪表板失败: ${this.errorMessage(error)}`
            )
            throw error
        }
    }

    private logBotDetectionMetrics(data: DashboardData): void {
        const attributes = data.profile?.attributes as unknown as Record<string, unknown> | undefined
        const score = attributes?.serpbotscore ?? attributes?.SerpBotScore
        const scoreUpdated = attributes?.serpbotscore_upd ?? attributes?.SerpBotScore_upd
        const warningNames = (data.dashboard?.userWarnings ?? [])
            .map(warning => warning?.name)
            .filter((name): name is string => Boolean(name))
        const platform = this.bot.isMobile ? 'MOBILE' : 'DESKTOP'
        const firstTime = !this.botMetricsLoggedPlatforms.has(platform)
        this.botMetricsLoggedPlatforms.add(platform)

        const message =
            `机器人检测指标 | serpbotscore=${score ?? '未知'} | 更新时间=${
                scoreUpdated ? String(scoreUpdated).slice(0, 16) : '未知'
            } | userWarnings=${warningNames.length > 0 ? warningNames.join(', ') : '无'}`

        if (warningNames.length > 0) {
            this.bot.logger.warn(this.bot.isMobile, 'GET-DASHBOARD-DATA', message)
        } else if (firstTime) {
            this.bot.logger.info(this.bot.isMobile, 'GET-DASHBOARD-DATA', message)
        } else {
            this.bot.logger.debug(this.bot.isMobile, 'GET-DASHBOARD-DATA', message)
        }
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }

    async getAppDashboardData(): Promise<AppDashboardData> {
        try {
            const request: HttpRequestConfig = {
                url: URLs.platform.me('SAIOS'),
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent': BING_APP_USER_AGENT,
                    'X-Rewards-Country': this.bot.userData.geoLocale,
                    'X-Rewards-Language': this.bot.userData.langCode,
                    'X-Rewards-IsMobile': 'true'
                }
            }

            const response = await this.bot.http.request(request)
            return response.data as AppDashboardData
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-DASHBOARD-DATA',
                `获取 App 仪表板数据出错: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    async getBrowserEarnablePoints(data?: DashboardData): Promise<BrowserEarnablePoints> {
        try {
            data ??= await this.getDashboardData()

            const counters = data?.dashboard?.userStatus?.counters
            const desktopSearchPoints =
                counters?.pcSearch?.reduce(
                    (sum: number, x: { pointProgressMax?: number; pointProgress?: number }) =>
                        sum + Math.max(0, (Number(x?.pointProgressMax) || 0) - (Number(x?.pointProgress) || 0)),
                    0
                ) ?? 0

            const mobileSearchPoints =
                counters?.mobileSearch?.reduce(
                    (sum: number, x: { pointProgressMax?: number; pointProgress?: number }) =>
                        sum + Math.max(0, (Number(x?.pointProgressMax) || 0) - (Number(x?.pointProgress) || 0)),
                    0
                ) ?? 0

            const todayDate = this.bot.utils.getFormattedDate()
            const dailySetList = data?.dashboard?.dailySetPromotions?.[todayDate] ?? []
            const dailySetPoints = Array.isArray(dailySetList)
                ? dailySetList.reduce(
                      (sum: number, x: { pointProgressMax?: number; pointProgress?: number }) =>
                          sum + Math.max(0, (Number(x?.pointProgressMax) || 0) - (Number(x?.pointProgress) || 0)),
                      0
                  )
                : 0

            const morePromotions = data?.dashboard?.morePromotions ?? []
            const morePromotionsPoints = Array.isArray(morePromotions)
                ? morePromotions.reduce((sum, x) => {
                      if (x?.promotionType === 'urlreward' && x?.exclusiveLockedFeatureStatus !== 'locked') {
                          return sum + Math.max(0, (Number(x?.pointProgressMax) || 0) - (Number(x?.pointProgress) || 0))
                      }
                      return sum
                  }, 0)
                : 0

            const totalEarnablePoints = desktopSearchPoints + mobileSearchPoints + dailySetPoints + morePromotionsPoints

            return {
                dailySetPoints,
                morePromotionsPoints,
                desktopSearchPoints,
                mobileSearchPoints,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-BROWSER-EARNABLE-POINTS',
                `获取浏览器可赚积分时发生非致命错误，使用安全兜底: ${error instanceof Error ? error.message : String(error)}`
            )
            return {
                dailySetPoints: 0,
                morePromotionsPoints: 0,
                desktopSearchPoints: 0,
                mobileSearchPoints: 0,
                totalEarnablePoints: 0
            }
        }
    }

    async getAppEarnablePoints(): Promise<AppEarnablePoints> {
        try {
            if (!this.bot.accessToken) {
                return { readToEarn: 0, checkIn: 0, totalEarnablePoints: 0 }
            }

            const eligibleOffers = ['ENUS_readarticle3_30points', 'Gamification_Sapphire_DailyCheckIn']

            const request: HttpRequestConfig = {
                url: URLs.platform.me('SAAndroid'),
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'X-Rewards-Country': this.bot.userData.geoLocale,
                    'X-Rewards-Language': this.bot.userData.langCode,
                    'X-Rewards-ismobile': 'true'
                }
            }

            const response = await this.bot.http.request<AppUserData>(request)
            const userData: AppUserData = response.data
            const promotions = userData?.response?.promotions
            if (!Array.isArray(promotions)) {
                return { readToEarn: 0, checkIn: 0, totalEarnablePoints: 0 }
            }

            const eligibleActivities = promotions.filter(x =>
                eligibleOffers.includes(x?.attributes?.offerid ?? '')
            )

            let readToEarn = 0
            let checkIn = 0

            for (const item of eligibleActivities) {
                const attrs = item?.attributes
                if (!attrs) continue

                if (attrs.type === 'msnreadearn') {
                    const pointMax = parseInt(attrs.pointmax ?? '0', 10) || 0
                    const pointProgress = parseInt(attrs.pointprogress ?? '0', 10) || 0
                    readToEarn = Math.max(0, pointMax - pointProgress)
                } else if (attrs.type === 'checkin') {
                    const progress = parseInt(attrs.progress ?? '0', 10) || 0
                    const checkInDay = progress % 7
                    const lastUpdated = new Date(attrs.last_updated ?? '')
                    const today = new Date()

                    if (checkInDay < 6 && today.getDate() !== lastUpdated.getDate()) {
                        checkIn = parseInt(attrs[`day_${checkInDay + 1}_points`] ?? '0', 10) || 0
                    }
                }
            }

            const totalEarnablePoints = readToEarn + checkIn

            return {
                readToEarn,
                checkIn,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-APP-EARNABLE-POINTS',
                `获取App可赚积分时发生非致命错误，使用安全兜底: ${error instanceof Error ? error.message : String(error)}`
            )
            return {
                readToEarn: 0,
                checkIn: 0,
                totalEarnablePoints: 0
            }
        }
    }

    async getPointsFromBrowserPage(page?: Page): Promise<number | null> {
        const activePage = page || (this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage)
        if (!activePage || activePage.isClosed()) return null

        try {
            // 1. 尝试从 Bing 顶栏 Rewards 积分角标提取 (#id_rc)
            const bingPointsText = await activePage
                .$eval('#id_rc, #id_rh, .id_name', el => el.textContent)
                .catch(() => null)
            if (bingPointsText) {
                const clean = bingPointsText.replace(/[^0-9]/g, '')
                if (clean) {
                    const parsed = parseInt(clean, 10)
                    if (Number.isFinite(parsed) && parsed >= 0) return parsed
                }
            }

            // 2. 尝试从 Rewards 页面主要积分元素提取
            const rewardsPointsText = await activePage
                .$eval(
                    '[data-bi-id="rewards-points"], .points-balance, [class*="pointsBalance"], [class*="availablePoints"], [aria-label*="points" i]',
                    el => el.textContent
                )
                .catch(() => null)
            if (rewardsPointsText) {
                const clean = rewardsPointsText.replace(/[^0-9]/g, '')
                if (clean) {
                    const parsed = parseInt(clean, 10)
                    if (Number.isFinite(parsed) && parsed >= 0) return parsed
                }
            }

            // 3. 在活跃页面内部执行 fetch 读取 Bing Flyout 积分（享用完整真实 Cookie 与指纹）
            const inPagePoints = await activePage
                .evaluate(async (url: string) => {
                    try {
                        const res = await fetch(url, { credentials: 'include' })
                        if (!res.ok) return null
                        const json = await res.json()
                        return json?.userInfo?.balance ?? json?.flyoutResult?.userStatus?.availablePoints ?? null
                    } catch {
                        return null
                    }
                }, URLs.bing.rewardsFlyoutUserInfo)
                .catch(() => null)

            if (typeof inPagePoints === 'number' && Number.isFinite(inPagePoints) && inPagePoints >= 0) {
                return inPagePoints
            }
        } catch {
            // 忽略 DOM 提取异常
        }

        return null
    }

    async getCurrentPoints(): Promise<number> {
        try {
            // 1. 优先从仪表板 API / Flyout 获取
            const data = await this.getDashboardData()
            const availablePoints = data?.dashboard?.userStatus?.availablePoints
            if (typeof availablePoints === 'number' && Number.isFinite(availablePoints) && availablePoints >= 0) {
                this.bot.userData.currentPoints = availablePoints
                return availablePoints
            }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-CURRENT-POINTS',
                `从仪表板获取当前积分失败，启动备用获取方式 | 错误=${this.errorMessage(error)}`
            )
        }

        // 2. 从当前活跃浏览器的 DOM 或页面内 fetch 获取
        const domPoints = await this.getPointsFromBrowserPage()
        if (typeof domPoints === 'number' && Number.isFinite(domPoints) && domPoints >= 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'GET-CURRENT-POINTS',
                `通过页面 DOM 成功获取到当前积分: ${domPoints}`
            )
            this.bot.userData.currentPoints = domPoints
            return domPoints
        }

        // 3. 尝试从 React 快照读取
        const snapshotPoints = this.bot.reactSnapshot?.account?.availablePoints
        if (typeof snapshotPoints === 'number' && Number.isFinite(snapshotPoints) && snapshotPoints >= 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'GET-CURRENT-POINTS',
                `通过 React 快照获取到当前积分: ${snapshotPoints}`
            )
            this.bot.userData.currentPoints = snapshotPoints
            return snapshotPoints
        }

        // 4. 回退到 userData 中的已知积分，保证永不抛错
        const fallbackPoints = this.bot.userData.currentPoints || this.bot.userData.initialPoints || 0
        this.bot.logger.warn(
            this.bot.isMobile,
            'GET-CURRENT-POINTS',
            `无法从远程或 DOM 获取最新积分，使用最后已知积分: ${fallbackPoints}`
        )
        return fallbackPoints
    }

    async getAllAccountPoints(): Promise<AccountAllPointsSummary> {
        let dashboardData: DashboardData | null = null
        try {
            dashboardData = await this.getDashboardData()
        } catch {
            dashboardData = this.createFallbackDashboardData()
        }

        const userStatus = dashboardData?.dashboard?.userStatus
        const counters = userStatus?.counters
        const snapshot = this.bot.reactSnapshot

        const availablePoints =
            (typeof userStatus?.availablePoints === 'number' && userStatus.availablePoints >= 0
                ? userStatus.availablePoints
                : null) ??
            (typeof snapshot?.account?.availablePoints === 'number' ? snapshot.account.availablePoints : null) ??
            this.bot.userData.currentPoints ??
            this.bot.userData.initialPoints ??
            0

        const lifetimePoints =
            Number(userStatus?.lifetimePoints) ||
            Number(snapshot?.account?.lifetimeEarn) ||
            0

        const lifetimeRedeemed = Number(userStatus?.lifetimePointsRedeemed) || 0
        const lifetimeGiving = Number(userStatus?.lifetimeGivingPoints) || 0

        const sumCounters = (list?: Array<{ pointProgress?: number; pointProgressMax?: number }>) => {
            let current = 0
            let max = 0
            if (Array.isArray(list)) {
                for (const item of list) {
                    const c = Math.max(0, Number(item?.pointProgress) || 0)
                    const m = Math.max(0, Number(item?.pointProgressMax) || 0)
                    current += c
                    max += m
                }
            }
            return { current, max, remaining: Math.max(0, max - current) }
        }

        const isEdge = (item: any) => {
            return [item?.offerId, item?.name, item?.title].some(
                (v: unknown) => typeof v === 'string' && /(^|[_\s-])edge([_\s-]|$)/i.test(v)
            )
        }

        const allPcCounters = counters?.pcSearch ?? []
        const edgeCounters = allPcCounters.filter(isEdge)
        const purePcCounters = edgeCounters.length ? allPcCounters.filter(c => !isEdge(c)) : allPcCounters

        const pcSearch = sumCounters(purePcCounters)
        const edgeSearch = sumCounters(edgeCounters)
        const mobileSearch = sumCounters(counters?.mobileSearch)

        const todayDate = this.bot.utils.getFormattedDate()
        const dailySetList = dashboardData?.dashboard?.dailySetPromotions?.[todayDate] ?? []
        const dailySet = sumCounters(dailySetList)

        let moreCurrent = 0
        let moreMax = 0
        const moreList = dashboardData?.dashboard?.morePromotions ?? []
        if (Array.isArray(moreList)) {
            for (const x of moreList) {
                if (x?.promotionType === 'urlreward' && x?.exclusiveLockedFeatureStatus !== 'locked') {
                    moreCurrent += Math.max(0, Number(x?.pointProgress) || 0)
                    moreMax += Math.max(0, Number(x?.pointProgressMax) || 0)
                }
            }
        }
        const morePromotions = { current: moreCurrent, max: moreMax, remaining: Math.max(0, moreMax - moreCurrent) }

        let appReadToEarn = { current: 0, max: 0, remaining: 0 }
        let appCheckIn = { day: 0, points: 0 }
        if (this.bot.accessToken) {
            try {
                const appEarnable = await this.getAppEarnablePoints()
                appReadToEarn = { current: 0, max: appEarnable.readToEarn, remaining: appEarnable.readToEarn }
                appCheckIn = { day: 0, points: appEarnable.checkIn }
            } catch {
                // Ignore app points error
            }
        }

        const totalEarnableToday =
            pcSearch.remaining +
            mobileSearch.remaining +
            edgeSearch.remaining +
            dailySet.remaining +
            morePromotions.remaining +
            appReadToEarn.remaining +
            appCheckIn.points

        const dailyPointCounters = counters?.dailyPoint
        let todayEarned = 0
        if (Array.isArray(dailyPointCounters) && dailyPointCounters.length > 0) {
            todayEarned = dailyPointCounters.reduce(
                (sum, c) => sum + Math.max(0, Number(c?.pointProgress) || 0),
                0
            )
        }
        if (todayEarned === 0 && this.bot.userData.initialPoints > 0 && availablePoints > this.bot.userData.initialPoints) {
            todayEarned = availablePoints - this.bot.userData.initialPoints
        }

        const level = Number(snapshot?.account?.level) || (availablePoints >= 500 ? 2 : 1)
        const pointsProgress = Number(snapshot?.account?.pointsProgress) || 0
        const pointsRemaining = Number(snapshot?.account?.pointsRemaining) || 0
        const streakCount = Number(snapshot?.streakProtection?.streakCounter) || 0
        const streakProtection = Boolean(snapshot?.streakProtection?.isProtectionOn)
        const streakProtectionDays = Number(snapshot?.streakProtection?.remainingDays) || 0

        return {
            availablePoints,
            lifetimePoints,
            lifetimeRedeemed,
            lifetimeGiving,
            todayEarned,
            pcSearch,
            mobileSearch,
            edgeSearch,
            dailySet,
            morePromotions,
            appReadToEarn,
            appCheckIn,
            totalEarnableToday,
            level,
            pointsProgress,
            pointsRemaining,
            streakCount,
            streakProtection,
            streakProtectionDays
        }
    }

    formatPointsSummary(summary: AccountAllPointsSummary, email?: string): string {
        const lines: string[] = [
            `------------------ 账号积分详细报表 ------------------`,
            `账号: ${email ?? this.bot.currentAccountEmail ?? '当前账号'}`,
            `可用积分余额: ${summary.availablePoints.toLocaleString()} 分 | 历史总积分: ${summary.lifetimePoints.toLocaleString()} 分`,
            `用户等级: Lv.${summary.level} | 连胜天数: ${summary.streakCount} 天${summary.streakProtection ? ` (保护中, 剩余${summary.streakProtectionDays}天)` : ''}`,
            `今日任务进度:`,
            `  • 电脑搜索: ${summary.pcSearch.current}/${summary.pcSearch.max} (剩余 ${summary.pcSearch.remaining} 分)`,
            `  • 手机搜索: ${summary.mobileSearch.current}/${summary.mobileSearch.max} (剩余 ${summary.mobileSearch.remaining} 分)`,
            `  • Edge奖励: ${summary.edgeSearch.current}/${summary.edgeSearch.max} (剩余 ${summary.edgeSearch.remaining} 分)`,
            `  • 每日任务: ${summary.dailySet.current}/${summary.dailySet.max} (剩余 ${summary.dailySet.remaining} 分)`,
            `  • 更多活动: ${summary.morePromotions.current}/${summary.morePromotions.max} (剩余 ${summary.morePromotions.remaining} 分)`,
            `  • App阅读:  ${summary.appReadToEarn.current}/${summary.appReadToEarn.max} (剩余 ${summary.appReadToEarn.remaining} 分)`,
            `  • App签到:  ${summary.appCheckIn.points > 0 ? `+${summary.appCheckIn.points}分可领` : '已完成/无'}`,
            `今日共计可赚取剩余: ${summary.totalEarnableToday} 分 | 今日已获得: +${summary.todayEarned} 分`,
            `----------------------------------------------------`
        ]
        return lines.join('\n')
    }

    async bootstrap(page: Page): Promise<void> {
        try {
            // /earn is the offers page
            await page.goto(URLs.rewards.earn, { waitUntil: 'domcontentloaded' })

            // first-time welcome modal blocks the dashboard from rendering
            await this.dismissRewardsWelcomeDialog(page)

            const earnDom = await page.content()
            const earnRaw = await this.fetchBootstrapHtml(page, URLs.rewards.earn, '/earn')

            this.rewardsDeploymentId = this.bot.browser.react.buildId(earnRaw || earnDom) ?? ''

            this.bot.nextRouterStateTree = this.bot.browser.react.routerStateTree('earn')

            // pull /dashboard HTML to capture chunks that /earn doesn't show
            const dashboardHtml = await this.fetchBootstrapHtml(page, URLs.rewards.dashboard, '/dashboard')

            const sources = [earnRaw, earnDom, dashboardHtml].filter(Boolean)
            const snapshot = this.bot.browser.react.snapshotPage(sources)
            this.bot.reactSnapshot = snapshot
            if (this.bot.isMobile) this.bot.reactSnapshots.mobile = snapshot
            else this.bot.reactSnapshots.desktop = snapshot

            // discovered from chunks referenced by either page
            this.bot.nextActions = await this.resolveActionIds(page, sources)

            const dashboardRendered = /<section\b[^>]*\bid=["']dailyset["']/i.test(sources.join('\n'))
            if (!dashboardRendered) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    'Rewards 仪表板页面静态内容未包含 section#dailyset（可能页面改版或由客户端动态渲染），降级为Flyout/API兜底模式'
                )
            }

            if (!this.bot.reactSnapshot.offers.length) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    '未解析到任何优惠活动 - 页面可能未渲染 RSC 载荷（请检查登录/重定向）'
                )
            }

            if (!Object.keys(this.bot.nextActions).length) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    '未发现任何 action id - server-action 调用将失败（bundle 可能已剥离名称）'
                )
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'BOOTSTRAP',
                `上下文就绪 | actions=${Object.keys(this.bot.nextActions).length} | 可上报=${this.bot.reactSnapshot.reportable.length} | 可用积分=${this.bot.reactSnapshot.account.availablePoints}`
            )

            this.bot.logger.info(
                this.bot.isMobile,
                'BUILD',
                `Rewards 构建 | id=${this.rewardsDeploymentId || 'unknown'}`,
                'cyan'
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'BOOTSTRAP',
                `获取上下文失败 | 错误=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    /**
     * Dismisses the first-time welcome modal on /earn, which otherwise
     * prevents section#dailyset from rendering.
     */
    private async dismissRewardsWelcomeDialog(page: Page): Promise<void> {
        try {
            const welcomeButton = await page
                .waitForSelector('section[role="dialog"] button[slot="close"]', { timeout: 5000 })
                .catch(() => null)
            if (!welcomeButton) return

            await welcomeButton.click({ timeout: 5000 })
            this.bot.logger.info(this.bot.isMobile, 'BOOTSTRAP', '已关闭首次访问欢迎弹窗')

            await page.waitForSelector('section#dailyset', { timeout: 15000 }).catch(() => undefined)
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'BOOTSTRAP',
                `关闭欢迎弹窗失败: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async fetchBootstrapHtml(page: Page, url: string, route: string): Promise<string> {
        try {
            const res = await page.request.get(url, { timeout: 20000 })
            if (res.ok()) return await res.text()

            this.bot.logger.warn(
                this.bot.isMobile,
                'BOOTSTRAP',
                `获取 ${route} HTML 失败 | 状态码=${res.status()} - 快照和 action 发现可能不完整`
            )
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'BOOTSTRAP',
                `获取 ${route} HTML 失败 | 错误=${error instanceof Error ? error.message : String(error)} - 快照和 action 发现可能不完整`
            )
        }

        return ''
    }

    private async resolveActionIds(page: Page, htmls: string[]): Promise<Record<string, string>> {
        const result: Record<string, string> = {}

        try {
            const initialChunks = new Set<string>()
            const chunkRegex = /(?:\/_next\/)?(static\/(?:chunks|immutable|media)\/[\w\-./()]+?\.js)/g
            for (const html of htmls) {
                if (!html) continue
                for (const match of html.matchAll(chunkRegex)) {
                    initialChunks.add('/_next/' + match[1]!)
                }
            }

            if (initialChunks.size === 0) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    '未在 HTML 中发现初始代码块 - 代码块引用形式可能已变化'
                )
            }

            this.bot.logger.debug(this.bot.isMobile, 'BOOTSTRAP', `正在获取 ${initialChunks.size} 个初始 JS 代码块`)
            const jsByPath = await this.fetchJsChunks(page, [...initialChunks])

            const dynamicPaths = new Set<string>()
            for (const js of jsByPath.values()) {
                for (const path of this.extractDynamicChunkPaths(js)) {
                    if (!jsByPath.has(path)) dynamicPaths.add(path)
                }
            }

            if (dynamicPaths.size) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'BOOTSTRAP',
                    `正在获取通过 webpack manifest 发现的 ${dynamicPaths.size} 个动态代码块`
                )
                const moreJs = await this.fetchJsChunks(page, [...dynamicPaths])
                for (const [path, js] of moreJs) jsByPath.set(path, js)
            }

            for (const [path, js] of jsByPath) {
                const filename = path.split('/').pop() ?? path
                const ids = this.bot.browser.react.extractActionIds(js)
                const names = Object.keys(ids.byName)

                if (names.length) {
                    Object.assign(result, ids.byName)
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `在 ${filename} 中发现 ${names.length} 个 action id: [${names.join(', ')}]`
                    )
                } else {
                    this.bot.logger.debug(this.bot.isMobile, 'BOOTSTRAP', `在 ${filename} 中未发现 server-action id`)
                }

                const namedSet = new Set(Object.values(ids.byName))
                const unnamed = ids.all.filter(id => !namedSet.has(id))
                if (unnamed.length) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `在 ${filename} 中发现 ${unnamed.length} 个未命名 action id: [${unnamed.join(', ')}]`
                    )
                }
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'BOOTSTRAP',
                `已发现 ${Object.keys(result).length} 个 action id: [${Object.keys(result).join(', ')}]`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'BOOTSTRAP',
                `解析 action id 失败 | 错误=${error instanceof Error ? error.message : String(error)}`
            )
        }

        return result
    }

    private async fetchJsChunks(page: Page, paths: string[]): Promise<Map<string, string>> {
        const result = new Map<string, string>()

        await Promise.all(
            paths.map(async path => {
                try {
                    const res = await page.request.get(URLs.rewards.path(path))
                    if (res.ok()) {
                        result.set(path, await res.text())
                    }
                } catch (error) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BOOTSTRAP',
                        `代码块获取失败 | 路径=${path} | ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            })
        )

        return result
    }

    private extractDynamicChunkPaths(js: string): string[] {
        const seen = new Set<string>()

        // Webpack builder
        const builder = /static\/chunks\/"\s*\+\s*\w+\s*\+\s*"([-.])"\s*\+\s*\{([\s\S]*?)\}\s*\[/g
        for (const match of js.matchAll(builder)) {
            const sep = match[1]!
            for (const [, id, hash] of match[2]!.matchAll(/(\d+)\s*:\s*"([a-f0-9]+)"/g)) {
                seen.add(`/_next/static/chunks/${id}${sep}${hash}.js`)
            }
        }

        // Webpack fallback
        for (const [, id, hash] of js.matchAll(/\b(\d{2,6}):"([a-f0-9]{12,})"/g)) {
            seen.add(`/_next/static/chunks/${id}-${hash}.js`)
            seen.add(`/_next/static/chunks/${id}.${hash}.js`)
        }

        // Turbopack
        const turbopackRegex = /"(static\/(?:immutable|chunks|media)\/[\w\-./()]+?\.js)"/g
        for (const match of js.matchAll(turbopackRegex)) {
            seen.add(`/_next/${match[1]}`)
        }

        return [...seen]
    }

    async closeBrowser(browser: BrowserContext, email: string, persistSession = true) {
        const rootBrowser = browser.browser?.() || null

        try {
            if (persistSession) {
                const storageState = await browser.storageState()
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'CLOSE-BROWSER',
                    `正在保存会话 | Cookie数=${storageState.cookies.length} | origins=${storageState.origins.length}`
                )
                saveStorageState(this.bot.config.sessionPath, email, this.bot.isMobile, storageState)
            }
        } catch (error) {
            if (isBrowserClosedError(error)) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'CLOSE-BROWSER',
                    `会话未保存（浏览器已在关闭中）: ${error instanceof Error ? error.message : String(error)}`
                )
            } else {
                this.bot.logger.error(this.bot.isMobile, 'CLOSE-BROWSER', `保存会话失败: ${error}`)
            }
        } finally {
            try {
                await browser.close()

                if (rootBrowser) {
                    await rootBrowser.close().catch(() => {})
                }

                this.bot.logger.info(this.bot.isMobile, 'CLOSE-BROWSER', '所有浏览器资源已关闭。')
            } catch (error) {
                if (isBrowserClosedError(error)) {
                    this.bot.logger.debug(this.bot.isMobile, 'CLOSE-BROWSER', '浏览器已处于关闭状态。')
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'CLOSE-BROWSER',
                        '关闭时遇到错误，但进程仍在退出。'
                    )
                }
            }
        }
    }

    private getActivePage(): Page | null {
        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        return page && !page.isClosed() ? page : null
    }

    async getRewardsPageHtml(url: string, route: string): Promise<string | null> {
        const direct = await this.fetchRewardsHtml(url, route)
        if (direct !== null) return direct

        const page = this.getActivePage()
        if (!page) return null

        try {
            const response = await page.request.get(url, { timeout: 20000 })
            if (response.ok()) {
                await this.syncActiveCookies(page, 'REWARDS-PAGE')
                return await response.text()
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'REWARDS-PAGE',
                `获取 ${route} 失败 | 状态码=${response.status()}`
            )
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'REWARDS-PAGE',
                `浏览器请求 ${route} 失败 | ${error instanceof Error ? error.message : String(error)}`
            )
        }

        return null
    }

    private getCachedCookies(explicitCookies?: Cookie[], targetUrl?: string): Cookie[] {
        const cookies = explicitCookies ?? (this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop)
        return targetUrl ? this.filterCookiesForUrl(cookies, targetUrl) : cookies
    }

    async checkpointActiveSession(source = 'SESSION-CHECKPOINT'): Promise<boolean> {
        const page = this.getActivePage()
        if (!page) {
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                '无法保存会话检查点，因为没有可用的活动浏览器页面'
            )
            return false
        }

        try {
            await this.syncActiveCookies(page, source, true)
            return true
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                `无法保存活动会话检查点 | 错误=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async synchronizeActiveBrowserCookies(source: string, applyCached = false): Promise<boolean> {
        const page = this.getActivePage()
        if (!page) return false

        try {
            const context = page.context()
            let liveCookies = await context.cookies()

            if (applyCached) {
                const now = Date.now() / 1000
                const liveByKey = new Map(
                    liveCookies.map(cookie => [`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie])
                )
                const changed = this.getCachedCookies().filter(cookie => {
                    if (cookie.expires !== -1 && cookie.expires <= now) return false
                    const live = liveByKey.get(`${cookie.domain}|${cookie.path}|${cookie.name}`)
                    return (
                        !live ||
                        live.value !== cookie.value ||
                        live.expires !== cookie.expires ||
                        live.httpOnly !== cookie.httpOnly ||
                        live.secure !== cookie.secure ||
                        live.sameSite !== cookie.sameSite
                    )
                })

                if (changed.length) {
                    await context.addCookies(changed)
                    liveCookies = await context.cookies()
                }
            }

            this.updateCookieCache(liveCookies, source)
            return true
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                `无法同步活动浏览器 Cookie | 错误=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    private updateCookieCache(liveCookies: Cookie[], source: string): boolean {
        const cachedCookies = this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop
        const cookieState = (cookie: Cookie) =>
            JSON.stringify({
                value: cookie.value,
                expires: cookie.expires,
                httpOnly: cookie.httpOnly,
                secure: cookie.secure,
                sameSite: cookie.sameSite
            })
        const cachedByKey = new Map(
            cachedCookies.map(cookie => [`${cookie.domain}|${cookie.path}|${cookie.name}`, cookieState(cookie)])
        )
        const changed =
            cachedCookies.length !== liveCookies.length ||
            liveCookies.some(
                cookie => cachedByKey.get(`${cookie.domain}|${cookie.path}|${cookie.name}`) !== cookieState(cookie)
            )

        if (this.bot.isMobile) this.bot.cookies.mobile = liveCookies
        else this.bot.cookies.desktop = liveCookies

        if (changed) {
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                `已刷新 Cookie 缓存 | 之前=${cachedCookies.length} | 当前=${liveCookies.length}`
            )
        }

        return changed
    }

    private async syncActiveCookies(page: Page, source: string, forcePersist = false): Promise<void> {
        try {
            const context = page.context()
            const liveCookies = await context.cookies()
            const changed = this.updateCookieCache(liveCookies, source)
            if (!changed && !forcePersist) return

            const email = this.bot.currentAccountEmail
            if (!email) return

            const storageState = await context.storageState()
            saveStorageState(this.bot.config.sessionPath, email, this.bot.isMobile, storageState)
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                `已持久化活动浏览器会话 | Cookie数=${storageState.cookies.length} | origins=${storageState.origins.length}`
            )
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                source,
                `无法持久化刷新后的 Cookie | 错误=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private filterCookiesForUrl(cookies: Cookie[], targetUrl: string): Cookie[] {
        const url = new URL(targetUrl)
        const host = url.hostname.toLowerCase()
        const requestPath = url.pathname || '/'
        const now = Date.now() / 1000

        return cookies
            .filter(cookie => {
                if (cookie.expires !== -1 && cookie.expires <= now) return false
                if (cookie.secure && url.protocol !== 'https:') return false

                const domain = cookie.domain.replace(/^\./, '').toLowerCase()
                if (host !== domain && !host.endsWith(`.${domain}`)) return false

                const cookiePath = cookie.path || '/'
                if (!requestPath.startsWith(cookiePath)) return false
                if (
                    requestPath.length > cookiePath.length &&
                    !cookiePath.endsWith('/') &&
                    requestPath.charAt(cookiePath.length) !== '/'
                )
                    return false

                return true
            })
            .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))
    }

    private async applyResponseCookies(requestUrl: string, setCookieHeader?: string[] | string): Promise<void> {
        if (!setCookieHeader) return

        const rawCookies = Array.isArray(setCookieHeader)
            ? setCookieHeader
            : this.splitCombinedSetCookieHeader(setCookieHeader)
        if (!rawCookies.length) return

        const current = this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop
        const updated = [...current]
        let changed = false

        for (const raw of rawCookies) {
            const parsed = this.parseSetCookie(raw, requestUrl)
            if (!parsed) continue

            const keyMatches = (cookie: Cookie) =>
                cookie.name === parsed.cookie.name &&
                cookie.domain === parsed.cookie.domain &&
                cookie.path === parsed.cookie.path
            const index = updated.findIndex(keyMatches)

            if (parsed.remove) {
                if (index >= 0) {
                    updated.splice(index, 1)
                    changed = true
                }
                continue
            }

            if (index >= 0) {
                if (JSON.stringify(updated[index]) !== JSON.stringify(parsed.cookie)) {
                    updated[index] = parsed.cookie
                    changed = true
                }
            } else {
                updated.push(parsed.cookie)
                changed = true
            }
        }

        if (!changed) return

        this.updateCookieCache(updated, 'COOKIE-SYNC')

        const email = this.bot.currentAccountEmail
        if (!email) return

        const saved = loadSession(this.bot.config.sessionPath, email, this.bot.isMobile)
        saveStorageState(this.bot.config.sessionPath, email, this.bot.isMobile, {
            cookies: updated,
            origins: saved?.storageState?.origins ?? []
        })
        this.bot.logger.debug(
            this.bot.isMobile,
            'COOKIE-SYNC',
            `已应用 ${rawCookies.length} 个响应 Cookie 并持久化更新后的会话`
        )
    }

    private parseSetCookie(raw: string, requestUrl: string): { cookie: Cookie; remove: boolean } | null {
        const parts = raw.split(';').map(part => part.trim())
        const first = parts.shift()
        if (!first) return null

        const equals = first.indexOf('=')
        if (equals <= 0) return null

        const request = new URL(requestUrl)
        const name = first.slice(0, equals).trim()
        const value = first.slice(equals + 1)
        let domain = request.hostname
        let cookiePath = this.defaultCookiePath(request.pathname)
        let expires = -1
        let secure = false
        let httpOnly = false
        let sameSite: Cookie['sameSite'] = 'Lax'
        let remove = false

        for (const attribute of parts) {
            const separator = attribute.indexOf('=')
            const attributeName = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase()
            const attributeValue = separator < 0 ? '' : attribute.slice(separator + 1).trim()

            if (attributeName === 'domain' && attributeValue) domain = attributeValue.toLowerCase()
            else if (attributeName === 'path' && attributeValue) cookiePath = attributeValue
            else if (attributeName === 'secure') secure = true
            else if (attributeName === 'httponly') httpOnly = true
            else if (attributeName === 'expires' && attributeValue) {
                const parsed = Date.parse(attributeValue)
                if (Number.isFinite(parsed)) expires = parsed / 1000
            } else if (attributeName === 'max-age' && attributeValue) {
                const seconds = Number(attributeValue)
                if (Number.isFinite(seconds)) {
                    if (seconds <= 0) remove = true
                    else expires = Date.now() / 1000 + seconds
                }
            } else if (attributeName === 'samesite') {
                const normalized = attributeValue.toLowerCase()
                if (normalized === 'strict') sameSite = 'Strict'
                else if (normalized === 'none') sameSite = 'None'
                else sameSite = 'Lax'
            }
        }

        if (expires !== -1 && expires <= Date.now() / 1000) remove = true

        return {
            cookie: { name, value, domain, path: cookiePath, expires, httpOnly, secure, sameSite },
            remove
        }
    }

    private defaultCookiePath(pathname: string): string {
        if (!pathname || !pathname.startsWith('/') || pathname === '/') return '/'
        const lastSlash = pathname.lastIndexOf('/')
        return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash)
    }

    private splitCombinedSetCookieHeader(header: string): string[] {
        return header
            .split(/,(?=\s*[^;,=\s]+=[^;,]*)/g)
            .map(value => value.trim())
            .filter(Boolean)
    }

    buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string {
        return cookies
            .filter(cookie => {
                if (!allowedDomains?.length) return true
                return allowedDomains.some(domain => cookie.domain.toLowerCase().endsWith(domain.toLowerCase()))
            })
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ')
    }

    // Fire a nextjs RSC server action shared by UrlReward / ClaimReward / ClaimBonusPoints
    async reportServerAction(
        actionId: string,
        body: unknown[],
        opts?: { url?: string; referer?: string; routerStateTree?: string }
    ): Promise<{ status: number; acknowledged: boolean; availablePoints: number | null }> {
        const url = opts?.url ?? URLs.rewards.earn
        const referer = opts?.referer ?? url
        const routerStateTree = opts?.routerStateTree ?? this.bot.nextRouterStateTree

        const fingerprintHeaders = { ...this.bot.fingerprint.headers }
        delete fingerprintHeaders['Cookie']
        delete fingerprintHeaders['cookie']

        const headers = {
            ...fingerprintHeaders,
            Referer: referer,
            Origin: URLs.rewards.origin,
            Accept: 'text/x-component',
            'Content-Type': 'text/plain;charset=UTF-8',
            'Next-Action': actionId,
            'Next-Router-State-Tree': routerStateTree,
            ...(this.rewardsDeploymentId ? { 'X-Deployment-Id': this.rewardsDeploymentId } : {})
        }

        const response = await this.bot.http.request({
            url,
            method: 'POST',
            headers: {
                ...headers,
                Cookie: this.buildCookieHeader(this.getCachedCookies(undefined, url))
            },
            data: JSON.stringify(body)
        })
        await this.applyResponseCookies(url, response.headers['set-cookie'])

        return {
            status: response.status,
            acknowledged: this.bot.utils.serverActionAcknowledged(response.data),
            availablePoints: this.bot.browser.react.availablePointsFromPayload(response.data)
        }
    }

    async refreshEarnSnapshot(): Promise<PageSnapshot | null> {
        const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
        const usePage = !!page && !page.isClosed()

        const fetchSnapshotPage = async (url: string, route: string): Promise<string | null> => {
            if (!usePage) return await this.fetchRewardsHtml(url, route)
            return await this.getRewardsPageHtml(url, route)
        }

        const pages = await Promise.all([
            fetchSnapshotPage(URLs.rewards.earn, '/earn'),
            fetchSnapshotPage(URLs.rewards.dashboard, '/dashboard')
        ])
        const availablePages = pages.filter((html): html is string => html !== null)

        return availablePages.length ? this.bot.browser.react.snapshotPage(availablePages) : null
    }

    private async fetchRewardsHtml(url: string, route: string): Promise<string | null> {
        try {
            const headers = { ...(this.bot.fingerprint?.headers ?? {}) }
            delete headers['Cookie']
            delete headers['cookie']

            const response = await this.bot.http.request<string>({
                url,
                method: 'GET',
                headers: {
                    ...headers,
                    Cookie: this.buildCookieHeader(this.getCachedCookies(undefined, url)),
                    Referer: URLs.rewards.referer,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                responseType: 'text'
            })

            await this.applyResponseCookies(url, response.headers['set-cookie'])
            return typeof response.data === 'string' ? response.data : null
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'EARN-SNAPSHOT',
                `通过 HTTP 获取 ${route} 失败 | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    async ensureOffer(offerId: string): Promise<ParsedOffer | null> {
        const cached = this.bot.reactSnapshot?.offers.find(o => o.offerId === offerId)
        if (cached) return cached

        this.bot.logger.debug(
            this.bot.isMobile,
            'EARN-SNAPSHOT',
            `${offerId} 不在缓存快照中 (offers=${this.bot.reactSnapshot?.offers.length ?? 0}) - 正在重新获取 /earn 和 /dashboard`
        )

        const refreshed = await this.refreshEarnSnapshot()
        if (!refreshed) return null

        if (!this.bot.reactSnapshot || refreshed.offers.length >= this.bot.reactSnapshot.offers.length) {
            this.bot.reactSnapshot = refreshed
        }

        const live = refreshed.offers.find(o => o.offerId === offerId) ?? null

        this.bot.logger.debug(
            this.bot.isMobile,
            'EARN-SNAPSHOT',
            `已重新获取 /earn 和 /dashboard | offers=${refreshed.offers.length} | ${offerId} 找到=${!!live}`
        )

        return live
    }
}
