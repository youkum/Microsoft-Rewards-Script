'use strict'

const fs = require('node:fs')
const path = require('node:path')

// The API rotates at 5 MiB. Read at most 6 MiB from each file even when
// externally edited/oversized, and never import API/credential/browser modules.
const MAX_FILE_BYTES = 6 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const MAX_RECORDS = 10000

function readFileRecords(filePath) {
    let fd
    try {
        fd = fs.openSync(filePath, 'r')
        const stat = fs.fstatSync(fd)
        if (!stat.isFile()) return []
        const start = Math.max(0, stat.size - MAX_FILE_BYTES)
        const bytes = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES))
        let read = 0
        while (read < bytes.length) {
            const count = fs.readSync(fd, bytes, read, bytes.length - read, start + read)
            if (!count) break
            read += count
        }
        const raw = bytes.subarray(0, read).toString('utf8')
        const lines = raw.split('\n')
        // A bounded tail can begin inside a JSON record or UTF-8 character.
        if (start > 0) lines.shift()
        const records = []
        for (const line of lines) {
            if (!line.trim() || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) continue
            try {
                const record = JSON.parse(line)
                if (record && typeof record === 'object' && !Array.isArray(record)) records.push(record)
            } catch {
                // Corrupt/truncated lines must not interrupt end-of-run delivery.
            }
        }
        return records.slice(-MAX_RECORDS)
    } catch {
        return []
    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd)
            } catch {
                // Best-effort read, including concurrent rotation/deletion.
            }
        }
    }
}

function readForecastHistory(projectRoot) {
    const file = path.join(projectRoot, 'config', 'points-history.jsonl')
    return [...readFileRecords(`${file}.1`), ...readFileRecords(file)].slice(-MAX_RECORDS)
}

module.exports = { readForecastHistory }
