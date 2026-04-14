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

function countSpikeEvents(candles, thresholdPct, spikeDirections, spikeMetric) {
  let count = 0
  const wantUp = spikeDirections !== 'down'
  const wantDown = spikeDirections !== 'up'
  const upFn = spikeMetric === 'wick' ? isWickSpikeUp : isBodySpikeUp
  const downFn = spikeMetric === 'wick' ? isWickSpikeDown : isBodySpikeDown
  for (const c of candles) {
    if (wantUp && upFn(c, thresholdPct)) count += 1
    if (wantDown && downFn(c, thresholdPct)) count += 1
  }
  return count
}

function isWickSpikeUp(c, thresholdPct) {
  if (!Number.isFinite(c.open) || c.open === 0 || !Number.isFinite(c.high)) return false
  const upPct = ((c.high - c.open) / c.open) * 100
  return upPct >= thresholdPct
}

function isWickSpikeDown(c, thresholdPct) {
  if (!Number.isFinite(c.open) || c.open === 0 || !Number.isFinite(c.low)) return false
  const downPct = ((c.open - c.low) / c.open) * 100
  return downPct >= thresholdPct
}

/** Signed body %: (close−open)/open×100. Up spike = green body ≥ threshold; down = red body ≥ threshold. */
function bodyPctSigned(c) {
  if (!Number.isFinite(c.open) || c.open === 0 || !Number.isFinite(c.close)) return null
  return ((c.close - c.open) / c.open) * 100
}

function isBodySpikeUp(c, thresholdPct) {
  const p = bodyPctSigned(c)
  return p != null && p >= thresholdPct
}

function isBodySpikeDown(c, thresholdPct) {
  const p = bodyPctSigned(c)
  return p != null && p <= -thresholdPct
}

/** Up wick %: (high − open) / open (positive). */
function spikeUpWickPct(c) {
  if (!Number.isFinite(c.open) || c.open === 0 || !Number.isFinite(c.high)) return null
  return ((c.high - c.open) / c.open) * 100
}

/** Down wick as signed %: (low − open) / open (negative when low &lt; open). */
function spikeDownWickPctSigned(c) {
  if (!Number.isFinite(c.open) || c.open === 0 || !Number.isFinite(c.low)) return null
  return ((c.low - c.open) / c.open) * 100
}

function nextCandleOtoCPct(c1) {
  if (!c1 || !Number.isFinite(c1.open) || c1.open === 0 || !Number.isFinite(c1.close)) {
    return null
  }
  return ((c1.close - c1.open) / c1.open) * 100
}

const SPIKE_DIRECTIONS = new Set(['up', 'down', 'both'])
const SPIKE_METRICS = new Set(['body', 'wick'])

