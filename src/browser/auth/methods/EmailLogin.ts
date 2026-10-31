import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'

export class EmailLogin {
    private readonly emailInputSelectors = [
        'input[name="loginfmt"]',
        'input#i0116',
        'input#usernameEntry',
        'input[data-testid="usernameEntry"]',
        'input[type="email"]',
        'input[type="text"][name*="login" i]',
        'input#userDisplayName'
    ]

    private readonly passwordInputSelectors = [
        'input[name="passwd"]',
        'input#i0118',
        'input#passwordEntry',
        'input[data-testid="passwordEntry"]',
        'input[type="password"]'
    ]

    private readonly submitButtonSelectors = [
        'button[data-testid="primaryButton"]',
        'input#idSIButton9',
        'button#idSIButton9',
        'input[type="submit"]',
        'button[type="submit"]',
        'button#acceptButton',
        'button:has-text("Next")',
        'button:has-text("下一步")',
        'button:has-text("Sign in")',
        'button:has-text("登录")'
    ]

    constructor(private bot: MicrosoftRewardsBot) {}

    private async findFirstVisibleSelector(page: Page, selectors: string[], timeout = 4000): Promise<string | null> {
        const start = Date.now()
        while (Date.now() - start < timeout) {
            for (const selector of selectors) {
                try {
                    const el = page.locator(selector).first()
                    if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
                        return selector
                    }
                } catch {
                    // 尝试下一个选择器
                }
            }
            await this.bot.utils.wait(250)
        }
        return null
    }

    private async clickSubmit(page: Page, contextLabel: string): Promise<boolean> {
        for (const selector of this.submitButtonSelectors) {
            try {
                const el = page.locator(selector).first()
                if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
                    const clicked = await this.bot.browser.utils.ghostClick(page, selector).catch(() => false)
                    if (clicked) {
                        this.bot.logger.debug(this.bot.isMobile, contextLabel, `通过 ghostClick 点击提交按钮: ${selector}`)
                        return true
                    }
                    await el.click({ timeout: 2000 }).catch(() => {})
                    this.bot.logger.debug(this.bot.isMobile, contextLabel, `通过标准 click 点击提交按钮: ${selector}`)
                    return true
                }
            } catch {
                // 尝试下一个选择器
            }
        }

        // 按钮未找到或点击失败时，回退到键盘回车提交
        try {
            this.bot.logger.info(this.bot.isMobile, contextLabel, '未找到明确提交按钮，回退至键盘 Enter 提交')
            await page.keyboard.press('Enter')
            return true
        } catch (err) {
            this.bot.logger.warn(
                this.bot.isMobile,
                contextLabel,
                `回退 Enter 失败: ${err instanceof Error ? err.message : String(err)}`
            )
            return false
        }
    }

    async enterEmail(page: Page, email: string): Promise<'ok' | 'error'> {
        try {
            const emailSelector = await this.findFirstVisibleSelector(page, this.emailInputSelectors, 5000)
            if (!emailSelector) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '未找到可用邮箱输入字段')
                return 'error'
            }

            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', `定位到邮箱输入框: ${emailSelector}`)
            await this.bot.utils.wait(500)

            const prefilled = await page
                .waitForSelector('#userDisplayName', { state: 'visible', timeout: 500 })
                .catch(() => null)

            if (!prefilled) {
                const locator = page.locator(emailSelector).first()
                await locator.click().catch(() => {})
                await locator.fill('').catch(() => {})
                await this.bot.utils.wait(300)
                await locator.fill(email).catch(() => {})
                await this.bot.utils.wait(600)
            } else {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '邮箱已预填充')
            }

            const submitted = await this.clickSubmit(page, 'LOGIN-ENTER-EMAIL')
            if (!submitted) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '无法提交邮箱')
                return 'error'
            }

            this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '邮箱已提交')
            return 'ok'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-ENTER-EMAIL',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            return 'error'
        }
    }

    async enterPassword(page: Page, password: string): Promise<'ok' | 'needs-2fa' | 'error'> {
        try {
            const passwordSelector = await this.findFirstVisibleSelector(page, this.passwordInputSelectors, 5000)
            if (!passwordSelector) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '未找到可用密码输入字段')
                return 'error'
            }

            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', `定位到密码输入框: ${passwordSelector}`)
            await this.bot.utils.wait(500)

            const locator = page.locator(passwordSelector).first()
            await locator.click().catch(() => {})
            await locator.fill('').catch(() => {})
            await this.bot.utils.wait(300)
            await locator.fill(password).catch(() => {})
            await this.bot.utils.wait(600)

            const submitted = await this.clickSubmit(page, 'LOGIN-ENTER-PASSWORD')
            if (!submitted) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '无法提交密码')
                return 'error'
            }

            this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '密码已提交')
            return 'ok'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-ENTER-PASSWORD',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            return 'error'
        }
    }
}
