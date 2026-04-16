import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
} from 'lightweight-charts'
import { synthTradeTime } from './spikeTpSlLightweightCharts.jsx'

const COL_BG = '#000000'
const COL_TEXT = '#e2e8f0'
const COL_GRID = '#1a1a1a'
const COL_LINE = '#38bdf8'
const COL_EMA = '#f59e0b'
const COL_FILTER = '#a78bfa'
const COL_POS = '#0ecb81'
const COL_NEG = '#f6465d'
const EMA_PERIOD_FIXED = 50

/** How often the UI pulls the snapshot (server sim still advances on each closed 5m bar). */
const LIVE_POLL_MS = 20000

function fmtIso(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString()
}

function fmtShortAgo(msOrIso) {
  if (msOrIso == null) return '—'
  const t = typeof msOrIso === 'number' ? msOrIso : Date.parse(String(msOrIso))
  if (!Number.isFinite(t)) return '—'
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 1) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

function fmtLocalTime(msOrIso) {
  if (msOrIso == null) return '—'
  const t = typeof msOrIso === 'number' ? msOrIso : Date.parse(String(msOrIso))
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleString()
}

function fmtPrice(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 10000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (abs >= 1) {
    return n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    })
  }
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 })
}

/** Fallback: synthetic x when no candle window. */
function curveToLineDataSynth(curve) {
  const out = [{ time: synthTradeTime(0), value: 0 }]
  if (!Array.isArray(curve) || curve.length === 0) {
    out.push({ time: synthTradeTime(1), value: 0 })
    return out
  }
  for (let i = 0; i < curve.length; i++) {
    const p = curve[i]
    const k = Number.isFinite(p.tradeIndex) ? p.tradeIndex : i + 1
    const v = Number(p.cumulativePnlPct)
    if (!Number.isFinite(v)) continue
    out.push({ time: synthTradeTime(k), value: v })
  }
  if (out.length < 2) out.push({ time: synthTradeTime(1), value: 0 })
  return out
}

function curveToLineDataUtc(curve, firstOpenTimeMs) {
  const toSec = (ms) => {
    const u = Math.floor(Number(ms) / 1000)
    return Number.isFinite(u) ? u : null
  }
  const used = new Set()
  const uniq = (t) => {
    let x = t
    while (used.has(x)) x += 1
    used.add(x)
    return x
  }
  const t0 = toSec(firstOpenTimeMs)
  if (t0 == null) return curveToLineDataSynth(curve)

  const out = [{ time: uniq(t0), value: 0 }]
  if (!Array.isArray(curve) || curve.length === 0) {
    out.push({ time: uniq(t0 + 300), value: 0 })
    return out
  }
  for (const p of curve) {
    const ts = toSec(p.time ?? p.exitOpenTime)
    if (ts == null) continue
    const v = Number(p.cumulativePnlPct)
    if (!Number.isFinite(v)) continue
    out.push({ time: uniq(ts), value: v })
  }
  if (out.length < 2) {
    out.push({ time: uniq(t0 + 300), value: out[out.length - 1].value })
  }
  return out
}

function emaOnValues(values, period) {
  const out = values.map(() => null)
  if (!Array.isArray(values) || values.length < period || period < 2) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += values[i]
  let ema = sum / period
  out[period - 1] = ema
  const alpha = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    ema = values[i] * alpha + ema * (1 - alpha)
    out[i] = ema
  }
  return out
}

function lineEmaData(lineData, period) {
  if (!Array.isArray(lineData) || lineData.length === 0) return null
  const vals = lineData.map((d) => Number(d.value))
  const emaArr = emaOnValues(vals, period)
  const out = []
  for (let i = 0; i < lineData.length; i++) {
    const v = emaArr[i]
    if (!Number.isFinite(v)) continue
    out.push({ time: lineData[i].time, value: v })
  }
  return out.length >= 2 ? out : null
}

