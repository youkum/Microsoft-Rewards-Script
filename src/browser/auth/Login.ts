import { URLs, REWARDS_BASE_URL } from '../../constants/urls'
import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../index'
import { saveStorageState } from '../../util/SessionStore'
import { unknownPageDiagnostic } from '../../util/ErrorDiagnostic'
import { configureMediaBlocking, suspendMediaBlocking } from '../MediaBlocker'

import { MobileAccessLogin } from './methods/MobileAccessLogin'
import { EmailLogin } from './methods/EmailLogin'
import { PasswordlessLogin } from './methods/PasswordlessLogin'
import { TotpLogin } from './methods/Totp2FALogin'
import { CodeLogin } from './methods/GetACodeLogin'
import { RecoveryLogin } from './methods/RecoveryEmailLogin'
import { canPromptForInput } from './methods/LoginUtils'

import type { Account } from '../../interface/Account'

type LoginState =
    | 'EMAIL_INPUT'
    | 'PASSWORD_INPUT'
    | 'FOOTER_ACTION'
    | 'SIGN_IN_METHOD_PICKER'
    | 'PASSKEY_ERROR'
    | 'PASSKEY_VIDEO'
    | 'KMSI_PROMPT'
    | 'LOGGED_IN'
    | 'EMAIL_VERIFICATION_INPUT'
    | 'RECOVERY_EMAIL_INPUT'
    | 'ACCOUNT_LOCKED'
    | 'ERROR_ALERT'
    | '2FA_TOTP'
    | 'LOGIN_PASSWORDLESS'
    | 'PASSWORDLESS_SEND_CODE'
    | 'OTP_CODE_ENTRY'
    | 'INTERSTITIAL_SKIP'
    | 'UNKNOWN'
    | 'CHROMEWEBDATA_ERROR'

type SignInMethodOption = {
    index: number
    selector: string
    label: string
    signature: string
}

type SignInMethodType = 'PASSWORD' | 'AUTHENTICATOR' | 'EMAIL' | 'PASSKEY' | 'TOTP' | 'UNKNOWN'

export class Login {
    emailLogin: EmailLogin
    passwordlessLogin: PasswordlessLogin
    totp2FALogin: TotpLogin
    codeLogin: CodeLogin
    recoveryLogin: RecoveryLogin

    private readonly capturedUnknownUrls = new Set<string>()
    private signInMethodsLogged = false
    private passwordlessMethodSelected = false
    private emailSubmittedCount = 0
    private passwordSubmittedCount = 0

    private readonly selectors = {
        primaryButton:
            'button[data-testid="primaryButton"], input#idSIButton9, button#idSIButton9, button[type="submit"], input[type="submit"], button#acceptButton',
        secondaryButton:
            'button[data-testid="secondaryButton"], input#idBtn_Back, button#idBtn_Back, #iCancel, #iShowSkip, a#iShowSkip, button:has-text("No thanks"), button:has-text("以后再说")',
        footerAction: '[data-testid="viewFooter"] [role="button"], #viewFooter [role="button"], a#cantAccessAccount',
        signInTile:
            '[data-testid="tile"], div[data-test="accountTile"], .table-cell[data-test="accountTile"], #picker[role="listbox"] div[role="option"], .tile-container',
        emailIconOld: 'img[data-testid="accessibleImg"][src*="picker_verify_email"], [data-value*="Email"]',
        passwordlessOptionOld:
            'img[data-testid="accessibleImg"][src*="picker_remote_ngc"], [data-value*="PhoneAppNotification"]',
        recoveryEmail: '[data-testid="proof-confirmation"], #proof-confirmation',
        emailVerificationInput: 'input#proof-confirmation-email-input, input#otc-confirmation-input',
        accountLocked: '#serviceAbuseLandingTitle, #idTd_Tile_ErrorMsg_Login',
        errorAlert:
            'div[role="alert"], #usernameError, #passwordError, div.alert-error, #errorText, #idTd_Tile_ErrorMsg_Login, span.text-danger, div.text-danger, div[data-testid="errorAlert"], div[data-testid="usernameError"], div[data-testid="passwordError"], div[id*="Error" i]',
        passwordEntry:
            '[data-testid="passwordEntry"], input#passwordEntry, input[name="passwd"], input#i0118, input[type="password"]',
        emailEntry:
            'input#usernameEntry, input[data-testid="usernameEntry"], input[name="loginfmt"], input#i0116, input[type="email"]',
        kmsiVideo:
            '[data-testid="kmsiVideo"], #kmsiTitle, input#KmsiCheckboxField, input[name="DontShowAgain"], div:has-text("保持登录状态"), div:has-text("Stay signed in")',
        passKeyVideo: '[data-testid="biometricVideo"]',
        passKeyError: '[data-testid="registrationImg"]',
        passwordlessCheck: '[data-testid="deviceShieldCheckmarkVideo"]',
        passwordlessNumber: '[data-testid="displaySign"], #displaySign',
        totpInput: 'input[name="otc"]',
        totpInputOld: 'form[name="OneTimeCodeViewForm"]',
        identityBanner: '[data-testid="identityBanner"], #displayName, #identityBanner',
        otpCodeEntry: '[data-testid="codeEntry"], input[name="otc"]',
        backButton: '#back-button, button[data-testid="backButton"], #idBtn_Back, button[aria-label="Back"]',
        bingProfile: '#id_n, #id_rh, #id_rc, .id_name',
        otpInput: 'div[data-testid="codeEntry"]',
        interstitialSkip:
            '#iShowSkip, a#iShowSkip, #iCancel, a:has-text("以后再说"), a:has-text("暂且跳过"), a:has-text("Skip for now"), button:has-text("No thanks"), button:has-text("以后再说"), button:has-text("取消")'
    } as const

