import { fetchUsdmPerpetualSymbols } from './breadth.js'
import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'

/** Supported candle intervals for this backtest (Binance futures klines). */
export const DCA_BACKTEST_INTERVALS = new Set(['1d', '4h'])

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

async function fetchIntervalKlines(futuresBase, symbol, interval, limit) {
  await acquireFuturesRestWeight(futuresKlinesRequestWeight(limit))
  const q = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  })
  const rows = await fetchJson(`${futuresBase}/fapi/v1/klines?${q}`)
  if (!Array.isArray(rows)) return []
  return rows
    .map((k) => ({
      openTime: Number(k[0]),
      open: Number.parseFloat(k[1]),
      close: Number.parseFloat(k[4]),
    }))
    .filter((k) => Number.isFinite(k.openTime) && Number.isFinite(k.open) && Number.isFinite(k.close) && k.open > 0)
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

function createLeg(entryPrice, marginUsd, leverage) {
  const notional = marginUsd * leverage
  const qty = notional / entryPrice
  return {
    entryPrice,
    marginUsd,
    notional,
    qty,
  }
}

function unrealizedPnlUsd(leg, markPrice) {
  return leg.qty * (markPrice - leg.entryPrice)
}

function legReturnPct(leg, markPrice) {
  if (!Number.isFinite(leg.entryPrice) || leg.entryPrice <= 0 || !Number.isFinite(markPrice)) return null
  return ((markPrice - leg.entryPrice) / leg.entryPrice) * 100
}

