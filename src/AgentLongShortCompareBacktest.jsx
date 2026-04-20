import { useCallback, useMemo, useState } from 'react'
import {
  SpikeTpSlAccountBalanceLightChart,
  SpikeTpSlCompareEquityChart,
  SpikeTpSlPerTradeCandleLightChart,
  compareProgressSynthTimeFromPointIndex,
} from './spikeTpSlLightweightCharts.jsx'
import { simulateAccountBalanceFromTradePcts } from './accountLeverageSim.js'
import { normalizeEquityEmaPeriod } from './equityEmaInteractiveFilter.js'
import { consumeQuickBacktestStream, MAX_QUICK_BACKTEST_CANDLES } from './spikeQuickBacktestClient.js'

const INTERVAL_OPTIONS = [
  { value: '1m', label: '1m' },
  { value: '3m', label: '3m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
  { value: '1h', label: '1h' },
  { value: '4h', label: '4h' },
]

const PROGRESS_CAP = 56
const QUICK_EMA_PERIOD = 50

function fmtSignedPct2(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

/** Max drawdown is stored as a positive magnitude (% points from peak equity). */
function fmtDrawdownPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${Number(n).toFixed(2)}%`
}

function fmtPct1(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${Number(n).toFixed(1)}%`
}

function fmtR3(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${Number(n).toFixed(3)}`
}

/** Final cumulative Σ % divided by max drawdown magnitude (higher = more return per unit of pain). */
function fmtReturnPerMaxDd(summary) {
  const fin = Number(summary?.finalPnlPctFromStart)
  const dd = Number(summary?.maxDrawdownPnlPct)
  if (!Number.isFinite(fin) || !Number.isFinite(dd) || dd <= 0) return '—'
  return `${(fin / dd).toFixed(2)}×`
}

function fmtUsd2(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${Number(n).toFixed(2)} USDT`
}

function computeEmaOnCloses(closes, period) {
  const out = closes.map(() => null)
  if (!Array.isArray(closes) || closes.length < period || period < 2) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]
  let ema = sum / period
  out[period - 1] = ema
  const alpha = 2 / (period + 1)
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * alpha + ema * (1 - alpha)
    out[i] = ema
  }
  return out
}

function maxDrawdownFromPnlPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return null
  let peak = -Infinity
  let maxDd = 0
  for (const p of points) {
    const v = Number(p?.pnlPctFromStart)
    if (!Number.isFinite(v)) continue
    if (v > peak) peak = v
    const dd = peak - v
    if (dd > maxDd) maxDd = dd
  }
  return Number.isFinite(maxDd) ? maxDd : null
}

/**
 * EMA gate per side: keep trade i only if cumulative close at i-1 > EMA(i-1).
 * Strict warmup: first `period` trades are skipped until EMA is established.
 * If server entry flags are present, reuse them for consistency with backend.
 */
