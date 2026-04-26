/**
 * On-disk Binance USDT-M kline cache for fast local backtests.
 *
 * Layout (current):
 *   {LOCAL_CANDLE_DIR}/binance_usdm/5m/{SYMBOL}.json
 *   {LOCAL_CANDLE_DIR}/binance_usdm/15m/{SYMBOL}.json
 *
 * Legacy (still read for backtests): binance_usdm/{SYMBOL}/{interval}.json
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fetchUsdmPerpetualSymbols } from './breadth.js'
import { binanceFuturesPublicHeaders } from './binancePublicHeaders.js'
import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'

const SCHEMA = 1
const KLINES_PAGE_LIMIT = 1500
const MAX_TAIL_PAGES = 48

/** @param {unknown} k Binance kline row */
export function mapKlineRowFull(k) {
  if (!Array.isArray(k) || k.length < 11) {
    return null
  }
  return {
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    quoteVolume: parseFloat(k[7]),
    trades: Number(k[8]),
    takerBuyBaseVolume: parseFloat(k[9]),
    takerBuyQuoteVolume: parseFloat(k[10]),
  }
}

export function getLocalCandlesRoot() {
  const rel = String(process.env.LOCAL_CANDLE_DIR ?? 'data/local-candles').trim() || 'data/local-candles'
  return path.resolve(process.cwd(), rel)
}

function normalizeSymbol(symbol) {
  const sym = String(symbol ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (!sym.length) throw new Error('invalid symbol')
  return sym
}

function assertInterval(interval) {
  const iv = String(interval ?? '').trim()
  if (!/^[0-9]{1,3}[mhdwM]$/.test(iv)) {
    throw new Error(`invalid interval: ${interval}`)
  }
  return iv
}

/** New layout: binance_usdm/{interval}/{SYMBOL}.json */
export function usdmBundlePath(symbol, interval) {
  const sym = normalizeSymbol(symbol)
  const iv = assertInterval(interval)
  return path.join(getLocalCandlesRoot(), 'binance_usdm', iv, `${sym}.json`)
}

/** Legacy: binance_usdm/{SYMBOL}/{interval}.json */
function legacyUsdmBundlePath(symbol, interval) {
  const sym = normalizeSymbol(symbol)
  const iv = assertInterval(interval)
  return path.join(getLocalCandlesRoot(), 'binance_usdm', sym, `${iv}.json`)
}

/** Try new path first, then legacy. */
function bundlePathCandidates(symbol, interval) {
  return [usdmBundlePath(symbol, interval), legacyUsdmBundlePath(symbol, interval)]
}

/**
 * Most recent `wantN` closed candles (oldest → newest), paginating backward with endTime.
 * If history is shorter than `wantN`, returns all available.
 * @param {Record<string, string>} [headers]
 */
export async function fetchKlinesLastNFull(futuresBase, symbol, interval, wantN, headers = {}) {
  const target = Math.floor(Number(wantN))
  if (!Number.isFinite(target) || target <= 0) return []
  const pageDelayMs = Number.parseInt(process.env.SPIKE_TPSL_PAGE_DELAY_MS ?? '0', 10)
  let merged = []
  let endTime = undefined
  for (let page = 0; page < MAX_TAIL_PAGES && merged.length < target; page++) {
    const limit = Math.min(KLINES_PAGE_LIMIT, target - merged.length)
    const q = new URLSearchParams({
      symbol,
      interval,
      limit: String(Math.max(1, limit)),
    })
    if (endTime != null) q.set('endTime', String(endTime))
    await acquireFuturesRestWeight(futuresKlinesRequestWeight(limit))
    const r = await fetch(`${futuresBase}/fapi/v1/klines?${q}`, { headers })
    const text = await r.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`Binance klines: invalid JSON (${r.status})`)
    }
    if (!r.ok) {
      const msg = data.msg || data.message || text
      throw new Error(`Binance ${r.status}: ${msg}`)
    }
    if (!Array.isArray(data) || data.length === 0) break

    const batch = []
    for (const row of data) {
      const m = mapKlineRowFull(row)
      if (m) batch.push(m)
    }
    if (batch.length === 0) break
    merged = merged.length === 0 ? batch : [...batch, ...merged]
    if (merged.length >= target) break
    if (data.length < limit) break
    const firstOt = data[0][0]
    endTime = firstOt - 1
    if (pageDelayMs > 0) await new Promise((res) => setTimeout(res, pageDelayMs))
  }
  if (merged.length > target) merged = merged.slice(-target)
  return merged
}

