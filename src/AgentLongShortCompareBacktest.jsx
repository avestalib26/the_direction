import { useCallback, useMemo, useState } from 'react'
import {
  SpikeTpSlAccountBalanceLightChart,
  SpikeTpSlCompareEquityChart,
  SpikeTpSlPerTradeCandleLightChart,
  compareProgressSynthTimeFromPointIndex,
} from './spikeTpSlLightweightCharts.jsx'
import { simulateAccountBalanceFromTradePcts } from './accountLeverageSim.js'
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

/**
 * Build chart line + sim meta from quick backtest result; x-axis aligned with compare/candle progress.
 */
function buildAccountSimForResult(result, startingBalanceStr, tradeSizePctStr, leverageStr) {
  if (!result?.perTradePricePctChron?.length || !result.equityCurve?.length || result.equityCurve.length < 2) {
    return null
  }
  const startingBalance = Number.parseFloat(String(startingBalanceStr).replace(/,/g, ''))
  const tradeSizePct = Number.parseFloat(String(tradeSizePctStr).replace(/,/g, ''))
  const leverage = Number.parseFloat(String(leverageStr).replace(/,/g, ''))
  const pcts = result.perTradePricePctChron.map((x) => {
    const v = Number(x)
    return Number.isFinite(v) ? v : 0
  })
  const sim = simulateAccountBalanceFromTradePcts({
    startingBalance,
    tradeSizePct,
    leverage,
    perTradePricePcts: pcts,
  })
  if (!sim) return null
  const nEq = Math.max(2, Math.floor(result.equityCurve.length))
  const points = sim.points.map((p) => ({
    time: compareProgressSynthTimeFromPointIndex(p.tradeIndex, nEq),
    value: p.balance,
  }))
  return { sim, points, subsampled: Boolean(result.perTradePricePctSubsampled) }
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
  const [progressLog, setProgressLog] = useState([])

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    setResultLong(null)
    setResultShort(null)
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
              `[short ${evt.index}/${evt.total}] ${evt.symbol}: ${evt.candlesFetched}/${evt.candlesRequested} bars${extra}`,
            )
          } else if (evt.phase === 'aggregate') {
            pushProgress(setProgressLog, 'Short: aggregating trades & equity…')
          }
        } else if (evt.event === 'done') {
          setResultShort(evt.result)
          pushProgress(setProgressLog, 'Short run done. Compare chart ready.')
        } else if (evt.event === 'error') {
          throw new Error(evt.message || 'Short backtest error')
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
  const showSummary = Boolean(sLong || sShort)

  const accountSimLong = useMemo(
    () => buildAccountSimForResult(resultLong, startingBalance, tradeSizePct, leverage),
    [resultLong, startingBalance, tradeSizePct, leverage],
  )
  const accountSimShort = useMemo(
    () => buildAccountSimForResult(resultShort, startingBalance, tradeSizePct, leverage),
    [resultShort, startingBalance, tradeSizePct, leverage],
  )

  return (
    <div className="vol-screener spike-tpsl-bt">
      <h1 className="vol-screener-title">Long / short simulation</h1>
      <p className="vol-screener-lead">
        One click runs the <strong>same</strong> quick backtest twice: <strong>Agent 1</strong> (long on green spikes) and{' '}
        <strong>Agent 3</strong> (short on red spikes). The chart overlays both cumulative Σ price % curves so you can
        compare which side fits your regime.
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
          Account simulation (applies after run; uses per-trade % returns chronologically)
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
          {running ? 'Running long + short…' : 'Run long & short comparison'}
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
          <h2 className="hourly-spikes-h2">Results — long vs short</h2>
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
        </section>
      ) : null}

      {accountSimLong || accountSimShort ? (
        <section className="hourly-spikes-section">
          <h2 className="hourly-spikes-h2">Simulated account balance</h2>
          <p className="hourly-spikes-hint" style={{ marginBottom: '0.75rem' }}>
            <strong>Sequential trades:</strong> each row is one <strong>closed</strong> trade; we book P&amp;L, then the
            next trade may use margin from the new balance (as if the prior position closed before the next opens — so
            100% size does not stack two open positions in this toy model). If balance falls to 0 or below, margin is 0,
            so <strong>no further trades</strong> get exposure (those steps add 0 P&amp;L). Each trade:{' '}
            <strong>margin</strong> = max(balance, 0) × (trade size % ÷ 100), <strong>notional</strong> = margin ×
            leverage, <strong>PnL USDT</strong> = notional × (per-trade price % ÷ 100). X-axis matches normalized run
            progress (same as charts below).
            {(accountSimLong?.subsampled || accountSimShort?.subsampled) && (
              <>
                {' '}
                <strong>Note:</strong> per-trade series was subsampled for the payload — simulation is approximate when
                trade count is very large.
              </>
            )}
          </p>
          {accountSimLong ? (
            <>
              <h3 className="hourly-spikes-h3" style={{ marginTop: 0 }}>
                Agent 1 — long
              </h3>
              <div className="backtest1-summary-grid" style={{ marginBottom: '0.5rem' }}>
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">Final balance</span>
                  <span
                    className={`backtest1-stat-value ${
                      accountSimLong.sim.finalBalance >= accountSimLong.sim.startingBalance ? 'pnl-pos' : 'pnl-neg'
                    }`}
                  >
                    {fmtUsd2(accountSimLong.sim.finalBalance)}
                  </span>
                </div>
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">Max drawdown (balance)</span>
                  <span className="backtest1-stat-value pnl-neg">{fmtUsd2(accountSimLong.sim.maxDrawdownUsd)}</span>
                </div>
                {accountSimLong.sim.tradesSkippedNoFreeMargin > 0 ? (
                  <div className="backtest1-stat">
                    <span className="backtest1-stat-label">Trades skipped (no free margin)</span>
                    <span className="backtest1-stat-value">
                      {accountSimLong.sim.tradesSkippedNoFreeMargin.toLocaleString()}
                    </span>
                  </div>
                ) : null}
              </div>
              <SpikeTpSlAccountBalanceLightChart points={accountSimLong.points} showFootnote={false} />
            </>
          ) : null}
          {accountSimShort ? (
            <>
              <h3 className="hourly-spikes-h3" style={{ marginTop: accountSimLong ? '1.25rem' : 0 }}>
                Agent 3 — short
              </h3>
              <div className="backtest1-summary-grid" style={{ marginBottom: '0.5rem' }}>
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">Final balance</span>
                  <span
                    className={`backtest1-stat-value ${
                      accountSimShort.sim.finalBalance >= accountSimShort.sim.startingBalance ? 'pnl-pos' : 'pnl-neg'
                    }`}
                  >
                    {fmtUsd2(accountSimShort.sim.finalBalance)}
                  </span>
                </div>
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">Max drawdown (balance)</span>
                  <span className="backtest1-stat-value pnl-neg">{fmtUsd2(accountSimShort.sim.maxDrawdownUsd)}</span>
                </div>
                {accountSimShort.sim.tradesSkippedNoFreeMargin > 0 ? (
                  <div className="backtest1-stat">
                    <span className="backtest1-stat-label">Trades skipped (no free margin)</span>
                    <span className="backtest1-stat-value">
                      {accountSimShort.sim.tradesSkippedNoFreeMargin.toLocaleString()}
                    </span>
                  </div>
                ) : null}
              </div>
              <SpikeTpSlAccountBalanceLightChart points={accountSimShort.points} showFootnote={false} />
            </>
          ) : null}
          <p className="hourly-spikes-hint" style={{ marginTop: '0.75rem' }}>
            Adjust starting balance, trade size %, and leverage above — charts update without re-running the backtest.
          </p>
        </section>
      ) : null}

      {resultLong?.equityCurve?.length > 1 || resultShort?.equityCurve?.length > 1 ? (
        <section className="hourly-spikes-section">
          <h2 className="hourly-spikes-h2">Cumulative Σ price % — long vs short</h2>
          <p className="hourly-spikes-hint">
            Candles use the same <strong>normalized progress</strong> time base as the compare line (per side). Each
            chart pans and zooms on its own.
          </p>
          <SpikeTpSlCompareEquityChart longPoints={resultLong?.equityCurve} shortPoints={resultShort?.equityCurve} />
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
        </section>
      ) : null}
    </div>
  )
}
