import { agent1IntervalMs } from './agent1ScanIntervals.js'
import {
  AGENT1_SHADOW_DEFAULT_BAR_COUNT,
  AGENT1_SHADOW_REGIME_EMA_PERIOD,
  buildAgent1ShadowCurveClosedTrades,
  buildLiveCurveWithOpenTrades,
  buildShadowRegimeSnapshotFromLiveCurve,
  fetchAgent1ShadowKlines,
  markOpenTradesWithLatestPrices,
  replayAgent1ShadowLongTrades,
  runMarketWideAgent1ShadowReplay,
  splitClosedAndOpenShadowTrades,
  summarizeTradeForApi,
} from './agent1ShadowEngine.js'

function normalizeShadowSymbol(raw) {
  const s = String(raw ?? 'BLESSUSDT')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  return s.length >= 4 ? s : 'BLESSUSDT'
}

/** @type {{ nextFireAt: number | null, lastRunAt: number | null, lastError: string | null, running: boolean }} */
export const agent1ShadowSchedulerState = {
  nextFireAt: null,
  lastRunAt: null,
  lastMarkAt: null,
  lastError: null,
  running: false,
}

let shadowPayload = {
  mode: 'market',
  symbol: null,
  universe: {
    symbolsRequested: 0,
    symbolsWithData: 0,
    symbolsErrored: 0,
    barCountPerSymbol: AGENT1_SHADOW_DEFAULT_BAR_COUNT,
  },
  barCount: 0,
  candles: [],
  curve: [],
  liveCurve: [],
  trades: [],
  ongoingTrades: [],
  lastBarOpenTime: null,
  updatedAt: null,
  settingsMeta: null,
  simUpdatedAt: null,
  markUpdatedAt: null,
  ongoingTradesRaw: [],
  regime: null,
}

export function getAgent1ShadowSnapshot() {
  const { ongoingTradesRaw, ...publicPayload } = shadowPayload
  return {
    ...publicPayload,
    scheduler: { ...agent1ShadowSchedulerState },
  }
}

export function setAgent1ShadowSnapshot(next) {
  if (!next || typeof next !== 'object') return
  shadowPayload = {
    ...shadowPayload,
    ...next,
  }
}

/**
 * @param {object} deps
 * @param {string} deps.futuresBase
 * @param {() => Promise<object>} deps.readSettings — Agent 1 settings (scan_* + maxSlPct); failures should be handled by caller
 */
