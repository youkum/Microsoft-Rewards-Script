import type { Page } from 'patchright'
import readline from 'readline'

export interface PromptOptions {
    question: string
    timeoutSeconds?: number
    validate?: (input: string) => boolean
    transform?: (input: string) => string
}

export function canPromptForInput(): boolean {
    return Boolean(
        process.stdin.isTTY === true ||
        process.stdin.readable ||
        process.env.API_MODE === 'true' ||
        process.env.DOCKER_CONTAINER === 'true'
    )
}

export function promptInput(options: PromptOptions): Promise<string | null> {
    if (!canPromptForInput()) return Promise.resolve(null)

    const { question, timeoutSeconds = 180, validate, transform } = options

    // 输出结构化标记，便于 WebUI / 控制 API 捕获并向前端展示交互卡片
    console.log(`__PROMPT_REQUEST__:${JSON.stringify({ question, timeoutSeconds })}`)

    return new Promise(resolve => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        })

        let resolved = false

        const cleanup = (result: string | null) => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            console.log('__PROMPT_RESOLVED__')
            rl.close()
            resolve(result)
        }

        const timer = setTimeout(() => {
            console.log(`[PROMPT-TIMEOUT] 交互输入等待超时 (${timeoutSeconds}s)`)
            cleanup(null)
        }, timeoutSeconds * 1000)

        rl.question(question, answer => {
            let value = answer.trim()
            if (transform) value = transform(value)

            if (validate && !validate(value)) {
                cleanup(null)
                return
            }

            cleanup(value)
        })
    })
}

export async function getSubtitleMessage(page: Page): Promise<string | null> {
    const message = await page
        .waitForSelector('[data-testid="subtitle"], div#oneTimeCodeDescription, [data-testid="description"]', {
            state: 'visible',
            timeout: 1000
        })
        .catch(() => null)

    if (!message) return null

    const text = await message.innerText()
    return text.trim()
}

export async function getErrorMessage(page: Page): Promise<string | null> {
    const errorAlert = await page
        .waitForSelector('div[role="alert"]', { state: 'visible', timeout: 1000 })
        .catch(() => null)

    if (!errorAlert) return null

    const text = await errorAlert.innerText()
    return text.trim()
}