export async function runDailyDcaBacktest(futuresBase, opts = {}) {
  const intervalRaw = String(opts.interval ?? '1d').trim()
  const interval = DCA_BACKTEST_INTERVALS.has(intervalRaw) ? intervalRaw : null
  if (!interval) {
    return { error: `interval must be one of: ${[...DCA_BACKTEST_INTERVALS].join(', ')}` }
  }

  const candleCount = Math.min(500, Math.max(30, Number.parseInt(String(opts.candleCount ?? 120), 10) || 120))
  const maxSymbolsRaw = Number.parseInt(String(opts.maxSymbols ?? '0'), 10)
  const maxSymbols = Number.isFinite(maxSymbolsRaw) && maxSymbolsRaw > 0 ? Math.min(1200, maxSymbolsRaw) : 0
  const tpPct = Number.isFinite(opts.tpPct) ? opts.tpPct : 20
  const addPct = Number.isFinite(opts.addPct) ? opts.addPct : -50
  const startingBalanceUsd = Number.isFinite(opts.startingBalanceUsd) ? opts.startingBalanceUsd : 1000
  const perEntryMarginUsd = Number.isFinite(opts.perEntryMarginUsd) ? opts.perEntryMarginUsd : 1
  const leverage = Number.isFinite(opts.leverage) ? opts.leverage : 20

  const allSymbols = await fetchUsdmPerpetualSymbols(futuresBase)
  const symbols = maxSymbols > 0 ? allSymbols.slice(0, maxSymbols) : allSymbols
  if (!symbols.length) return { error: 'No USDT perpetual symbols available.' }

  const seriesRows = await mapPool(symbols, KLINES_CONCURRENCY, async (symbol) => {
    try {
      const klines = await fetchIntervalKlines(futuresBase, symbol, interval, candleCount)
      if (klines.length < candleCount) {
        return { symbol, klines: null, error: 'insufficient history' }
      }
      return { symbol, klines: klines.slice(-candleCount), error: null }
    } catch (e) {
      return {
        symbol,
        klines: null,
        error: e instanceof Error ? e.message : 'fetch failed',
      }
    }
  })
  const valid = seriesRows.filter((r) => Array.isArray(r.klines) && r.klines.length > 0)
  if (!valid.length) return { error: `No symbols returned enough ${interval} candles.` }
  const rowBySymbol = new Map(valid.map((v) => [v.symbol, v]))

  const L = Math.min(candleCount, ...valid.map((r) => r.klines.length))
  const symbolState = new Map()
  const realizedBySymbol = new Map()
  const closedBySymbol = new Map()
  const addedBySymbol = new Map()
  const initialBySymbol = new Map()
  let totalRealizedPnlUsd = 0
  let totalAddedMarginUsd = 0
  let totalInitialMarginUsd = 0
  let totalClosedTrades = 0
  let totalOpenLegsPeak = 0

  // Start from first candle: open one long $1 margin per symbol.
  for (const item of valid) {
    const first = item.klines[item.klines.length - L]
    const legs = [createLeg(first.open, perEntryMarginUsd, leverage)]
    symbolState.set(item.symbol, legs)
    totalInitialMarginUsd += perEntryMarginUsd
    initialBySymbol.set(item.symbol, 1)
  }

  const equityCurve = []
  const dailyRows = []
  let peakEquity = startingBalanceUsd
  let maxDrawdownPct = 0

  // At each bar close, decide closures/additions, then execute on next bar open.
  for (let i = 0; i < L; i++) {
    let dayRealizedPnlUsd = 0
    let dayUnrealizedPnlUsd = 0
    let dayClosedCount = 0
    let dayAddedCount = 0
    const actionsForNextOpen = []
    let dayOpenTime = null

    for (const item of valid) {
      const k = item.klines[item.klines.length - L + i]
      if (dayOpenTime == null) dayOpenTime = k.openTime
      const legs = symbolState.get(item.symbol) ?? []
      if (!legs.length) continue

      for (let li = legs.length - 1; li >= 0; li--) {
        const leg = legs[li]
        const retPct = legReturnPct(leg, k.close)
        if (retPct == null) continue
        const u = unrealizedPnlUsd(leg, k.close)
        dayUnrealizedPnlUsd += u
        if (retPct >= tpPct) {
          // TP check uses unlevered % move threshold; PnL uses leveraged notional.
          dayRealizedPnlUsd += u
          totalRealizedPnlUsd += u
          legs.splice(li, 1)
          dayClosedCount += 1
          totalClosedTrades += 1
          closedBySymbol.set(item.symbol, (closedBySymbol.get(item.symbol) ?? 0) + 1)
          realizedBySymbol.set(item.symbol, (realizedBySymbol.get(item.symbol) ?? 0) + u)
          // Keep participating: open a fresh $1 long next bar open.
          if (i + 1 < L) actionsForNextOpen.push({ symbol: item.symbol, type: 'reopen' })
        } else if (retPct <= addPct) {
          // Add another $1 long if this leg is down at least -50%.
          if (i + 1 < L) actionsForNextOpen.push({ symbol: item.symbol, type: 'add' })
        }
      }
      symbolState.set(item.symbol, legs)
    }

    if (i + 1 < L) {
      for (const act of actionsForNextOpen) {
        const row = rowBySymbol.get(act.symbol)
        if (!row) continue
        const nextK = row.klines[row.klines.length - L + i + 1]
        if (!nextK || !Number.isFinite(nextK.open) || nextK.open <= 0) continue
        const legs = symbolState.get(act.symbol) ?? []
        legs.push(createLeg(nextK.open, perEntryMarginUsd, leverage))
        symbolState.set(act.symbol, legs)
        dayAddedCount += 1
        totalAddedMarginUsd += perEntryMarginUsd
        addedBySymbol.set(act.symbol, (addedBySymbol.get(act.symbol) ?? 0) + 1)
      }
    }

    let openLegs = 0
    let openMarginUsd = 0
    let openNotionalUsd = 0
    for (const legs of symbolState.values()) {
      openLegs += legs.length
      for (const leg of legs) {
        openMarginUsd += leg.marginUsd
        openNotionalUsd += leg.notional
      }
    }
    if (openLegs > totalOpenLegsPeak) totalOpenLegsPeak = openLegs

    const equityUsd = startingBalanceUsd + totalRealizedPnlUsd + dayUnrealizedPnlUsd
    if (equityUsd > peakEquity) peakEquity = equityUsd
    const ddPct = peakEquity > 0 ? ((peakEquity - equityUsd) / peakEquity) * 100 : 0
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct

    equityCurve.push({
      index: i,
      openTime: dayOpenTime,
      equityUsd,
      drawdownPct: ddPct,
      realizedPnlUsd: totalRealizedPnlUsd,
      unrealizedPnlUsd: dayUnrealizedPnlUsd,
      openLegs,
      openMarginUsd,
      openNotionalUsd,
    })
    dailyRows.push({
      index: i,
      openTime: dayOpenTime,
      dayRealizedPnlUsd,
      dayUnrealizedPnlUsd,
      dayClosedCount,
      dayAddedCount,
      openLegs,
      equityUsd,
      drawdownPct: ddPct,
    })
  }

  const lastBySymbol = []
  for (const item of valid) {
    const legs = symbolState.get(item.symbol) ?? []
    const lastK = item.klines[item.klines.length - 1]
    let u = 0
    for (const leg of legs) u += unrealizedPnlUsd(leg, lastK.close)
    lastBySymbol.push({
      symbol: item.symbol,
      openLegs: legs.length,
      initialEntries: initialBySymbol.get(item.symbol) ?? 0,
      addedEntries: addedBySymbol.get(item.symbol) ?? 0,
      closedTrades: closedBySymbol.get(item.symbol) ?? 0,
      realizedPnlUsd: realizedBySymbol.get(item.symbol) ?? 0,
      unrealizedPnlUsd: u,
      totalPnlUsd: (realizedBySymbol.get(item.symbol) ?? 0) + u,
    })
  }
  lastBySymbol.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd)

  const latest = equityCurve[equityCurve.length - 1] ?? null
  const totalUnrealizedPnlUsd = Number.isFinite(latest?.unrealizedPnlUsd) ? latest.unrealizedPnlUsd : 0
  const totalPnlUsd = totalRealizedPnlUsd + totalUnrealizedPnlUsd
  const totalReturnPct = startingBalanceUsd > 0 ? (totalPnlUsd / startingBalanceUsd) * 100 : 0

  return {
    config: {
      interval,
      candleCountRequested: candleCount,
      tpPct,
      addPct,
      perEntryMarginUsd,
      leverage,
      startingBalanceUsd,
      noVolumeFilter: true,
      maxSymbols: maxSymbols > 0 ? maxSymbols : null,
    },
    universe: {
      listedUsdtPerpetuals: allSymbols.length,
      symbolsRequested: symbols.length,
      symbolsWithData: valid.length,
      symbolsSkipped: symbols.length - valid.length,
      candleCountUsed: L,
    },
    summary: {
      totalPnlUsd,
      totalRealizedPnlUsd,
      totalUnrealizedPnlUsd,
      totalReturnPct,
      maxDrawdownPct,
      totalClosedTrades,
      totalInitialEntries: totalInitialMarginUsd / perEntryMarginUsd,
      totalAddedEntries: totalAddedMarginUsd / perEntryMarginUsd,
      totalOpenLegs: latest?.openLegs ?? 0,
      peakOpenLegs: totalOpenLegsPeak,
      currentOpenMarginUsd: latest?.openMarginUsd ?? 0,
      currentOpenNotionalUsd: latest?.openNotionalUsd ?? 0,
      endingEquityUsd: latest?.equityUsd ?? startingBalanceUsd,
    },
    equityCurve,
    dailyRows,
    symbolRows: lastBySymbol,
    fetchedAt: new Date().toISOString(),
  }
}
