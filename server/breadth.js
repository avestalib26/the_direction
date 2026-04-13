/** Binance USDT-M futures market breadth (public klines). */

import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'

export const ALLOWED_INTERVALS = new Set([
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
])

/** Lower on Vercel (Hobby ≈10s function cap) so breadth finishes in time. */
const IS_VERCEL = process.env.VERCEL === '1'
const KLINES_CONCURRENCY = IS_VERCEL
  ? Math.min(
      12,
      Math.max(4, Number.parseInt(process.env.BREADTH_KLINES_CONCURRENCY ?? '5', 10) || 5),
    )
  : 12

/** On Vercel, only fetch klines for this many symbols unless BREADTH_MAX_SYMBOLS is set (0 = no cap). */
function breadthSymbolCap() {
  if (!IS_VERCEL) return 0
  const raw = process.env.BREADTH_MAX_SYMBOLS
  if (raw === '0' || raw === '') return 0
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (Number.isFinite(n) && n > 0) return n
  return 200
}

async function fetchJson(url, init = {}, weight = 1) {
  await acquireFuturesRestWeight(weight)
  const res = await fetch(url, init)
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const msg = data.msg || data.message || text
    throw new Error(`Binance ${res.status}: ${msg}`)
  }
  return data
}

export async function fetchUsdmPerpetualSymbols(futuresBase, init = {}) {
  const data = await fetchJson(`${futuresBase}/fapi/v1/exchangeInfo`, init)
  const symbols = data.symbols ?? []
  return symbols
    .filter(
      (s) =>
        s.status === 'TRADING' &&
        s.contractType === 'PERPETUAL' &&
        s.quoteAsset === 'USDT',
    )
    .map((s) => s.symbol)
    .sort()
}

/** Single candle: open → close % move. */
export function candleChangePct(k) {
  const o = parseFloat(k[1])
  const c = parseFloat(k[4])
  if (!Number.isFinite(o) || o === 0 || !Number.isFinite(c)) return null
  return ((c - o) / o) * 100
}

async function fetchKlines(futuresBase, symbol, interval, limit) {
  const q = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  })
  const url = `${futuresBase}/fapi/v1/klines?${q}`
  const w = futuresKlinesRequestWeight(limit)
  const klines = await fetchJson(url, {}, w)
  return Array.isArray(klines) ? klines : []
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

export async function computeMarketBreadth(futuresBase, interval, candleLimit) {
  let symbols = await fetchUsdmPerpetualSymbols(futuresBase)
  const fullSymbolCount = symbols.length
  const cap = breadthSymbolCap()
  let breadthTruncated = false
  if (cap > 0 && symbols.length > cap) {
    symbols = symbols.slice(0, cap)
    breadthTruncated = true
  }
  const raw = await mapPool(symbols, KLINES_CONCURRENCY, async (symbol) => {
    try {
      const klines = await fetchKlines(futuresBase, symbol, interval, candleLimit)
      if (!Array.isArray(klines) || klines.length < candleLimit) {
        return { symbol, klines: null, error: 'insufficient klines' }
      }
      const slice = klines.slice(-candleLimit)
      return { symbol, klines: slice, error: null }
    } catch (e) {
      return {
        symbol,
        klines: null,
        error: e instanceof Error ? e.message : 'failed',
      }
    }
  })

  const valid = raw.filter((r) => r.klines && r.klines.length === candleLimit)
  const skipped = raw.length - valid.length

  const nCoins = valid.length
  const candleBreadth = Array.from({ length: candleLimit }, (_, j) => ({
    index: j,
    openTime: valid[0]?.klines[j]?.[0] ?? 0,
    green: 0,
    red: 0,
    neutral: 0,
  }))

  for (const { klines } of valid) {
    for (let j = 0; j < candleLimit; j++) {
      const pct = candleChangePct(klines[j])
      if (pct === null) {
        candleBreadth[j].neutral++
        continue
      }
      if (pct > 0) candleBreadth[j].green++
      else if (pct < 0) candleBreadth[j].red++
      else candleBreadth[j].neutral++
    }
  }

  const t = nCoins > 0 ? nCoins : 1
  for (let j = 0; j < candleLimit; j++) {
    if (valid[0]?.klines[j]?.[0] != null) {
      candleBreadth[j].openTime = valid[0].klines[j][0]
    }
    candleBreadth[j].greenPct = (candleBreadth[j].green / t) * 100
    candleBreadth[j].redPct = (candleBreadth[j].red / t) * 100
    candleBreadth[j].neutralPct = (candleBreadth[j].neutral / t) * 100
  }

  const symbolRows = valid.map(({ symbol, klines }) => {
    const candles = klines.map((k) => {
      const changePct = candleChangePct(k)
      let direction = 'neutral'
      if (changePct !== null) {
        if (changePct > 0) direction = 'green'
        else if (changePct < 0) direction = 'red'
      }
      return {
        openTime: k[0],
        changePct,
        direction,
      }
    })
    return { symbol, candles }
  })
  symbolRows.sort((a, b) => a.symbol.localeCompare(b.symbol))

  return {
    interval,
    candleLimit,
    symbolCount: fullSymbolCount,
    symbolsInRequest: symbols.length,
    nCoins,
    candleBreadth,
    symbolRows,
    skipped,
    fetchedAt: new Date().toISOString(),
    breadthTruncated,
    breadthNote:
      breadthTruncated && IS_VERCEL
        ? `Using first ${symbols.length} of ${fullSymbolCount} USDT perpetuals so the request fits Vercel’s short function limit. Upgrade to Vercel Pro (longer timeouts), self-host the API, or set BREADTH_MAX_SYMBOLS.`
        : undefined,
  }
}
