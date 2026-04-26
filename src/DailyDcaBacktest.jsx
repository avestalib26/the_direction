import { useCallback, useMemo, useState } from 'react'

async function fetchDailyDcaBacktest({
  interval,
  candleCount,
  maxSymbols,
  startingBalanceUsd,
  leverage,
  perEntryMarginUsd,
  tpPct,
  addPct,
}) {
  const q = new URLSearchParams({
    interval,
    candleCount: String(candleCount),
    maxSymbols: String(maxSymbols),
    startingBalanceUsd: String(startingBalanceUsd),
    leverage: String(leverage),
    perEntryMarginUsd: String(perEntryMarginUsd),
    tpPct: String(tpPct),
    addPct: String(addPct),
  })
  const res = await fetch(`/api/binance/daily-dca-backtest?${q}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export function DailyDcaBacktest() {
  const [interval, setInterval] = useState('1d')
  const [candleCount, setCandleCount] = useState('120')
  const [maxSymbols, setMaxSymbols] = useState('0')
  const [startingBalanceUsd, setStartingBalanceUsd] = useState('1000')
  const [leverage, setLeverage] = useState('20')
  const [perEntryMarginUsd, setPerEntryMarginUsd] = useState('1')
  const [tpPct, setTpPct] = useState('20')
  const [addPct, setAddPct] = useState('-50')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchDailyDcaBacktest({
        interval,
        candleCount: Number.parseInt(candleCount, 10),
        maxSymbols: Number.parseInt(maxSymbols, 10),
        startingBalanceUsd: Number.parseFloat(startingBalanceUsd),
        leverage: Number.parseFloat(leverage),
        perEntryMarginUsd: Number.parseFloat(perEntryMarginUsd),
        tpPct: Number.parseFloat(tpPct),
        addPct: Number.parseFloat(addPct),
      })
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backtest failed')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [addPct, candleCount, interval, leverage, maxSymbols, perEntryMarginUsd, startingBalanceUsd, tpPct])

  const barLabel = data?.config?.interval ?? interval
  const curve = useMemo(() => (Array.isArray(data?.equityCurve) ? data.equityCurve : []), [data])
  const symbols = useMemo(() => (Array.isArray(data?.symbolRows) ? data.symbolRows : []), [data])
  const daily = useMemo(() => (Array.isArray(data?.dailyRows) ? data.dailyRows : []), [data])
  const latest = curve[curve.length - 1] ?? null

  return (
    <div className="breadth">
      <div className="breadth-header">
        <h1 className="title">DCA all-coins backtest</h1>
        <p className="subtitle">
          Starts with one $1 long per coin (20x leverage = $20 notional), no volume filter.
          Close a leg if unlevered move reaches +20%. Add another $1 long when a leg reaches -50%,
          executed at the next bar open. Choose daily or 4h candles.
        </p>
        <div className="breadth-controls">
          <label className="field">
            <span className="field-label">Timeframe</span>
            <select
              className="field-input"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              disabled={loading}
            >
              <option value="1d">1d</option>
              <option value="4h">4h</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Candles</span>
            <input className="field-input" type="number" min={30} max={500} value={candleCount} onChange={(e) => setCandleCount(e.target.value)} disabled={loading} />
          </label>
          <label className="field">
            <span className="field-label">Max symbols (0 = all)</span>
            <input className="field-input" type="number" min={0} max={1200} value={maxSymbols} onChange={(e) => setMaxSymbols(e.target.value)} disabled={loading} />
          </label>
          <label className="field">
            <span className="field-label">Start balance ($)</span>
            <input className="field-input" type="number" min={1} step={1} value={startingBalanceUsd} onChange={(e) => setStartingBalanceUsd(e.target.value)} disabled={loading} />
          </label>
          <label className="field">
            <span className="field-label">Leverage</span>
            <input className="field-input" type="number" min={1} max={125} step={1} value={leverage} onChange={(e) => setLeverage(e.target.value)} disabled={loading} />
          </label>
          <label className="field">
            <span className="field-label">$ per entry</span>
            <input className="field-input" type="number" min={0.1} step={0.1} value={perEntryMarginUsd} onChange={(e) => setPerEntryMarginUsd(e.target.value)} disabled={loading} />
          </label>
          <label className="field">
            <span className="field-label">TP % (unlevered)</span>
            <input className="field-input" type="number" min={0.1} step={0.1} value={tpPct} onChange={(e) => setTpPct(e.target.value)} disabled={loading} />
          </label>
          <label className="field">
            <span className="field-label">Add threshold %</span>
            <input className="field-input" type="number" max={-0.1} step={0.1} value={addPct} onChange={(e) => setAddPct(e.target.value)} disabled={loading} />
          </label>
          <button type="button" className="btn-refresh breadth-run" onClick={() => void run()} disabled={loading}>
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

      {data?.summary && (
        <section className="breadth-insights" aria-label="Backtest summary">
          <h2 className="breadth-detail-title">Summary</h2>
          <div className="breadth-insight-cards">
            <div className="insight-card insight-card--hero">
              <span className="insight-label">Total PnL</span>
              <span className={`insight-value ${chgClass(data.summary.totalPnlUsd)}`}>
                {fmtSigned(data.summary.totalPnlUsd)}
              </span>
              <span className={`insight-sub ${chgClass(data.summary.totalReturnPct)}`}>
                {fmtSigned(data.summary.totalReturnPct)}%
              </span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Ending equity</span>
              <span className="insight-mono insight-lg">{fmtSigned(data.summary.endingEquityUsd)}</span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Max drawdown</span>
              <span className="insight-mono insight-lg pnl-neg">{fmtSigned(data.summary.maxDrawdownPct)}%</span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Realized / unrealized</span>
              <span className="insight-mono">
                <span className={chgClass(data.summary.totalRealizedPnlUsd)}>{fmtSigned(data.summary.totalRealizedPnlUsd)}</span>
                {' / '}
                <span className={chgClass(data.summary.totalUnrealizedPnlUsd)}>{fmtSigned(data.summary.totalUnrealizedPnlUsd)}</span>
              </span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Closed trades</span>
              <span className="insight-mono insight-lg">{data.summary.totalClosedTrades}</span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Open legs now / peak</span>
              <span className="insight-mono insight-lg">
                {data.summary.totalOpenLegs} / {data.summary.peakOpenLegs}
              </span>
            </div>
          </div>
          <p className="positions-meta">
            Interval {data.config?.interval ?? interval} · universe {data.universe?.listedUsdtPerpetuals} · requested {data.universe?.symbolsRequested} · used {data.universe?.symbolsWithData} · skipped {data.universe?.symbolsSkipped}
          </p>
        </section>
      )}

      {curve.length > 0 && (
        <section className="breadth-summary-section breadth-summary-inner" aria-live="polite">
          <h2 className="breadth-detail-title breadth-table-title">Equity & drawdown matrix</h2>
          <div className="table-wrap breadth-by-candle-wrap">
            <table className="positions-table breadth-by-candle-table zebra">
              <thead>
                <tr>
                  <th>Open (UTC)</th>
                  <th>Equity $</th>
                  <th>Drawdown %</th>
                  <th>Realized $</th>
                  <th>Unrealized $</th>
                  <th>Open legs</th>
                  <th>Open margin $</th>
                  <th>Open notional $</th>
                </tr>
              </thead>
              <tbody>
                {curve.map((r) => (
                  <tr key={r.openTime ?? r.index} className={r === latest ? 'breadth-row--latest' : ''}>
                    <td className="cell-mono cell-time">{fmtOpenTime(r.openTime, barLabel)}</td>
                    <td className={`cell-mono ${chgClass(r.equityUsd - Number.parseFloat(startingBalanceUsd))}`}>{fmtSigned(r.equityUsd)}</td>
                    <td className="cell-mono pnl-neg">{fmtSigned(r.drawdownPct)}%</td>
                    <td className={`cell-mono ${chgClass(r.realizedPnlUsd)}`}>{fmtSigned(r.realizedPnlUsd)}</td>
                    <td className={`cell-mono ${chgClass(r.unrealizedPnlUsd)}`}>{fmtSigned(r.unrealizedPnlUsd)}</td>
                    <td className="cell-mono">{r.openLegs}</td>
                    <td className="cell-mono">{fmtSigned(r.openMarginUsd)}</td>
                    <td className="cell-mono">{fmtSigned(r.openNotionalUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {daily.length > 0 && (
        <section className="breadth-summary-section breadth-summary-inner" aria-live="polite">
          <h2 className="breadth-detail-title breadth-table-title">Per-bar action matrix</h2>
          <div className="table-wrap breadth-by-candle-wrap">
            <table className="positions-table breadth-by-candle-table zebra">
              <thead>
                <tr>
                  <th>Open (UTC)</th>
                  <th>Realized PnL $</th>
                  <th>Unrealized PnL $</th>
                  <th>Closed trades</th>
                  <th>Added entries</th>
                  <th>Open legs</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((r) => (
                  <tr key={r.openTime ?? r.index}>
                    <td className="cell-mono cell-time">{fmtOpenTime(r.openTime, barLabel)}</td>
                    <td className={`cell-mono ${chgClass(r.dayRealizedPnlUsd)}`}>{fmtSigned(r.dayRealizedPnlUsd)}</td>
                    <td className={`cell-mono ${chgClass(r.dayUnrealizedPnlUsd)}`}>{fmtSigned(r.dayUnrealizedPnlUsd)}</td>
                    <td className="cell-mono">{r.dayClosedCount}</td>
                    <td className="cell-mono">{r.dayAddedCount}</td>
                    <td className="cell-mono">{r.openLegs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {symbols.length > 0 && (
        <section className="breadth-summary-section breadth-summary-inner" aria-live="polite">
          <h2 className="breadth-detail-title breadth-table-title">Per-symbol matrix (sorted by total PnL)</h2>
          <div className="table-wrap breadth-by-candle-wrap">
            <table className="positions-table breadth-by-candle-table zebra">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Total PnL $</th>
                  <th>Realized $</th>
                  <th>Unrealized $</th>
                  <th>Open legs</th>
                  <th>Initial entries</th>
                  <th>Added entries</th>
                  <th>Closed trades</th>
                </tr>
              </thead>
              <tbody>
                {symbols.map((r) => (
                  <tr key={r.symbol}>
                    <td className="cell-mono">{r.symbol}</td>
                    <td className={`cell-mono ${chgClass(r.totalPnlUsd)}`}>{fmtSigned(r.totalPnlUsd)}</td>
                    <td className={`cell-mono ${chgClass(r.realizedPnlUsd)}`}>{fmtSigned(r.realizedPnlUsd)}</td>
                    <td className={`cell-mono ${chgClass(r.unrealizedPnlUsd)}`}>{fmtSigned(r.unrealizedPnlUsd)}</td>
                    <td className="cell-mono">{r.openLegs}</td>
                    <td className="cell-mono">{r.initialEntries}</td>
                    <td className="cell-mono">{r.addedEntries}</td>
                    <td className="cell-mono">{r.closedTrades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

function fmtSigned(n) {
  if (!Number.isFinite(n)) return '—'
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}`
}

function fmtOpenTime(ms, interval) {
  if (!Number.isFinite(ms)) return '—'
  const s = new Date(ms).toISOString().replace('T', ' ')
  if (interval === '1d') return s.slice(0, 10)
  return s.slice(0, 19)
}

function chgClass(n) {
  if (!Number.isFinite(n) || n === 0) return ''
  return n > 0 ? 'pnl-pos' : 'pnl-neg'
}
