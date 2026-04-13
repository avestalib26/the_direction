import {
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
} from 'lightweight-charts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

async function fetchBacktest(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v != null) q.set(k, String(v))
  }
  const res = await fetch(`/api/binance/zone-hedge-backtest?${q}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

function ZoneHedgeEquityChart({ points }) {
  const ref = useRef(null)
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = () => setDark(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])

  useEffect(() => {
    if (!Array.isArray(points) || points.length === 0 || !ref.current) return
    const bg = dark ? '#1e2329' : '#ffffff'
    const text = dark ? '#b7bdc6' : '#474d57'
    const grid = dark ? '#2b3139' : '#eaecef'
    const used = new Set()
    const data = points.map((p) => {
      let t = Math.floor(p.openTime / 1000)
      while (used.has(t)) t += 1
      used.add(t)
      return { time: t, value: p.equity }
    })
    const chart = createChart(ref.current, {
      layout: {
        background: { type: ColorType.Solid, color: bg },
        textColor: text,
        fontSize: 12,
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
      autoSize: true,
    })
    const line = chart.addSeries(LineSeries, {
      color: '#2962ff',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })
    line.setData(data)
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [points, dark])

  if (!points?.length) return null
  return <div ref={ref} className="trade-tv-pane" style={{ minHeight: 280 }} />
}

export function ZoneHedgeBacktest() {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [interval, setInterval] = useState('1h')
  const [limit, setLimit] = useState('500')
  const [margins, setMargins] = useState('50,100,200')
  const [leverage, setLeverage] = useState('20')
  const [maxSteps, setMaxSteps] = useState('3')
  const [tpPct, setTpPct] = useState('10')
  const [adversePct, setAdversePct] = useState('10')
  const [feeBps, setFeeBps] = useState('4')
  const [slipBps, setSlipBps] = useState('2')
  const [maint, setMaint] = useState('0.004')
  const [mode, setMode] = useState('longFirst')
  const [startingEquity, setStartingEquity] = useState('10000')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetchBacktest({
        symbol: symbol.trim().toUpperCase(),
        interval,
        limit,
        margins,
        leverage,
        maxSteps,
        tpPct,
        adversePct,
        feeBpsPerSide: feeBps,
        slippageBps: slipBps,
        maintenanceMarginRate: maint,
        mode,
        startingEquity,
      })
      setData(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [
    symbol,
    interval,
    limit,
    margins,
    leverage,
    maxSteps,
    tpPct,
    adversePct,
    feeBps,
    slipBps,
    maint,
    mode,
    startingEquity,
  ])

  const s = data?.summary
  const equityCurve = useMemo(
    () => (Array.isArray(data?.equityCurve) ? data.equityCurve : []),
    [data],
  )

  return (
    <div className="vol-screener">
      <h1 className="vol-screener-title">Zone-hedge backtest</h1>
      <p className="vol-screener-lead">
        Ladder hedges with fixed <strong>price</strong> TP/SL from each leg’s entry (not anchor).
        Margins double each step (default $50 → $100 → $200 at 20×). On 10% adverse, realize the loss
        and open the opposite side at the next margin. Fees, slippage, and approximate isolated
        liquidation prices included. Intrabar: liquidation &gt; stop &gt; TP when levels conflict.
      </p>

      <div className="vol-screener-form">
        <label className="vol-screener-field">
          <span className="vol-screener-label">Symbol</span>
          <input
            className="vol-screener-input"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            disabled={loading}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Interval</span>
          <select
            className="vol-screener-input"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            disabled={loading}
          >
            {['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Candles</span>
          <input
            type="number"
            className="vol-screener-input"
            min={50}
            max={1500}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            disabled={loading}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Margins USD (comma)</span>
          <input
            className="vol-screener-input"
            value={margins}
            onChange={(e) => setMargins(e.target.value)}
            disabled={loading}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Leverage</span>
          <input
            type="number"
            className="vol-screener-input"
            min={1}
            value={leverage}
            onChange={(e) => setLeverage(e.target.value)}
            disabled={loading}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Max steps</span>
          <input
            type="number"
            className="vol-screener-input"
            min={1}
            max={10}
            value={maxSteps}
            onChange={(e) => setMaxSteps(e.target.value)}
            disabled={loading}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">TP % (price)</span>
          <input
            type="number"
            className="vol-screener-input"
            step={0.1}
            value={tpPct}
            onChange={(e) => setTpPct(e.target.value)}
            disabled={loading}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Adverse % (price)</span>
          <input
            type="number"
            className="vol-screener-input"
            step={0.1}
            value={adversePct}
            onChange={(e) => setAdversePct(e.target.value)}
            disabled={loading}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Fee (bps / side)</span>
          <input
            type="number"
            className="vol-screener-input"
            value={feeBps}
            onChange={(e) => setFeeBps(e.target.value)}
            disabled={loading}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Slippage (bps)</span>
          <input
            type="number"
            className="vol-screener-input"
            value={slipBps}
            onChange={(e) => setSlipBps(e.target.value)}
            disabled={loading}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Maint. margin rate</span>
          <input
            className="vol-screener-input"
            value={maint}
            onChange={(e) => setMaint(e.target.value)}
            disabled={loading}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">First leg</span>
          <select
            className="vol-screener-input"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            disabled={loading}
          >
            <option value="longFirst">Long first</option>
            <option value="shortFirst">Short first</option>
          </select>
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Starting equity ($)</span>
          <input
            type="number"
            className="vol-screener-input"
            min={100}
            value={startingEquity}
            onChange={(e) => setStartingEquity(e.target.value)}
            disabled={loading}
          />
        </label>
        <div className="vol-screener-actions">
          <button type="button" className="btn-refresh" onClick={run} disabled={loading}>
            {loading ? 'Running…' : 'Run backtest'}
          </button>
        </div>
      </div>

      {error && (
        <div className="positions-error" role="alert">
          <p className="positions-error-title">Backtest failed</p>
          <p className="positions-error-msg">{error}</p>
        </div>
      )}

      {data && s && (
        <>
          <p className="positions-meta vol-screener-meta">
            {data.symbol} · {data.interval} · {data.candleCount} candles ·{' '}
            {data.fetchedAt && new Date(data.fetchedAt).toLocaleString()}
          </p>
          <div className="backtest1-summary-grid">
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Final equity</span>
              <span className="backtest1-stat-value">
                ${s.finalEquity?.toFixed(2) ?? '—'}
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Cumulative PnL</span>
              <span
                className={`backtest1-stat-value ${(s.cumulativePnlUsd ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
              >
                ${s.cumulativePnlUsd?.toFixed(2) ?? '—'}
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Win rate</span>
              <span className="backtest1-stat-value">
                {s.wins ?? 0}W / {s.losses ?? 0}L ({s.winRatePct?.toFixed(1) ?? '—'}%)
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Max DD (est.)</span>
              <span className="backtest1-stat-value pnl-neg">
                ${s.maxDrawdownUsd?.toFixed(2) ?? '—'} ({s.maxDrawdownPct?.toFixed(2) ?? '—'}%)
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Cycles</span>
              <span className="backtest1-stat-value">{s.totalCycles ?? '—'}</span>
            </div>
          </div>

          <h2 className="breadth-detail-title" style={{ marginTop: '1rem' }}>
            Equity curve
          </h2>
          <ZoneHedgeEquityChart points={equityCurve} />

          <h2 className="breadth-detail-title" style={{ marginTop: '1rem' }}>
            Cycle log
          </h2>
          <div className="table-wrap">
            <table className="positions-table zebra">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Outcome</th>
                  <th>Legs</th>
                  <th>Net $</th>
                  <th>Cum. PnL</th>
                  <th>Equity</th>
                </tr>
              </thead>
              <tbody>
                {data.cycles?.map((c, i) => (
                  <tr key={`${c.cycleStartIndex}-${i}`}>
                    <td className="cell-mono">{i + 1}</td>
                    <td className="cell-mono">{c.outcome}</td>
                    <td className="cell-mono">{c.legs?.length ?? 0}</td>
                    <td className="cell-mono">{c.netRealizedUsd?.toFixed(2) ?? '—'}</td>
                    <td className="cell-mono">{c.cumulativePnlUsd?.toFixed(2) ?? '—'}</td>
                    <td className="cell-mono">{c.equityAfter?.toFixed(2) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="breadth-details" style={{ marginTop: '1rem' }}>
            <summary className="breadth-details-summary">Leg details (all cycles)</summary>
            <div className="zone-hedge-leg-log">
              {data.cycles?.map((c, ci) => (
                <div key={`leg-${ci}`} className="zone-hedge-cycle-block">
                  <h3 className="breadth-movers-title">
                    Cycle {ci + 1} — {c.outcome} — net ${c.netRealizedUsd?.toFixed(4)}
                  </h3>
                  <table className="positions-table zebra">
                    <thead>
                      <tr>
                        <th>Step</th>
                        <th>Side</th>
                        <th>Margin</th>
                        <th>Entry</th>
                        <th>Exit</th>
                        <th>Why</th>
                        <th>TP</th>
                        <th>SL</th>
                        <th>Liq</th>
                        <th>Leg PnL</th>
                        <th>Cum leg</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.legs?.map((L) => (
                        <tr key={`${L.step}-${L.entryBarIndex}`}>
                          <td className="cell-mono">{L.step}</td>
                          <td className="cell-mono">{L.side}</td>
                          <td className="cell-mono">${L.marginUsd}</td>
                          <td className="cell-mono">{L.entryPrice?.toFixed(4)}</td>
                          <td className="cell-mono">{L.exitPrice?.toFixed(4)}</td>
                          <td className="cell-mono">{L.exitReason}</td>
                          <td className="cell-mono">{L.tpPrice?.toFixed(4)}</td>
                          <td className="cell-mono">{L.slPrice?.toFixed(4)}</td>
                          <td className="cell-mono">{L.liqPrice?.toFixed(4)}</td>
                          <td className="cell-mono">{L.netPnlUsd?.toFixed(4)}</td>
                          <td className="cell-mono">{L.cumulativeAfterLegUsd?.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </details>

          <pre className="zone-hedge-params-json" style={{ marginTop: '1rem', fontSize: '0.75rem' }}>
            {JSON.stringify(data.params, null, 2)}
          </pre>
        </>
      )}
    </div>
  )
}
