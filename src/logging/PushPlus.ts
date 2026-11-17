import { httpRequest } from '../util/Http'
import type { HttpRequestConfig } from '../util/Http'
import PQueue from 'p-queue'
import type { WebhookPushPlusConfig } from '../interface/Config'
import { flushQueue } from './Queue'

const pushPlusQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

export async function sendPushPlus(config: WebhookPushPlusConfig, content: string): Promise<void> {
    if (!config?.token) return

    const request: HttpRequestConfig = {
        method: 'POST',
        url: 'https://www.pushplus.plus/send',
        headers: { 'Content-Type': 'application/json' },
        data: {
            token: config.token,
            title: config.title,
            content,
            template: config.template,
            channel: config.channel
        },
        timeout: 10000,
        // Retrying a notification POST can deliver the same summary twice.
        retries: 0
    }

    await pushPlusQueue.add(async () => {
        let response
        try {
            response = await httpRequest<unknown>(request)
        } catch (err) {
            const status = (err as { response?: { status?: number } })?.response?.status
            // Do not retain the original error/cause; HTTP request configs carry tokens.
            const detail = Number.isInteger(status) ? ` (HTTP ${status})` : ''
            throw new Error(`PushPlus request failed${detail}`)
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`PushPlus request failed (HTTP ${response.status})`)
        }
        const body = response.data
        if (!body || typeof body !== 'object' || (body as { code?: unknown }).code !== 200) {
            throw new Error('PushPlus rejected the notification or returned an invalid response')
        }
    })
}

export function flushPushPlusQueue(timeoutMs = 5000): Promise<void> {
    return flushQueue(pushPlusQueue, timeoutMs)
}