function buildEmaGatedPackForResult(result, emaPeriod = QUICK_EMA_PERIOD) {
  const pctsRaw = result?.perTradePricePctChron
  if (!Array.isArray(pctsRaw) || pctsRaw.length === 0) return null
  const n = pctsRaw.length
  const pcts = pctsRaw.map((x) => {
    const v = Number(x)
    return Number.isFinite(v) ? v : 0
  })
  const period = normalizeEquityEmaPeriod(emaPeriod)

  const closes = []
  let c = 0
  for (let i = 0; i < n; i++) {
    c += pcts[i]
    closes.push(c)
  }
  const ema = computeEmaOnCloses(closes, period)
  const entryFlagsRaw = result?.perTradeEquityEmaAtEntryOk
  const useEntryFlags = Array.isArray(entryFlagsRaw) && entryFlagsRaw.length === n
  const entryOk = new Array(n).fill(false)
  for (let i = 0; i < n; i++) {
    // Strict warmup: do not count trades before EMA(period) is established.
    // For prior-point gating, first eligible trade index is `period`.
    if (i < period) {
      entryOk[i] = false
      continue
    }
    if (useEntryFlags) {
      entryOk[i] = entryFlagsRaw[i] === true
      continue
    }
    const prevClose = closes[i - 1]
    const prevEma = ema[i - 1]
    entryOk[i] = Number.isFinite(prevClose) && Number.isFinite(prevEma) && prevClose > prevEma
  }

  const points = [{ tradeIndex: 0, pnlPctFromStart: 0 }]
  const activeByPoint = [false]
  let cum = 0
  let kept = 0
  let skipped = 0
  let sumR = 0
  let tpHits = 0
  let slHits = 0
  let eodHits = 0
  let winningTrades = 0
  let losingTrades = 0
  let breakevenTrades = 0
  const rChron = Array.isArray(result?.perTradeRChron) && result.perTradeRChron.length === n ? result.perTradeRChron : null
  const oc = Array.isArray(result?.perTradeOutcomeChron) && result.perTradeOutcomeChron.length === n
    ? result.perTradeOutcomeChron
    : null

  for (let i = 0; i < n; i++) {
    const ok = entryOk[i] === true
    activeByPoint.push(ok)
    if (ok) {
      cum += pcts[i]
      kept += 1
      const r = Number(rChron?.[i])
      if (Number.isFinite(r)) {
        sumR += r
        if (r > 0) winningTrades += 1
        else if (r < 0) losingTrades += 1
        else breakevenTrades += 1
      }
      const o = oc?.[i]
      if (o === 'tp') tpHits += 1
      else if (o === 'sl') slHits += 1
      else if (o === 'eod') eodHits += 1
    } else {
      skipped += 1
    }
    points.push({ tradeIndex: i + 1, pnlPctFromStart: cum })
  }

  const decided = tpHits + slHits
  const summary = {
    totalTrades: kept,
    skippedTradesByEma: skipped,
    finalPnlPctFromStart: cum,
    avgPnlPctPerTrade: kept > 0 ? cum / kept : null,
    maxDrawdownPnlPct: maxDrawdownFromPnlPoints(points),
    sumR: Number.isFinite(sumR) ? sumR : null,
    avgR: kept > 0 && Number.isFinite(sumR) ? sumR / kept : null,
    tpHits,
    slHits,
    eodHits,
    winningTrades,
    losingTrades,
    breakevenTrades,
    winRateTpVsSlPct: decided > 0 ? (100 * tpHits) / decided : null,
    usedServerEntryFlags: useEntryFlags,
  }
  const cut = Math.min(period, points.length - 1)
  const displayPoints = points.slice(cut)
  const displayActivity = activeByPoint.slice(cut)

  let equityCurveOut = displayPoints.length >= 2 ? displayPoints : points
  if (Array.isArray(result?.equityEmaFilteredCurve) && result.equityEmaFilteredCurve.length > 1) {
    const srv = result.equityEmaFilteredCurve
      .map((p) => ({
        tradeIndex: p.tradeIndex,
        pnlPctFromStart: Number(p.pnlPctFromStart),
      }))
      .filter((p) => Number.isFinite(p.pnlPctFromStart))
    if (srv.length > 1) {
      const cutSrv = Math.min(period, Math.max(0, srv.length - 1))
      const sliced = srv.slice(cutSrv)
      equityCurveOut = sliced.length >= 2 ? sliced : srv
      const lastFin = Number(srv[srv.length - 1]?.pnlPctFromStart)
      if (Number.isFinite(lastFin)) {
        summary.finalPnlPctFromStart = lastFin
        summary.avgPnlPctPerTrade = kept > 0 ? lastFin / kept : null
        summary.maxDrawdownPnlPct = maxDrawdownFromPnlPoints(srv)
      }
    }
  }

  return {
    equityCurve: equityCurveOut,
    activityByPoint: displayActivity.length >= 2 ? displayActivity : activeByPoint,
    summary,
    period,
    sourceTrades: n,
    subsampled: Boolean(result?.perTradePricePctSubsampled),
  }
}

function buildCombinedActivityBars(longPack, shortPack) {
  const nLong = longPack?.activityByPoint?.length ?? 0
  const nShort = shortPack?.activityByPoint?.length ?? 0
  const n = Math.max(nLong, nShort)
  if (n < 2) return null
  const out = []
  for (let i = 0; i < n; i++) {
    const t = compareProgressSynthTimeFromPointIndex(i, n)
    let longOn = false
    let shortOn = false
    if (nLong >= 2 && longPack?.activityByPoint) {
      const idxL = Math.round((i / (n - 1)) * (nLong - 1))
      longOn = longPack.activityByPoint[idxL] === true
    }
    if (nShort >= 2 && shortPack?.activityByPoint) {
      const idxS = Math.round((i / (n - 1)) * (nShort - 1))
      shortOn = shortPack.activityByPoint[idxS] === true
    }
    const state = (longOn ? 1 : 0) + (shortOn ? 2 : 0)
    out.push({ time: t, state })
  }
  return out
}

