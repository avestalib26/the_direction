/**
 * Green (and optionally red) body spikes + next-candle stats, optional trend / volume-ratio filters.
 * Single-symbol or full USDT-M universe filtered by 24h quote volume.
 */

import { computeFutures24hVolumes } from './volumeScreener.js'
import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'

async function fetchKlinesJson(futuresBase, symbol, interval, limit) {
  await acquireFuturesRestWeight(futuresKlinesRequestWeight(limit))
  const q = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  })
  const r = await fetch(`${futuresBase}/fapi/v1/klines?${q}`)
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
  if (!Array.isArray(data)) throw new Error('Unexpected klines response')
  return data.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }))
}

function isGreenBodySpike(c, thresholdPct) {
  if (!c || !Number.isFinite(c.open) || c.open === 0) return false
  if (!(c.close > c.open)) return false
  const bodyPct = ((c.close - c.open) / c.open) * 100
  return bodyPct >= thresholdPct
}

/** Red candle with body magnitude ≥ thresholdPct (same numeric threshold as green). */
function isRedBodySpike(c, thresholdPct) {
  if (!c || !Number.isFinite(c.open) || c.open === 0) return false
  if (!(c.close < c.open)) return false
  const bodyDownPct = ((c.open - c.close) / c.open) * 100
  return bodyDownPct >= thresholdPct
}

function priorWindowTrendPct(candles, i, lookback) {
  const from = i - lookback
  if (from < 0 || i < 1) return null
  const c0 = candles[from].close
  const c1 = candles[i - 1].close
  if (!Number.isFinite(c0) || c0 === 0 || !Number.isFinite(c1)) return null
  return ((c1 - c0) / c0) * 100
}

function meanVolumeBefore(candles, i, lookback) {
  const from = i - lookback
  if (from < 0 || i < 1) return null
  let sum = 0
  let n = 0
  for (let j = from; j <= i - 1; j++) {
    const v = candles[j].volume
    if (Number.isFinite(v) && v >= 0) {
      sum += v
      n++
    }
  }
  if (n === 0) return null
  return sum / n
}

/**
 * @param {Array} candles
 * @param {object} filterOpts
 * @returns {Array<object>} spike rows (no symbol)
 */
export function collectSpikesFromCandles(candles, filterOpts) {
  const {
    thresholdPct,
    minSpikeQuoteVolume = 0,
    includeNegativeSpikes = false,
    trendFilterEnabled = false,
    trendLookback = 15,
    trendDirection = 'up',
    volumeRatioFilterEnabled = false,
    volumeLookback = 15,
    volumeMultiplier = 2,
  } = filterOpts

  const minVol =
    Number.isFinite(minSpikeQuoteVolume) && minSpikeQuoteVolume > 0 ? minSpikeQuoteVolume : 0
  const tLb = Math.max(1, Math.floor(trendLookback) || 15)
  const vLb = Math.max(1, Math.floor(volumeLookback) || 15)
  const volMult = Number.isFinite(volumeMultiplier) && volumeMultiplier > 0 ? volumeMultiplier : 2
  const wantTrendUp = trendDirection !== 'down'

  const spikes = []
  if (!candles || candles.length < 2) return spikes

  for (let i = 0; i < candles.length - 1; i++) {
    const spike = candles[i]
    const next = candles[i + 1]

    const spikeGreen = isGreenBodySpike(spike, thresholdPct)
    const spikeRed = isRedBodySpike(spike, thresholdPct)
    if (includeNegativeSpikes) {
      if (!spikeGreen && !spikeRed) continue
    } else if (!spikeGreen) {
      continue
    }
    if (minVol > 0 && (!Number.isFinite(spike.volume) || spike.volume < minVol)) continue

    const spikeBodyPct = ((spike.close - spike.open) / spike.open) * 100
    const spikeBodyIsGreen = spike.close > spike.open
    const nextGreen = next.close > next.open
    const nextBodyPct =
      next.open !== 0 && Number.isFinite(next.open) && Number.isFinite(next.close)
        ? ((next.close - next.open) / next.open) * 100
        : null

    const trendPctPrior = priorWindowTrendPct(candles, i, tLb)
    let passTrend = true
    if (trendFilterEnabled) {
      if (trendPctPrior == null) passTrend = false
      else if (wantTrendUp) passTrend = trendPctPrior > 0
      else passTrend = trendPctPrior < 0
    }

    const avgVolPrior = meanVolumeBefore(candles, i, vLb)
    const sv = spike.volume
    let volRatio = null
    let passVolRatio = true
    if (Number.isFinite(sv) && sv >= 0 && avgVolPrior != null && avgVolPrior > 0) {
      volRatio = sv / avgVolPrior
    }
    if (volumeRatioFilterEnabled) {
      if (volRatio == null) passVolRatio = false
      else passVolRatio = volRatio >= volMult
    }

    const passedFilters = passTrend && passVolRatio

    spikes.push({
      spikeIndex: i,
      spikeOpenTime: spike.openTime,
      spikeBodyPct,
      spikeBodyIsGreen,
      spikeVolume: spike.volume,
      nextOpenTime: next.openTime,
      nextIsGreen: nextGreen,
      nextBodyPct,
      trendPctPrior,
      passTrend,
      avgVolPrior,
      volRatio,
      passVolRatio,
      passedFilters,
    })
  }

  return spikes
}