function computeEmaFilteredClosedCurve(closedCurve, firstOpenTimeMs, period) {
  const src = curveToLineDataUtc(closedCurve, firstOpenTimeMs)
  const values = src.map((d) => Number(d.value))
  const emaArr = emaOnValues(values, period)
  const out = [{ time: src[0].time, value: 0 }]
  let sum = 0
  let kept = 0
  for (let i = 0; i < (closedCurve?.length ?? 0); i++) {
    // For trade i, compare "before trade" cumulative (src[i]) against EMA at same index.
    const before = values[i]
    const emaBefore = emaArr[i]
    const tradePnlPct = Number(closedCurve[i]?.pnlPct)
    const keep = Number.isFinite(before) && Number.isFinite(emaBefore) && before > emaBefore
    if (!keep || !Number.isFinite(tradePnlPct)) continue
    kept += 1
    sum += tradePnlPct
    const t = Math.floor(Number(closedCurve[i]?.time ?? closedCurve[i]?.exitOpenTime) / 1000)
    if (!Number.isFinite(t)) continue
    let tt = t
    while (out.some((x) => x.time === tt)) tt += 1
    out.push({ time: tt, value: sum })
  }
  if (out.length < 2) out.push({ time: out[0].time + 300, value: 0 })
  return { data: out, keptCount: kept, totalCount: closedCurve?.length ?? 0, sumPnlPct: sum }
}

function chartSize(el) {
  return Math.max(280, el.clientWidth || el.offsetWidth || 600)
}

/**
 * One candle per closed trade: Y = cumulative Σ price % (not $).
 * open = level before this trade’s close, close = after; high/low padded if flat (bodies-only style).
 */
function tradePctCandleRowsFromCurve(curve) {
  if (!Array.isArray(curve) || curve.length === 0) return []
  const used = new Set()
  const uniqSec = (ms) => {
    let s = Math.floor(Number(ms) / 1000)
    if (!Number.isFinite(s)) s = 0
    while (used.has(s)) s += 1
    used.add(s)
    return s
  }
  const rows = []
  const pad = 1e-4
  for (let i = 0; i < curve.length; i++) {
    const p = curve[i]
    const open = i === 0 ? 0 : Number(curve[i - 1].cumulativePnlPct)
    const close = Number(p.cumulativePnlPct)
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue
    let high = Math.max(open, close)
    let low = Math.min(open, close)
    if (!(high > low)) {
      high += pad
      low -= pad
    }
    const exitMs = p.time ?? p.exitOpenTime
    rows.push({
      time: uniqSec(exitMs),
      open,
      high,
      low,
      close,
    })
  }
  return rows
}

function SimTradePctCandleChart({ curve }) {
  const wrapRef = useRef(null)
  const rows = useMemo(() => tradePctCandleRowsFromCurve(curve), [curve])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el || rows.length === 0) return undefined

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: COL_BG },
        textColor: COL_TEXT,
        fontFamily: 'system-ui, Segoe UI, sans-serif',
      },
      grid: {
        vertLines: { color: COL_GRID },
        horzLines: { color: COL_GRID },
      },
      crosshair: { mode: CrosshairMode.Normal },
      width: chartSize(el),
      height: 320,
      timeScale: {
        borderColor: COL_GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: COL_GRID,
        scaleMargins: { top: 0.06, bottom: 0.06 },
      },
      localization: {
        priceFormatter: (x) =>
          `${Number(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}%`,
      },
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: COL_POS,
      downColor: COL_NEG,
      borderVisible: false,
      wickUpColor: COL_POS,
      wickDownColor: COL_NEG,
      wickVisible: false,
    })
    series.setData(rows)
    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => {
      if (el.isConnected) chart.applyOptions({ width: chartSize(el) })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [rows])

  if (rows.length === 0) {
    return <p className="hourly-spikes-hint">No closed trades yet — nothing to plot in %.</p>
  }

  return (
    <div
      ref={wrapRef}
      className="spike-tpsl-lw-chart longsim5m-chart"
      style={{ width: '100%', minHeight: 320, minWidth: 280 }}
    />
  )
}

