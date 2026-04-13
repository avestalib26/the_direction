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

function parseKlines(data) {
  if (!Array.isArray(data)) return []
  return data.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }))
}

async function fetchKlines(futuresBase, symbol, interval, limit) {
  await acquireFuturesRestWeight(futuresKlinesRequestWeight(limit))
  const q = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  })
  const data = await fetchJson(`${futuresBase}/fapi/v1/klines?${q}`)
  return parseKlines(data)
}

function isSpikeUp(c, thresholdPct) {
  if (!Number.isFinite(c.open) || c.open === 0 || !Number.isFinite(c.high)) return false
  const upPct = ((c.high - c.open) / c.open) * 100
  return upPct >= thresholdPct
}

function isSpikeDown(c, thresholdPct) {
  if (!Number.isFinite(c.open) || c.open === 0 || !Number.isFinite(c.low)) return false
  const downPct = ((c.open - c.low) / c.open) * 100
  return downPct >= thresholdPct
}

const SPIKE_DIRECTIONS = new Set(['up', 'down', 'both'])

/**
 * USDT-M hourly candles: filter by 24h quote volume, scan wick spikes vs threshold.
 * Returns per-candle-interval counts (timeline) and spikes aggregated by UTC hour-of-day (0–23).
 */
export async function computeHourlySpikesBacktest(futuresBase, {
  candleCount,
  minQuoteVolume,
  thresholdPct,
  spikeDirections = 'up',
}) {
  const dir =
    typeof spikeDirections === 'string' && SPIKE_DIRECTIONS.has(spikeDirections)
      ? spikeDirections
      : 'up'
  const wantUp = dir !== 'down'
  const wantDown = dir !== 'up'

  const volumeRows = await computeFutures24hVolumes(futuresBase)
  const filtered = volumeRows.filter((r) => r.quoteVolume24h >= minQuoteVolume)
  const requestedSymbols = filtered.length

  const maxSymRaw = Number.parseInt(process.env.HOURLY_SPIKES_MAX_SYMBOLS ?? '300', 10)
  const maxSymbols = Number.isFinite(maxSymRaw) && maxSymRaw > 0 ? maxSymRaw : 300
  const selected = filtered.slice(0, maxSymbols)

  const candlesPerSymbol = Math.max(1, Math.min(1500, Math.floor(candleCount)))
  const interval = '1h'
  const CONCURRENCY = 9

  const timelineMap = new Map()
  const spikesByUtcHour = Array.from({ length: 24 }, (_, h) => ({ utcHour: h, spikeCount: 0 }))

  const raw = await mapPool(selected, CONCURRENCY, async (row) => {
    try {
      const candles = await fetchKlines(futuresBase, row.symbol, interval, candlesPerSymbol)
      if (!candles.length) {
        return { symbol: row.symbol, quoteVolume24h: row.quoteVolume24h, error: 'no candles' }
      }

      let spikeCount = 0
      const events = []

      for (const c of candles) {
        if (!Number.isFinite(c.openTime)) continue

        const dirs = []
        if (wantUp && isSpikeUp(c, thresholdPct)) dirs.push('up')
        if (wantDown && isSpikeDown(c, thresholdPct)) dirs.push('down')

        for (const direction of dirs) {
          spikeCount += 1
          const utcHour = new Date(c.openTime).getUTCHours()
          if (utcHour >= 0 && utcHour < 24) {
            spikesByUtcHour[utcHour].spikeCount += 1
          }

          if (!timelineMap.has(c.openTime)) {
            timelineMap.set(c.openTime, {
              openTime: c.openTime,
              spikeCount: 0,
              symbols: new Set(),
            })
          }
          const slot = timelineMap.get(c.openTime)
          slot.spikeCount += 1
          slot.symbols.add(row.symbol)

          events.push({
            openTime: c.openTime,
            symbol: row.symbol,
            direction,
          })
        }
      }

      return {
        symbol: row.symbol,
        quoteVolume24h: row.quoteVolume24h,
        candleCount: candles.length,
        spikeCount,
        spikeRatePct: candles.length > 0 ? (spikeCount / candles.length) * 100 : 0,
        events,
        error: null,
      }
    } catch (e) {
      return {
        symbol: row.symbol,
        quoteVolume24h: row.quoteVolume24h,
        error: e instanceof Error ? e.message : 'failed',
      }
    }
  })

  const rows = []
  let skipped = 0
  for (const r of raw) {
    if (r.error) {
      skipped += 1
      continue
    }
    rows.push(r)
  }
  rows.sort((a, b) => {
    if (b.spikeCount !== a.spikeCount) return b.spikeCount - a.spikeCount
    if (b.spikeRatePct !== a.spikeRatePct) return b.spikeRatePct - a.spikeRatePct
    return b.quoteVolume24h - a.quoteVolume24h
  })

  const timeline = [...timelineMap.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .map((t) => {
      const uniqueSymbolCount = t.symbols.size
      return {
        openTime: t.openTime,
        spikeCount: t.spikeCount,
        uniqueSymbolCount,
        spikeRatePct:
          uniqueSymbolCount > 0 ? (t.spikeCount / uniqueSymbolCount) * 100 : 0,
      }
    })

  const totalSpikes = spikesByUtcHour.reduce((s, x) => s + x.spikeCount, 0)

  const rowsOut = rows.map((r) => ({
    symbol: r.symbol,
    quoteVolume24h: r.quoteVolume24h,
    candleCount: r.candleCount,
    spikeCount: r.spikeCount,
    spikeRatePct: r.spikeRatePct,
  }))

  return {
    rows: rowsOut,
    timeline,
    spikesByUtcHour,
    totalSpikes,
    thresholdPct,
    minQuoteVolume,
    candleCount: candlesPerSymbol,
    interval,
    spikeDirections: dir,
    requestedSymbols,
    symbolCount: rows.length,
    symbolsCapped: requestedSymbols > maxSymbols,
    cappedAt: maxSymbols,
    skipped,
    fetchedAt: new Date().toISOString(),
  }
}
