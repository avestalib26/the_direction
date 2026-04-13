import { computeFutures24hVolumes } from './volumeScreener.js'
import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'

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

function parseKlinesResponse(data) {
  if (!Array.isArray(data)) return null
  return data.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }))
}

async function fetchKlines1h(futuresBase, symbol, limit) {
  await acquireFuturesRestWeight(futuresKlinesRequestWeight(limit))
  const q = new URLSearchParams({
    symbol,
    interval: '1h',
    limit: String(limit),
  })
  const url = `${futuresBase}/fapi/v1/klines?${q}`
  const data = await fetchJson(url)
  return parseKlinesResponse(data)
}

/**
 * USDT-M perpetuals meeting volume filter, each with `limit` 1h candles (oldest → newest).
 */
export async function computeBacktest3Dataset(futuresBase, {
  minQuoteVolume,
  mode = 'above',
  limit,
}) {
  const volRows = await computeFutures24hVolumes(futuresBase)
  const above = mode === 'below' ? false : true
  const filtered = volRows.filter((r) =>
    above ? r.quoteVolume24h >= minQuoteVolume : r.quoteVolume24h <= minQuoteVolume,
  )

  const maxSym = Number.parseInt(process.env.BACKTEST3_MAX_SYMBOLS ?? '250', 10)
  const cap = Number.isFinite(maxSym) && maxSym > 0 ? maxSym : 250
  const requested = filtered.length
  const selected = filtered.slice(0, cap)
  const symbols = selected.map((r) => r.symbol)
  const change24hBySymbol = {}
  for (const row of selected) {
    change24hBySymbol[row.symbol] = Number.isFinite(row.priceChangePercent)
      ? row.priceChangePercent
      : null
  }

  const CONCURRENCY = 9
  const raw = await mapPool(symbols, CONCURRENCY, async (symbol) => {
    try {
      const candles = await fetchKlines1h(futuresBase, symbol, limit)
      if (!candles || candles.length < limit) {
        return { symbol, candles: null, error: 'insufficient klines' }
      }
      return { symbol, candles: candles.slice(-limit), error: null }
    } catch (e) {
      return {
        symbol,
        candles: null,
        error: e instanceof Error ? e.message : 'failed',
      }
    }
  })

  const candlesBySymbol = {}
  let skipped = 0
  for (const r of raw) {
    if (r.candles) {
      candlesBySymbol[r.symbol] = r.candles
    } else {
      skipped += 1
    }
  }

  const symbolList = Object.keys(candlesBySymbol).sort()

  return {
    candlesBySymbol,
    change24hBySymbol,
    symbols: symbolList,
    symbolCount: symbolList.length,
    requestedSymbols: requested,
    cappedAt: cap,
    symbolsCapped: requested > cap,
    skipped,
    minQuoteVolume,
    mode: above ? 'above' : 'below',
    candleLimit: limit,
    fetchedAt: new Date().toISOString(),
  }
}
