import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { EmotionsCharts } from './EmotionsCharts'
import {
  buildPsychologyModel,
  emptyPsychologyModel,
} from './psychology/psychologyEngine.js'
import { SESSION_GAP_MS } from './psychology/psychologyThresholds.js'

const FETCH_LIMIT = 1000
const LS_KEY = 'emotionsDashboardFilters'

async function fetchClosedPositions() {
  const q = new URLSearchParams({ limit: String(FETCH_LIMIT) })
  const res = await fetch(`/api/binance/closed-positions?${q}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function loadSavedFilters() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function saveFilters(v) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

function rangeToSinceMs(preset) {
  const now = Date.now()
  if (preset === '24h') return now - 24 * 3600000
  if (preset === '7d') return now - 7 * 86400000
  if (preset === '30d') return now - 30 * 86400000
  return null
}

/** Interprets saved gap: large numbers are usually ms mistaken for minutes. */
function normalizeSessionGapMinutes(raw) {
  if (raw == null || raw === '') return '90'
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw))
  if (!Number.isFinite(n) || n <= 0) return '90'
  if (n > 10080) {
    const asMin = n / 60000
    if (asMin >= 15 && asMin <= 10080) return String(Math.round(asMin))
  }
  return String(Math.min(10080, Math.max(15, Math.round(n))))
}

function avgGapSec(trades) {
  if (!trades || trades.length < 2) return null
  let s = 0
  for (let i = 1; i < trades.length; i++) {
    s += (trades[i].closedAt - trades[i - 1].closedAt) / 1000
  }
  return s / (trades.length - 1)
}

function fmtUtc(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function fmtMoney(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  return `${sign}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function riskPillClass(level) {
  if (level === 'low') return 'emotions-pill emotions-pill--ok'
  if (level === 'medium') return 'emotions-pill emotions-pill--warn'
  if (level === 'high') return 'emotions-pill emotions-pill--bad'
  return 'emotions-pill emotions-pill--extreme'
}

function modeClass(mode) {
  if (mode === 'Attack') return 'emotions-mode emotions-mode--attack'
  if (mode === 'Defense') return 'emotions-mode emotions-mode--defense'
  return 'emotions-mode emotions-mode--preserve'
}

export function Emotions() {
  const saved = loadSavedFilters()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [closes, setCloses] = useState([])
  const [fetchedAt, setFetchedAt] = useState(null)
  const [meta, setMeta] = useState(null)

  const [rangePreset, setRangePreset] = useState(saved?.rangePreset ?? 'all')
  const [symbolFilter, setSymbolFilter] = useState(saved?.symbolFilter ?? '')
  const [sessionGapMin, setSessionGapMin] = useState(() =>
    normalizeSessionGapMinutes(saved?.sessionGapMin),
  )
  const [stateFilter, setStateFilter] = useState('all')

  useEffect(() => {
    saveFilters({
      rangePreset,
      symbolFilter,
      sessionGapMin: Number.parseFloat(sessionGapMin) || 90,
    })
  }, [rangePreset, symbolFilter, sessionGapMin])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchClosedPositions()
      setCloses(data.closes ?? [])
      setFetchedAt(data.fetchedAt ?? null)
      setMeta({
        symbolsScanned: data.symbolsScanned,
        tradesPerSymbolLimit: data.tradesPerSymbolLimit,
        note: data.note,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
      setCloses([])
      setFetchedAt(null)
      setMeta(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const sinceMs = useMemo(() => rangeToSinceMs(rangePreset), [rangePreset])
  const gapMs = useMemo(() => {
    const n = Number.parseFloat(sessionGapMin)
    return Number.isFinite(n) && n > 0 ? n * 60 * 1000 : SESSION_GAP_MS
  }, [sessionGapMin])

  const { model, modelComputeError } = useMemo(() => {
    try {
      return {
        model: buildPsychologyModel(closes, {
          sinceMs: sinceMs ?? undefined,
          symbol: symbolFilter.trim() || undefined,
          sessionGapMs: gapMs,
        }),
        modelComputeError: null,
      }
    } catch (e) {
      console.error('[Emotions] buildPsychologyModel', e)
      return {
        model: emptyPsychologyModel(),
        modelComputeError: e instanceof Error ? e.message : String(e),
      }
    }
  }, [closes, sinceMs, symbolFilter, gapMs])

  const filteredTradeCount = model.trades?.length ?? 0

  const resetFilters = () => {
    setRangePreset('all')
    setSymbolFilter('')
    setSessionGapMin('90')
    setStateFilter('all')
    try {
      localStorage.removeItem(LS_KEY)
    } catch {
      /* ignore */
    }
  }

  const postPeak = useMemo(() => {
    const ep = model.equityPoints
    const tr = model.trades
    if (!ep?.length || !tr?.length) return null
    let maxI = 0
    let maxC = -Infinity
    for (let i = 0; i < ep.length; i++) {
      if (ep[i].cum > maxC) {
        maxC = ep[i].cum
        maxI = i
      }
    }
    const tPeak = ep[maxI].closedAt
    const after = tr.filter((t) => t.closedAt > tPeak)
    const before = tr.filter((t) => t.closedAt <= tPeak)
    if (after.length === 0) {
      return {
        atPeak: true,
        peakEquity: maxC,
        tradesAfter: 0,
        symsAfter: 0,
        avgGapAfter: null,
        avgGapBefore: avgGapSec(before),
      }
    }
    const symsAfter = new Set(after.map((t) => t.symbol)).size
    const symsBefore = new Set(before.map((t) => t.symbol)).size
    return {
      atPeak: false,
      peakEquity: maxC,
      peakTime: tPeak,
      tradesAfter: after.length,
      symsAfter,
      symsBefore,
      avgGapAfter: avgGapSec(after),
      avgGapBefore: avgGapSec(before),
      winRateAfter:
        after.filter((t) => t.realizedPnl > 0).length /
        Math.max(1, after.filter((t) => t.realizedPnl !== 0).length),
    }
  }, [model])

  const filteredSessions = useMemo(() => {
    const rows = model.sessionDetails ?? []
    if (stateFilter === 'all') return rows
    return rows.filter((r) =>
      r.stateLabel.toLowerCase().includes(stateFilter.toLowerCase()),
    )
  }, [model.sessionDetails, stateFilter])

  const [expanded, setExpanded] = useState(() => new Set())

  const toggleSession = (idx) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const exportJson = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            fetchedAt,
            filters: { rangePreset, symbolFilter, sessionGapMin: gapMs },
            model,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    )
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `emotions-dashboard-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const s = model?.summary

  return (
    <div className="emotions">
      <header className="emotions-header trade-history-header">
        <h1 className="title">Emotions</h1>
        <p className="subtitle emotions-intro">
          Behavioral cockpit from your <strong>closed USDT-M</strong> realizes (same
          feed as Trade history). Mode and scores infer <strong>drift vs your own
          baseline</strong> in this window — tune rules in{' '}
          <code className="inline-code">src/psychology/psychologyThresholds.js</code>.
        </p>
        {meta?.note && <p className="trade-history-note">{meta.note}</p>}
        <div className="emotions-toolbar">
          <button
            type="button"
            className="btn-refresh"
            onClick={load}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh data'}
          </button>
          <button type="button" className="btn-refresh emotions-export" onClick={exportJson}>
            Export JSON
          </button>
          <button type="button" className="btn-refresh emotions-reset" onClick={resetFilters}>
            Reset filters
          </button>
        </div>
      </header>

      <section className="emotions-controls" aria-label="Filters">
        <label className="emotions-field">
          <span className="emotions-field-label">Range</span>
          <select
            className="backtest1-input"
            value={rangePreset}
            onChange={(e) => setRangePreset(e.target.value)}
          >
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="all">All loaded</option>
          </select>
        </label>
        <label className="emotions-field">
          <span className="emotions-field-label">Symbol</span>
          <input
            className="backtest1-input"
            placeholder="e.g. BTCUSDT"
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value)}
          />
        </label>
        <label className="emotions-field">
          <span className="emotions-field-label">Session gap (min)</span>
          <input
            type="number"
            min={15}
            step={15}
            className="backtest1-input backtest1-input--narrow"
            value={sessionGapMin}
            onChange={(e) => setSessionGapMin(e.target.value)}
          />
        </label>
        <label className="emotions-field">
          <span className="emotions-field-label">Session table</span>
          <select
            className="backtest1-input"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
          >
            <option value="all">All states</option>
            <option value="calm">Calm</option>
            <option value="aggressive">Aggressive</option>
            <option value="recovery">Recovery</option>
            <option value="revenge">Revenge</option>
            <option value="overtrading">Overtrading</option>
            <option value="drift">Drift</option>
            <option value="tilt">Tilt</option>
          </select>
        </label>
      </section>

      {loading && !closes.length && (
        <p className="positions-status">Loading closed positions…</p>
      )}

      {loading && closes.length > 0 && (
        <p className="emotions-refreshing" role="status">
          Refreshing data…
        </p>
      )}

      {!error && !loading && (
        <div className="emotions-data-strip" role="status">
          <span>
            API closes: <strong>{closes.length}</strong>
          </span>
          <span>
            In view (after range + symbol): <strong>{filteredTradeCount}</strong>
          </span>
          <span>
            Range: <strong>{rangePreset}</strong>
            {symbolFilter.trim() ? (
              <>
                {' '}
                · Symbol: <strong>{symbolFilter.trim().toUpperCase()}</strong>
              </>
            ) : null}
          </span>
        </div>
      )}

      {modelComputeError && (
        <div className="positions-error emotions-compute-error" role="alert">
          <p className="positions-error-title">Analysis error (safe mode)</p>
          <p className="positions-error-msg">{modelComputeError}</p>
        </div>
      )}

      {error && (
        <div className="positions-error" role="alert">
          <p className="positions-error-title">Could not load history</p>
          <p className="positions-error-msg">{error}</p>
        </div>
      )}

      {!error && closes.length > 0 && (
        <p className="positions-meta">
          {fetchedAt && (
            <>
              Updated {new Date(fetchedAt).toLocaleString()} ·{' '}
            </>
          )}
          {closes.length} closes loaded (max {FETCH_LIMIT}) · symbols scanned{' '}
          {meta?.symbolsScanned ?? '—'}
        </p>
      )}

      {model.lowData && !model.empty && (
        <p className="emotions-warn" role="status">
          Thin sample — labels gain weight after more closes (see{' '}
          <code className="inline-code">MIN_CLOSES_FOR_FULL_MODEL</code> in thresholds).
        </p>
      )}

      {!model.empty && s != null && (
        <>
          <section className="emotions-summary-strip" aria-label="Current state">
            <div className={`emotions-summary-card emotions-summary-card--mode ${modeClass(s.mode)}`}>
              <span className="emotions-summary-k">Mode</span>
              <span className="emotions-summary-v">{s.mode}</span>
            </div>
            <div
              className="emotions-summary-card"
              title="Starts at 100; subtracts for drawdown tiers, bursts, recovery/overtrading signals (see psychologyScoreFrom in psychologyEngine.js)."
            >
              <span className="emotions-summary-k">Psychology</span>
              <span className="emotions-summary-v">
                {Number.isFinite(s.psychologyScore) ? Math.round(s.psychologyScore) : '—'}
              </span>
            </div>
            <div
              className="emotions-summary-card"
              title="Win rate vs older window, gap compression, burst penalty (executionQualityScore)."
            >
              <span className="emotions-summary-k">Execution Q</span>
              <span className="emotions-summary-v">
                {Number.isFinite(s.executionScore) ? Math.round(s.executionScore) : '—'}
              </span>
            </div>
            <div className="emotions-summary-card">
              <span className="emotions-summary-k">DD from peak</span>
              <span className="emotions-summary-v pnl-neg">
                {(s.drawdownFromPeak * 100).toFixed(1)}% ({fmtMoney(s.peakEquity - s.currentEquity)} USDT)
              </span>
            </div>
            <div className="emotions-summary-card">
              <span className="emotions-summary-k">Streak</span>
              <span className="emotions-summary-v">
                {s.streak.kind === 'loss'
                  ? `L${s.streak.n}`
                  : s.streak.kind === 'win'
                    ? `W${s.streak.n}`
                    : '—'}
              </span>
            </div>
            <div className="emotions-summary-card">
              <span className="emotions-summary-k">Recovery risk</span>
              <span className={riskPillClass(s.recoveryChasingRisk)}>
                {s.recoveryChasingRisk}
              </span>
            </div>
            <div className="emotions-summary-card">
              <span className="emotions-summary-k">Overtrading</span>
              <span className={riskPillClass(s.overtradingRisk)}>{s.overtradingRisk}</span>
            </div>
            <div className="emotions-summary-card">
              <span className="emotions-summary-k">Random entry</span>
              <span className={riskPillClass(s.randomEntryRisk)}>{s.randomEntryRisk}</span>
            </div>
            <div className="emotions-summary-card emotions-summary-card--wide">
              <span className="emotions-summary-k">Primary read</span>
              <span className="emotions-summary-v emotions-primary-read">{s.primaryBehavior}</span>
            </div>
          </section>

          <section className="emotions-panel emotions-engine" aria-labelledby="engine-heading">
            <h2 className="breadth-detail-title" id="engine-heading">
              Behavioral state engine
            </h2>
            <p className="emotions-engine-intro">
              Each close is scored for recovery, revenge, overtrading, random exploration, and
              same-side clusters. Sessions receive one <strong>primary</strong> label; the strip
              above shows your <strong>current composite</strong> read on the latest activity.
            </p>
            <ul className="emotions-taxonomy">
              <li>
                <strong>Calm / Selective</strong> — tempo and breadth near your median.
              </li>
              <li>
                <strong>Aggressive but Controlled</strong> — active but not drifting vs baseline.
              </li>
              <li>
                <strong>Recovery Chasing</strong> — underwater from peak + elevated rate.
              </li>
              <li>
                <strong>Revenge Trading</strong> — loss streak + compressed re-entry tempo.
              </li>
              <li>
                <strong>Overtrading</strong> — burst counts or sustained rate vs your norm.
              </li>
              <li>
                <strong>Execution Drift</strong> — correlated same-side bursts or breadth decay.
              </li>
              <li>
                <strong>Tilt / Shutdown Risk</strong> — stacked losses + hostile tempo.
              </li>
            </ul>
            {model.sessionDetails?.length > 0 && (
              <p className="emotions-engine-foot">
                Latest session label:{' '}
                <strong>
                  {model.sessionDetails[model.sessionDetails.length - 1].stateLabel}
                </strong>
              </p>
            )}
          </section>

          <section className="emotions-chart-section" aria-label="Equity and drawdown">
            <h2 className="breadth-detail-title">Equity &amp; drawdown</h2>
            <EmotionsCharts
              key={`${fetchedAt}-${rangePreset}-${symbolFilter}`}
              equityPoints={model.equityPoints}
              markers={model.markers}
            />
          </section>

          <section className="emotions-panel" aria-labelledby="why-heading">
            <h2 className="breadth-detail-title" id="why-heading">
              Why the dashboard thinks this
            </h2>
            <ul className="emotions-why-list">
              {model.explanations.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </section>

          {postPeak && !postPeak.atPeak && (
            <section className="emotions-panel emotions-panel--compare" aria-label="After peak">
              <h2 className="breadth-detail-title">What changed after the equity peak</h2>
              <p className="emotions-compare-body">
                Peak ≈ <strong>{fmtMoney(postPeak.peakEquity)} USDT</strong> at{' '}
                {fmtUtc(postPeak.peakTime)}. Since then:{' '}
                <strong>{postPeak.tradesAfter}</strong> closes,{' '}
                <strong>{postPeak.symsAfter}</strong> distinct symbols (vs{' '}
                {postPeak.symsBefore} before peak in window). Avg gap:{' '}
                {postPeak.avgGapAfter != null ? `${postPeak.avgGapAfter.toFixed(0)}s` : '—'} after vs{' '}
                {postPeak.avgGapBefore != null ? `${postPeak.avgGapBefore.toFixed(0)}s` : '—'} before.
                {postPeak.winRateAfter != null && (
                  <>
                    {' '}
                    Win rate after peak: <strong>{(postPeak.winRateAfter * 100).toFixed(0)}%</strong>.
                  </>
                )}
              </p>
            </section>
          )}

          <section className="emotions-panel" aria-labelledby="timeline-heading">
            <h2 className="breadth-detail-title" id="timeline-heading">
              State transition timeline
            </h2>
            <ol className="emotions-timeline">
              {model.timeline.map((ev, i) => (
                <li key={`${ev.chartTime}-${ev.kind}-${i}`} className="emotions-timeline-item">
                  <span className="emotions-timeline-time">{fmtUtc(ev.closedAt)}</span>
                  <span className={`emotions-timeline-kind emotions-timeline-kind--${ev.kind}`}>
                    {ev.kind}
                  </span>
                  <span className="emotions-timeline-label">{ev.label}</span>
                  <span className="emotions-timeline-detail">{ev.detail}</span>
                </li>
              ))}
            </ol>
          </section>

          <div className="emotions-two-col">
            <section className="emotions-panel" aria-label="Symbol behavior">
              <h2 className="breadth-detail-title">Symbol behavior</h2>
              {model.symbolPanel && (
                <>
                  <p className="emotions-metric-line">
                    Distinct symbols (last session):{' '}
                    <strong>{model.symbolPanel.distinctInLastSession}</strong>
                  </p>
                  <p className="emotions-metric-line">
                    New symbols after first loss (session):{' '}
                    <strong>{model.symbolPanel.newAfterLoss}</strong>
                  </p>
                  <p className="emotions-metric-line">
                    Concentration score (0 = scattered):{' '}
                    <strong>
                      {Number.isFinite(model.symbolPanel.concentrationVsRandom)
                        ? model.symbolPanel.concentrationVsRandom.toFixed(0)
                        : '—'}
                    </strong>
                  </p>
                  {model.symbolPanel.warning && (
                    <p className="emotions-warn-inline">{model.symbolPanel.warning}</p>
                  )}
                </>
              )}
            </section>

            <section className="emotions-panel" aria-label="Trade tempo">
              <h2 className="breadth-detail-title">Trade tempo</h2>
              {model.tempoPanel && (
                <>
                  <p className="emotions-metric-line">
                    Avg gap (all window):{' '}
                    <strong>
                      {model.tempoPanel.avgGapSecGlobal != null
                        ? `${model.tempoPanel.avgGapSecGlobal.toFixed(0)}s`
                        : '—'}
                    </strong>
                  </p>
                  <p className="emotions-metric-line">
                    Last gap:{' '}
                    <strong>
                      {model.tempoPanel.avgGapSecLast != null
                        ? `${model.tempoPanel.avgGapSecLast.toFixed(0)}s`
                        : '—'}
                    </strong>
                  </p>
                  <p className="emotions-metric-line">
                    Closes last 60m / 15m:{' '}
                    <strong>
                      {model.tempoPanel.tradesLast60m} / {model.tempoPanel.tradesLast15m}
                    </strong>
                  </p>
                  {model.tempoPanel.tradeRateVsBaselineInDrawdown != null && (
                    <p className="emotions-metric-line">
                      Trade rate vs your median session (in drawdown):{' '}
                      <strong>
                        {model.tempoPanel.tradeRateVsBaselineInDrawdown.toFixed(2)}×
                      </strong>
                    </p>
                  )}
                </>
              )}
            </section>
          </div>

          <section className="emotions-panel emotions-actions" aria-label="Actions">
            <h2 className="breadth-detail-title">Action panel</h2>
            <ul className="emotions-actions-list">
              {model.actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </section>

          <section className="trade-history-table-section" aria-label="Sessions">
            <h2 className="breadth-detail-title">Sessions</h2>
            <div className="table-wrap">
              <table className="positions-table emotions-session-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Start (UTC)</th>
                    <th>End</th>
                    <th>PnL</th>
                    <th>Trades</th>
                    <th>Win%</th>
                    <th>Symbols</th>
                    <th>State</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filteredSessions.map((row) => (
                    <Fragment key={row.index}>
                      <tr className="emotions-session-row">
                        <td className="cell-mono">{row.index + 1}</td>
                        <td className="cell-mono cell-time">{fmtUtc(row.startMs)}</td>
                        <td className="cell-mono cell-time">{fmtUtc(row.endMs)}</td>
                        <td
                          className={`cell-mono cell-pnl ${
                            row.netPnl >= 0 ? 'pnl-pos' : 'pnl-neg'
                          }`}
                        >
                          {fmtMoney(row.netPnl)}
                        </td>
                        <td className="cell-mono">{row.tradeCount}</td>
                        <td className="cell-mono">
                          {row.winRate != null ? `${(row.winRate * 100).toFixed(0)}%` : '—'}
                        </td>
                        <td className="cell-mono">{row.symbols.length}</td>
                        <td className="emotions-state-cell">{row.stateLabel}</td>
                        <td>
                          <button
                            type="button"
                            className="emotions-expand-btn"
                            onClick={() => toggleSession(row.index)}
                            aria-expanded={expanded.has(row.index)}
                          >
                            {expanded.has(row.index) ? 'Hide' : 'Details'}
                          </button>
                        </td>
                      </tr>
                      {expanded.has(row.index) && (
                        <tr className="emotions-session-detail-row">
                          <td colSpan={9}>
                            <div className="emotions-session-detail">
                              <p>
                                Max run-up (session): {fmtMoney(row.maxRunup)} · Max DD
                                (session): {fmtMoney(row.maxDrawdownSession)} · Avg gap:{' '}
                                {row.avgGapSec != null ? `${row.avgGapSec.toFixed(0)}s` : '—'}
                              </p>
                              <p>
                                New symbols after first loss: {row.newSymbolsAfterLoss} ·
                                Overtrade ratio vs baseline: {row.overtradeRatio.toFixed(2)}×
                              </p>
                              <p className="emotions-symbols-row">
                                Symbols:{' '}
                                {row.symbols.map((sym) => (
                                  <span key={sym} className="emotions-sym-pill">
                                    {sym}
                                  </span>
                                ))}
                              </p>
                              <p>
                                Best: {row.topWinningSymbol?.symbol} ({fmtMoney(row.topWinningSymbol?.pnl)}) ·
                                Worst: {row.topLosingSymbol?.symbol} ({fmtMoney(row.topLosingSymbol?.pnl)})
                              </p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {model.baseline && (
            <section className="emotions-panel emotions-baseline" aria-label="Baseline">
              <h2 className="breadth-detail-title">Your baseline (this window)</h2>
              <p className="emotions-baseline-grid">
                <span>Median trades / session: <strong>{model.baseline.medianTradesPerSession.toFixed(1)}</strong></span>
                <span>Median symbols / session: <strong>{model.baseline.medianSymbolsPerSession.toFixed(1)}</strong></span>
                <span>Median gap: <strong>{model.baseline.medianGapSec.toFixed(0)}s</strong></span>
                <span>Median trades when green: <strong>{model.baseline.medianTradesWhenProfitable.toFixed(1)}</strong></span>
              </p>
            </section>
          )}
        </>
      )}

      {!error && !loading && model.empty && (
        <div className="emotions-empty emotions-empty--prominent" role="status">
          <p className="positions-empty emotions-empty-title">
            {closes.length === 0
              ? 'No closed positions returned by the API (same limits as Trade history).'
              : 'No trades in the current view — filters removed every row.'}
          </p>
          {closes.length > 0 && (
            <p className="emotions-empty-hint">
              The API returned <strong>{closes.length}</strong> close(s), but{' '}
              <strong>none</strong> fall inside your date range and symbol filter. Use{' '}
              <strong>Reset filters</strong> or set <strong>Range → All loaded</strong> and clear{' '}
              <strong>Symbol</strong>.
            </p>
          )}
          {model.explanations?.[0] && (
            <p className="emotions-empty-note">{model.explanations[0]}</p>
          )}
        </div>
      )}
    </div>
  )
}