function buildFilterMeta(filterOpts) {
  const tLb = Math.max(1, Math.floor(filterOpts.trendLookback) || 15)
  const vLb = Math.max(1, Math.floor(filterOpts.volumeLookback) || 15)
  const volMult =
    Number.isFinite(filterOpts.volumeMultiplier) && filterOpts.volumeMultiplier > 0
      ? filterOpts.volumeMultiplier
      : 2
  const minVol =
    Number.isFinite(filterOpts.minSpikeQuoteVolume) && filterOpts.minSpikeQuoteVolume > 0
      ? filterOpts.minSpikeQuoteVolume
      : 0
  return {
    trendFilterEnabled: !!filterOpts.trendFilterEnabled,
    trendLookback: tLb,
    trendDirection: filterOpts.trendDirection !== 'down' ? 'up' : 'down',
    volumeRatioFilterEnabled: !!filterOpts.volumeRatioFilterEnabled,
    volumeLookback: vLb,
    volumeMultiplier: volMult,
    minSpikeQuoteVolume: minVol,
    includeNegativeSpikes: !!filterOpts.includeNegativeSpikes,
  }
}

export async function computeSpikeFilter(futuresBase, opts) {
  const {
    symbol,
    interval,
    limit,
    thresholdPct,
    minSpikeQuoteVolume = 0,
    includeNegativeSpikes = false,
    trendFilterEnabled = false,
    trendLookback = 15,
    trendDirection = 'up',
    volumeRatioFilterEnabled = false,
    volumeLookback = 15,
    volumeMultiplier = 2,
  } = opts

  const candles = await fetchKlinesJson(futuresBase, symbol, interval, limit)
  const filterOpts = {
    thresholdPct,
    minSpikeQuoteVolume,
    includeNegativeSpikes,
    trendFilterEnabled,
    trendLookback,
    trendDirection,
    volumeRatioFilterEnabled,
    volumeLookback,
    volumeMultiplier,
  }
  const spikes = collectSpikesFromCandles(candles, filterOpts)
  const filtered = spikes.filter((s) => s.passedFilters)
  const filteredGreen = filtered.filter((s) => s.nextIsGreen).length
  const filteredRed = filtered.length - filteredGreen

  const tagged = spikes.map((s) => ({ ...s, tradeSymbol: symbol }))
  const { hourlyByUtc, timeline } = aggregateHourlyAndTimeline(tagged)

  return {
    mode: 'single',
    symbol,
    interval,
    candlesFetched: candles.length,
    limit: candles.length,
    thresholdPct,
    minSpikeQuoteVolume: buildFilterMeta(filterOpts).minSpikeQuoteVolume,
    filters: buildFilterMeta(filterOpts),
    summary: {
      spikeCount: spikes.length,
      filteredCount: filtered.length,
      filteredNextGreen: filteredGreen,
      filteredNextRed: filteredRed,
      filteredNextGreenPct:
        filtered.length > 0 ? (100 * filteredGreen) / filtered.length : null,
    },
    hourlyByUtc,
    timeline,
    spikes,
    fetchedAt: new Date().toISOString(),
  }
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

function emptyHourlySlot(h) {
  return {
    utcHour: h,
    rawSpikeCount: 0,
    filteredSpikeCount: 0,
    filteredNextBodySum: 0,
    filteredNextBodyN: 0,
    filteredGreen: 0,
    filteredRed: 0,
  }
}

/**
 * Build hourly buckets + timeline from spike rows.
 * Optional `tradeSymbol` on each row counts distinct symbols per timeline slot when filtered.
 */
function aggregateHourlyAndTimeline(spikes) {
  const hourly = Array.from({ length: 24 }, (_, h) => emptyHourlySlot(h))
  const timelineMap = new Map()

  for (const s of spikes) {
    const utcHour = new Date(s.spikeOpenTime).getUTCHours()
    if (utcHour >= 0 && utcHour < 24) {
      hourly[utcHour].rawSpikeCount += 1
      if (s.passedFilters) {
        hourly[utcHour].filteredSpikeCount += 1
        if (s.nextBodyPct != null && Number.isFinite(s.nextBodyPct)) {
          hourly[utcHour].filteredNextBodySum += s.nextBodyPct
          hourly[utcHour].filteredNextBodyN += 1
        }
        if (s.nextIsGreen) hourly[utcHour].filteredGreen += 1
        else hourly[utcHour].filteredRed += 1
      }
    }

    if (!timelineMap.has(s.spikeOpenTime)) {
      timelineMap.set(s.spikeOpenTime, {
        openTime: s.spikeOpenTime,
        rawSpikeCount: 0,
        filteredSpikeCount: 0,
        filteredNextBodySum: 0,
        filteredNextBodyN: 0,
        symbols: new Set(),
      })
    }
    const slot = timelineMap.get(s.spikeOpenTime)
    slot.rawSpikeCount += 1
    if (s.passedFilters) {
      slot.filteredSpikeCount += 1
      if (s.tradeSymbol) slot.symbols.add(s.tradeSymbol)
      if (s.nextBodyPct != null && Number.isFinite(s.nextBodyPct)) {
        slot.filteredNextBodySum += s.nextBodyPct
        slot.filteredNextBodyN += 1
      }
    }
  }

  const hourlyOut = hourly.map((h) => ({
    utcHour: h.utcHour,
    rawSpikeCount: h.rawSpikeCount,
    filteredSpikeCount: h.filteredSpikeCount,
    meanFilteredNextBodyPct:
      h.filteredNextBodyN > 0 ? h.filteredNextBodySum / h.filteredNextBodyN : null,
    filteredGreen: h.filteredGreen,
    filteredRed: h.filteredRed,
  }))

  const timeline = [...timelineMap.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .map((t) => ({
      openTime: t.openTime,
      rawSpikeCount: t.rawSpikeCount,
      filteredSpikeCount: t.filteredSpikeCount,
      uniqueSymbolCount: t.symbols.size,
      meanFilteredNextBodyPct:
        t.filteredNextBodyN > 0 ? t.filteredNextBodySum / t.filteredNextBodyN : null,
    }))

  return { hourlyByUtc: hourlyOut, timeline }
}

/**
 * All USDT-M symbols with 24h quote volume ≥ minQuoteVolume24h.
 */
export async function computeSpikeFilterUniverse(futuresBase, opts) {
  const {
    minQuoteVolume24h,
    interval,
    limit,
    thresholdPct,
    minSpikeQuoteVolume = 0,
    includeNegativeSpikes = false,
    trendFilterEnabled = false,
    trendLookback = 15,
    trendDirection = 'up',
    volumeRatioFilterEnabled = false,
    volumeLookback = 15,
    volumeMultiplier = 2,
  } = opts

  const filterOpts = {
    thresholdPct,
    minSpikeQuoteVolume,
    includeNegativeSpikes,
    trendFilterEnabled,
    trendLookback,
    trendDirection,
    volumeRatioFilterEnabled,
    volumeLookback,
    volumeMultiplier,
  }

  const candlesPerSymbol = Math.max(20, Math.min(1500, Math.floor(limit)))
  const maxSymRaw = Number.parseInt(process.env.SPIKE_FILTER_MAX_SYMBOLS ?? '300', 10)
  const maxSymbols = Number.isFinite(maxSymRaw) && maxSymRaw > 0 ? maxSymRaw : 300
  const CONCURRENCY = 8

  const volumeRows = await computeFutures24hVolumes(futuresBase)
  const volFiltered = volumeRows.filter((r) => r.quoteVolume24h >= minQuoteVolume24h)
  const requestedSymbols = volFiltered.length
  const selected = volFiltered.slice(0, maxSymbols)

  const hourly = Array.from({ length: 24 }, (_, h) => emptyHourlySlot(h))
  const timelineMap = new Map()

  const raw = await mapPool(selected, CONCURRENCY, async (row) => {
    try {
      const candles = await fetchKlinesJson(futuresBase, row.symbol, interval, candlesPerSymbol)
      if (!candles.length) {
        return {
          symbol: row.symbol,
          quoteVolume24h: row.quoteVolume24h,
          error: 'no candles',
          rawSpikes: 0,
          filteredSpikes: 0,
        }
      }
      const spikes = collectSpikesFromCandles(candles, filterOpts)
      for (const s of spikes) {
        const utcHour = new Date(s.spikeOpenTime).getUTCHours()
        if (utcHour >= 0 && utcHour < 24) {
          hourly[utcHour].rawSpikeCount += 1
          if (s.passedFilters) {
            hourly[utcHour].filteredSpikeCount += 1
            if (s.nextBodyPct != null && Number.isFinite(s.nextBodyPct)) {
              hourly[utcHour].filteredNextBodySum += s.nextBodyPct
              hourly[utcHour].filteredNextBodyN += 1
            }
            if (s.nextIsGreen) hourly[utcHour].filteredGreen += 1
            else hourly[utcHour].filteredRed += 1
          }
        }

        if (!timelineMap.has(s.spikeOpenTime)) {
          timelineMap.set(s.spikeOpenTime, {
            openTime: s.spikeOpenTime,
            rawSpikeCount: 0,
            filteredSpikeCount: 0,
            filteredNextBodySum: 0,
            filteredNextBodyN: 0,
            symbols: new Set(),
          })
        }
        const slot = timelineMap.get(s.spikeOpenTime)
        slot.rawSpikeCount += 1
        if (s.passedFilters) {
          slot.filteredSpikeCount += 1
          slot.symbols.add(row.symbol)
          if (s.nextBodyPct != null && Number.isFinite(s.nextBodyPct)) {
            slot.filteredNextBodySum += s.nextBodyPct
            slot.filteredNextBodyN += 1
          }
        }
      }
      const filteredN = spikes.filter((x) => x.passedFilters).length
      return {
        symbol: row.symbol,
        quoteVolume24h: row.quoteVolume24h,
        candleCount: candles.length,
        rawSpikes: spikes.length,
        filteredSpikes: filteredN,
        error: null,
      }
    } catch (e) {
      return {
        symbol: row.symbol,
        quoteVolume24h: row.quoteVolume24h,
        error: e instanceof Error ? e.message : 'failed',
        rawSpikes: 0,
        filteredSpikes: 0,
      }
    }
  })

  let skipped = 0
  const symbolRows = []
  let totalRaw = 0
  let totalFiltered = 0
  for (const r of raw) {
    if (r.error) {
      skipped += 1
      continue
    }
    totalRaw += r.rawSpikes
    totalFiltered += r.filteredSpikes
    symbolRows.push(r)
  }
  symbolRows.sort((a, b) => {
    if (b.filteredSpikes !== a.filteredSpikes) return b.filteredSpikes - a.filteredSpikes
    if (b.rawSpikes !== a.rawSpikes) return b.rawSpikes - a.rawSpikes
    return b.quoteVolume24h - a.quoteVolume24h
  })

  const hourlyOut = hourly.map((h) => ({
    utcHour: h.utcHour,
    rawSpikeCount: h.rawSpikeCount,
    filteredSpikeCount: h.filteredSpikeCount,
    meanFilteredNextBodyPct:
      h.filteredNextBodyN > 0 ? h.filteredNextBodySum / h.filteredNextBodyN : null,
    filteredGreen: h.filteredGreen,
    filteredRed: h.filteredRed,
  }))

  const timeline = [...timelineMap.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .map((t) => ({
      openTime: t.openTime,
      rawSpikeCount: t.rawSpikeCount,
      filteredSpikeCount: t.filteredSpikeCount,
      uniqueSymbolCount: t.symbols.size,
      meanFilteredNextBodyPct:
        t.filteredNextBodyN > 0 ? t.filteredNextBodySum / t.filteredNextBodyN : null,
    }))

  const filteredAll = hourly.reduce((s, h) => s + h.filteredSpikeCount, 0)
  const greenAll = hourly.reduce((s, h) => s + h.filteredGreen, 0)
  const redAll = hourly.reduce((s, h) => s + h.filteredRed, 0)

  return {
    mode: 'universe',
    interval,
    limit: candlesPerSymbol,
    thresholdPct,
    minQuoteVolume24h,
    minSpikeQuoteVolume: buildFilterMeta(filterOpts).minSpikeQuoteVolume,
    filters: buildFilterMeta(filterOpts),
    requestedSymbols,
    symbolCount: symbolRows.length,
    symbolsCapped: requestedSymbols > maxSymbols,
    cappedAt: maxSymbols,
    skipped,
    summary: {
      spikeCount: totalRaw,
      filteredCount: totalFiltered,
      filteredNextGreen: greenAll,
      filteredNextRed: redAll,
      filteredNextGreenPct:
        filteredAll > 0 ? (100 * greenAll) / filteredAll : null,
    },
    hourlyByUtc: hourlyOut,
    timeline,
    symbolSummaries: symbolRows,
    fetchedAt: new Date().toISOString(),
  }
}
