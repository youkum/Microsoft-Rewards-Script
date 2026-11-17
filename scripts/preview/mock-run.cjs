// Finite local demo only. Uses filesystem data and stdout; never loads the bot,
// browser tooling, proxy agents, third-party packages, or a networking module.
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { parseEnvContent } = require('./scripts/credentialEnv.cjs')

const root = __dirname
let seed = false
try {
    fs.unlinkSync(path.join(root, '.preview-seed'))
    seed = true
} catch (error) {
    if (error.code !== 'ENOENT') throw error
}

function readAccounts() {
    const env = {}
    if (process.env.ACCOUNTS_FILTERED === 'true') {
        for (const [key, value] of Object.entries(process.env)) {
            if (/^ACCOUNT_[1-9]\d*_[A-Z_]+$/.test(key)) env[key] = value
        }
    } else {
        for (const { key, value } of parseEnvContent(
            fs.readFileSync(path.join(root, 'config', 'accounts.env'), 'utf8')
        )) {
            if (/^ACCOUNT_[1-9]\d*_[A-Z_]+$/.test(key)) env[key] = value
        }
    }
    return Object.keys(env)
        .map(key => /^ACCOUNT_([1-9]\d*)_EMAIL$/.exec(key)?.[1])
        .filter(index => index && env[`ACCOUNT_${index}_EMAIL`])
        .sort((a, b) => Number(a) - Number(b))
        .slice(0, 50)
        .map((index, position) => ({
            email: env[`ACCOUNT_${index}_EMAIL`],
            geoLocale: env[`ACCOUNT_${index}_GEO_LOCALE`] || 'US',
            locale: env[`ACCOUNT_${index}_LANG_CODE`] || 'en-US',
            gained: [285, 240, 310][position % 3],
            balance: 12000 + position * 4000
        }))
}

function restoreBalances(accounts) {
    try {
        const records = fs
            .readFileSync(path.join(root, 'config', 'points-history.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line))
            .reverse()
        for (const account of accounts) {
            const previous = records
                .flatMap(record => record.accounts || [])
                .find(entry => entry.email === account.email && Number.isFinite(entry.balance))
            if (previous) account.balance = previous.balance
        }
    } catch {
        // Demo accounts without history start from their synthetic base balance.
    }
}

function line(user, title, message, platform = 'MAIN', level = 'INFO') {
    const safe = value => String(value).replace(/[\r\n[\]]/g, ' ')
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'UTC' })
    process.stdout.write(`[${timestamp}] [${safe(user)}] [${level}] ${platform} [${title}] ${safe(message)}\n`)
}

async function run() {
    const accounts = readAccounts()
    restoreBalances(accounts)
    const started = Date.now()
    line(
        'preview',
        'PREVIEW',
        'DEMO ONLY: synthetic points and local logs. No Microsoft login, browser, proxy connection or external network request runs.'
    )
    line(
        'preview',
        'RUN-START',
        `Starting Microsoft Rewards Script | v0.0.0-demo | Accounts: ${accounts.length} | Clusters: 1`
    )
    let collected = 0
    let originalBalance = 0
    for (const [index, account] of accounts.entries()) {
        const user = account.email.split('@')[0]
        const step = async (title, message, platform = 'MAIN') => {
            line(user, title, message, platform)
            await delay(seed ? 3 : 650)
        }
        const initial = account.balance
        originalBalance += initial
        await step(
            'ACCOUNT-START',
            `Starting account: ${account.email} | geoLocale: ${account.geoLocale} | locale: ${account.locale}`
        )
        await step(
            'POINTS',
            `Earnable today | Mobile: 90 | Browser: 150 | App: 70 | ${account.email} | locale: ${account.locale}`
        )
        await step(
            'REACT-PARSE',
            `Snapshot completed | offers=12 | reportable=8 | streaks=1 | streakProtectionEnabled=true | streakProtectionRemainingDays=14 | streakCounter=${18 + index * 7} | level=2 | account=${account.email}`
        )
        await step('SEARCH-BING', `Starting Bing search | currentBalance=${initial}`, 'DESKTOP')
        await step(
            'DAILY-CHECK-IN',
            `Completed Daily Check-In | pointsGained=10 | currentBalance=${initial + 10}`,
            'MOBILE'
        )
        await step('READ-TO-EARN', `Read article | pointsGained=30 | currentBalance=${initial + 40}`, 'MOBILE')
        await step(
            'SEARCH-BING',
            `Demo search completed | pointsGained=${account.gained - 40} | currentBalance=${initial + account.gained}`,
            'DESKTOP'
        )
        await step('SEARCH-MANAGER', 'Search summary | mobile=90 | desktop=150 | bonus=0 | total=240')
        await step(
            'EDGE-BROWSING',
            'Finished background Edge browsing activity | reports=1 | scheduledMinutesCovered=5/5 | accepted=1 | duplicates=0 | failed=0 | elapsedMinutes=5 | estimatedRemainingMinutes=0'
        )
        await step(
            'FLOW',
            `Points collected | pointsGained=${account.gained} | currentBalance=${initial + account.gained} | account=${account.email}`
        )
        await step(
            'ACCOUNT-END',
            `Account completed: ${account.email} | pointsGained=${account.gained} | originalBalance=${initial} | currentBalance=${initial + account.gained} | durationSeconds=${seed ? 0.1 : 7.15}`
        )
        collected += account.gained
    }
    line(
        'preview',
        'RUN-END',
        `All accounts completed | accountsProcessed=${accounts.length} | pointsGained=${collected} | originalBalance=${originalBalance} | currentBalance=${originalBalance + collected} | runtimeMinutes=${((Date.now() - started) / 60000).toFixed(3)}`
    )
    line(
        'preview',
        'PREVIEW',
        'Finite demo run finished. Start again to stream another synthetic run; Stop cancels it locally.'
    )
}

process.once('SIGTERM', () => {
    line('preview', 'PREVIEW', 'Demo run stopped locally.')
    process.exit(0)
})
process.once('SIGINT', () => process.exit(0))
run().catch(error => {
    line('preview', 'PREVIEW', `Demo fixture error: ${error.message}`, 'MAIN', 'ERROR')
    process.exitCode = 1
})