export async function computeFiveMinScreener(futuresBase, {
  candleCount,
  minQuoteVolume,
  thresholdPct,
  interval = '5m',
  spikeDirections = 'up',
  spikeMetric = 'body',
  maxSymbols: maxSymbolsOpt,
}) {
  const dir =
    typeof spikeDirections === 'string' && SPIKE_DIRECTIONS.has(spikeDirections)
      ? spikeDirections
      : 'up'
  const metric =
    typeof spikeMetric === 'string' && SPIKE_METRICS.has(spikeMetric.toLowerCase())
      ? spikeMetric.toLowerCase()
      : 'body'
  const wantUp = dir !== 'down'
  const wantDown = dir !== 'up'
  const volumeRows = await computeFutures24hVolumes(futuresBase)
  const filtered = volumeRows.filter((r) => r.quoteVolume24h >= minQuoteVolume)
  const requestedSymbols = filtered.length

  const maxSymEnv = Number.parseInt(process.env.FIVEMIN_SCREENER_MAX_SYMBOLS ?? '600', 10)
  const envCap = Number.isFinite(maxSymEnv) && maxSymEnv > 0 ? maxSymEnv : 600
  const maxSymQuery = Number.parseInt(String(maxSymbolsOpt ?? ''), 10)
  const hardCap = 800
  const maxSymbols =
    Number.isFinite(maxSymQuery) && maxSymQuery > 0
      ? Math.min(hardCap, maxSymQuery)
      : Math.min(hardCap, envCap)
  const selected = filtered.slice(0, maxSymbols)

  const intervalMinutes = intervalToMinutes(interval)
  const candlesPerSymbol = Math.max(1, Math.min(1500, Math.floor(candleCount)))
  const concRaw = Number.parseInt(process.env.FIVEMIN_SCREENER_CONCURRENCY ?? '18', 10)
  const CONCURRENCY = Math.min(
    24,
    Math.max(4, Number.isFinite(concRaw) && concRaw > 0 ? concRaw : 18),
  )
  const timelineMap = new Map()
  const raw = await mapPool(selected, CONCURRENCY, async (row) => {
    try {
      const candles = await fetchKlines(futuresBase, row.symbol, interval, candlesPerSymbol)
      if (!candles.length) {
        return { symbol: row.symbol, quoteVolume24h: row.quoteVolume24h, error: 'no candles' }
      }
      const count = countSpikeEvents(candles, thresholdPct, dir, metric)
      const spikeEvents = []
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]
        if (!Number.isFinite(c.openTime)) continue
        const key = c.openTime
        if (!timelineMap.has(key)) {
          timelineMap.set(key, {
            openTime: key,
            spikeCount: 0,
            coinCount: 0,
            next1PctSum: 0,
            next1ValidCount: 0,
            next1MissingCount: 0,
            next2PositiveCount: 0,
            next2NegativeCount: 0,
            next2FlatCount: 0,
            next2PctSum: 0,
            next2MissingCount: 0,
          })
        }
        const slot = timelineMap.get(key)
        slot.coinCount += 1

        const upFn = metric === 'wick' ? isWickSpikeUp : isBodySpikeUp
        const downFn = metric === 'wick' ? isWickSpikeDown : isBodySpikeDown
        const dirs = []
        if (wantUp && upFn(c, thresholdPct)) dirs.push('up')
        if (wantDown && downFn(c, thresholdPct)) dirs.push('down')

        for (const direction of dirs) {
          const wickPct =
            metric === 'wick'
              ? direction === 'up'
                ? spikeUpWickPct(c)
                : spikeDownWickPctSigned(c)
              : bodyPctSigned(c)
          const c1 = candles[i + 1]
          const nextPct = nextCandleOtoCPct(c1)
          if (wickPct != null) {
            spikeEvents.push({
              openTime: c.openTime,
              symbol: row.symbol,
              direction,
              spikePct: wickPct,
              nextCandlePct: nextPct,
            })
          }
          slot.spikeCount += 1
          const c2 = candles[i + 2]
          if (!c1 || !Number.isFinite(c1.open) || c1.open === 0 || !Number.isFinite(c1.close)) {
            slot.next1MissingCount += 1
          } else {
            const r1 = ((c1.close - c1.open) / c1.open) * 100
            slot.next1PctSum += r1
            slot.next1ValidCount += 1
          }

          if (
            !c1 ||
            !c2 ||
            !Number.isFinite(c1.open) ||
            c1.open === 0 ||
            !Number.isFinite(c1.close) ||
            !Number.isFinite(c2.open) ||
            c2.open === 0 ||
            !Number.isFinite(c2.close)
          ) {
            slot.next2MissingCount += 1
          } else {
            const r1 = ((c1.close - c1.open) / c1.open) * 100
            const r2 = ((c2.close - c2.open) / c2.open) * 100
            const next2Pct = r1 + r2
            slot.next2PctSum += next2Pct
            if (next2Pct > 0) slot.next2PositiveCount += 1
            else if (next2Pct < 0) slot.next2NegativeCount += 1
            else slot.next2FlatCount += 1
          }
        }
      }
      return {
        symbol: row.symbol,
        quoteVolume24h: row.quoteVolume24h,
        candleCount: candles.length,
        spikeCount: count,
        spikeRatePct: candles.length > 0 ? (count / candles.length) * 100 : 0,
        spikeEvents,
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

  const spikeEventsChronological = []
  for (const r of rows) {
    if (Array.isArray(r.spikeEvents)) {
      spikeEventsChronological.push(...r.spikeEvents)
    }
  }
  spikeEventsChronological.sort((a, b) => {
    if (a.openTime !== b.openTime) return a.openTime - b.openTime
    if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol)
    const da = a.direction || 'up'
    const db = b.direction || 'up'
    if (da !== db) return da === 'up' ? -1 : 1
    return 0
  })

  /** V2: one entry per candle time, chronologically — aggregates + per-symbol spikes. */
  const spikeSlotsTimeWiseV2 = groupSpikesByOpenTime(spikeEventsChronological)

  const timeline = [...timelineMap.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .map((t) => ({
      ...t,
      spikeRatePct: t.coinCount > 0 ? (t.spikeCount / t.coinCount) * 100 : 0,
      next1PctAvg:
        t.next1ValidCount > 0 ? t.next1PctSum / t.next1ValidCount : 0,
      next2PositiveRatePct:
        t.spikeCount > 0 ? (t.next2PositiveCount / t.spikeCount) * 100 : 0,
      next2PctAvg:
        t.spikeCount - t.next2MissingCount > 0
          ? t.next2PctSum / (t.spikeCount - t.next2MissingCount)
          : 0,
    }))

  let maxSpikeCount = 0
  let avgSpikeCount = 0
  if (timeline.length > 0) {
    let sum = 0
    for (const t of timeline) {
      if (t.spikeCount > maxSpikeCount) maxSpikeCount = t.spikeCount
      sum += t.spikeCount
    }
    avgSpikeCount = sum / timeline.length
  }

  const rowsOut = rows.map((r) => {
    const rest = { ...r }
    delete rest.spikeEvents
    return rest
  })

  return {
    rows: rowsOut,
    spikeEventsChronological,
    spikeSlotsTimeWiseV2,
    timeline,
    spikeDirections: dir,
    spikeMetric: metric,
    thresholdPct,
    minQuoteVolume,
    candleCount: candlesPerSymbol,
    interval,
    intervalMinutes,
    candleLimit: candlesPerSymbol,
    requestedSymbols,
    symbolCount: rows.length,
    symbolsCapped: requestedSymbols > maxSymbols,
    cappedAt: maxSymbols,
    skipped,
    maxSpikeCount,
    avgSpikeCount,
    fetchedAt: new Date().toISOString(),
  }
}

function groupSpikesByOpenTime(events) {
  const map = new Map()
  for (const ev of events) {
    if (!Number.isFinite(ev.openTime)) continue
    if (!map.has(ev.openTime)) map.set(ev.openTime, [])
    map.get(ev.openTime).push(ev)
  }
  const slots = []
  for (const [openTime, list] of map) {
    list.sort((a, b) => {
      if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol)
      const da = a.direction || 'up'
      const db = b.direction || 'up'
      if (da !== db) return da === 'up' ? -1 : 1
      return 0
    })
    let sumSpike = 0
    let sumNext = 0
    let nNext = 0
    let sumNextAfterUpSpikes = 0
    let sumNextAfterDownSpikes = 0
    for (const e of list) {
      sumSpike += e.spikePct
      const nx = e.nextCandlePct
      if (nx != null && Number.isFinite(nx)) {
        sumNext += nx
        nNext += 1
        if ((e.direction || 'up') === 'down') sumNextAfterDownSpikes += nx
        else sumNextAfterUpSpikes += nx
      }
    }
    const longShortNetNextSum = sumNextAfterUpSpikes - sumNextAfterDownSpikes
    slots.push({
      openTime,
      spikeCount: list.length,
      avgSpikePct: list.length ? sumSpike / list.length : 0,
      avgNextCandlePct: nNext > 0 ? sumNext / nNext : null,
      sumNextAfterUpSpikes,
      sumNextAfterDownSpikes,
      longShortNetNextSum,
      events: list,
    })
  }
  slots.sort((a, b) => a.openTime - b.openTime)
  return slots
}

function intervalToMinutes(interval) {
  const m = {
    '1m': 1,
    '3m': 3,
    '5m': 5,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '2h': 120,
    '4h': 240,
    '6h': 360,
    '8h': 480,
    '12h': 720,
    '1d': 1440,
  }
  return m[interval] ?? 5
}

