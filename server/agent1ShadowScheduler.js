import { agent1IntervalMs, AGENT1_SCAN_INTERVALS } from './agent1ScanIntervals.js'
import {
  AGENT1_SHADOW_DEFAULT_BAR_COUNT,
  AGENT1_SHADOW_REGIME_EMA_PERIOD,
  AGENT1_SHADOW_REPLAY_TP_R,
  buildAgent1ShadowCurveClosedTrades,
  buildAgent3ShadowCurveClosedTrades,
  buildLiveCurveWithOpenTrades,
  buildLiveCurveWithOpenTradesShort,
  buildShadowRegimeSnapshotFromLiveCurve,
  fetchAgent1ShadowKlines,
  markOpenShortTradesWithLatestPrices,
  markOpenTradesWithLatestPrices,
  replayAgent1ShadowLongTrades,
  replayAgent3ShadowShortTrades,
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

/** Runtime pause (API / UI). When true, full replay ticks and mark polls are skipped (no Binance sim load). */
let agent1ShadowSimulationPaused = false

export function getAgent1ShadowSimulationPaused() {
  return agent1ShadowSimulationPaused
}

export function setAgent1ShadowSimulationPaused(paused) {
  agent1ShadowSimulationPaused = Boolean(paused)
}

/**
 * Optional replay-only overrides. Merged over **shadow sim env baseline** each tick (not live agent DB).
 * @type {null | {
 *   scanInterval?: string,
 *   scanMinQuoteVolume?: number,
 *   scanMaxSymbols?: number,
 *   barCount?: number,
 *   scanThresholdPct?: number,
 *   shortThresholdPct?: number,
 * }}
 */
let shadowSimRuntimeOverrides = null

export function getShadowSimRuntimeOverrides() {
  return shadowSimRuntimeOverrides ? { ...shadowSimRuntimeOverrides } : null
}

/**
 * @param {object} body
 * @param {boolean} [body.clear] — if true, drop all overrides
 * @param {string | null} [body.scanInterval]
 * @param {number | null} [body.scanMinQuoteVolume]
 * @param {number | null} [body.scanMaxSymbols]
 * @param {number | null} [body.barCount]
 * @param {number | null} [body.scanThresholdPct]
 * @param {number | null} [body.shortThresholdPct]
 * @returns {object | null} merged overrides or null
 */
export function patchShadowSimRuntimeOverrides(body) {
  if (!body || typeof body !== 'object') throw new Error('Body required')
  if (body.clear === true) {
    shadowSimRuntimeOverrides = null
    return null
  }
  const cur = { ...(shadowSimRuntimeOverrides ?? {}) }
  if ('scanInterval' in body) {
    if (body.scanInterval == null || body.scanInterval === '') {
      delete cur.scanInterval
    } else {
      const s = String(body.scanInterval).trim()
      if (!AGENT1_SCAN_INTERVALS.has(s)) {
        throw new Error(`scanInterval must be one of: ${[...AGENT1_SCAN_INTERVALS].sort().join(', ')}`)
      }
      cur.scanInterval = s
    }
  }
  if ('scanMinQuoteVolume' in body) {
    if (body.scanMinQuoteVolume == null || body.scanMinQuoteVolume === '') {
      delete cur.scanMinQuoteVolume
    } else {
      const v = Number(body.scanMinQuoteVolume)
      if (!Number.isFinite(v) || v < 0) throw new Error('scanMinQuoteVolume must be >= 0')
      cur.scanMinQuoteVolume = v
    }
  }
  if ('scanMaxSymbols' in body) {
    if (body.scanMaxSymbols == null || body.scanMaxSymbols === '') {
      delete cur.scanMaxSymbols
    } else {
      const v = Math.floor(Number(body.scanMaxSymbols))
      if (!Number.isFinite(v) || v < 1 || v > 800) throw new Error('scanMaxSymbols must be 1–800')
      cur.scanMaxSymbols = v
    }
  }
  if ('barCount' in body) {
    if (body.barCount == null || body.barCount === '') {
      delete cur.barCount
    } else {
      const v = Math.floor(Number(body.barCount))
      if (!Number.isFinite(v) || v < 50 || v > 1500) throw new Error('barCount must be 50–1500')
      cur.barCount = v
    }
  }
  if ('scanThresholdPct' in body) {
    if (body.scanThresholdPct == null || body.scanThresholdPct === '') {
      delete cur.scanThresholdPct
    } else {
      const v = Number(body.scanThresholdPct)
      if (!Number.isFinite(v) || v <= 0) throw new Error('scanThresholdPct must be > 0')
      cur.scanThresholdPct = v
    }
  }
  if ('shortThresholdPct' in body) {
    if (body.shortThresholdPct == null || body.shortThresholdPct === '') {
      delete cur.shortThresholdPct
    } else {
      const v = Number(body.shortThresholdPct)
      if (!Number.isFinite(v) || v <= 0) throw new Error('shortThresholdPct must be > 0')
      cur.shortThresholdPct = v
    }
  }
  shadowSimRuntimeOverrides = Object.keys(cur).length ? cur : null
  return getShadowSimRuntimeOverrides()
}

function applyShadowReplayScanOverrides(base) {
  const o = shadowSimRuntimeOverrides
  if (!o) return base
  return {
    ...base,
    ...(o.scanInterval != null ? { scanInterval: o.scanInterval } : {}),
    ...(o.scanMinQuoteVolume != null ? { scanMinQuoteVolume: o.scanMinQuoteVolume } : {}),
    ...(o.scanMaxSymbols != null ? { scanMaxSymbols: o.scanMaxSymbols } : {}),
    ...(o.scanThresholdPct != null ? { scanThresholdPct: o.scanThresholdPct } : {}),
  }
}

function applyShadowReplayShortScanOverrides(shortBase) {
  const o = shadowSimRuntimeOverrides
  if (!o) return shortBase
  return {
    ...shortBase,
    ...(o.shortThresholdPct != null ? { scanThresholdPct: o.shortThresholdPct } : {}),
  }
}

function resolveShadowReplayBarCount() {
  const o = shadowSimRuntimeOverrides
  if (o?.barCount != null) {
    const v = Math.floor(Number(o.barCount))
    if (Number.isFinite(v) && v >= 50 && v <= 1500) return v
  }
  const barEnv = Number.parseInt(String(process.env.AGENT1_SHADOW_BARS ?? ''), 10)
  if (Number.isFinite(barEnv) && barEnv >= 50) return Math.min(barEnv, 1500)
  return AGENT1_SHADOW_DEFAULT_BAR_COUNT
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
  curveAgent3: [],
  liveCurveAgent3: [],
  trades: [],
  ongoingTrades: [],
  agent3Trades: [],
  agent3OngoingTrades: [],
  lastBarOpenTime: null,
  updatedAt: null,
  settingsMeta: null,
  settingsMetaAgent3: null,
  simUpdatedAt: null,
  markUpdatedAt: null,
  ongoingTradesRaw: [],
  ongoingTradesRawAgent3: [],
  regime: null,
  regimeAgent3: null,
}

export function getAgent1ShadowSnapshot() {
  const publicPayload = { ...shadowPayload }
  delete publicPayload.ongoingTradesRaw
  delete publicPayload.ongoingTradesRawAgent3
  return {
    ...publicPayload,
    scheduler: { ...agent1ShadowSchedulerState },
    simulationPaused: agent1ShadowSimulationPaused,
    shadowSimRuntimeOverrides: getShadowSimRuntimeOverrides(),
  }
}

export function setAgent1ShadowSnapshot(next) {
  if (!next || typeof next !== 'object') return
  const { shadowSimRuntimeOverrides: snapOvr, ...rest } = next
  if (Object.prototype.hasOwnProperty.call(next, 'shadowSimRuntimeOverrides')) {
    if (snapOvr && typeof snapOvr === 'object' && Object.keys(snapOvr).length > 0) {
      shadowSimRuntimeOverrides = { ...snapOvr }
    } else {
      shadowSimRuntimeOverrides = null
    }
  }
  shadowPayload = {
    ...shadowPayload,
    ...rest,
  }
}

/**
 * @param {object} deps
 * @param {string} deps.futuresBase
 * @param {() => Promise<{ longBase: object, shortBase: object, configUpdatedAt: string | null, configFromDb: boolean }>} deps.loadShadowSimBaseSettings
 */
export async function runAgent1ShadowTickOnce(deps) {
  const { futuresBase, loadShadowSimBaseSettings } = deps
  const basePack = await loadShadowSimBaseSettings()
  const longBase = basePack.longBase
  const shortBase = basePack.shortBase
  const settings = applyShadowReplayScanOverrides(longBase)
  const shortAdjusted = applyShadowReplayShortScanOverrides(shortBase)
  const settingsA3 = {
    ...shortAdjusted,
    scanInterval: settings.scanInterval,
    scanMinQuoteVolume: settings.scanMinQuoteVolume,
    scanMaxSymbols: settings.scanMaxSymbols,
  }
  const n = resolveShadowReplayBarCount()

  const marketWide = process.env.AGENT1_SHADOW_MARKET_WIDE !== 'false'

  if (marketWide) {
    const result = await runMarketWideAgent1ShadowReplay(futuresBase, settings, n, settingsA3)
    shadowPayload = {
      mode: 'market',
      symbol: null,
      universe: result.universe,
      barCount: result.universe.barCountPerSymbol,
      candles: [],
      curve: result.curve,
      liveCurve: result.liveCurve,
      curveAgent3: result.curveAgent3,
      liveCurveAgent3: result.liveCurveAgent3,
      trades: result.closedTrades.map(summarizeTradeForApi),
      ongoingTrades: result.openTrades.map(summarizeTradeForApi),
      agent3Trades: result.closedTradesAgent3.map(summarizeTradeForApi),
      agent3OngoingTrades: result.openTradesAgent3.map(summarizeTradeForApi),
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
        replayBarCount: n,
        effectiveMinQuoteVolume: result.universe.effectiveMinQuoteVolume,
        shadowSimConfigSource: basePack.configFromDb ? 'supabase' : 'code_defaults',
        shadowSimConfigUpdatedAt: basePack.configUpdatedAt,
        shadowSimLongBaseline: longBase,
        shadowSimRuntimeOverrides: getShadowSimRuntimeOverrides(),
        tpR: AGENT1_SHADOW_REPLAY_TP_R,
        shadowTradeGeometryNote:
          'R from spike bar (long: close−low, short: high−close). SL starts at entry ∓ R; if that is farther than max_sl_pct / short_max_sl_pct (public.agent1_shadow_sim_config, default 1%), capStop tightens SL so max adverse distance is that % of entry (narrower stops unchanged). TP = entry ± tpR×R (code constant).',
        klineIntervalNote:
          'Baseline from public.agent1_shadow_sim_config (or code defaults if DB missing). Optional runtime override for interval / universe / bars. Short leg uses same klines; short spike fields from DB short_* columns.',
      },
      settingsMetaAgent3: {
        scanInterval: settingsA3.scanInterval,
        scanThresholdPct: settingsA3.scanThresholdPct,
        maxSlPct: settingsA3.maxSlPct,
        scanSpikeMetric: settingsA3.scanSpikeMetric,
        scanDirection: settingsA3.scanDirection,
        scanMinQuoteVolume: settingsA3.scanMinQuoteVolume,
        scanMaxSymbols: settingsA3.scanMaxSymbols,
        shadowSimShortBaseline: shortBase,
        tpR: AGENT1_SHADOW_REPLAY_TP_R,
      },
      ongoingTradesRaw: result.openTrades,
      ongoingTradesRawAgent3: result.openTradesAgent3,
      regime: buildShadowRegimeSnapshotFromLiveCurve(result.curve, {
        emaPeriod: AGENT1_SHADOW_REGIME_EMA_PERIOD,
        source: 'sim',
        updatedAt: new Date().toISOString(),
      }),
      regimeAgent3: buildShadowRegimeSnapshotFromLiveCurve(result.curveAgent3, {
        emaPeriod: AGENT1_SHADOW_REGIME_EMA_PERIOD,
        source: 'sim',
        updatedAt: new Date().toISOString(),
      }),
    }
    return
  }

  const symbol = normalizeShadowSymbol(process.env.AGENT1_SHADOW_SYMBOL ?? 'BLESSUSDT')
  const candles = await fetchAgent1ShadowKlines(futuresBase, symbol, settings.scanInterval, n)
  const tradeOptsA1 = {
    thresholdPct: settings.scanThresholdPct,
    maxSlPct: settings.maxSlPct,
    spikeMetric: settings.scanSpikeMetric,
    scanDirection: settings.scanDirection,
    tpR: AGENT1_SHADOW_REPLAY_TP_R,
  }
  const tradeOptsA3 = {
    thresholdPct: settingsA3.scanThresholdPct,
    maxSlPct: settingsA3.maxSlPct,
    spikeMetric: settingsA3.scanSpikeMetric,
    scanDirection: settingsA3.scanDirection,
    tpR: AGENT1_SHADOW_REPLAY_TP_R,
  }
  const tradesLong = replayAgent1ShadowLongTrades(candles, tradeOptsA1).map((t) => ({ ...t, symbol }))
  const tradesShort = replayAgent3ShadowShortTrades(candles, tradeOptsA3).map((t) => ({ ...t, symbol }))
  const lastBar = candles.length > 0 ? candles[candles.length - 1] : null
  const lastOpen = lastBar?.openTime ?? null
  const splitL = splitClosedAndOpenShadowTrades(tradesLong, lastOpen)
  const splitS = splitClosedAndOpenShadowTrades(tradesShort, lastOpen)
  const curve = buildAgent1ShadowCurveClosedTrades(splitL.closedTrades)
  const liveCurve = buildLiveCurveWithOpenTrades(curve, splitL.openTrades, lastOpen)
  const curveAgent3 = buildAgent3ShadowCurveClosedTrades(splitS.closedTrades)
  const liveCurveAgent3 = buildLiveCurveWithOpenTradesShort(curveAgent3, splitS.openTrades, lastOpen)

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
    curveAgent3,
    liveCurveAgent3,
    trades: splitL.closedTrades.map(summarizeTradeForApi),
    ongoingTrades: splitL.openTrades.map(summarizeTradeForApi),
    agent3Trades: splitS.closedTrades.map(summarizeTradeForApi),
    agent3OngoingTrades: splitS.openTrades.map(summarizeTradeForApi),
    lastBarOpenTime: lastOpen,
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
      replayBarCount: n,
      shadowSimConfigSource: basePack.configFromDb ? 'supabase' : 'code_defaults',
      shadowSimConfigUpdatedAt: basePack.configUpdatedAt,
      shadowSimLongBaseline: longBase,
      shadowSimRuntimeOverrides: getShadowSimRuntimeOverrides(),
      tpR: AGENT1_SHADOW_REPLAY_TP_R,
      shadowTradeGeometryNote:
        'R from spike bar (long: close−low, short: high−close). SL starts at entry ∓ R; if that is farther than max_sl_pct / short_max_sl_pct (public.agent1_shadow_sim_config, default 1%), capStop tightens SL so max adverse distance is that % of entry (narrower stops unchanged). TP = entry ± tpR×R (code constant).',
      klineIntervalNote:
        'Baseline from agent1_shadow_sim_config or code defaults; optional runtime override for interval / universe / bars.',
    },
    settingsMetaAgent3: {
      scanInterval: settingsA3.scanInterval,
      scanThresholdPct: settingsA3.scanThresholdPct,
      maxSlPct: settingsA3.maxSlPct,
      scanSpikeMetric: settingsA3.scanSpikeMetric,
      scanDirection: settingsA3.scanDirection,
      scanMinQuoteVolume: settingsA3.scanMinQuoteVolume,
      scanMaxSymbols: settingsA3.scanMaxSymbols,
      shadowSimShortBaseline: shortBase,
      tpR: AGENT1_SHADOW_REPLAY_TP_R,
    },
    ongoingTradesRaw: splitL.openTrades,
    ongoingTradesRawAgent3: splitS.openTrades,
    regime: buildShadowRegimeSnapshotFromLiveCurve(curve, {
      emaPeriod: AGENT1_SHADOW_REGIME_EMA_PERIOD,
      source: 'sim',
      updatedAt: new Date().toISOString(),
    }),
    regimeAgent3: buildShadowRegimeSnapshotFromLiveCurve(curveAgent3, {
      emaPeriod: AGENT1_SHADOW_REGIME_EMA_PERIOD,
      source: 'sim',
      updatedAt: new Date().toISOString(),
    }),
  }
  }