    constructor(private bot: MicrosoftRewardsBot) {
        this.emailLogin = new EmailLogin(this.bot)
        this.passwordlessLogin = new PasswordlessLogin(this.bot)
        this.totp2FALogin = new TotpLogin(this.bot)
        this.codeLogin = new CodeLogin(this.bot)
        this.recoveryLogin = new RecoveryLogin(this.bot)
    }

    async login(page: Page, account: Account) {
        try {
            suspendMediaBlocking(this.bot, page.context())
            this.capturedUnknownUrls.clear()
            this.signInMethodsLogged = false
            this.passwordlessMethodSelected = false
            this.emailSubmittedCount = 0
            this.passwordSubmittedCount = 0
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始登录流程')

            await page
                .goto(URLs.rewards.userLogin, {
                    waitUntil: 'domcontentloaded'
                })
                .catch(() => {})
            await this.bot.utils.wait(2000)
            await this.bot.browser.utils.reloadBadPage(page)
            await this.bot.browser.utils.disableFido(page)

            const maxIterations = 25
            let iteration = 0
            let previousState: LoginState = 'UNKNOWN'
            let sameStateCount = 0

            while (iteration < maxIterations) {
                if (page.isClosed()) throw new Error('Page closed unexpectedly')

                iteration++
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `状态检查迭代 ${iteration}/${maxIterations}`)

                const state = await this.detectCurrentState(page)
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `当前状态: ${state}`)

                if (state !== previousState && previousState !== 'UNKNOWN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `状态转换: ${previousState} → ${state}`)
                }

                if (state === previousState && state !== 'LOGGED_IN' && state !== 'UNKNOWN') {
                    sameStateCount++
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN',
                        `相同状态计数: ${sameStateCount}/4 状态为 "${state}"`
                    )
                    if (sameStateCount >= 4) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN',
                            `在状态 "${state}" 停滞4次循环`
                        )
                        if (state === 'KMSI_PROMPT') {
                            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'KMSI停滞，尝试点击否/跳过或强制提交表单以推进流程')
                            await page.locator('input#idBtn_Back, button:has-text("否"), button:has-text("No"), button[data-testid="secondaryButton"]').first().click().catch(() => {})
                            await page.evaluate(() => (document.querySelector('form') as HTMLFormElement)?.submit()).catch(() => {})
                            await this.bot.utils.wait(3000)
                            sameStateCount = 0
                            continue
                        }
                        await page.reload({ waitUntil: 'domcontentloaded' })
                        await this.bot.utils.wait(3000)
                        sameStateCount = 0
                        previousState = 'UNKNOWN'
                        continue
                    }
                } else {
                    sameStateCount = 0
                }
                previousState = state

                if (state === 'LOGGED_IN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '登录成功')
                    break
                }

                const shouldContinue = await this.handleState(state, page, account)
                if (!shouldContinue) {
                    throw new Error(`Login failed or aborted at state: ${state}`)
                }

                await this.bot.utils.wait(1000)
            }

            if (iteration >= maxIterations) {
                throw new Error('Login timeout: exceeded maximum iterations')
            }

            await this.finalizeLogin(page, account)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN',
                `致命错误: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async detectCurrentState(page: Page): Promise<LoginState> {
        await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})

        const url = new URL(page.url())
        const hostname = url.hostname.toLowerCase()
        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `当前URL: ${hostname}${url.pathname}`)

        if (hostname === 'chromewebdata') {
            this.bot.logger.warn(this.bot.isMobile, 'DETECT-STATE', '检测到chromewebdata错误页面')
            return 'CHROMEWEBDATA_ERROR'
        }

        const isLocked = await this.checkSelector(page, this.selectors.accountLocked)
        if (isLocked) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '账户锁定选择器被发现')
            return 'ACCOUNT_LOCKED'
        }

        if (hostname === 'bing.com' || hostname.endsWith('.bing.com') || hostname === 'account.microsoft.com') {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '在Bing/奖励/账户页面，假设已登录')
            return 'LOGGED_IN'
        }

        // 优先主动探测页面上是否存在非空可见的告警/错误容器
        const activeAlertError = await this.getActiveAlertError(page)

        // Page/state selectors are checked together; page-specific routing is resolved below by priority
        const stateChecks: Array<[string, LoginState]> = [
            [this.selectors.passwordEntry, 'PASSWORD_INPUT'],
            [this.selectors.emailEntry, 'EMAIL_INPUT'],
            [this.selectors.recoveryEmail, 'RECOVERY_EMAIL_INPUT'],
            [this.selectors.emailVerificationInput, 'EMAIL_VERIFICATION_INPUT'],
            [this.selectors.interstitialSkip, 'INTERSTITIAL_SKIP'],
            [this.selectors.kmsiVideo, 'KMSI_PROMPT'],
            [this.selectors.passKeyVideo, 'PASSKEY_VIDEO'],
            [this.selectors.passKeyError, 'PASSKEY_ERROR'],
            [this.selectors.signInTile, 'SIGN_IN_METHOD_PICKER'],
            [this.selectors.passwordlessOptionOld, 'SIGN_IN_METHOD_PICKER'],
            [this.selectors.emailIconOld, 'SIGN_IN_METHOD_PICKER'],
            [this.selectors.passwordlessCheck, 'LOGIN_PASSWORDLESS'],
            [this.selectors.passwordlessNumber, 'LOGIN_PASSWORDLESS'],
            [this.selectors.totpInput, '2FA_TOTP'],
            [this.selectors.totpInputOld, '2FA_TOTP'],
            [this.selectors.otpCodeEntry, 'OTP_CODE_ENTRY'],
            [this.selectors.otpInput, 'OTP_CODE_ENTRY']
        ]

        const [results, identityBanner, primaryButton, passwordEntry, footerAction, footerActionText] =
            await Promise.all([
                Promise.all(
                    stateChecks.map(async ([sel, state]) => {
                        const visible = await this.checkSelector(page, sel)
                        return visible ? state : null
                    })
                ),
                this.checkSelector(page, this.selectors.identityBanner),
                this.checkSelector(page, this.selectors.primaryButton),
                this.checkSelector(page, this.selectors.passwordEntry),
                this.checkSelector(page, this.selectors.footerAction),
                page
                    .locator(this.selectors.footerAction)
                    .first()
                    .innerText({ timeout: 200 })
                    .catch(() => '')
            ])

        if (activeAlertError && !this.isInstructionalNotice(activeAlertError)) {
            results.push('ERROR_ALERT')
        }

        const visibleStates = results.filter((s): s is LoginState => s !== null)
        if (visibleStates.length > 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `可见状态: [${visibleStates.join(', ')}]`)
        }

        // Get a sign-in request - distinguish a generic methods footer from a direct email/phone fallback
        if (
            identityBanner &&
            primaryButton &&
            !passwordEntry &&
            !results.includes('2FA_TOTP') &&
            !results.includes('RECOVERY_EMAIL_INPUT') &&
            !results.includes('EMAIL_VERIFICATION_INPUT')
        ) {
            const normalizedFooterAction = this.normalizeSignInText(footerActionText)
            // 通过邮箱/掩码手机号正则区分通用方法入口与具体验证回退，不依赖本地化文案
            const footerTargetsSpecificProof =
                /[\w.+*-]+@[\w.*-]+\.[a-z]{2,}/i.test(normalizedFooterAction) ||
                /(?:\+?\d|[*xX])(?:[\d\s().*xX-]{4,})(?:\d|[*xX])/.test(normalizedFooterAction)

            if (footerAction && !footerTargetsSpecificProof && !this.passwordlessMethodSelected) {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '有可用的备选登录方式')
                results.push('FOOTER_ACTION')
            } else {
                if (footerAction && footerTargetsSpecificProof) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'DETECT-STATE',
                        '页脚指向具体验证方式；保持主登录方式'
                    )
                }
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '检测到主无密码登录操作')
                results.push('PASSWORDLESS_SEND_CODE')
            }
        }

        let foundStates = results.filter((s): s is LoginState => s !== null)

        if (foundStates.length === 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '未找到匹配的状态')
            return 'UNKNOWN'
        }

        if (foundStates.includes('ERROR_ALERT')) {
            const isCookie = this.isCookieOrTermsNotice(activeAlertError)
            const isFatal = this.isFatalLoginError(activeAlertError)
            const isInstruction = this.isInstructionalNotice(activeAlertError)

            if (isInstruction) {
                // 仅为输入引导提示（如“输入 Microsoft 帐户的密码”），绝非错误
                foundStates = foundStates.filter(s => s !== 'ERROR_ALERT')
            } else if (isFatal) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'DETECT-STATE',
                    `检测到明确的账户致命错误提示: "${activeAlertError}"`
                )
                // 保持 ERROR_ALERT，确保按最高优先级处理并快速报错退出
            } else if (isCookie) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DETECT-STATE',
                    '检测到Cookie/隐私条款提示，优先处理提示以解除页面遮挡'
                )
                // 保持 ERROR_ALERT，handleState 将自动点击同意/继续按钮
            } else {
                const hasActionableInput =
                    foundStates.includes('PASSWORD_INPUT') ||
                    foundStates.includes('EMAIL_INPUT') ||
                    foundStates.includes('KMSI_PROMPT') ||
                    foundStates.includes('2FA_TOTP') ||
                    foundStates.includes('SIGN_IN_METHOD_PICKER') ||
                    foundStates.includes('OTP_CODE_ENTRY')

                if (hasActionableInput) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'DETECT-STATE',
                        `存在可操作输入，暂缓非致命提示: "${activeAlertError}"`
                    )
                    foundStates = foundStates.filter(s => s !== 'ERROR_ALERT')
                }
            }
        }

        const priorities: LoginState[] = [
            'ACCOUNT_LOCKED',
            'ERROR_ALERT',
            'PASSKEY_VIDEO',
            'PASSKEY_ERROR',
            'INTERSTITIAL_SKIP',
            'KMSI_PROMPT',
            'LOGIN_PASSWORDLESS',
            'PASSWORD_INPUT',
            'EMAIL_INPUT',
            'EMAIL_VERIFICATION_INPUT',
            'RECOVERY_EMAIL_INPUT',
            'SIGN_IN_METHOD_PICKER',
            'OTP_CODE_ENTRY',
            'FOOTER_ACTION',
            'PASSWORDLESS_SEND_CODE',
            '2FA_TOTP'
        ]

        for (const priority of priorities) {
            if (foundStates.includes(priority)) {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `按优先级选择状态: ${priority}`)
                return priority
            }
        }

        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `返回第一个找到的状态: ${foundStates[0]}`)
        return foundStates[0] as LoginState
    }

    private async getActiveAlertError(page: Page): Promise<string> {
        try {
            const alertEls = page.locator(this.selectors.errorAlert)
            const alertCount = await alertEls.count().catch(() => 0)
            for (let i = 0; i < alertCount; i++) {
                const el = alertEls.nth(i)
                const isVis = await el.isVisible().catch(() => false)
                if (!isVis) continue
                const text = (await el.innerText().catch(() => '')).trim()
                if (text && text.length > 0) {
                    return text
                }
            }
        } catch {}
        return ''
    }

    private isInstructionalNotice(text: string): boolean {
        const lower = text.toLowerCase()
        const instructionalPatterns = [
            '输入 microsoft 帐户的密码',
            '输入 microsoft 账户的密码',
            '输入你的密码',
            '输入密码',
            'enter password',
            'enter the password',
            'enter your password',
            '输入代码',
            'enter code',
            '输入安全代码',
            'enter the code'
        ]
        return instructionalPatterns.some(p => lower.includes(p))
    }

    private isCookieOrTermsNotice(text: string): boolean {
        const lower = text.toLowerCase()
        const cookieBannerPatterns = [
            '使用可选的 cookie',
            '可选的 cookie',
            'we use optional cookies',
            'optional cookies',
            'cookie',
            'cookies',
            '隐私声明',
            'privacy statement',
            '隐私',
            'privacy',
            '条款',
            'terms',
            '声明',
            'statement',
            '接受',
            'accept',
            '同意',
            'agree'
        ]
        return cookieBannerPatterns.some(p => lower.includes(p))
    }

    private isFatalLoginError(text: string): boolean {
        const lower = text.toLowerCase()
        const fatalPatterns = [
            '密码不正确',
            '密码错误',
            'incorrect password',
            'wrong password',
            'invalid password',
            '不存在',
            "doesn't exist",
            'does not exist',
            '找不到',
            'could not find',
            "couldn't find",
            '已锁定',
            'locked',
            'blocked',
            '已被阻止',
            '已被暂停',
            'suspended',
            '尝试次数过多',
            'too many attempts',
            '请求过多',
            '有效',
            'valid',
            '保护你的账户',
            'protect your account',
            '验证码',
            'captcha',
            '无法登录',
            'cannot sign in',
            "can't sign in",
            '未识别',
            'not recognized',
            '此用户名可能不正确',
            'username may be incorrect',
            '键入正确',
            'type it correctly'
        ]
        return fatalPatterns.some(p => lower.includes(p))
    }

    private async checkSelector(page: Page, selector: string): Promise<boolean> {
        return page
            .waitForSelector(selector, { state: 'visible', timeout: 5000 })
            .then(() => true)
            .catch(() => false)
    }

    private normalizeSignInText(value: string): string {
        return value.replace(/\s+/g, ' ').trim()
    }

    private sanitizeSignInLabel(value: string): string {
        return this.normalizeSignInText(value)
            .replace(/[\w.+*-]+@[\w.-]+\.[a-z]{2,}/gi, '<email>')
            .replace(/\+?\d[\d\s().*-]{5,}\d/g, '<phone>')
    }

    private async getSignInMethodOptions(page: Page): Promise<SignInMethodOption[]> {
        const tiles = page.locator(this.selectors.signInTile)
        const count = await tiles.count().catch(() => 0)
        const options = await Promise.all(
            Array.from({ length: count }, async (_, index): Promise<SignInMethodOption | null> => {
                const tile = tiles.nth(index)
                if (!(await tile.isVisible().catch(() => false))) return null

                const metadata = await tile
                    .evaluate(element => {
                        const elements = [element, ...Array.from(element.querySelectorAll('*'))]
                        const structuralAttributeNames = new Set([
                            'id',
                            'name',
                            'src',
                            'data-testid',
                            'data-value',
                            'data-bind',
                            'd'
                        ])
                        const accessibleText = elements
                            .flatMap(node => ['aria-label', 'title', 'alt'].map(name => node.getAttribute(name) ?? ''))
                            .filter(Boolean)
                            .join(' ')
                        const structuralAttributes = elements
                            .flatMap(node =>
                                Array.from(node.attributes)
                                    .filter(attribute => structuralAttributeNames.has(attribute.name))
                                    .map(attribute => `${attribute.name}=${attribute.value}`)
                            )
                            .join(' ')

                        return {
                            text: element.textContent ?? '',
                            accessibleText,
                            structuralAttributes
                        }
                    })
                    .catch(() => null)

                if (!metadata) return null

                const label = this.normalizeSignInText(`${metadata.text} ${metadata.accessibleText}`)
                const signature = this.normalizeSignInText(metadata.structuralAttributes).toLowerCase()

                return {
                    index,
                    selector: `${this.selectors.signInTile} >> nth=${index}`,
                    label: label || `Sign-in option ${index + 1}`,
                    signature
                }
            })
        )

        return options.filter((option): option is SignInMethodOption => option !== null)
    }

    private classifySignInMethod(option: SignInMethodOption): SignInMethodType {
        const signature = option.signature
        const label = option.label.toLowerCase()

        // Sign in another way - classify method tiles from structural signatures AND translated labels
        if (
            signature.includes('m5.25 4h13.5a3.25') ||
            signature.includes('picker_verify_email') ||
            signature.includes('email') ||
            /email|mail|邮箱|将代码发送到|发送代码|send.*code/i.test(label)
        ) {
            return 'EMAIL'
        }
        if (
            signature.includes('m11.78 10.22a.75') ||
            signature.includes('password') ||
            /password|密码/i.test(label)
        ) {
            return 'PASSWORD'
        }
        // Known passkey/security-key SVG signature keeps it out of the Authenticator fallback
        if (/picker_fido|passkey|fido|m18 16\.66a3\.51/i.test(signature) || /passkey|通行密钥/i.test(label)) return 'PASSKEY'
        if (/phone[\s_-]*app[\s_-]*otp|\btotp\b/i.test(signature) || /totp|身份验证器应用中的代码|动态密码/i.test(label)) return 'TOTP'
        // Known Remote NGC/mobile-app SVG signature identifies Microsoft Authenticator language-independently
        if (
            /remote[\s_-]*ngc|picker_remote_ngc|phone[\s_-]*app[\s_-]*notification|push[\s_-]*notification|m15\.75 2c16\.99 2 18 3/i.test(
                signature
            ) ||
            /authenticator|在我的 microsoft authenticator|应用中批准/i.test(label)
        ) {
            return 'AUTHENTICATOR'
        }

        return 'UNKNOWN'
    }

    private async clickSignInMethodOption(page: Page, option: SignInMethodOption): Promise<boolean> {
        const ghostClicked = await this.bot.browser.utils.ghostClick(page, option.selector)
        if (ghostClicked) return true

        return page
            .locator(this.selectors.signInTile)
            .nth(option.index)
            .click()
            .then(() => true)
            .catch(() => false)
    }

    private logAvailableSignInMethods(options: SignInMethodOption[]): void {
        if (this.signInMethodsLogged) return
        this.signInMethodsLogged = true
        if (options.length === 0) return

        const labels = options.map(option => this.sanitizeSignInLabel(option.label))
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', `可用的登录方式: ${labels.join(' | ')}`)
    }

    private async waitForIdle(page: Page, note: string, timeout = 5000): Promise<void> {
        await page.waitForLoadState('networkidle', { timeout }).catch(() => {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `网络空闲超时: ${note}`)
        })
    }

    private async tryClick(page: Page, selector: string, label: string, timeout = 2000): Promise<boolean> {
        const found = await page.waitForSelector(selector, { state: 'visible', timeout }).catch(() => null)
        if (!found) return false

        const clicked = await this.bot.browser.utils.ghostClick(page, selector)
        if (!clicked) return false

        await this.waitForIdle(page, `after ${label}`)
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', `${label} 已点击`)
        return true
    }

    private async handleState(state: LoginState, page: Page, account: Account): Promise<boolean> {
        this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `处理状态: ${state}`)

        switch (state) {
            case 'ACCOUNT_LOCKED': {
                const msg = 'This account has been locked! Remove from config and restart!'
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', msg)
                throw new Error(msg)
            }

            case 'ERROR_ALERT': {
                // 页面上可能同时存在多个 role=alert 容器（含跳转瞬间的空 aria-live 区域），
                // 只有携带非空文本的才是真实错误
                const errorMsg = await this.getActiveAlertError(page)
                if (!errorMsg) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '告警容器无文本，视为瞬时状态，稍后重新检测')
                    await this.bot.utils.wait(2000)
                    return true
                }

                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', `捕获到页面告警/错误文本: "${errorMsg}"`)

                // Cookie 同意横幅或条款提示会被误判为错误告警：尝试关闭并继续，不视为登录失败
                if (this.isCookieOrTermsNotice(errorMsg)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN',
                        `检测到横幅/同意提示被捕获，尝试关闭并继续 | 文本=${errorMsg.slice(0, 60)}`
                    )
                    const acceptSelectors = [
                        'button#acceptButton',
                        '[data-testid="accept-button"]',
                        'button#idSIButton9',
                        'input#idSIButton9',
                        'button:has-text("接受")',
                        'button:has-text("Accept")',
                        'button:has-text("同意")',
                        'button:has-text("OK")',
                        'button:has-text("继续")',
                        'button:has-text("Continue")'
                    ]
                    for (const sel of acceptSelectors) {
                        try {
                            const el = page.locator(sel).first()
                            if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
                                await el.click({ timeout: 2000 })
                                this.bot.logger.info(this.bot.isMobile, 'LOGIN', `已点击同意/确认按钮 | 选择器=${sel}`)
                                break
                            }
                        } catch {
                            // 尝试下一个选择器
                        }
                    }
                    await this.bot.utils.wait(2000)
                    return true
                }

                // 引导提示（如“输入 Microsoft 帐户的密码”），平滑等待输入
                const isInstruction = this.isInstructionalNotice(errorMsg)
                if (isInstruction) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN',
                        `捕获到输入引导文案: "${errorMsg.slice(0, 60)}"，平滑等待输入`
                    )
                    await this.bot.utils.wait(1000)
                    return true
                }

                // 检查是否为致命凭据错误（密码错误、账号锁定或不存在）
                const isFatal = this.isFatalLoginError(errorMsg)
                if (isFatal) {
                    this.bot.logger.error(this.bot.isMobile, 'LOGIN', `微软登录账户致命错误: ${errorMsg}`)
                    throw new Error(`Microsoft login error: ${errorMsg}`)
                }

                // 非致命临时提示，尝试消除弹窗并平滑等待下一轮状态检测
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    `捕获到非致命提示: ${errorMsg.slice(0, 60)}，尝试消除并继续`
                )
                await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})
                await this.bot.utils.wait(2000)
                return true
            }

            case 'INTERSTITIAL_SKIP': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '检测到过渡/引导提示（如无密码提示或安全信息），正在跳过')
                const skipSelectors = [
                    '#iShowSkip',
                    'a#iShowSkip',
                    '#iCancel',
                    'button:has-text("以后再说")',
                    'a:has-text("以后再说")',
                    'button:has-text("暂且跳过")',
                    'a:has-text("暂且跳过")',
                    'button:has-text("No thanks")',
                    'a:has-text("No thanks")',
                    'button:has-text("Skip for now")',
                    'a:has-text("Skip for now")',
                    'button:has-text("取消")'
                ]
                for (const sel of skipSelectors) {
                    try {
                        const el = page.locator(sel).first()
                        if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
                            const clicked = await this.bot.browser.utils.ghostClick(page, sel).catch(() => false)
                            if (!clicked) {
                                await el.click({ timeout: 2000 }).catch(() => {})
                            }
                            this.bot.logger.info(this.bot.isMobile, 'LOGIN', `已跳过过渡页面 | 选择器=${sel}`)
                            break
                        }
                    } catch {
                        // 继续尝试下一个
                    }
                }
                await this.waitForIdle(page, 'after interstitial skip')
                return true
            }

            case 'LOGGED_IN':
                return true

            case 'EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '输入邮箱')
                const result = await this.emailLogin.enterEmail(page, account.email)
                if (result !== 'ok') return false
                this.emailSubmittedCount++
                await this.waitForIdle(page, 'after email entry')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '邮箱输入成功')
                return true
            }

            // Enter password - use it only when Microsoft actually presents the password page
            case 'PASSWORD_INPUT': {
                if (!account.password) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN',
                        '检测到密码输入页但未配置密码；返回登录方式选择'
                    )
                    if (await this.tryClick(page, this.selectors.backButton, 'Back button')) return true

                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '未配置密码且无法返回登录方式选择')
                    return false
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '输入密码')
                const result = await this.emailLogin.enterPassword(page, account.password)
                if (result === 'error') return false
                this.passwordSubmittedCount++
                await this.waitForIdle(page, 'after password entry')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '密码输入成功')
                return true
            }

            // 通用备选方式页脚 - 先打开方式选择器再选择凭据
            case 'FOOTER_ACTION': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '打开备选登录方式')
                const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.footerAction)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法打开备选登录方式')
                    return false
                }
                this.passwordlessMethodSelected = false
                await this.waitForIdle(page, 'after sign-in footer action')
                return true
            }

            // Get a sign-in request - keep the primary Authenticator action when footer is a proof fallback
            case 'PASSWORDLESS_SEND_CODE': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '继续使用主要登录方式')
                const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法继续使用主要登录方式')
                    return false
                }
                await this.waitForIdle(page, 'after primary sign-in action')
                return true
            }

            // 其他登录方式 - 优先密码，其次Authenticator，最后交互式邮箱验证码
            case 'SIGN_IN_METHOD_PICKER': {
                const options = await this.getSignInMethodOptions(page)
                this.logAvailableSignInMethods(options)

                const methods = options.map(option => ({ option, type: this.classifySignInMethod(option) }))
                const passwordOption = methods.find(method => method.type === 'PASSWORD')?.option
                const authenticatorOption = methods.find(method => method.type === 'AUTHENTICATOR')?.option
                const emailOption = methods.find(method => method.type === 'EMAIL')?.option

                if (account.password && passwordOption) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '密码登录可用；正在选择')
                    this.passwordlessMethodSelected = false

                    if (!(await this.clickSignInMethodOption(page, passwordOption))) {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法选择密码登录方式')
                        return false
                    }

                    await this.waitForIdle(page, 'after password method selection')
                    return true
                }

                const passwordlessOptionOldFound = await this.checkSelector(page, this.selectors.passwordlessOptionOld)
                if (authenticatorOption || passwordlessOptionOldFound) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '选择Microsoft Authenticator登录')
                    this.passwordlessMethodSelected = true

                    const clicked = authenticatorOption
                        ? await this.clickSignInMethodOption(page, authenticatorOption)
                        : await this.bot.browser.utils.ghostClick(page, this.selectors.passwordlessOptionOld)

                    if (!clicked) {
                        this.passwordlessMethodSelected = false
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法选择Microsoft Authenticator')
                        return false
                    }

                    await this.waitForIdle(page, 'after Microsoft Authenticator selection')

                    const passwordlessChallengeVisible =
                        (await this.checkSelector(page, this.selectors.passwordlessCheck)) ||
                        (await this.checkSelector(page, this.selectors.passwordlessNumber))

                    if (
                        !passwordlessChallengeVisible &&
                        (await this.checkSelector(page, this.selectors.primaryButton))
                    ) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '正在发送Microsoft Authenticator请求')
                        const confirmed = await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                        if (!confirmed) {
                            this.passwordlessMethodSelected = false
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'LOGIN',
                                '无法发送Microsoft Authenticator请求'
                            )
                            return false
                        }
                        await this.waitForIdle(page, 'after Microsoft Authenticator request')
                    }

                    return true
                }

                const emailIconOldFound = await this.checkSelector(page, this.selectors.emailIconOld)
                if (emailOption || emailIconOldFound) {
                    if (!canPromptForInput()) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'LOGIN',
                            '没有可用的非交互登录方式；邮箱验证码回退需要交互式终端输入'

                        )
                        return false
                    }

                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '选择邮箱验证码登录')
                    this.passwordlessMethodSelected = false

                    const clicked = emailOption
                        ? await this.clickSignInMethodOption(page, emailOption)
                        : await this.bot.browser.utils.ghostClick(page, this.selectors.emailIconOld)

                    if (!clicked) {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法选择邮箱验证码登录方式')
                        return false
                    }

                    await this.waitForIdle(page, 'after email method selection')
                    await this.codeLogin.handle(page, account?.recoveryEmail)
                    return true
                }

                const ignoredMethods = methods
                    .map(method => method.type)
                    .filter(type => type === 'PASSKEY' || type === 'TOTP' || type === 'UNKNOWN')

                this.bot.logger.error(
                    this.bot.isMobile,
                    'LOGIN',
                    `没有可用的受支持登录方式${ignoredMethods.length ? `；已忽略=${ignoredMethods.join(',')}` : ''}`
                )
                return false
            }

            // Recovery email confirmation
            case 'RECOVERY_EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '检测到恢复邮箱输入')
                await this.waitForIdle(page, 'on recovery page')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '启动恢复邮箱处理器')
                await this.recoveryLogin.handle(page, account?.recoveryEmail)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '恢复邮箱处理器完成')
                return true
            }

            // Verify your email - identical footer actions are validated by their resulting state, not position
            case 'EMAIL_VERIFICATION_INPUT': {
                if (!account.password) {
                    if (!canPromptForInput()) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'LOGIN',
                            '邮箱验证需要已配置的密码或交互式终端输入'
                        )
                        return false
                    }

                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '检测到邮箱验证输入')
                    await this.codeLogin.handle(page, account?.recoveryEmail)
                    return true
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    '检测到邮箱验证输入；正在检查备选方式'
                )
                await this.waitForIdle(page, 'on email verification page')

                const footerActions = page.locator(this.selectors.footerAction)
                const footerCount = await footerActions.count().catch(() => 0)

                for (let index = 0; index < footerCount; index++) {
                    const selector = `${this.selectors.footerAction} >> nth=${index}`
                    if (
                        !(await footerActions
                            .nth(index)
                            .isVisible()
                            .catch(() => false))
                    )
                        continue
                    if (!(await this.bot.browser.utils.ghostClick(page, selector))) continue

                    await this.waitForIdle(page, 'after email verification alternative')

                    if (await this.checkSelector(page, this.selectors.passwordEntry)) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '已选择密码登录选项')
                        return true
                    }

                    if (await this.checkSelector(page, this.selectors.signInTile)) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '已打开登录方式选择器')
                        return true
                    }

                    if (!(await this.tryClick(page, this.selectors.backButton, 'Back button'))) break
                    if (!(await this.checkSelector(page, this.selectors.emailVerificationInput))) break
                }

                if (canPromptForInput()) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '回退到交互式邮箱验证')
                    await this.codeLogin.handle(page, account?.recoveryEmail)
                    return true
                }

                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '未找到可用的邮箱验证备选方式')
                return false
            }

            case 'CHROMEWEBDATA_ERROR': {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '检测到chromewebdata错误，尝试恢复')
                try {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `导航到 ${REWARDS_BASE_URL}`)
                    await page
                        .goto(REWARDS_BASE_URL, {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    await this.bot.utils.wait(3000)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '恢复导航成功')
                    return true
                } catch {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '回退到login.live.com')
                    await page
                        .goto(URLs.auth.loginLive, {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    await this.bot.utils.wait(3000)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '回退导航成功')
                    return true
                }
            }

            case '2FA_TOTP': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '需要TOTP双因素认证')
                await this.totp2FALogin.handle(page, account.totpSecret)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'TOTP双因素认证处理器完成')
                return true
            }

            // 保持登录 / KMSI 确认
            case 'KMSI_PROMPT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '接受保持登录 (KMSI) 提示')
                const dontShowAgain = page.locator('input#KmsiCheckboxField, input[name="DontShowAgain"]').first()
                if (await dontShowAgain.isVisible({ timeout: 500 }).catch(() => false)) {
                    await dontShowAgain.check().catch(() => {})
                }
                let clicked = false
                const kmsiButtons = [
                    'input#idSIButton9',
                    'button#idSIButton9',
                    'button[data-testid="primaryButton"]',
                    'input[type="submit"]',
                    'button[type="submit"]',
                    'button:has-text("是")',
                    'button:has-text("Yes")',
                    '#acceptButton',
                    'input#idBtn_Back',
                    'button:has-text("否")',
                    'button:has-text("No")'
                ]
                for (const sel of kmsiButtons) {
                    try {
                        const el = page.locator(sel).first()
                        if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
                            await el.click({ timeout: 2000 })
                            clicked = true
                            this.bot.logger.info(this.bot.isMobile, 'LOGIN', `已点击 KMSI 按钮: ${sel}`)
                            break
                        }
                    } catch {}
                }
                if (!clicked) {
                    clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton).catch(() => false)
                }
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '未能明确点击KMSI按钮，尝试回车或表单提交')
                    await page.keyboard.press('Enter').catch(() => {})
                    await page.evaluate(() => (document.querySelector('form') as HTMLFormElement)?.submit()).catch(() => {})
                }
                await this.waitForIdle(page, 'after KMSI acceptance')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'KMSI提示已处理')
                return true
            }

            // Passkey prompt/error - skip back to a supported sign-in method
            case 'PASSKEY_VIDEO':
            case 'PASSKEY_ERROR': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '跳过Passkey提示')
                const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法跳过Passkey提示')
                    return false
                }
                await this.waitForIdle(page, 'after Passkey skip')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Passkey提示已跳过')
                return true
            }

            // Microsoft Authenticator approval/number challenge
            case 'LOGIN_PASSWORDLESS': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '处理无密码认证')
                await this.passwordlessLogin.handle(page)
                this.passwordlessMethodSelected = false
                await this.waitForIdle(page, 'after passwordless auth')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '无密码认证完成')
                return true
            }

            // Enter your code - prefer its alternate-method footer before Back to avoid an email-code loop
            case 'OTP_CODE_ENTRY': {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    '检测到OTP代码输入页面；尝试可用的备选登录方式'
                )

                if (await this.checkSelector(page, this.selectors.footerAction)) {
                    const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.footerAction)
                    if (clicked) {
                        await this.waitForIdle(page, 'after OTP alternative sign-in action')

                        const stillOnOtp = await this.checkSelector(page, this.selectors.otpCodeEntry)
                        if (!stillOnOtp) {
                            const methodPickerVisible =
                                (await this.checkSelector(page, this.selectors.signInTile)) ||
                                (await this.checkSelector(page, this.selectors.passwordlessOptionOld)) ||
                                (await this.checkSelector(page, this.selectors.emailIconOld))
                            const passwordlessLandingVisible =
                                (await this.checkSelector(page, this.selectors.passwordlessCheck)) ||
                                (await this.checkSelector(page, this.selectors.passwordlessNumber)) ||
                                ((await this.checkSelector(page, this.selectors.identityBanner)) &&
                                    (await this.checkSelector(page, this.selectors.primaryButton)))

                            this.passwordlessMethodSelected = passwordlessLandingVisible
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'LOGIN',
                                methodPickerVisible
                                    ? '已返回登录方式选择'
                                    : passwordlessLandingVisible
                                      ? '已切换到Microsoft Authenticator登录'
                                      : '已离开邮箱验证码登录'
                            )
                            return true
                        }

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'LOGIN',
                            'OTP页脚操作未离开代码输入页；回退到返回按钮'
                        )
                    }
                }

                this.passwordlessMethodSelected = false
                if (!(await this.tryClick(page, this.selectors.backButton, 'Back button'))) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'OTP页面上没有可用的备选操作')
                    return false
                }

                return true
            }

            // Unknown page - keep diagnostics useful instead of guessing a sign-in action
            case 'UNKNOWN': {
                const rawUrl = page.url()
                const url = new URL(rawUrl)
                const hostname = url.hostname.toLowerCase()
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    `在 ${url.hostname}${url.pathname} 的未知状态，尝试自动消除弹窗并等待`
                )

                // 尝试消除页面上可能阻断的任意提示弹窗
                await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

                // 检查是否已经在目标已登录页面
                if (
                    hostname === 'bing.com' ||
                    hostname.endsWith('.bing.com') ||
                    hostname === 'account.microsoft.com'
                ) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '已处于目标已登录域名，判定为已登录')
                    return true
                }

                if (this.bot.config.errorDiagnostics && !this.capturedUnknownUrls.has(rawUrl)) {
                    this.capturedUnknownUrls.add(rawUrl)
                    await unknownPageDiagnostic(page, {
                        platform: this.bot.isMobile ? 'mobile' : 'desktop'
                    })
                }
                return true
            }

            default:
                this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `未处理的状态: ${state}，继续执行`)
                return true
        }
    }

    private async finalizeLogin(page: Page, account: Account) {
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '完成登录')

        await page.goto(REWARDS_BASE_URL, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

        const rewardsLanding = new URL(page.url())
        const rewardsHostname = rewardsLanding.hostname.toLowerCase()
        const loginRewardsSuccess = rewardsHostname === 'bing.com' || rewardsHostname.endsWith('.bing.com')
        if (loginRewardsSuccess) {
            if (rewardsHostname === 'rewards.bing.com') {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '成功登录Microsoft Rewards')
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    `Rewards登录重定向到Bing主页 (${rewardsHostname})；继续验证`
                )
            }
        } else {
            this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法验证奖励仪表板，假定登录有效')
        }

        // Dismiss at rewards dashboard
        await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始Bing会话验证')
        await this.verifyBingSession(page, account)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '获取奖励上下文')
        await this.getRewardsSession(page)

        const context = page.context()
        const storageState = await context.storageState()
        this.bot.logger.debug(
            this.bot.isMobile,
            'LOGIN',
            `保存会话 | cookies=${storageState.cookies.length} | origins=${storageState.origins.length}`
        )
        saveStorageState(this.bot.config.sessionPath, account.email, this.bot.isMobile, storageState)

        await configureMediaBlocking(this.bot, context)
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '登录完成，会话已保存')
    }

    async verifyBingSession(page: Page, account: Account) {
        const url = URLs.auth.bingSignIn
        const loopMax = 5

        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', '验证Bing会话')

        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

            for (let i = 0; i < loopMax; i++) {
                if (page.isClosed()) break

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `验证循环 ${i + 1}/${loopMax}`)

                const u = new URL(page.url())
                const hostname = u.hostname.toLowerCase()
                const atBingPage =
                    (hostname === 'bing.com' || hostname.endsWith('.bing.com')) && hostname !== 'rewards.bing.com'
                if (!atBingPage) {
                    const state = await this.detectCurrentState(page)
                    if (state === 'PASSKEY_ERROR') {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', '关闭Passkey错误状态')
                        await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                    }

                    await this.handleState(state, page, account)
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-BING',
                    `在Bing页面: ${atBingPage} (${hostname}${u.pathname})`
                )

                if (atBingPage) {
                    await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

                    const signedIn = await page
                        .waitForSelector(this.selectors.bingProfile, { timeout: 3000 })
                        .then(() => true)
                        .catch(() => false)

                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `找到个人资料元素: ${signedIn}`)

                    if (signedIn || this.bot.isMobile) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Bing会话验证成功')
                        return
                    }
                }

                await this.bot.utils.wait(1000)
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-BING', '无法验证Bing会话，继续执行')
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-BING',
                `验证错误: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async getRewardsSession(page: Page) {
        this.bot.logger.info(this.bot.isMobile, 'GET-REWARD-SESSION', '引导奖励上下文')

        try {
            await this.bot.browser.func.bootstrap(page)

            const actionsCount = Object.keys(this.bot.nextActions).length
            const snapshot = this.bot.reactSnapshot
            const reportableCount = snapshot?.reportable.length ?? 0
            const availablePoints = snapshot?.account.availablePoints ?? null

            if (!actionsCount) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-REWARD-SESSION',
                    '未解析到操作ID - 本次运行将跳过服务器操作调用（报告/连击保护）'
                )
            }

            if (!snapshot || !snapshot.offers.length) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-REWARD-SESSION',
                    '页面快照为空 - /earn 和 /dashboard 均未渲染出可用的RSC数据'
                )
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `上下文就绪 | actions=${actionsCount} | reportable=${reportableCount} | available=${availablePoints}`
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)

            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `获取奖励上下文遇到异常，降级为Flyout/API模式继续运行: ${message}`
            )
        }
    }

    async getAppAccessToken(page: Page, email: string) {
        this.bot.logger.info(this.bot.isMobile, 'GET-APP-TOKEN', '请求移动访问令牌')
        return await new MobileAccessLogin(this.bot, page).get(email)
    }
}
