import { computeFutures24hVolumes } from './volumeScreener.js'
import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'

const IS_VERCEL = process.env.VERCEL === '1'
const KLINES_CONCURRENCY = IS_VERCEL
  ? Math.min(
      8,
      Math.max(4, Number.parseInt(process.env.BREADTH_KLINES_CONCURRENCY ?? '5', 10) || 5),
    )
  : 12

async function fetchJson(url) {
  const res = await fetch(url)
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const msg = data.msg || data.message || text
    throw new Error(`Binance ${res.status}: ${msg}`)
  }
  return data
}

function parseKlines(data) {
  if (!Array.isArray(data)) return []
  return data.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    close: parseFloat(k[4]),
  }))
}

async function fetchDailyKlines(futuresBase, symbol, limit) {
  await acquireFuturesRestWeight(futuresKlinesRequestWeight(limit))
  const q = new URLSearchParams({
    symbol,
    interval: '1d',
    limit: String(limit),
  })
  const data = await fetchJson(`${futuresBase}/fapi/v1/klines?${q}`)
  return parseKlines(data)
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

function candleChangePct(k) {
  if (!Number.isFinite(k?.open) || !Number.isFinite(k?.close) || k.open === 0) return null
  return ((k.close - k.open) / k.open) * 100
}

export async function computeDailyMarketOverview(futuresBase, opts = {}) {
  const days = Math.min(120, Math.max(10, Number.parseInt(String(opts.days ?? 60), 10) || 60))
  const minQuoteVolume = Number.isFinite(opts.minQuoteVolume) ? opts.minQuoteVolume : 2_000_000
  const maxSymbols = Math.min(
    500,
    Math.max(20, Number.parseInt(String(opts.maxSymbols ?? 250), 10) || 250),
  )

  const volRows = await computeFutures24hVolumes(futuresBase)
  const liquid = volRows.filter((r) => r.quoteVolume24h >= minQuoteVolume)
  const candidateSymbols = liquid.slice(0, maxSymbols).map((r) => r.symbol)
  if (!candidateSymbols.length) {
    return {
      error: 'No symbols match the volume filter. Lower minQuoteVolume.',
    }
  }

  const raw = await mapPool(candidateSymbols, KLINES_CONCURRENCY, async (symbol) => {
    try {
      const klines = await fetchDailyKlines(futuresBase, symbol, days)
      if (!klines.length || klines.length < days) {
        return { symbol, klines: null, error: 'insufficient history' }
      }
      return { symbol, klines: klines.slice(-days), error: null }
    } catch (e) {
      return {
        symbol,
        klines: null,
        error: e instanceof Error ? e.message : 'fetch failed',
      }
    }
  })

  const valid = raw.filter((r) => Array.isArray(r.klines) && r.klines.length > 0)
  if (!valid.length) {
    return {
      error: 'No symbols have enough daily history for the selected days.',
    }
  }

  const L = Math.min(days, ...valid.map((r) => r.klines.length))
  const rows = []
  let cumulativeSumChangePct = 0
  let cumulativeGreenChangePct = 0
  let cumulativeRedChangePct = 0

  for (let i = 0; i < L; i++) {
    let symbolsCount = 0
    let greenCount = 0
    let redCount = 0
    let neutralCount = 0
    let sumChangePct = 0
    let greenSumChangePct = 0
    let redSumChangePct = 0
    let openTime = null

    for (const item of valid) {
      const k = item.klines[item.klines.length - L + i]
      if (openTime == null && Number.isFinite(k?.openTime)) openTime = k.openTime
      const chg = candleChangePct(k)
      if (!Number.isFinite(chg)) continue
      symbolsCount += 1
      sumChangePct += chg
      if (chg > 0) {
        greenCount += 1
        greenSumChangePct += chg
      } else if (chg < 0) {
        redCount += 1
        redSumChangePct += chg
      } else {
        neutralCount += 1
      }
    }

    cumulativeSumChangePct += sumChangePct
    cumulativeGreenChangePct += greenSumChangePct
    cumulativeRedChangePct += redSumChangePct
    rows.push({
      index: i,
      openTime,
      symbolsCount,
      greenCount,
      redCount,
      neutralCount,
      sumChangePct,
      greenSumChangePct,
      redSumChangePct,
      cumulativeSumChangePct,
      cumulativeGreenChangePct,
      cumulativeRedChangePct,
    })
  }

  const latest = rows[rows.length - 1] ?? null
  return {
    daysRequested: days,
    dayCount: rows.length,
    minQuoteVolume,
    maxSymbols,
    symbolUniverseCount: volRows.length,
    symbolsMatchedVolume: liquid.length,
    symbolsRequested: candidateSymbols.length,
    symbolsWithData: valid.length,
    symbolsSkipped: candidateSymbols.length - valid.length,
    fetchedAt: new Date().toISOString(),
    latest,
    rows,
  }
}