function getResampledAtIndex(arr, toLen, i) {
  if (!Array.isArray(arr) || arr.length === 0 || toLen <= 0) return 0
  if (arr.length === 1) return Number(arr[0]) || 0
  const idx = Math.round((i / (toLen - 1)) * (arr.length - 1))
  const v = Number(arr[idx])
  return Number.isFinite(v) ? v : 0
}

function equityCurveDeltas(points) {
  if (!Array.isArray(points) || points.length < 2) return []
  const out = []
  for (let i = 1; i < points.length; i++) {
    const prev = Number(points[i - 1]?.pnlPctFromStart)
    const cur = Number(points[i]?.pnlPctFromStart)
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) out.push(0)
    else out.push(cur - prev)
  }
  return out
}

function getResampledBoolAtIndex(arr, toLen, i) {
  if (!Array.isArray(arr) || arr.length === 0 || toLen <= 0) return false
  if (arr.length === 1) return arr[0] === true
  const idx = Math.round((i / (toLen - 1)) * (arr.length - 1))
  return arr[idx] === true
}

/**
 * Shared-wallet simulation where EMA-gated Agent 1 + Agent 3 returns are combined per normalized progress step.
 * This is an approximation when side trade counts differ, because returns are aligned by progress index.
 */
function buildCombinedEmaGatedAccountSim(longPack, shortPack, startingBalanceStr, tradeSizePctStr, leverageStr) {
  const dL = equityCurveDeltas(longPack?.equityCurve)
  const dS = equityCurveDeltas(shortPack?.equityCurve)
  const n = Math.max(dL.length, dS.length)
  if (n < 1) return null

  const pctsCombined = []
  let longOnlySteps = 0
  let shortOnlySteps = 0
  let bothSteps = 0
  for (let i = 0; i < n; i++) {
    const longOn = getResampledBoolAtIndex(longPack?.activityByPoint, n + 1, i + 1)
    const shortOn = getResampledBoolAtIndex(shortPack?.activityByPoint, n + 1, i + 1)
    if (longOn && shortOn) bothSteps += 1
    else if (longOn) longOnlySteps += 1
    else if (shortOn) shortOnlySteps += 1

    const xL = getResampledAtIndex(dL, n, i)
    const xS = getResampledAtIndex(dS, n, i)
    pctsCombined.push(xL + xS)
  }

  const startingBalance = Number.parseFloat(String(startingBalanceStr).replace(/,/g, ''))
  const tradeSizePct = Number.parseFloat(String(tradeSizePctStr).replace(/,/g, ''))
  const leverage = Number.parseFloat(String(leverageStr).replace(/,/g, ''))
  const sim = simulateAccountBalanceFromTradePcts({
    startingBalance,
    tradeSizePct,
    leverage,
    perTradePricePcts: pctsCombined,
  })
  if (!sim) return null
  const totalPoints = Math.max(2, sim.points.length)
  const points = sim.points.map((p, i) => ({
    time: compareProgressSynthTimeFromPointIndex(i, totalPoints),
    value: p.balance,
  }))
  return {
    sim,
    points,
    nSteps: n,
    longOnlySteps,
    shortOnlySteps,
    bothSteps,
    approxByResample:
      (Array.isArray(dL) && Array.isArray(dS) && dL.length > 0 && dS.length > 0 && dL.length !== dS.length) ||
      longPack?.subsampled ||
      shortPack?.subsampled,
  }
}

function pushProgress(setLog, line) {
  setLog((prev) => {
    const next = [...prev, `${new Date().toLocaleTimeString()} ${line}`]
    return next.length > PROGRESS_CAP ? next.slice(-PROGRESS_CAP) : next
  })
}

function buildQuery({
  minQuoteVolume24h,
  interval,
  candleCount,
  thresholdPct,
  strategy,
  tpR,
  maxSymbols,
}) {
  const q = new URLSearchParams({
    minQuoteVolume24h: String(minQuoteVolume24h),
    interval,
    candleCount: String(candleCount),
    thresholdPct: String(thresholdPct),
    strategy,
    equityEmaSlow: String(QUICK_EMA_PERIOD),
  })
  if (Number.isFinite(tpR) && tpR > 0) q.set('tpR', String(tpR))
  if (Number.isFinite(maxSymbols) && maxSymbols >= 10) q.set('maxSymbols', String(Math.min(300, maxSymbols)))
  return q
}