export async function runAgent1ShadowTickOnce(deps) {
  const { futuresBase, readSettings } = deps
  const settings = await readSettings()
  const barEnv = Number.parseInt(String(process.env.AGENT1_SHADOW_BARS ?? ''), 10)
  const n =
    Number.isFinite(barEnv) && barEnv >= 50 ? Math.min(barEnv, 1500) : AGENT1_SHADOW_DEFAULT_BAR_COUNT

  const marketWide = process.env.AGENT1_SHADOW_MARKET_WIDE !== 'false'

  if (marketWide) {
    const result = await runMarketWideAgent1ShadowReplay(futuresBase, settings, n)
    shadowPayload = {
      mode: 'market',
      symbol: null,
      universe: result.universe,
      barCount: result.universe.barCountPerSymbol,
      candles: [],
      curve: result.curve,
      liveCurve: result.liveCurve,
      trades: result.closedTrades.map(summarizeTradeForApi),
      ongoingTrades: result.openTrades.map(summarizeTradeForApi),
      lastBarOpenTime: result.lastBarOpenTime,
      updatedAt: new Date().toISOString(),
      simUpdatedAt: new Date().toISOString(),
      markUpdatedAt: new Date().toISOString(),
      settingsMeta: {
        scanInterval: settings.scanInterval,
        scanThresholdPct: settings.scanThresholdPct,
        maxSlPct: settings.maxSlPct,
        scanSpikeMetric: settings.scanSpikeMetric,
        scanDirection: settings.scanDirection,
        scanMinQuoteVolume: settings.scanMinQuoteVolume,
        scanMaxSymbols: settings.scanMaxSymbols,
        effectiveMinQuoteVolume: result.universe.effectiveMinQuoteVolume,
      },
      ongoingTradesRaw: result.openTrades,
      regime: buildShadowRegimeSnapshotFromLiveCurve(result.liveCurve, {
        emaPeriod: AGENT1_SHADOW_REGIME_EMA_PERIOD,
        source: 'sim',
        updatedAt: new Date().toISOString(),
      }),
    }
    return
  }

  const symbol = normalizeShadowSymbol(process.env.AGENT1_SHADOW_SYMBOL ?? 'BLESSUSDT')
  const candles = await fetchAgent1ShadowKlines(futuresBase, symbol, settings.scanInterval, n)
  const trades = replayAgent1ShadowLongTrades(candles, {
    thresholdPct: settings.scanThresholdPct,
    maxSlPct: settings.maxSlPct,
    spikeMetric: settings.scanSpikeMetric,
    scanDirection: settings.scanDirection,
    tpR: 2,
  })
  const tagged = trades.map((t) => ({ ...t, symbol }))
  const lastBar = candles.length > 0 ? candles[candles.length - 1] : null
  const split = splitClosedAndOpenShadowTrades(tagged, lastBar?.openTime ?? null)
  const curve = buildAgent1ShadowCurveClosedTrades(split.closedTrades)
  const liveCurve = buildLiveCurveWithOpenTrades(curve, split.openTrades, lastBar?.openTime ?? null)

  shadowPayload = {
    mode: 'single',
    symbol,
    universe: {
      symbolsRequested: 1,
      symbolsWithData: candles.length > 0 ? 1 : 0,
      symbolsErrored: 0,
      barCountPerSymbol: n,
    },
    barCount: candles.length,
    candles: candles.map((c) => ({
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
    curve,
    liveCurve,
    trades: split.closedTrades.map(summarizeTradeForApi),
    ongoingTrades: split.openTrades.map(summarizeTradeForApi),
    lastBarOpenTime: lastBar?.openTime ?? null,
    updatedAt: new Date().toISOString(),
    simUpdatedAt: new Date().toISOString(),
    markUpdatedAt: new Date().toISOString(),
    settingsMeta: {
      scanInterval: settings.scanInterval,
      scanThresholdPct: settings.scanThresholdPct,
      maxSlPct: settings.maxSlPct,
      scanSpikeMetric: settings.scanSpikeMetric,
      scanDirection: settings.scanDirection,
      scanMinQuoteVolume: settings.scanMinQuoteVolume,
      scanMaxSymbols: settings.scanMaxSymbols,
    },
    ongoingTradesRaw: split.openTrades,
    regime: buildShadowRegimeSnapshotFromLiveCurve(liveCurve, {
      emaPeriod: AGENT1_SHADOW_REGIME_EMA_PERIOD,
      source: 'sim',
      updatedAt: new Date().toISOString(),
    }),
  }
}

/**
 * @param {object} deps
 * @param {string} deps.futuresBase
 * @param {() => Promise<object>} deps.readSettings
 * @param {{ log?: typeof console.log, error?: typeof console.error }} [deps.logger]
 * @param {() => Promise<boolean> | boolean} [deps.shouldRunTick] - return false to skip this tick (e.g. not lease owner).
 * @param {(snapshot: object) => Promise<void> | void} [deps.afterTick] - called after successful run.
 * @param {() => Promise<boolean> | boolean} [deps.shouldMarkTick] - return false to skip mark-to-market updates.
 * @param {(snapshot: object) => Promise<void> | void} [deps.afterMarkTick] - called after successful mark update.
 */
export function startAgent1ShadowScheduler(deps) {
  const {
    futuresBase,
    readSettings,
    logger = console,
    shouldRunTick = null,
    afterTick = null,
    shouldMarkTick = null,
    afterMarkTick = null,
  } = deps
  let timer = null
  let markTimer = null
  let stopped = false
  let latestFuturesBase = futuresBase
  /** @type {Array<object>} */
  let latestOpenTradesRaw = []
  /** @type {Array<object>} */
  let latestClosedCurve = []
  const MARK_POLL_MS = Math.min(
    120_000,
    Math.max(5_000, Number.parseInt(String(process.env.AGENT1_SHADOW_MARK_POLL_MS ?? '20000'), 10) || 20_000),
  )

  const stop = () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (markTimer) {
      clearInterval(markTimer)
      markTimer = null
    }
  }

  async function fetchLatestPricesMap() {
    const r = await fetch(`${latestFuturesBase}/fapi/v1/ticker/price`)
    const text = await r.text()
    let data
    try {
      data = text ? JSON.parse(text) : []
    } catch {
      throw new Error(`Binance ticker/price invalid JSON (${r.status})`)
    }
    if (!r.ok) {
      const msg = data?.msg || data?.message || text
      throw new Error(`Binance ${r.status}: ${msg}`)
    }
    if (!Array.isArray(data)) throw new Error('Unexpected ticker/price response')
    const map = new Map()
    for (const row of data) {
      const s = String(row?.symbol ?? '').toUpperCase()
      const p = Number(row?.price)
      if (!s || !Number.isFinite(p)) continue
      map.set(s, p)
    }
    return map
  }

  async function runMarkTick() {
    if (stopped) return
    if (!latestOpenTradesRaw.length) return
    try {
      if (shouldMarkTick) {
        const ok = await shouldMarkTick()
        if (!ok) return
      }
      const pxMap = await fetchLatestPricesMap()
      const nowMs = Date.now()
      const markedOpen = markOpenTradesWithLatestPrices(latestOpenTradesRaw, pxMap, nowMs)
      const liveCurve = buildLiveCurveWithOpenTrades(latestClosedCurve, markedOpen, nowMs)
      shadowPayload = {
        ...shadowPayload,
        liveCurve,
        ongoingTrades: markedOpen.map(summarizeTradeForApi),
        updatedAt: new Date(nowMs).toISOString(),
        markUpdatedAt: new Date(nowMs).toISOString(),
        regime: buildShadowRegimeSnapshotFromLiveCurve(liveCurve, {
          emaPeriod: AGENT1_SHADOW_REGIME_EMA_PERIOD,
          source: 'mark',
          updatedAt: new Date(nowMs).toISOString(),
        }),
      }
      agent1ShadowSchedulerState.lastMarkAt = nowMs
      if (afterMarkTick) {
        await afterMarkTick(getAgent1ShadowSnapshot())
      }
    } catch (e) {
      // Keep running; mark updates are best-effort between full replay ticks.
      agent1ShadowSchedulerState.lastError = e instanceof Error ? e.message : String(e)
    }
  }

  async function scheduleNext() {
    if (stopped) return
    let s
    try {
      s = await readSettings()
    } catch {
      s = null
    }
    const intervalMs = agent1IntervalMs(s?.scanInterval ?? '5m')
    const afterCloseMsRaw = Number.parseInt(
      String(process.env.AGENT1_SHADOW_AFTER_CLOSE_MS ?? '30000'),
      10,
    )
    const afterCloseMs = Math.min(
      Math.max(Number.isFinite(afterCloseMsRaw) ? afterCloseMsRaw : 30000, 0),
      Math.max(intervalMs - 1, 0),
    )
    const nowMs = Date.now()
    const open = Math.floor(nowMs / intervalMs) * intervalMs
    let nextFireAt = open + intervalMs + afterCloseMs
    if (nowMs >= nextFireAt) nextFireAt += intervalMs
    const delayMs = Math.max(0, nextFireAt - nowMs)
    agent1ShadowSchedulerState.nextFireAt = nextFireAt
    timer = setTimeout(runTick, delayMs)
  }

  async function runTick() {
    if (stopped) return
    agent1ShadowSchedulerState.running = true
    agent1ShadowSchedulerState.lastError = null
    try {
      if (shouldRunTick) {
        const ok = await shouldRunTick()
        if (!ok) return
      }
      await runAgent1ShadowTickOnce({ futuresBase, readSettings })
      latestFuturesBase = futuresBase
      latestClosedCurve = Array.isArray(shadowPayload.curve) ? shadowPayload.curve : []
      latestOpenTradesRaw = Array.isArray(shadowPayload.ongoingTradesRaw)
        ? shadowPayload.ongoingTradesRaw
        : []
      if (afterTick) {
        await afterTick(getAgent1ShadowSnapshot())
      }
      agent1ShadowSchedulerState.lastRunAt = Date.now()
    } catch (e) {
      agent1ShadowSchedulerState.lastError = e instanceof Error ? e.message : String(e)
      logger.error?.('[agent1-shadow] tick failed', e)
    } finally {
      agent1ShadowSchedulerState.running = false
      scheduleNext()
    }
  }

  void runTick()
  markTimer = setInterval(() => {
    void runMarkTick()
  }, MARK_POLL_MS)
  logger.log?.('[agent1-shadow] scheduler started (full replay on each tick; ignores agent master toggle)')
  return { stop, state: agent1ShadowSchedulerState }
}
