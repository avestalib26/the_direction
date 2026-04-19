import { useCallback, useMemo, useState } from 'react'
import {
  computeEquityEmaFilterStats,
  computePerTradeSubsampleStats,
  normalizeEquityEmaPeriod,
} from './equityEmaInteractiveFilter.js'
import { SpikeTpSlEquityLightChart } from './spikeTpSlLightweightCharts.jsx'

const INTERVAL_OPTIONS = [
  { value: '1m', label: '1m' },
  { value: '3m', label: '3m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
  { value: '1h', label: '1h' },
  { value: '4h', label: '4h' },
]

const MAX_CANDLES = 20000
const PROGRESS_CAP = 48
/** Fixed EMA period on stacked equity (matches API `equityEmaSlow: 50`). */
const QUICK_EMA_PERIOD = 50

function fmtInt(n) {
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

function pushProgress(setLog, line) {
  setLog((prev) => {
    const next = [...prev, `${new Date().toLocaleTimeString()} ${line}`]
    return next.length > PROGRESS_CAP ? next.slice(-PROGRESS_CAP) : next
  })
}

async function consumeQuickBacktestStream(query, onEvent) {
  const res = await fetch(`/api/binance/spike-tpsl-quick-backtest/stream?${query}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(t || `HTTP ${res.status}`)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')
  const dec = new TextDecoder()
  let buf = ''
  let last = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    for (;;) {
      const sep = buf.indexOf('\n\n')
      if (sep < 0) break
      const block = buf.slice(0, sep).trim()
      buf = buf.slice(sep + 2)
      const dataLine = block
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      const json = dataLine.replace(/^data:\s?/, '')
      const obj = JSON.parse(json)
      last = obj
      onEvent(obj)
    }
  }
  return last
}

export function AgentStrategiesQuickBacktest() {
  const [minQuoteVolume24h, setMinQuoteVolume24h] = useState('1000000')
  const [interval, setInterval] = useState('5m')
  const [thresholdPct, setThresholdPct] = useState('3')
  const [strategy, setStrategy] = useState('long')
  const [candleCount, setCandleCount] = useState('8000')
  const [tpR, setTpR] = useState('2')
  const [maxSymbols, setMaxSymbols] = useState('120')
  /** When on: EMA stats + filtered cumulative chart use cumulative &gt; EMA(50) at entry (server flags). */
  const [equityEmaStatsFilterOn, setEquityEmaStatsFilterOn] = useState(true)

  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [progressLog, setProgressLog] = useState([])

  const equityEmaPeriodNum = useMemo(() => normalizeEquityEmaPeriod(QUICK_EMA_PERIOD), [])

  const equityEmaStats = useMemo(() => {
    const pcts = result?.perTradePricePctChron
    const r = result?.perTradeRChron
    if (!Array.isArray(pcts) || !Array.isArray(r) || pcts.length === 0 || r.length !== pcts.length) {
      return null
    }
    const oc = result?.perTradeOutcomeChron
    const outcomes = Array.isArray(oc) && oc.length === pcts.length ? oc : null
    if (equityEmaStatsFilterOn) {
      const entryOk = result?.perTradeEquityEmaAtEntryOk
      return computeEquityEmaFilterStats(
        pcts,
        r,
        outcomes,
        equityEmaPeriodNum,
        Array.isArray(entryOk) && entryOk.length === pcts.length ? entryOk : null,
      )
    }
    return computePerTradeSubsampleStats(pcts, r, outcomes)
  }, [result, equityEmaStatsFilterOn, equityEmaPeriodNum])

  const equityEmaInteractiveCurvePoints = useMemo(() => {
    const serverFiltered = result?.equityEmaFilteredCurve
    if (
      equityEmaStatsFilterOn &&
      Array.isArray(serverFiltered) &&
      serverFiltered.length > 1
    ) {
      return serverFiltered
    }
    return result?.equityCurve?.length > 1 ? result.equityCurve : null
  }, [result, equityEmaStatsFilterOn])

  const equityEmaInteractiveBaseline = useMemo(() => {
    if (!equityEmaStatsFilterOn || !result?.equityCurve) return undefined
    return result.equityCurve
  }, [equityEmaStatsFilterOn, result?.equityCurve])

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    setProgressLog([])
    try {
      const vol = Number.parseFloat(String(minQuoteVolume24h).replace(/,/g, ''))
      const th = Number.parseFloat(String(thresholdPct))
      const n = Number.parseInt(String(candleCount).replace(/,/g, ''), 10)
      const tp = Number.parseFloat(String(tpR).replace(/,/g, ''))
      const maxSym = Number.parseInt(String(maxSymbols).trim(), 10)

      if (!Number.isFinite(vol) || vol < 0) throw new Error('Volume must be >= 0')
      if (!Number.isFinite(th) || th <= 0) throw new Error('Threshold must be > 0')
      if (!Number.isFinite(n) || n < 50 || n > MAX_CANDLES) {
        throw new Error(`Candles must be 50–${MAX_CANDLES}`)
      }

      const q = new URLSearchParams({
        minQuoteVolume24h: String(vol),
        interval,
        candleCount: String(n),
        thresholdPct: String(th),
        strategy,
        equityEmaSlow: '50',
      })
      if (Number.isFinite(tp) && tp > 0) q.set('tpR', String(tp))
      if (Number.isFinite(maxSym) && maxSym >= 10) q.set('maxSymbols', String(Math.min(300, maxSym)))

      await consumeQuickBacktestStream(q, (evt) => {
        if (evt.event === 'progress') {
          if (evt.phase === 'volumes') {
            pushProgress(
              setProgressLog,
              `Universe: ${evt.symbolsQualified ?? '—'} pass volume; running ${evt.symbolsSelected ?? '—'} symbols × ${evt.candlesRequested ?? '—'} bars (extended=${evt.extendedCandles ? 'yes' : 'no'})`,
            )
          } else if (evt.phase === 'symbol') {
            const extra = evt.error ? ` — ${evt.error}` : ''
            pushProgress(
              setProgressLog,
              `[${evt.index}/${evt.total}] ${evt.symbol}: ${evt.candlesFetched}/${evt.candlesRequested} bars${extra}`,
            )
          } else if (evt.phase === 'aggregate') {
            pushProgress(setProgressLog, 'Aggregating trades & equity…')
          }
        } else if (evt.event === 'done') {
          setResult(evt.result)
          pushProgress(setProgressLog, 'Done.')
        } else if (evt.event === 'error') {
          throw new Error(evt.message || 'Backtest error')
        }
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setRunning(false)
    }
  }, [
    minQuoteVolume24h,
    interval,
    thresholdPct,
    strategy,
    candleCount,
    tpR,
    maxSymbols,
  ])

  const s = result?.summary

  return (
    <div className="vol-screener spike-tpsl-bt">
      <h1 className="vol-screener-title">Agent strategies — quick backtest</h1>
      <p className="vol-screener-lead">
        Same engine as <strong>Spike 2R backtest</strong>, stripped down for speed:{' '}
        <strong>Agent 1</strong> = long on green spikes; <strong>Agent 3</strong> = short on red spikes. Up to{' '}
        <strong>{MAX_CANDLES.toLocaleString()}</strong> bars per symbol (paginated from Binance). Symbols with shorter
        history use what is available (no error). Volume filter uses <strong>current</strong> 24h quote volume.
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
          <span className="backtest1-label">Strategy</span>
          <select
            className="backtest1-input"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            disabled={running}
          >
            <option value="long">Agent 1 — long (green spike)</option>
            <option value="short_red_spike">Agent 3 — short (red spike)</option>
          </select>
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Candles per symbol (max {MAX_CANDLES.toLocaleString()})</span>
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
        <button type="button" className="backtest1-btn" onClick={run} disabled={running}>
          {running ? 'Running…' : 'Run backtest'}
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
            maxHeight: 220,
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

      {s && result ? (
        <>
          <section className="hourly-spikes-section">
            <h2 className="hourly-spikes-h2">Summary</h2>
            <div className="backtest1-summary-grid">
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Total trades</span>
                <span className="backtest1-stat-value">{s.totalTrades?.toLocaleString?.() ?? '—'}</span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Cumulative Σ price %</span>
                <span
                  className={`backtest1-stat-value ${(s.finalPnlPctFromStart ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                >
                  {s.finalPnlPctFromStart != null && Number.isFinite(s.finalPnlPctFromStart)
                    ? `${s.finalPnlPctFromStart >= 0 ? '+' : ''}${Number(s.finalPnlPctFromStart).toFixed(2)}%`
                    : '—'}
                </span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">TP / SL / EOD</span>
                <span className="backtest1-stat-value">
                  {s.tpHits ?? '—'} / {s.slHits ?? '—'} / {s.eodHits ?? '—'}
                </span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Symbols skipped (fetch / thin data)</span>
                <span className="backtest1-stat-value">{result.skipped?.toLocaleString?.() ?? '—'}</span>
              </div>
            </div>
          </section>

          {result.equityCurve && result.equityCurve.length > 1 ? (
            <section className="hourly-spikes-section">
              <h2 className="hourly-spikes-h2">Cumulative Σ price % (all trades)</h2>
              <p className="hourly-spikes-hint">
                Entry-time order; running sum of per-trade price %. Synthetic time axis. No per-symbol OHLC in quick
                mode.
              </p>
              <SpikeTpSlEquityLightChart points={result.equityCurve} showFootnote />
            </section>
          ) : null}

          {result.perTradeRChron?.length ? (
            <section className="hourly-spikes-section spike-tpsl-equity-ema-panel">
              <h2 className="hourly-spikes-h2 spike-tpsl-equity-ema-title">Equity EMA filter (EMA {QUICK_EMA_PERIOD})</h2>
              <p className="hourly-spikes-hint spike-tpsl-equity-ema-lead">
                Same rules as the main Spike 2R backtest: when <strong>on</strong>, only trades where stacked
                cumulative <strong>&gt; EMA</strong> at entry (server uses full trade list; chart may be downsampled).
              </p>
              <label className="vol-screener-field spike-tpsl-sl-open-toggle spike-tpsl-equity-ema-toggle">
                <input
                  type="checkbox"
                  checked={equityEmaStatsFilterOn}
                  onChange={(e) => setEquityEmaStatsFilterOn(e.target.checked)}
                />
                <span>
                  <strong>Equity EMA filter</strong> — off = subsample stats for all trades; on = cumulative &gt; EMA(50)
                  at entry.
                </span>
              </label>
              {equityEmaStats ? (
                <>
                  <div className="backtest1-summary-grid spike-tpsl-equity-ema-stats">
                    <div className="backtest1-stat">
                      <span className="backtest1-stat-label">Stats mode</span>
                      <span className="backtest1-stat-value">
                        {equityEmaStats.mode === 'filtered' ? 'Cumulative &gt; EMA' : 'All (subsample)'}
                      </span>
                    </div>
                    <div className="backtest1-stat">
                      <span className="backtest1-stat-label">EMA period</span>
                      <span className="backtest1-stat-value">
                        {equityEmaStats.emaPeriod != null && Number.isFinite(equityEmaStats.emaPeriod)
                          ? fmtInt(equityEmaStats.emaPeriod)
                          : '—'}
                      </span>
                    </div>
                    <div className="backtest1-stat">
                      <span className="backtest1-stat-label">Kept / skipped</span>
                      <span className="backtest1-stat-value">
                        {fmtInt(equityEmaStats.kept)} / {fmtInt(equityEmaStats.skipped)}
                      </span>
                    </div>
                    <div className="backtest1-stat">
                      <span className="backtest1-stat-label">Sum R</span>
                      <span
                        className={`backtest1-stat-value ${(equityEmaStats.sumR ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                      >
                        {equityEmaStats.sumR != null && Number.isFinite(equityEmaStats.sumR)
                          ? `${equityEmaStats.sumR.toFixed(2)}R`
                          : '—'}
                      </span>
                    </div>
                    <div className="backtest1-stat">
                      <span className="backtest1-stat-label">Avg R</span>
                      <span
                        className={`backtest1-stat-value ${(equityEmaStats.avgR ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                      >
                        {equityEmaStats.avgR != null && Number.isFinite(equityEmaStats.avgR)
                          ? `${equityEmaStats.avgR.toFixed(3)}R`
                          : '—'}
                      </span>
                    </div>
                    <div className="backtest1-stat">
                      <span className="backtest1-stat-label">Σ price %</span>
                      <span
                        className={`backtest1-stat-value ${(equityEmaStats.sumPnlPct ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                      >
                        {equityEmaStats.sumPnlPct != null && Number.isFinite(equityEmaStats.sumPnlPct)
                          ? `${equityEmaStats.sumPnlPct >= 0 ? '+' : ''}${equityEmaStats.sumPnlPct.toFixed(2)}%`
                          : '—'}
                      </span>
                    </div>
                    <div className="backtest1-stat">
                      <span className="backtest1-stat-label">End stack</span>
                      <span className="backtest1-stat-value">
                        {equityEmaStats.finalStackLevel != null && Number.isFinite(equityEmaStats.finalStackLevel)
                          ? equityEmaStats.finalStackLevel.toFixed(4)
                          : '—'}
                      </span>
                    </div>
                    <div className="backtest1-stat">
                      <span className="backtest1-stat-label">TP / SL / EOD</span>
                      <span className="backtest1-stat-value">
                        {fmtInt(equityEmaStats.tpHits)} / {fmtInt(equityEmaStats.slHits)} /{' '}
                        {fmtInt(equityEmaStats.eodHits)}
                      </span>
                    </div>
                    <div className="backtest1-stat">
                      <span className="backtest1-stat-label">TP / (TP+SL)</span>
                      <span className="backtest1-stat-value">
                        {equityEmaStats.winRateTpVsSlPct != null && Number.isFinite(equityEmaStats.winRateTpVsSlPct)
                          ? `${equityEmaStats.winRateTpVsSlPct.toFixed(1)}%`
                          : '—'}
                      </span>
                    </div>
                  </div>
                  {equityEmaInteractiveCurvePoints && equityEmaInteractiveCurvePoints.length > 1 ? (
                    <>
                      <h3 className="hourly-spikes-h3">Filtered vs all trades (cumulative Σ price %)</h3>
                      <p className="hourly-spikes-hint">
                        {equityEmaStats.mode === 'filtered' ? (
                          <>
                            <strong>Bold</strong>: filtered cumulative (server). <strong>Dim</strong>: all trades.
                          </>
                        ) : (
                          <>All-trades subsample curve (filter off).</>
                        )}
                      </p>
                      <SpikeTpSlEquityLightChart
                        points={equityEmaInteractiveCurvePoints}
                        baselinePoints={equityEmaInteractiveBaseline ?? undefined}
                      />
                    </>
                  ) : null}
                </>
              ) : (
                <p className="hourly-spikes-hint">No per-trade series in response.</p>
              )}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