function LongShortSideMetrics({ title, summary, symbolsSkipped, isFirst }) {
  if (!summary) return null
  const s = summary
  const total = s.totalTrades ?? 0
  const winPctSigned =
    total > 0 && Number.isFinite(s.winningTrades) ? (100 * s.winningTrades) / total : null

  return (
    <>
      <h3
        className="hourly-spikes-h3"
        style={{ marginTop: isFirst ? '0.35rem' : '1.15rem', marginBottom: '0.35rem' }}
      >
        {title}
      </h3>
      <div className="backtest1-summary-grid">
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Total trades</span>
          <span className="backtest1-stat-value">{total > 0 ? total.toLocaleString() : '—'}</span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Cumulative Σ price %</span>
          <span
            className={`backtest1-stat-value ${(s.finalPnlPctFromStart ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
          >
            {fmtSignedPct2(s.finalPnlPctFromStart)}
          </span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Max drawdown (Σ %)</span>
          <span className="backtest1-stat-value pnl-neg">{fmtDrawdownPct(s.maxDrawdownPnlPct)}</span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Avg % / trade</span>
          <span
            className={`backtest1-stat-value ${(s.avgPnlPctPerTrade ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
          >
            {fmtSignedPct2(s.avgPnlPctPerTrade)}
          </span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Σ % ÷ max DD</span>
          <span className="backtest1-stat-value">{fmtReturnPerMaxDd(s)}</span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Win rate (TP vs SL)</span>
          <span className="backtest1-stat-value">{fmtPct1(s.winRateTpVsSlPct)}</span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Win % (signed P&amp;L)</span>
          <span className="backtest1-stat-value">{fmtPct1(winPctSigned)}</span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">W / L / BE</span>
          <span className="backtest1-stat-value">
            {s.winningTrades ?? '—'} / {s.losingTrades ?? '—'} / {s.breakevenTrades ?? '—'}
          </span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Exit: TP / SL / EOD</span>
          <span className="backtest1-stat-value">
            {s.tpHits ?? '—'} / {s.slHits ?? '—'} / {s.eodHits ?? '—'}
          </span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Avg R</span>
          <span
            className={`backtest1-stat-value ${(s.avgR ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
          >
            {s.avgR != null && Number.isFinite(s.avgR) ? `${fmtR3(s.avgR)}R` : '—'}
          </span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Sum R</span>
          <span
            className={`backtest1-stat-value ${(s.sumR ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
          >
            {s.sumR != null && Number.isFinite(s.sumR) ? `${fmtR3(s.sumR)}R` : '—'}
          </span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">EMA filter skips</span>
          <span className="backtest1-stat-value">
            {s.emaFilterSkips != null ? s.emaFilterSkips.toLocaleString() : '—'}
          </span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Symbols skipped</span>
          <span className="backtest1-stat-value">
            {Number.isFinite(symbolsSkipped) ? symbolsSkipped.toLocaleString() : '—'}
          </span>
        </div>
      </div>
    </>
  )
}

function EmaGatedSideMetrics({ title, gatedPack, isFirst }) {
  if (!gatedPack?.summary) return null
  const s = gatedPack.summary
  const total = s.totalTrades ?? 0
  const winPctSigned = total > 0 ? (100 * (s.winningTrades ?? 0)) / total : null
  return (
    <>
      <h3
        className="hourly-spikes-h3"
        style={{ marginTop: isFirst ? '0.35rem' : '1.15rem', marginBottom: '0.35rem' }}
      >
        {title}
      </h3>
      <div className="backtest1-summary-grid">
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Trades kept (EMA gate)</span>
          <span className="backtest1-stat-value">{total > 0 ? total.toLocaleString() : '—'}</span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Trades skipped (below EMA)</span>
          <span className="backtest1-stat-value">{(s.skippedTradesByEma ?? 0).toLocaleString()}</span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">EMA-gated cumulative Σ %</span>
          <span className={`backtest1-stat-value ${(s.finalPnlPctFromStart ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
            {fmtSignedPct2(s.finalPnlPctFromStart)}
          </span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Max drawdown (Σ %)</span>
          <span className="backtest1-stat-value pnl-neg">{fmtDrawdownPct(s.maxDrawdownPnlPct)}</span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Avg % / kept trade</span>
          <span className={`backtest1-stat-value ${(s.avgPnlPctPerTrade ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
            {fmtSignedPct2(s.avgPnlPctPerTrade)}
          </span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Σ % ÷ max DD</span>
          <span className="backtest1-stat-value">{fmtReturnPerMaxDd(s)}</span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Win rate (TP vs SL)</span>
          <span className="backtest1-stat-value">{fmtPct1(s.winRateTpVsSlPct)}</span>
        </div>
        <div className="backtest1-stat">
          <span className="backtest1-stat-label">Win % (signed P&amp;L)</span>
          <span className="backtest1-stat-value">{fmtPct1(winPctSigned)}</span>
        </div>
      </div>
    </>
  )
}

export function AgentLongShortCompareBacktest() {
  const [minQuoteVolume24h, setMinQuoteVolume24h] = useState('10000000')
  const [interval, setInterval] = useState('5m')
  const [thresholdPct, setThresholdPct] = useState('3')
  const [candleCount, setCandleCount] = useState('500')
  const [tpR, setTpR] = useState('2')
  const [maxSymbols, setMaxSymbols] = useState('300')
  const [startingBalance, setStartingBalance] = useState('100')
  const [tradeSizePct, setTradeSizePct] = useState('10')
  const [leverage, setLeverage] = useState('20')

  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [resultLong, setResultLong] = useState(null)
  const [resultShort, setResultShort] = useState(null)
  const [resultAgent4, setResultAgent4] = useState(null)
  const [progressLog, setProgressLog] = useState([])

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    setResultLong(null)
    setResultShort(null)
    setResultAgent4(null)
    setProgressLog([])
    try {
      const vol = Number.parseFloat(String(minQuoteVolume24h).replace(/,/g, ''))
      const th = Number.parseFloat(String(thresholdPct))
      const n = Number.parseInt(String(candleCount).replace(/,/g, ''), 10)
      const tp = Number.parseFloat(String(tpR).replace(/,/g, ''))
      const maxSym = Number.parseInt(String(maxSymbols).trim(), 10)

      if (!Number.isFinite(vol) || vol < 0) throw new Error('Volume must be >= 0')
      if (!Number.isFinite(th) || th <= 0) throw new Error('Threshold must be > 0')
      if (!Number.isFinite(n) || n < 50 || n > MAX_QUICK_BACKTEST_CANDLES) {
        throw new Error(`Candles must be 50–${MAX_QUICK_BACKTEST_CANDLES}`)
      }

      const base = {
        minQuoteVolume24h: vol,
        interval,
        candleCount: n,
        thresholdPct: th,
        tpR: Number.isFinite(tp) && tp > 0 ? tp : undefined,
        maxSymbols: Number.isFinite(maxSym) && maxSym >= 10 ? Math.min(300, maxSym) : undefined,
      }

      pushProgress(setProgressLog, 'Starting Agent 1 (long / green spike)…')
      await consumeQuickBacktestStream(buildQuery({ ...base, strategy: 'long' }), (evt) => {
        if (evt.event === 'progress') {
          if (evt.phase === 'symbol') {
            const extra = evt.error ? ` — ${evt.error}` : ''
            pushProgress(
              setProgressLog,
              `[long ${evt.index}/${evt.total}] ${evt.symbol}: ${evt.candlesFetched}/${evt.candlesRequested} bars${extra}`,
            )
          } else if (evt.phase === 'aggregate') {
            pushProgress(setProgressLog, 'Long: aggregating trades & equity…')
          }
        } else if (evt.event === 'done') {
          setResultLong(evt.result)
          pushProgress(setProgressLog, 'Long run done.')
        } else if (evt.event === 'error') {
          throw new Error(evt.message || 'Long backtest error')
        }
      })

      pushProgress(setProgressLog, 'Starting Agent 3 (short / red spike)…')
      await consumeQuickBacktestStream(buildQuery({ ...base, strategy: 'short_red_spike' }), (evt) => {
        if (evt.event === 'progress') {
          if (evt.phase === 'symbol') {
            const extra = evt.error ? ` — ${evt.error}` : ''
            pushProgress(
              setProgressLog,
              `[A3 short ${evt.index}/${evt.total}] ${evt.symbol}: ${evt.candlesFetched}/${evt.candlesRequested} bars${extra}`,
            )
          } else if (evt.phase === 'aggregate') {
            pushProgress(setProgressLog, 'Agent 3: aggregating trades & equity…')
          }
        } else if (evt.event === 'done') {
          setResultShort(evt.result)
          pushProgress(setProgressLog, 'Agent 3 done.')
        } else if (evt.event === 'error') {
          throw new Error(evt.message || 'Short backtest error')
        }
      })

      pushProgress(setProgressLog, 'Starting Agent 4 (long / red spike, 2R fixed)…')
      await consumeQuickBacktestStream(buildQuery({ ...base, strategy: 'agent4' }), (evt) => {
        if (evt.event === 'progress') {
          if (evt.phase === 'symbol') {
            const extra = evt.error ? ` — ${evt.error}` : ''
            pushProgress(
              setProgressLog,
              `[A4 long ${evt.index}/${evt.total}] ${evt.symbol}: ${evt.candlesFetched}/${evt.candlesRequested} bars${extra}`,
            )
          } else if (evt.phase === 'aggregate') {
            pushProgress(setProgressLog, 'Agent 4: aggregating trades & equity…')
          }
        } else if (evt.event === 'done') {
          setResultAgent4(evt.result)
          pushProgress(setProgressLog, 'Agent 4 done. Compare charts ready.')
        } else if (evt.event === 'error') {
          throw new Error(evt.message || 'Agent 4 backtest error')
        }
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setRunning(false)
    }
  }, [minQuoteVolume24h, interval, thresholdPct, candleCount, tpR, maxSymbols])

  const sLong = resultLong?.summary
  const sShort = resultShort?.summary
  const sA4 = resultAgent4?.summary
  const showSummary = Boolean(sLong || sShort || sA4)

  const compareExtraSeries = useMemo(() => {
    if (resultAgent4?.equityCurve?.length > 1) {
      return [
        {
          points: resultAgent4.equityCurve,
          side: 'long',
          label: 'Agent 4 (long / red spike, 2R)',
        },
      ]
    }
    return null
  }, [resultAgent4])

  const emaGateLong = useMemo(() => buildEmaGatedPackForResult(resultLong, QUICK_EMA_PERIOD), [resultLong])
  const emaGateShort = useMemo(() => buildEmaGatedPackForResult(resultShort, QUICK_EMA_PERIOD), [resultShort])
  const emaGateActivityBars = useMemo(
    () => buildCombinedActivityBars(emaGateLong, emaGateShort),
    [emaGateLong, emaGateShort],
  )
  const emaGateCombinedAccount = useMemo(
    () => buildCombinedEmaGatedAccountSim(emaGateLong, emaGateShort, startingBalance, tradeSizePct, leverage),
    [emaGateLong, emaGateShort, startingBalance, tradeSizePct, leverage],
  )

  return (
    <div className="vol-screener spike-tpsl-bt">
      <h1 className="vol-screener-title">Long / short simulation</h1>
      <p className="vol-screener-lead">
        One click runs three quick backtests: <strong>Agent 1</strong> (long on green spikes), <strong>Agent 3</strong>{' '}
        (short on red spikes), and <strong>Agent 4</strong> (long on red spikes, fixed 2R TP / 1R SL). The compare chart
        overlays cumulative Σ price % curves. <strong>tpR</strong> applies to Agents 1 and 3 only; Agent 4 uses fixed
        2R take-profit in the engine.
      </p>

      <div className="backtest1-form" style={{ maxWidth: 560, marginBottom: '1.25rem' }}>
        <label className="backtest1-field">
          <span className="backtest1-label">Min 24h quote volume (USDT)</span>
          <input
            className="backtest1-input"
            value={minQuoteVolume24h}
            onChange={(e) => setMinQuoteVolume24h(e.target.value)}
            disabled={running}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Timeframe</span>
          <select
            className="backtest1-input"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            disabled={running}
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Spike threshold %</span>
          <input
            className="backtest1-input"
            value={thresholdPct}
            onChange={(e) => setThresholdPct(e.target.value)}
            disabled={running}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Candles per symbol (max {MAX_QUICK_BACKTEST_CANDLES.toLocaleString()})</span>
          <input
            className="backtest1-input"
            value={candleCount}
            onChange={(e) => setCandleCount(e.target.value)}
            disabled={running}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Take-profit (R multiple)</span>
          <input
            className="backtest1-input"
            value={tpR}
            onChange={(e) => setTpR(e.target.value)}
            disabled={running}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Max symbols (10–300)</span>
          <input
            className="backtest1-input"
            value={maxSymbols}
            onChange={(e) => setMaxSymbols(e.target.value)}
            disabled={running}
          />
        </label>
        <p className="backtest1-meta" style={{ gridColumn: '1 / -1', margin: '0.25rem 0 0' }}>
          Balance / size / leverage: used for the EMA-gated combined wallet (Agent 1 + Agent 3) only
        </p>
        <label className="backtest1-field">
          <span className="backtest1-label">Starting balance (USDT)</span>
          <input
            className="backtest1-input"
            value={startingBalance}
            onChange={(e) => setStartingBalance(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Trade size (% of balance at entry)</span>
          <input
            className="backtest1-input"
            value={tradeSizePct}
            onChange={(e) => setTradeSizePct(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Leverage (×)</span>
          <input
            className="backtest1-input"
            value={leverage}
            onChange={(e) => setLeverage(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <button type="button" className="backtest1-btn" onClick={run} disabled={running}>
          {running ? 'Running Agents 1, 3, 4…' : 'Run comparison (3 agents)'}
        </button>
      </div>

      {error ? (
        <p className="hourly-spikes-hint" style={{ color: 'var(--danger, #f6465d)' }} role="alert">
          {error}
        </p>
      ) : null}

      <section className="hourly-spikes-section">
        <h2 className="hourly-spikes-h2">Progress</h2>
        <pre
          className="hourly-spikes-hint"
          style={{
            maxHeight: 240,
            overflow: 'auto',
            fontSize: 12,
            lineHeight: 1.45,
            margin: 0,
            padding: '10px 12px',
            background: 'rgba(0,0,0,0.25)',
            borderRadius: 8,
            whiteSpace: 'pre-wrap',
          }}
        >
          {progressLog.length === 0 ? '—' : progressLog.join('\n')}
        </pre>
      </section>

      {showSummary ? (
        <section className="hourly-spikes-section">
          <h2 className="hourly-spikes-h2">Results — all agents</h2>
          <p className="hourly-spikes-hint" style={{ marginBottom: '0.75rem' }}>
            <strong>Max drawdown</strong> is the largest peak-to-trough drop in cumulative Σ price % (same definition as
            the main Spike backtest). <strong>Win rate (TP vs SL)</strong> uses only TP+SL exits; EOD uses signed price %.
            <strong> Σ % ÷ max DD</strong> compares final cumulative return to worst underwater path (only when DD &gt; 0).
          </p>
          <LongShortSideMetrics
            title="Agent 1 — long (green spike)"
            summary={sLong}
            symbolsSkipped={resultLong?.skipped}
            isFirst
          />
          <LongShortSideMetrics
            title="Agent 3 — short (red spike)"
            summary={sShort}
            symbolsSkipped={resultShort?.skipped}
            isFirst={false}
          />
          <LongShortSideMetrics
            title="Agent 4 — long (red spike, 2R fixed)"
            summary={sA4}
            symbolsSkipped={resultAgent4?.skipped}
            isFirst={false}
          />
        </section>
      ) : null}

      {emaGateLong?.equityCurve?.length > 1 || emaGateShort?.equityCurve?.length > 1 ? (
        <section className="hourly-spikes-section">
          <h2 className="hourly-spikes-h2">EMA(50)-gated equity compare</h2>
          <p className="hourly-spikes-hint" style={{ marginBottom: '0.75rem' }}>
            Entry rule per agent: take a trade only when that agent&apos;s cumulative Σ equity is above EMA(50) at the
            prior point. The first 50 trades are skipped as EMA warmup. Trades already opened before a later cross are still fully closed by their
            normal TP/SL/EOD outcome; the gate only affects <strong>new entries</strong>. Vertical fills on the chart
            show active windows: green=Agent 1, orange=Agent 3, amber=both.
          </p>
          <SpikeTpSlCompareEquityChart
            longPoints={emaGateLong?.equityCurve}
            shortPoints={emaGateShort?.equityCurve}
            activityBars={emaGateActivityBars}
            showFootnote={false}
          />
          {emaGateCombinedAccount ? (
            <>
              <h3 className="hourly-spikes-h3" style={{ marginTop: '1rem' }}>
                Combined account (EMA-gated Agent 1 + Agent 3 on one wallet)
              </h3>
              <p className="hourly-spikes-hint" style={{ marginBottom: '0.5rem' }}>
                Single shared-wallet curve where both EMA-gated agents affect the same balance. Per-step return is
                combined as Agent1% + Agent3% on normalized progress.
              </p>
              <div className="backtest1-summary-grid" style={{ marginBottom: '0.5rem' }}>
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">Final balance</span>
                  <span
                    className={`backtest1-stat-value ${
                      emaGateCombinedAccount.sim.finalBalance >= emaGateCombinedAccount.sim.startingBalance
                        ? 'pnl-pos'
                        : 'pnl-neg'
                    }`}
                  >
                    {fmtUsd2(emaGateCombinedAccount.sim.finalBalance)}
                  </span>
                </div>
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">Max drawdown (balance)</span>
                  <span className="backtest1-stat-value pnl-neg">
                    {fmtUsd2(emaGateCombinedAccount.sim.maxDrawdownUsd)}
                  </span>
                </div>
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">Long-only / short-only / both steps</span>
                  <span className="backtest1-stat-value">
                    {emaGateCombinedAccount.longOnlySteps.toLocaleString()} /{' '}
                    {emaGateCombinedAccount.shortOnlySteps.toLocaleString()} /{' '}
                    {emaGateCombinedAccount.bothSteps.toLocaleString()}
                  </span>
                </div>
              </div>
              <SpikeTpSlAccountBalanceLightChart points={emaGateCombinedAccount.points} showFootnote={false} />
              {emaGateCombinedAccount.approxByResample ? (
                <p className="hourly-spikes-hint" style={{ marginTop: '0.5rem' }}>
                  Combined curve is approximate because agent trade counts differ (progress-resampled merge) and/or
                  per-trade payload is subsampled.
                </p>
              ) : null}
            </>
          ) : null}
          <EmaGatedSideMetrics title="Agent 1 — long (EMA gated)" gatedPack={emaGateLong} isFirst />
          <EmaGatedSideMetrics title="Agent 3 — short (EMA gated)" gatedPack={emaGateShort} isFirst={false} />
          {emaGateLong?.subsampled || emaGateShort?.subsampled ? (
            <p className="hourly-spikes-hint">
              EMA-gated metrics use the per-trade payload sent by API. This run is subsampled, so gated results are
              approximate.
            </p>
          ) : null}
        </section>
      ) : null}

      {resultLong?.equityCurve?.length > 1 ||
      resultShort?.equityCurve?.length > 1 ||
      resultAgent4?.equityCurve?.length > 1 ? (
        <section className="hourly-spikes-section">
          <h2 className="hourly-spikes-h2">Cumulative Σ price % — all agents</h2>
          <p className="hourly-spikes-hint">
            Candles use the same <strong>normalized progress</strong> time base as the compare line (per side). Each
            chart pans and zooms on its own.
          </p>
          <SpikeTpSlCompareEquityChart
            longPoints={resultLong?.equityCurve}
            shortPoints={resultShort?.equityCurve}
            extraCompareSeries={compareExtraSeries}
          />
          {resultLong?.equityCurve?.length > 1 ? (
            <>
              <h3 className="hourly-spikes-h3" style={{ marginTop: '1.25rem' }}>
                Agent 1 — stacked cumulative % candles + EMA({QUICK_EMA_PERIOD})
              </h3>
              <SpikeTpSlPerTradeCandleLightChart
                perTradePricePctChron={resultLong.perTradePricePctChron}
                tradesFallback={resultLong.trades}
                totalTradeRows={resultLong.totalTradeRows}
                serverSubsampled={Boolean(resultLong.perTradePricePctSubsampled)}
                emaPeriod={QUICK_EMA_PERIOD}
                cumulativePnlScale="pnlFromZero"
                chartTimeMode="compareProgress"
                compareProgressEquityPointCount={resultLong.equityCurve.length}
                showFooterHint={false}
                bollingerToggle
              />
            </>
          ) : null}
          {resultShort?.equityCurve?.length > 1 ? (
            <>
              <h3 className="hourly-spikes-h3" style={{ marginTop: '1.25rem' }}>
                Agent 3 — stacked cumulative % candles + EMA({QUICK_EMA_PERIOD})
              </h3>
              <SpikeTpSlPerTradeCandleLightChart
                perTradePricePctChron={resultShort.perTradePricePctChron}
                tradesFallback={resultShort.trades}
                totalTradeRows={resultShort.totalTradeRows}
                serverSubsampled={Boolean(resultShort.perTradePricePctSubsampled)}
                emaPeriod={QUICK_EMA_PERIOD}
                cumulativePnlScale="pnlFromZero"
                chartTimeMode="compareProgress"
                compareProgressEquityPointCount={resultShort.equityCurve.length}
                showFooterHint={false}
                bollingerToggle
              />
            </>
          ) : null}
          {resultAgent4?.equityCurve?.length > 1 ? (
            <>
              <h3 className="hourly-spikes-h3" style={{ marginTop: '1.25rem' }}>
                Agent 4 — stacked cumulative % candles + EMA({QUICK_EMA_PERIOD})
              </h3>
              <SpikeTpSlPerTradeCandleLightChart
                perTradePricePctChron={resultAgent4.perTradePricePctChron}
                tradesFallback={resultAgent4.trades}
                totalTradeRows={resultAgent4.totalTradeRows}
                serverSubsampled={Boolean(resultAgent4.perTradePricePctSubsampled)}
                emaPeriod={QUICK_EMA_PERIOD}
                cumulativePnlScale="pnlFromZero"
                chartTimeMode="compareProgress"
                compareProgressEquityPointCount={resultAgent4.equityCurve.length}
                showFooterHint={false}
                bollingerToggle
              />
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
