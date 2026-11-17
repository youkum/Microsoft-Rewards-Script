#!/usr/bin/env sh
set -eu

# Cron runs in both modes, including API startup without an enabled schedule.
pgrep -x cron >/dev/null 2>&1 || exit 1
if [ "${API_MODE:-false}" != "true" ]; then
    exit 0
fi

node --input-type=module <<'NODE'
import http from 'node:http'

const port = Number(process.env.API_PORT || 3010)
const token = process.env.API_TOKEN || ''
const headers = token ? { Authorization: `Bearer ${token}` } : {}

const req = http.get({ host: '127.0.0.1', port, path: '/health', headers }, res => {
    let raw = ''
    res.setEncoding('utf8')
    res.on('data', chunk => {
        raw += chunk
    })
    res.on('end', () => {
        try {
            const body = JSON.parse(raw)
            process.exit(res.statusCode === 200 && body.ok === true ? 0 : 1)
        } catch {
            process.exit(1)
        }
    })
})

req.setTimeout(3000, () => req.destroy(new Error('health check timed out')))
req.on('error', () => process.exit(1))
NODE