function SimCurveChart({ lineData, emaData = null, lineColor = COL_LINE }) {
  const wrapRef = useRef(null)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el || !lineData?.length) return undefined

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: COL_BG },
        textColor: COL_TEXT,
        fontFamily: 'system-ui, Segoe UI, sans-serif',
      },
      grid: {
        vertLines: { color: COL_GRID },
        horzLines: { color: COL_GRID },
      },
      crosshair: { mode: CrosshairMode.Normal },
      width: chartSize(el),
      height: 320,
      timeScale: {
        borderColor: COL_GRID,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: COL_GRID,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      localization: {
        priceFormatter: (p) =>
          `${Number(p).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}%`,
      },
    })

    const series = chart.addSeries(LineSeries, {
      color: lineColor,
      lineWidth: 2,
      crosshairMarkerVisible: true,
      lastValueVisible: true,
      priceLineVisible: true,
    })
    series.setData(lineData)
    if (emaData && emaData.length >= 2) {
      const emaSeries = chart.addSeries(LineSeries, {
        color: COL_EMA,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        lastValueVisible: true,
        priceLineVisible: false,
      })
      emaSeries.setData(emaData)
    }
    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => {
      if (el.isConnected) chart.applyOptions({ width: chartSize(el) })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [lineData, emaData, lineColor])

  return (
    <div
      ref={wrapRef}
      className="spike-tpsl-lw-chart longsim5m-chart"
      style={{ width: '100%', minHeight: 320, minWidth: 280 }}
    />
  )
}

/** @typedef {'both' | 'candles' | 'curve'} LongSimChartMode */