/**
 * @param {{ symbol: string, interval: string, targetBars: number, candles: object[], futuresBase: string, error?: string|null }} opts
 */
export async function writeCandleBundle(opts) {
  const { symbol, interval, targetBars, candles, futuresBase, error = null } = opts
  const sym = normalizeSymbol(symbol)
  const iv = assertInterval(interval)
  const dir = path.join(getLocalCandlesRoot(), 'binance_usdm', iv)
  await fs.mkdir(dir, { recursive: true })
  const first = candles[0]
  const last = candles[candles.length - 1]
  const payload = {
    schema: SCHEMA,
    exchange: 'binance_usdm',
    symbol: sym,
    interval: iv,
    targetBars: Math.floor(targetBars),
    fetchedAt: new Date().toISOString(),
    futuresBase: String(futuresBase),
    candleCount: candles.length,
    firstOpenTime: first?.openTime ?? null,
    lastOpenTime: last?.openTime ?? null,
    error: error ?? null,
    candles,
  }
  const fp = path.join(dir, `${sym}.json`)
  await fs.writeFile(fp, JSON.stringify(payload), 'utf8')
}

/** @returns {Promise<object | null>} parsed bundle or null */
export async function readCandleBundle(symbol, interval) {
  for (const fp of bundlePathCandidates(symbol, interval)) {
    try {
      const raw = await fs.readFile(fp, 'utf8')
      const j = JSON.parse(raw)
      if (!j || j.schema !== SCHEMA || !Array.isArray(j.candles)) continue
      return j
    } catch {
      /* try next */
    }
  }
  return null
}

/** Shape expected by spikeTpSlBacktest (quoteVolume for rolling gates). */
export function normalizeCandlesForBacktest(bundle, wantN) {
  if (!bundle || !Array.isArray(bundle.candles) || bundle.candles.length === 0) return null
  const w = Math.floor(Number(wantN))
  if (!Number.isFinite(w) || w <= 0) return null
  const arr = bundle.candles
  const slice = arr.length >= w ? arr.slice(-w) : arr
  const out = []
  for (const c of slice) {
    const openTime = Number(c.openTime)
    const open = Number(c.open)
    const high = Number(c.high)
    const low = Number(c.low)
    const close = Number(c.close)
    const quoteVolume = Number(c.quoteVolume)
    if (
      !Number.isFinite(openTime) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue
    }
    out.push({
      openTime,
      open,
      high,
      low,
      close,
      quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : 0,
    })
  }
  return out.length > 0 ? out : null
}

export async function loadCandlesFromLocalStore(symbol, interval, wantN) {
  const bundle = await readCandleBundle(symbol, interval)
  return normalizeCandlesForBacktest(bundle, wantN)
}

async function mapPool(items, concurrency, mapper) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const idx = next++
      if (idx >= items.length) return
      out[idx] = await mapper(items[idx], idx)
    }
  }
  const n = Math.min(concurrency, items.length) || 1
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}

async function countJsonFilesInDir(dir) {
  let count = 0
  let bytes = 0
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue
      const fp = path.join(dir, e.name)
      const st = await fs.stat(fp)
      count += 1
      bytes += st.size
    }
  } catch {
    /* missing */
  }
  return { count, bytes }
}

