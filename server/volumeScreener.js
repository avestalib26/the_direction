import { fetchUsdmPerpetualSymbols } from './breadth.js'
import {
  acquireFuturesRestWeight,
  FUTURES_TICKER_24HR_ALL_WEIGHT,
} from './binanceFuturesRestThrottle.js'

async function fetchJson(url, init = {}) {
  await acquireFuturesRestWeight(FUTURES_TICKER_24HR_ALL_WEIGHT)
  const res = await fetch(url, init)
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

/**
 * USDT-M perpetuals with 24h quote volume (USDT) and last price.
 * Sorted by quote volume descending.
 */
export async function computeFutures24hVolumes(futuresBase, init = {}) {
  const [perpSymbols, tickers] = await Promise.all([
    fetchUsdmPerpetualSymbols(futuresBase, init),
    fetchJson(`${futuresBase}/fapi/v1/ticker/24hr`, init),
  ])
  const symSet = new Set(perpSymbols)
  const rows = []
  if (!Array.isArray(tickers)) {
    throw new Error('Unexpected 24h ticker response')
  }
  for (const t of tickers) {
    if (!symSet.has(t.symbol)) continue
    const qv = parseFloat(t.quoteVolume)
    if (!Number.isFinite(qv)) continue
    const lastPrice = parseFloat(t.lastPrice)
    const priceChangePercent = parseFloat(t.priceChangePercent)
    rows.push({
      symbol: t.symbol,
      quoteVolume24h: qv,
      lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
      priceChangePercent: Number.isFinite(priceChangePercent)
        ? priceChangePercent
        : null,
    })
  }
  rows.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
  return rows
}