/**
 * @param {object} deps
 * @param {string} deps.futuresBase
 * @param {() => Promise<{ longBase: object, shortBase: object, configUpdatedAt: string | null, configFromDb: boolean }>} deps.loadShadowSimBaseSettings
 * @param {{ log?: typeof console.log, error?: typeof console.error }} [deps.logger]
 * @param {() => Promise<boolean> | boolean} [deps.shouldRunTick] - return false to skip this tick (e.g. not lease owner).
 * @param {(snapshot: object) => Promise<void> | void} [deps.afterTick] - called after successful run.
 * @param {() => Promise<void> | void} [deps.syncPausedFromDb] - when DB coordination is on, reload pause flag from shared snapshot before replay/mark (so any instance’s PATCH reaches the lease owner).
 * @param {() => Promise<void> | void} [deps.syncShadowOverridesFromDb] - when DB coordination is on, merge replay overrides from shared snapshot before each replay tick (so PATCH from any instance applies on the lease owner).
 * @param {() => Promise<boolean> | boolean} [deps.shouldMarkTick] - return false to skip mark-to-market updates.
 * @param {(snapshot: object) => Promise<void> | void} [deps.afterMarkTick] - called after successful mark update.
 */
export function startAgent1ShadowScheduler(deps) {
  const {
    futuresBase,
    loadShadowSimBaseSettings,
    logger = console,
    shouldRunTick = null,
    afterTick = null,
    syncPausedFromDb = null,
    syncShadowOverridesFromDb = null,
    shouldMarkTick = null,
    afterMarkTick = null,
  } = deps
  if (typeof loadShadowSimBaseSettings !== 'function') {
    throw new Error('startAgent1ShadowScheduler requires loadShadowSimBaseSettings')
  }
  let timer = null
  let markTimer = null
  let stopped = false
  let latestFuturesBase = futuresBase
  /** @type {Array<object>} */
  let latestOpenTradesRaw = []
  /** @type {Array<object>} */
  let latestOpenTradesRawAgent3 = []
  /** @type {Array<object>} */
  let latestClosedCurve = []
  /** @type {Array<object>} */
  let latestClosedCurveAgent3 = []
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
    if (syncPausedFromDb) {
      try {
        await syncPausedFromDb()
      } catch {
        // ignore; keep last in-memory flag
      }
    }
    if (agent1ShadowSimulationPaused) return
    if (!latestOpenTradesRaw.length && !latestOpenTradesRawAgent3.length) return
    try {
      if (shouldMarkTick) {
        const ok = await shouldMarkTick()
        if (!ok) return
      }
      const nowMs = Date.now()
      /** Default off: open rows use last kline close from replay (eod). Live ticker marks mix "historical sim" with current market and inflate/deflate unrealized %. Set AGENT1_SHADOW_OPEN_MARK_LIVE=true to restore old behavior. */
      const useLiveOpenMark = process.env.AGENT1_SHADOW_OPEN_MARK_LIVE === 'true'
      let markedOpen
      let markedOpenA3
      let markTimeMsForCurve
      if (useLiveOpenMark) {
        const pxMap = await fetchLatestPricesMap()
        markTimeMsForCurve = nowMs
        markedOpen = markOpenTradesWithLatestPrices(latestOpenTradesRaw, pxMap, markTimeMsForCurve)
        markedOpenA3 = markOpenShortTradesWithLatestPrices(latestOpenTradesRawAgent3, pxMap, markTimeMsForCurve)
      } else {
        markedOpen = latestOpenTradesRaw.map((t) => ({ ...t }))
        markedOpenA3 = latestOpenTradesRawAgent3.map((t) => ({ ...t }))
        const lastBar = Number(shadowPayload.lastBarOpenTime)
        markTimeMsForCurve = Number.isFinite(lastBar) ? lastBar : nowMs
      }
      const liveCurve = buildLiveCurveWithOpenTrades(latestClosedCurve, markedOpen, markTimeMsForCurve)
      const liveCurveAgent3 = buildLiveCurveWithOpenTradesShort(
        latestClosedCurveAgent3,
        markedOpenA3,
        markTimeMsForCurve,
      )
      shadowPayload = {
        ...shadowPayload,
        liveCurve,
        liveCurveAgent3,
        ongoingTrades: markedOpen.map(summarizeTradeForApi),
        agent3OngoingTrades: markedOpenA3.map(summarizeTradeForApi),
        updatedAt: new Date(nowMs).toISOString(),
        markUpdatedAt: new Date(nowMs).toISOString(),
        regime: buildShadowRegimeSnapshotFromLiveCurve(latestClosedCurve, {
          emaPeriod: AGENT1_SHADOW_REGIME_EMA_PERIOD,
          source: 'mark',
          updatedAt: new Date(nowMs).toISOString(),
        }),
        regimeAgent3: buildShadowRegimeSnapshotFromLiveCurve(latestClosedCurveAgent3, {
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
    let intervalKey = '5m'
    try {
      const pack = await loadShadowSimBaseSettings()
      const o = getShadowSimRuntimeOverrides()
      intervalKey = o?.scanInterval ?? pack.longBase?.scanInterval ?? '5m'
    } catch {
      // keep default interval alignment
    }
    const intervalMs = agent1IntervalMs(intervalKey)
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
      if (syncPausedFromDb) {
        try {
          await syncPausedFromDb()
        } catch {
          // ignore
        }
      }
      if (syncShadowOverridesFromDb) {
        try {
          await syncShadowOverridesFromDb()
        } catch {
          // ignore
        }
      }
      if (shouldRunTick) {
        const ok = await shouldRunTick()
        if (!ok) return
      }
      if (agent1ShadowSimulationPaused) return
      await runAgent1ShadowTickOnce({ futuresBase, loadShadowSimBaseSettings })
      latestFuturesBase = futuresBase
      latestClosedCurve = Array.isArray(shadowPayload.curve) ? shadowPayload.curve : []
      latestClosedCurveAgent3 = Array.isArray(shadowPayload.curveAgent3) ? shadowPayload.curveAgent3 : []
      latestOpenTradesRaw = Array.isArray(shadowPayload.ongoingTradesRaw)
        ? shadowPayload.ongoingTradesRaw
        : []
      latestOpenTradesRawAgent3 = Array.isArray(shadowPayload.ongoingTradesRawAgent3)
        ? shadowPayload.ongoingTradesRawAgent3
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