export async function scanLocalCandlesStatus() {
  const root = getLocalCandlesRoot()
  const base = path.join(root, 'binance_usdm')
  const dir5 = path.join(base, '5m')
  const dir15 = path.join(base, '15m')

  const modern5 = await countJsonFilesInDir(dir5)
  const modern15 = await countJsonFilesInDir(dir15)

  let legacyFiles5m = 0
  let legacyFiles15m = 0
  let legacyBytes = 0
  let legacySymbolDirs = 0

  let entries = []
  try {
    entries = await fs.readdir(base, { withFileTypes: true })
  } catch {
    return {
      root,
      binanceUsdmDir: base,
      layout: 'interval-per-subfolder',
      files5m: modern5.count,
      files15m: modern15.count,
      totalBytes: modern5.bytes + modern15.bytes,
      legacySymbolDirs: 0,
      legacyFiles5m: 0,
      legacyFiles15m: 0,
      legacyBytes: 0,
    }
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    const name = e.name
    if (name === '5m' || name === '15m') continue
    legacySymbolDirs += 1
    const symDir = path.join(base, name)
    for (const intv of ['5m', '15m']) {
      const fp = path.join(symDir, `${intv}.json`)
      try {
        const st = await fs.stat(fp)
        legacyBytes += st.size
        if (intv === '5m') legacyFiles5m += 1
        else legacyFiles15m += 1
      } catch {
        /* */
      }
    }
  }

  return {
    root,
    binanceUsdmDir: base,
    layout: 'interval-per-subfolder (writes); legacy per-symbol dirs still read',
    files5m: modern5.count,
    files15m: modern15.count,
    totalBytes: modern5.bytes + modern15.bytes + legacyBytes,
    legacySymbolDirs,
    legacyFiles5m,
    legacyFiles15m,
    legacyBytes,
  }
}

/**
 * Fetch & store klines for all USDT-M perpetuals.
 * @param {object} p
 * @param {string} p.futuresBase
 * @param {Record<string, string>} [p.headers]
 * @param {number} [p.targetBars]
 * @param {string[]} [p.intervals]
 * @param {number} [p.concurrency] parallel symbols
 * @param {(obj: object) => void} [p.onEvent]
 */
export async function runLocalCandlesFullSync(p) {
  const {
    futuresBase,
    headers = binanceFuturesPublicHeaders(),
    targetBars = 10_000,
    intervals = ['5m', '15m'],
    concurrency = 2,
    onEvent = () => {},
  } = p

  const want = Math.max(1, Math.floor(Number(targetBars)) || 10_000)
  const symbols = await fetchUsdmPerpetualSymbols(futuresBase, { headers })
  const conc = Math.max(1, Math.min(8, Math.floor(Number(concurrency)) || 2))

  onEvent({
    event: 'start',
    futuresBase,
    symbolCount: symbols.length,
    intervals,
    targetBars: want,
    concurrency: conc,
  })

  let completedPairs = 0
  const totalPairs = symbols.length * intervals.length
  let errors = 0

  await mapPool(symbols, conc, async (symbol, symIdx) => {
    for (const interval of intervals) {
      try {
        const candles = await fetchKlinesLastNFull(futuresBase, symbol, interval, want, headers)
        await writeCandleBundle({
          symbol,
          interval,
          targetBars: want,
          candles,
          futuresBase,
          error: candles.length < want ? 'partial_history' : null,
        })
        completedPairs += 1
        onEvent({
          event: 'progress',
          symbol,
          interval,
          bars: candles.length,
          symbolIndex: symIdx + 1,
          symbolTotal: symbols.length,
          completedPairs,
          totalPairs,
          partial: candles.length < want,
        })
      } catch (e) {
        errors += 1
        const msg = e instanceof Error ? e.message : 'fetch failed'
        onEvent({
          event: 'symbol_error',
          symbol,
          interval,
          message: msg,
          symbolIndex: symIdx + 1,
          symbolTotal: symbols.length,
        })
        try {
          await writeCandleBundle({
            symbol,
            interval,
            targetBars: want,
            candles: [],
            futuresBase,
            error: msg,
          })
        } catch {
          /* ignore write errors */
        }
      }
    }
  })

  const status = await scanLocalCandlesStatus()
  onEvent({
    event: 'done',
    completedPairs,
    totalPairs,
    errors,
    ...status,
  })
}