export function LongSim5m() {
  const [payload, setPayload] = useState(null)
  const [error, setError] = useState('')
  const [simToggleBusy, setSimToggleBusy] = useState(false)
  /** Bumps once per second so "Xs ago" stays accurate without polling every second. */
  const [, bumpAgeDisplay] = useState(0)
  /** @type {[LongSimChartMode, (m: LongSimChartMode) => void]} */
  const [chartMode, setChartMode] = useState('both')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/agent1/shadow-curve', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
      setPayload(data)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load simulation')
    }
  }, [])

  const setSimulationPaused = useCallback(
    async (paused) => {
      if (payload?.shadowSchedulerActive === false) return
      setSimToggleBusy(true)
      try {
        const res = await fetch('/api/agents/agent1/shadow-simulation', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to update simulation')
      } finally {
        setSimToggleBusy(false)
      }
    },
    [load, payload?.shadowSchedulerActive],
  )

  useEffect(() => {
    load()
    const t = setInterval(load, LIVE_POLL_MS)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    const id = setInterval(() => bumpAgeDisplay((x) => x + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const sched = payload?.scheduler
  const shadowSchedulerActive = payload?.shadowSchedulerActive !== false
  const simulationPaused = payload?.simulationPaused === true
  const curve = payload?.curve
  const liveCurve = payload?.liveCurve
  const trades = payload?.trades
  const ongoingTrades = payload?.ongoingTrades
  const tradeN = Array.isArray(trades) ? trades.length : 0
  const ongoingN = Array.isArray(ongoingTrades) ? ongoingTrades.length : 0

  const lineStartMs = useMemo(() => {
    if (Array.isArray(trades) && trades.length > 0) {
      const t0 = trades[0].spikeOpenTime ?? trades[0].entryOpenTime
      if (Number.isFinite(t0)) return t0
    }
    if (Array.isArray(curve) && curve.length > 0) {
      const t0 = curve[0].spikeOpenTime ?? curve[0].entryOpenTime
      if (Number.isFinite(t0)) return t0
    }
    return null
  }, [trades, curve])

  const lineSource = Array.isArray(liveCurve) && liveCurve.length > 0 ? liveCurve : curve
  const lineData = useMemo(() => curveToLineDataUtc(lineSource, lineStartMs), [lineSource, lineStartMs])
  const emaPeriod = EMA_PERIOD_FIXED
  const emaData = useMemo(() => lineEmaData(lineData, emaPeriod), [lineData, emaPeriod])
  const emaFiltered = useMemo(
    () => computeEmaFilteredClosedCurve(curve, lineStartMs, emaPeriod),
    [curve, lineStartMs, emaPeriod],
  )

  const latestCum = lineData.length ? Number(lineData[lineData.length - 1]?.value) : null
  const latestEma = emaData?.length ? Number(emaData[emaData.length - 1]?.value) : null
  const isAboveEma =
    Number.isFinite(latestCum) && Number.isFinite(latestEma)
      ? latestCum > latestEma
      : null

  const totalUnrealizedPct = useMemo(() => {
    let s = 0
    let seen = 0
    for (const t of ongoingTrades ?? []) {
      const v = Number(t?.pnlPct)
      if (!Number.isFinite(v)) continue
      s += v
      seen += 1
    }
    return seen > 0 ? s : null
  }, [ongoingTrades])

  const totalUnrealizedR = useMemo(() => {
    let s = 0
    let seen = 0
    for (const t of ongoingTrades ?? []) {
      const v = Number(t?.rMultiple)
      if (!Number.isFinite(v)) continue
      s += v
      seen += 1
    }
    return seen > 0 ? s : null
  }, [ongoingTrades])

  const showCandles = chartMode === 'both' || chartMode === 'candles'
  const showCurve = chartMode === 'both' || chartMode === 'curve'

  return (
    <div className="vol-screener agent1-page longsim5m-page">
      {sched ? (
        <div className="risk-summary agent1-risk-summary longsim5m-status">
          <div className="risk-chip">
            Tick: <strong>{sched.running ? '…' : sched.lastRunAt ? 'idle' : 'start'}</strong>
          </div>
          <div className="risk-chip">
            Next: <strong>{fmtIso(sched.nextFireAt)}</strong>
          </div>
          {simulationPaused && shadowSchedulerActive ? (
            <div className="risk-chip" style={{ color: '#fbbf24' }} title="Full replay and mark polls are paused; last curve is frozen.">
              Simulation paused
            </div>
          ) : null}
          {!shadowSchedulerActive ? (
            <div className="risk-chip muted" title="Enable AGENT1_SHADOW_SCHEDULER on the API (not false) and restart.">
              Scheduler off in config
            </div>
          ) : null}
          {sched.lastError ? (
            <div className="risk-chip" style={{ color: '#f87171' }}>
              {sched.lastError}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="longsim5m-toolbar">
        <div className="longsim5m-meta">
          {shadowSchedulerActive ? (
            <>
              <button
                type="button"
                className={`btn-refresh longsim5m-sim-toggle ${simulationPaused ? 'longsim5m-sim-toggle--paused' : ''}`}
                disabled={simToggleBusy}
                onClick={() => void setSimulationPaused(!simulationPaused)}
                title={
                  simulationPaused
                    ? 'Resume full market replay and mark-to-market polls'
                    : 'Stop simulation: no new Binance kline replay or mark updates until resumed'
                }
              >
                {simToggleBusy ? '…' : simulationPaused ? 'Resume simulation' : 'Stop simulation'}
              </button>
              <span className="longsim5m-meta-sep" aria-hidden>
                ·
              </span>
            </>
          ) : null}
          <span className="longsim5m-live" title="UI polls every few seconds; curve changes when the server finishes a sim step (each closed 5m bar).">
            <span className="longsim5m-live-dot" aria-hidden />
            Live
          </span>
          <span className="longsim5m-meta-sep">·</span>
          {payload?.mode === 'market' ? (
            <span title="24h volume-ranked USDT perps; min volume & max symbols match Agent 1 scan settings.">
              Market{' '}
              <strong>{payload.universe?.symbolsWithData ?? '—'}</strong>
              /{payload.universe?.symbolsRequested ?? '—'}
              {payload.universe?.symbolsErrored > 0 ? (
                <span className="longsim5m-meta-muted">
                  {' '}
                  ({payload.universe.symbolsErrored} err)
                </span>
              ) : null}
            </span>
          ) : (
            <span className="cell-mono">{payload?.symbol ?? '—'}</span>
          )}
          <span className="longsim5m-meta-sep">·</span>
          <span>{payload?.barCount ?? '—'} bars/sym</span>
          <span className="longsim5m-meta-sep">·</span>
          <span title="24h quote-volume floor for tradable symbols in this simulation">
            min vol{' '}
            <strong>
              {Number.isFinite(Number(payload?.settingsMeta?.effectiveMinQuoteVolume))
                ? `${(Number(payload.settingsMeta.effectiveMinQuoteVolume) / 1_000_000).toFixed(0)}M`
                : '10M'}
            </strong>
          </span>
          <span className="longsim5m-meta-sep">·</span>
          <span>{tradeN} closes</span>
          <span className="longsim5m-meta-sep">·</span>
          <span>{ongoingN} open</span>
          <span className="longsim5m-meta-sep">·</span>
          <span className="longsim5m-meta-muted" title="Server snapshot time (ISO)">
            live {fmtShortAgo(payload?.updatedAt)}
          </span>
        </div>
        <div className="longsim5m-chart-toggle">
          <span className="longsim5m-ema-fixed">EMA {EMA_PERIOD_FIXED} (fixed)</span>
          <div className="longsim5m-chart-toggle-buttons" role="group" aria-label="Chart view">
            {[
              { id: 'both', label: 'Both' },
              { id: 'candles', label: 'Trades %' },
              { id: 'curve', label: 'Curve' },
            ].map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`longsim5m-toggle-btn ${chartMode === id ? 'longsim5m-toggle-btn--on' : ''}`}
                onClick={() => setChartMode(/** @type {LongSimChartMode} */ (id))}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? (
        <div className="positions-error" role="alert" style={{ marginTop: '0.75rem' }}>
          <p className="positions-error-msg">{error}</p>
        </div>
      ) : null}

      {showCandles ? (
        <section className="longsim5m-chart-block" aria-label="Trade PnL candles">
          <h3 className="longsim5m-chart-label">Trades (cumulative Σ price %)</h3>
          <p className="hourly-spikes-hint longsim5m-chart-hint">
            Bars follow the same cumulative series as the line (global merged stream across symbols). Final bar
            includes the open-trade live mark when present.
          </p>
          <SimTradePctCandleChart curve={lineSource} />
        </section>
      ) : null}

      {showCurve ? (
        <section className="longsim5m-chart-block" aria-label="Cumulative PnL">
          <h3 className="longsim5m-chart-label">Cumulative PnL % (closed + open mark)</h3>
          <p className="hourly-spikes-hint longsim5m-chart-hint">
            Cyan = cumulative %, amber = EMA({emaPeriod}). Gate = cumulative &gt; EMA. Current state:{' '}
            <strong
              className={
                isAboveEma == null ? '' : isAboveEma ? 'pnl-pos' : 'pnl-neg'
              }
            >
              {isAboveEma == null ? 'warming up' : isAboveEma ? 'above EMA' : 'below EMA'}
            </strong>
            .
          </p>
          <SimCurveChart lineData={lineData} emaData={emaData} />
        </section>
      ) : null}

      <section className="longsim5m-chart-block" aria-label="EMA rule realized curve">
        <h3 className="longsim5m-chart-label">Realized curve after EMA rule</h3>
        <p className="hourly-spikes-hint longsim5m-chart-hint">
          Keep closed trade i only when cumulative before trade i is above EMA({emaPeriod}).
        </p>
        <div className="risk-summary longsim5m-filter-summary">
          <div className="risk-chip">
            EMA-above closes: <strong>{emaFiltered.keptCount}</strong> / {emaFiltered.totalCount}
          </div>
          <div className="risk-chip">
            Realized % (filtered):{' '}
            <strong className={emaFiltered.sumPnlPct >= 0 ? 'pnl-pos' : 'pnl-neg'}>
              {emaFiltered.sumPnlPct >= 0 ? '+' : ''}
              {emaFiltered.sumPnlPct.toFixed(3)}%
            </strong>
          </div>
        </div>
        <SimCurveChart lineData={emaFiltered.data} lineColor={COL_FILTER} />
      </section>

      {ongoingN > 0 ? (
        <>
          <h3 className="vol-screener-title agent1-section-title">Ongoing trades (live mark)</h3>
          <div className="risk-summary longsim5m-filter-summary">
            <div className="risk-chip">
              Total unrealized %:{' '}
              <strong className={Number(totalUnrealizedPct) >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                {Number.isFinite(Number(totalUnrealizedPct))
                  ? `${Number(totalUnrealizedPct) >= 0 ? '+' : ''}${Number(totalUnrealizedPct).toFixed(3)}%`
                  : '—'}
              </strong>
            </div>
            <div className="risk-chip">
              Total unrealized R:{' '}
              <strong className={Number(totalUnrealizedR) >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                {Number.isFinite(Number(totalUnrealizedR))
                  ? `${Number(totalUnrealizedR) >= 0 ? '+' : ''}${Number(totalUnrealizedR).toFixed(3)}`
                  : '—'}
              </strong>
            </div>
          </div>
          <div className="table-wrap agent1-spikes-wrap">
            <table className="positions-table agent1-spikes-table">
              <thead>
                <tr>
                  <th>Sym</th>
                  <th>Entry time</th>
                  <th>Entry price</th>
                  <th>Mark (bar close)</th>
                  <th>Unrealized %</th>
                  <th>R (mark)</th>
                </tr>
              </thead>
              <tbody>
                {ongoingTrades.map((t, idx) => (
                  <tr key={`open-${t.symbol ?? ''}-${t.entryOpenTime}-${idx}`}>
                    <td className="cell-mono">{t.symbol ?? '—'}</td>
                    <td className="cell-mono">{fmtLocalTime(t.entryOpenTime)}</td>
                    <td className="cell-mono">{fmtPrice(t.entryPrice)}</td>
                    <td className="cell-mono">{fmtLocalTime(t.exitOpenTime)}</td>
                    <td className={`cell-mono ${Number(t.pnlPct) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
                      {Number.isFinite(Number(t.pnlPct))
                        ? `${Number(t.pnlPct) >= 0 ? '+' : ''}${Number(t.pnlPct).toFixed(3)}%`
                        : '—'}
                    </td>
                    <td className={`cell-mono ${Number(t.rMultiple) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
                      {Number.isFinite(Number(t.rMultiple))
                        ? `${Number(t.rMultiple) >= 0 ? '+' : ''}${Number(t.rMultiple).toFixed(3)}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tradeN > 0 ? (
        <>
          <h3 className="vol-screener-title agent1-section-title">Closed trades</h3>
          <div className="table-wrap agent1-spikes-wrap">
            <table className="positions-table agent1-spikes-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Sym</th>
                  <th>Spike O</th>
                  <th>Entry O</th>
                  <th>Exit O</th>
                  <th>Outcome</th>
                  <th>R</th>
                  <th>Entry</th>
                  <th>Exit</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, idx) => (
                  <tr key={`${t.symbol ?? ''}-${t.entryOpenTime}-${t.spikeOpenTime}-${idx}`}>
                    <td>{idx + 1}</td>
                    <td className="cell-mono">{t.symbol ?? '—'}</td>
                    <td className="cell-mono">{t.spikeOpenTime}</td>
                    <td className="cell-mono">{t.entryOpenTime}</td>
                    <td className="cell-mono">{t.exitOpenTime}</td>
                    <td>{t.outcome}</td>
                    <td className="cell-mono">
                      {t.rMultiple != null && Number.isFinite(t.rMultiple) ? t.rMultiple.toFixed(3) : '—'}
                    </td>
                    <td className="cell-mono">{t.entryPrice}</td>
                    <td className="cell-mono">{t.exitPrice}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  )
}
