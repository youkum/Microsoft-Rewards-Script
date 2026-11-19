import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function load(file, dependencies = {}, transform = source => source, globals = {}) {
    const filename = path.join(root, file)
    const code = ts.transpileModule(transform(fs.readFileSync(filename, 'utf8')), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText
    const exports = {}
    const nativeRequire = createRequire(filename)
    vm.runInNewContext(code, {
        exports,
        URL,
        Date,
        Number,
        Map,
        Set,
        AbortController,
        setTimeout,
        clearTimeout,
        require: name => (Object.hasOwn(dependencies, name) ? dependencies[name] : nativeRequire(name)),
        ...globals
    })
    return exports
}
const flyout = load('src/browser/FlyoutDashboard.ts')
const { URLs } = load('src/constants/urls.ts')
const sessionStore = { loadSession: () => null, saveStorageState: () => assert.fail('test must not write sessions') }
const BrowserFunc = load('src/browser/BrowserFunc.ts', {
    '../constants/urls': { URLs },
    '../constants/userAgents': {},
    '../util/SessionStore': sessionStore,
    '../util/Utils': { isBrowserClosedError: () => false },
    './FlyoutDashboard': flyout
}).default
const { SearchProgress } = load('src/functions/activities/search/SearchProgress.ts')
const logger = { info() {}, warn() {}, debug() {}, error() {} }
const observer = { measure: (_stage, fn) => fn(), measureSync: (_stage, fn) => fn() }
function payload(balance = 18722) {
    return {
        isError: false,
        userInfo: { isRewardsUser: true, balance, profile: { attributes: { country: 'CN' } } },
        flyoutResult: {
            userStatus: {
                isRewardsUser: true,
                availablePoints: balance,
                counters: { PCSearch: [{ pointProgress: 0, pointProgressMax: 60 }] }
            },
            morePromotions: []
        }
    }
}
function bot() {
    return {
        isMobile: false,
        currentAccountEmail: null,
        logger,
        performance: observer,
        cookies: { desktop: [], mobile: [] },
        fingerprint: { headers: {} },
        accessToken: '',
        userData: { currentPoints: 0, initialPoints: 0, geoLocale: 'CN' },
        utils: { getFormattedDate: () => '11/19/2026' }
    }
}

test('regional Flyout request carries CN host cookies and restores the 60-point search quota', async () => {
    const b = bot()
    const cookie = (domain, name) => ({ domain, name, value: 'test', expires: -1, path: '/', secure: true })
    b.cookies.desktop = [
        cookie('.bing.com', 'shared'),
        cookie('cn.bing.com', 'cnAuth'),
        cookie('www.bing.com', 'wwwOnly')
    ]
    const requests = []
    b.http = {
        request: async request => {
            requests.push(request)
            return { data: payload(), headers: {} }
        }
    }
    const f = new BrowserFunc(b)
    b.browser = { func: f }
    const dashboard = await f.getDashboardData()
    assert.equal(requests.length, 1, 'valid Flyout must avoid the deprecated API')
    assert.equal(new URL(requests[0].url).hostname, 'cn.bing.com')
    assert.match(requests[0].headers.Cookie, /cnAuth=test/)
    assert.doesNotMatch(requests[0].headers.Cookie, /wwwOnly/)
    assert.equal(dashboard.dashboard.userStatus.availablePoints, 18722)
    const quotas = new SearchProgress(b).calculateQuotas(dashboard.dashboard.userStatus.counters)
    assert.equal(quotas.desktop.remaining, 60)
    b.userData.geoLocale = 'US'
    await f.getDashboardData()
    assert.equal(new URL(requests[1].url).hostname, 'www.bing.com')
})

test('anonymous Flyout and missing balance never become a verified zero balance', () => {
    const anonymous = payload(0)
    anonymous.userInfo.isRewardsUser = false
    anonymous.flyoutResult.userStatus.isRewardsUser = false
    assert.throws(() => flyout.mapFlyoutToDashboard(anonymous), /missing Rewards account data/)
    const missing = payload(null)
    const mapped = flyout.mapFlyoutToDashboard(missing)
    assert.equal(mapped.dataQuality.balance, false)
    const noQuota = payload()
    noQuota.flyoutResult.userStatus.counters = {}
    assert.equal(flyout.mapFlyoutToDashboard(noQuota).dataQuality.search, false)
    assert.equal(flyout.mapFlyoutToDashboard(payload(0)).dataQuality.balance, true)
})

test('local fallback cannot mark search quotas complete or suppress the live balance fallback', async () => {
    const b = bot(),
        f = new BrowserFunc(b)
    b.browser = { func: f }
    f.getDashboardData = async () => f.createFallbackDashboardData()
    let probes = 0
    f.getPointsFromBrowserPage = async () => {
        probes++
        return 18722
    }
    assert.equal(await f.getCurrentPoints(), 18722)
    assert.equal(probes, 1)
    const summary = await f.getAllAccountPoints()
    assert.equal(summary.availablePoints, 18722)
    assert.equal(summary.balanceVerified, true)
    await assert.rejects(new SearchProgress(b).getCounters(), /搜索额度数据不可用/)
    f.getPointsFromBrowserPage = async () => null
    assert.equal((await f.getAllAccountPoints()).balanceVerified, false)
})

test('browser transport uses its cookie jar when direct Flyout transport returns anonymous data', async () => {
    const b = bot(),
        f = new BrowserFunc(b)
    let direct = 0,
        browser = 0
    b.http = {
        request: async () => {
            direct++
            const d = payload()
            d.userInfo.isRewardsUser = false
            return { data: d, headers: {} }
        }
    }
    b.mainDesktopPage = {
        isClosed: () => false,
        request: {
            get: async url => {
                browser++
                assert.equal(new URL(url).hostname, 'cn.bing.com')
                return { ok: () => true, json: async () => payload() }
            }
        }
    }
    assert.equal((await f.getDashboardData()).dashboard.userStatus.availablePoints, 18722)
    assert.equal(direct, 1)
    assert.equal(browser, 1)
})

test('local fallback does not mark daily tasks or promotions complete', async () => {
    class BaseActivity {
        constructor(bot) {
            this.bot = bot
        }
    }
    const dependencies = { '../BaseActivity': { BaseActivity }, './PromotionActivityRunner': {} }
    for (const [file, name] of [
        ['DailySet', 'DailySet'],
        ['MorePromotions', 'MorePromotions']
    ]) {
        const Activity = load(`src/functions/activities/rewards/${file}.ts`, dependencies)[name]
        const b = bot(),
            f = new BrowserFunc(b)
        await assert.rejects(new Activity(b).run(f.createFallbackDashboardData()), /数据不可用/)
    }
})

class Dummy {}
const placeholder = new Proxy({ __esModule: true, default: Dummy }, { get: (object, key) => object[key] ?? Dummy })
const indexSource = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')
const imports = [...indexSource.matchAll(/from '([^']+)'/g)].map(match => match[1])
const indexDeps = Object.fromEntries(imports.filter(name => !name.startsWith('node:')).map(name => [name, placeholder]))
indexDeps['./util/Locale'] = {
    normalizeCountry: country => country,
    resolveAccountLocale: () => ({ country: 'CN', locale: 'zh-CN' })
}
const { MicrosoftRewardsBot } = load('src/index.ts', indexDeps, source =>
    source.slice(0, source.lastIndexOf('\nmain().catch'))
)
function runner() {
    const values = bot()
    delete values.isMobile
    delete values.currentAccountEmail
    delete values.fingerprint
    const b = Object.assign(Object.create(MicrosoftRewardsBot.prototype), values)
    b.config = { experimental: {}, workers: {}, searchSettings: {} }
    b.accountLocale = { country: 'CN' }
    const page = { isClosed: () => false }
    b.browserFactory = {
        createBrowser: async () => ({
            context: { newPage: async () => page, cookies: async () => [] },
            fingerprint: {}
        })
    }
    b.login = { login: async () => {} }
    b.http = { setDefaultHeaders() {} }
    b.searchManager = { getSearchPoints: async () => ({ doMobile: false, doDesktop: false }) }
    const dashboard = flyout.mapFlyoutToDashboard(payload())
    b.browser = {
        func: {
            resetAccountState() {},
            checkpointActiveSession: async () => {},
            closeBrowser: async () => {},
            getDashboardData: async () => dashboard,
            getAllAccountPoints: async () => ({ balanceVerified: true, availablePoints: 18722 }),
            getBrowserEarnablePoints: async () => ({ desktopSearchPoints: 60, mobileSearchPoints: 0 }),
            formatPointsSummary: () => ''
        }
    }
    return b
}
const account = { email: 'account@example.test', geoLocale: 'CN' }

test('login maintenance saves only requested platforms without executing rewards workers', async () => {
    for (const platform of ['mobile', 'desktop', 'both']) {
        const b = runner()
        b.utils.getEmailUsername = () => 'account'
        b.activities = new Proxy({}, { get: () => () => assert.fail('login must not execute rewards activities') })
        const loggedIn = [],
            closed = []
        b.login.login = async (_page, _account, requireVerifiedSession) => {
            assert.equal(requireVerifiedSession, true, 'maintenance must require upstream validation')
            loggedIn.push(b.isMobile ? 'mobile' : 'desktop')
        }
        b.login.getAppAccessToken = () => assert.fail('login does not request app activity tokens')
        b.browser.func.checkpointActiveSession = async () => true
        b.browser.func.closeBrowser = async (_context, email, persist) => closed.push({ email, persist })
        await b.saveLoginOnly(account, platform)
        assert.deepEqual(loggedIn, platform === 'both' ? ['mobile', 'desktop'] : [platform])
        assert.equal(closed.length, loggedIn.length)
        assert.ok(closed.every(item => item.email === account.email && item.persist))
    }
})

test('failed maintenance login closes its browser without replacing a saved session', async () => {
    const b = runner()
    b.utils.getEmailUsername = () => 'account'
    b.login.login = async () => {
        throw new Error('verification failed')
    }
    const persisted = []
    b.browser.func.closeBrowser = async (_context, _email, persist) => persisted.push(persist)
    b.browser.func.checkpointActiveSession = async () => assert.fail('must not checkpoint a failed login')
    await assert.rejects(b.saveLoginOnly(account, 'both'), /verification failed/)
    assert.deepEqual(persisted, [false])
})

test('maintenance login reports a failed database save and never reports completion', async () => {
    const b = runner()
    b.utils.getEmailUsername = () => 'account'
    b.browser.func.checkpointActiveSession = async () => false
    const titles = []
    b.logger = { ...logger, info: (_platform, title) => titles.push(title) }
    await assert.rejects(b.saveLoginOnly(account, 'desktop'), /会话保存失败/)
    assert.ok(!titles.includes('LOGIN-ONLY-END'))
})

const loginSource = fs.readFileSync(path.join(root, 'src/browser/auth/Login.ts'), 'utf8')
const loginImports = [...loginSource.matchAll(/from '([^']+)'/g)].map(match => match[1])
const loginDeps = Object.fromEntries(loginImports.map(name => [name, placeholder]))
loginDeps['../../constants/urls'] = { URLs, REWARDS_BASE_URL: 'https://rewards.bing.com' }
loginDeps['../FlyoutDashboard'] = flyout
loginDeps['../MediaBlocker'] = { configureMediaBlocking: async () => {} }
loginDeps['../../util/SessionStore'] = sessionStore
const { Login } = load('src/browser/auth/Login.ts', loginDeps)

test('Bing session validation uses the regional sign-in destination and verifies both platforms upstream', async () => {
    for (const isMobile of [false, true]) {
        const b = bot()
        b.isMobile = isMobile
        b.utils.wait = async () => {}
        b.browser = { utils: { tryDismissAllMessages: async () => {} } }
        const page = {
            goto: async url => {
                const u = new URL(url)
                assert.equal(u.hostname, 'cn.bing.com')
                assert.equal(u.searchParams.get('return_url'), 'https://cn.bing.com/')
            },
            url: () => 'https://cn.bing.com/',
            isClosed: () => false,
            request: {
                get: async url => {
                    assert.equal(new URL(url).hostname, 'cn.bing.com')
                    return { ok: () => true, json: async () => payload(2003) }
                }
            }
        }
        assert.equal(await new Login(b).verifyBingSession(page, account), true)
    }
    assert.equal(new URL(URLs.auth.bingSignInForCountry('US')).hostname, 'www.bing.com')
})

test('anonymous Bing pages never validate mobile sessions or overwrite saved sessions', async () => {
    for (const isMobile of [false, true]) {
        const b = bot()
        b.isMobile = isMobile
        b.config = { sessionPath: 'sessions' }
        b.utils.wait = async () => {}
        b.browser = { utils: { tryDismissAllMessages: async () => {} } }
        const anonymous = payload(0)
        anonymous.userInfo.isRewardsUser = false
        const page = {
            goto: async () => {},
            url: () => 'https://cn.bing.com/',
            isClosed: () => false,
            request: { get: async () => ({ ok: () => true, json: async () => anonymous }) },
            context: () => assert.fail('unverified login must not save or alter media configuration')
        }
        await assert.rejects(new Login(b).finalizeLogin(page, account, true), /未通过上游验证/)
    }
})

test('login CLI releases the process on success and failure even when dependencies retain handles', async () => {
    for (const fails of [false, true]) {
        const exits = []
        const deps = {
            ...indexDeps,
            './util/Validator': { checkNodeVersion() {} },
            './util/SessionStore': { closeSessionStore() {} }
        }
        for (const module of ['Discord', 'Ntfy', 'Telegram', 'PushPlus', 'ServerChan', 'ClawBot']) {
            deps[`./logging/${module}`] = { [`flush${module}Queue`]: async () => {} }
        }
        const b = {
            logger,
            initialize: async () => {},
            run: async () => {
                if (fails) throw new Error('upstream rejected session')
            }
        }
        const { main } = load(
            'src/index.ts',
            deps,
            source =>
                source
                    .slice(0, source.lastIndexOf('\nmain().catch'))
                    .replace('const rewardsBot = new MicrosoftRewardsBot()', 'const rewardsBot = mainBot') +
                '\nexports.main = main;',
            { mainBot: b, process: { env: { REWARDS_LOGIN_ONLY: 'desktop' }, on() {}, exit: code => exits.push(code) } }
        )
        await main()
        assert.deepEqual(exits, [fails ? 1 : 0])
    }
})

test('account lifecycle clears previous balances and actions before browser startup', async () => {
    const b = runner()
    Object.assign(b.userData, { initialPoints: 12764, currentPoints: 12764, gainedPoints: 50 })
    b.nextActions = { old: 'old' }
    b.nextRouterStateTree = 'old'
    let resets = 0
    b.browser.func.resetAccountState = () => resets++
    b.browserFactory.createBrowser = async () => {
        throw new Error('browser stopped')
    }
    await assert.rejects(b.runAccount(account), /browser stopped/)
    assert.equal(b.userData.initialPoints, 0)
    assert.equal(b.userData.currentPoints, 0)
    assert.equal(b.userData.gainedPoints, 0)
    assert.equal(Object.keys(b.nextActions).length, 0)
    assert.equal(b.nextRouterStateTree, '')
    assert.equal(resets, 1)
})

test('unverified initial and final balances never produce successful revenue', async () => {
    for (const invalidAt of [0, 1]) {
        const b = runner()
        let call = 0
        b.browser.func.getAllAccountPoints = async () => ({
            balanceVerified: call++ !== invalidAt,
            availablePoints: invalidAt === 0 ? 0 : 18722
        })
        await assert.rejects(b.runAccount(account), /余额无法核实/)
    }
    const b = runner()
    const balances = [0, 3]
    b.browser.func.getAllAccountPoints = async () => ({ balanceVerified: true, availablePoints: balances.shift() })
    const result = await b.runAccount(account)
    assert.equal(result.initialPoints, 0, 'a verified zero balance remains valid')
    assert.equal(result.collectedPoints, 3)
})

test('unavailable dashboard stops the account before tasks and earnings reporting', async () => {
    const b = runner()
    b.browser.func.getDashboardData = async () => new BrowserFunc(bot()).createFallbackDashboardData()
    b.browser.func.getAllAccountPoints = async () => assert.fail('must not request earnings from unknown dashboard')
    await assert.rejects(b.runAccount(account), /仪表板数据不可用/)
})

test('fallback state and diagnostic flags reset between accounts', () => {
    const f = new BrowserFunc(bot())
    f.useFlyoutDashboardFallback = true
    f.rewardsDeploymentId = 'old'
    f.botMetricsLoggedPlatforms.add('DESKTOP')
    f.resetAccountState()
    assert.equal(f.useFlyoutDashboardFallback, false)
    assert.equal(f.rewardsDeploymentId, '')
    assert.equal(f.botMetricsLoggedPlatforms.size, 0)
})
