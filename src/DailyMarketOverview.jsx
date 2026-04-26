import { useCallback, useMemo, useState } from 'react'

async function fetchDailyOverview({ days, minQuoteVolume, maxSymbols }) {
  const q = new URLSearchParams({
    days: String(days),
    minQuoteVolume: String(minQuoteVolume),
    maxSymbols: String(maxSymbols),
  })
  const res = await fetch(`/api/binance/daily-market-overview?${q}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

export function DailyMarketOverview() {
  const [days, setDays] = useState('60')
  const [minQuoteVolume, setMinQuoteVolume] = useState('2000000')
  const [maxSymbols, setMaxSymbols] = useState('250')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)
  const [order, setOrder] = useState('newest')

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchDailyOverview({
        days: Number.parseInt(days, 10),
        minQuoteVolume: Number.parseFloat(minQuoteVolume),
        maxSymbols: Number.parseInt(maxSymbols, 10),
      })
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [days, minQuoteVolume, maxSymbols])

  const rows = useMemo(
    () => (Array.isArray(data?.rows) ? data.rows : []),
    [data],
  )
  const latest = data?.latest ?? null
  const displayRows = useMemo(() => {
    if (order === 'newest') return [...rows].reverse()
    return rows
  }, [rows, order])

  return (
    <div className="breadth">
      <div className="breadth-header">
        <h1 className="title">Daily market overview</h1>
        <p className="subtitle">
          Fetches daily candles for volume-filtered USDT-M symbols and aggregates each day across all
          coins: total sum of % change, green/red counts, green/red sums, and cumulative totals.
        </p>
        <div className="breadth-controls">
          <label className="field">
            <span className="field-label">Days</span>
            <input
              type="number"
              className="field-input"
              min={10}
              max={120}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              disabled={loading}
            />
          </label>
          <label className="field">
            <span className="field-label">Min 24h quote volume (USDT)</span>
            <input
              type="number"
              className="field-input"
              min={0}
              step={100000}
              value={minQuoteVolume}
              onChange={(e) => setMinQuoteVolume(e.target.value)}
              disabled={loading}
            />
          </label>
          <label className="field">
            <span className="field-label">Max symbols</span>
            <input
              type="number"
              className="field-input"
              min={20}
              max={500}
              value={maxSymbols}
              onChange={(e) => setMaxSymbols(e.target.value)}
              disabled={loading}
            />
          </label>
          <button
            type="button"
            className="btn-refresh breadth-run"
            onClick={() => void run()}
            disabled={loading}
          >
            {loading ? 'Fetching…' : 'Run overview'}
          </button>
        </div>
      </div>

      {error && (
        <div className="positions-error" role="alert">
          <p className="positions-error-title">Daily overview failed</p>
          <p className="positions-error-msg">{error}</p>
        </div>
      )}

      {latest && (
        <section className="breadth-insights" aria-label="Daily market summary">
          <h2 className="breadth-detail-title">Latest day summary</h2>
          <div className="breadth-insight-cards">
            <div className="insight-card">
              <span className="insight-label">Date (UTC)</span>
              <span className="insight-mono insight-lg">{fmtUtcDate(latest.openTime)}</span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Day sum (%)</span>
              <span className={`insight-mono insight-lg ${chgClass(latest.sumChangePct)}`}>
                {fmtSigned(latest.sumChangePct)}
              </span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Greens / reds / flat</span>
              <span className="insight-mono">
                <span className="pnl-pos">{latest.greenCount}</span>
                {' / '}
                <span className="pnl-neg">{latest.redCount}</span>
                {' / '}
                {latest.neutralCount}
              </span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Green sum (%)</span>
              <span className="insight-mono pnl-pos">{fmtSigned(latest.greenSumChangePct)}</span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Red sum (%)</span>
              <span className="insight-mono pnl-neg">{fmtSigned(latest.redSumChangePct)}</span>
            </div>
            <div className="insight-card insight-card--hero">
              <span className="insight-label">Cumulative sum (%)</span>
              <span className={`insight-value ${chgClass(latest.cumulativeSumChangePct)}`}>
                {fmtSigned(latest.cumulativeSumChangePct)}
              </span>
              <span className="insight-sub">
                Green cum {fmtSigned(latest.cumulativeGreenChangePct)} · Red cum{' '}
                {fmtSigned(latest.cumulativeRedChangePct)}
              </span>
            </div>
          </div>
          <p className="positions-meta">
            Universe {data.symbolUniverseCount} · volume matched {data.symbolsMatchedVolume} · used{' '}
            {data.symbolsWithData} symbols · skipped {data.symbolsSkipped}
          </p>
        </section>
      )}

      {displayRows.length > 0 && (
        <section className="breadth-summary-section breadth-summary-inner" aria-live="polite">
          <div className="breadth-table-toolbar">
            <h2 className="breadth-detail-title breadth-table-title">Per-day aggregate table</h2>
            <label className="breadth-toggle">
              <span className="field-label">Order</span>
              <select
                className="field-input"
                value={order}
                onChange={(e) => setOrder(e.target.value)}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
          </div>
          <div className="table-wrap breadth-by-candle-wrap">
            <table className="positions-table breadth-by-candle-table zebra">
              <thead>
                <tr>
                  <th>Date (UTC)</th>
                  <th>Symbols</th>
                  <th>Green</th>
                  <th>Red</th>
                  <th>Flat</th>
                  <th>Day sum %</th>
                  <th>Green sum %</th>
                  <th>Red sum %</th>
                  <th>Cumulative %</th>
                  <th>Cum green %</th>
                  <th>Cum red %</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r) => (
                  <tr key={r.openTime ?? r.index}>
                    <td className="cell-mono cell-time">{fmtUtcDate(r.openTime)}</td>
                    <td className="cell-mono">{r.symbolsCount}</td>
                    <td className="cell-mono pnl-pos">{r.greenCount}</td>
                    <td className="cell-mono pnl-neg">{r.redCount}</td>
                    <td className="cell-mono">{r.neutralCount}</td>
                    <td className={`cell-mono ${chgClass(r.sumChangePct)}`}>{fmtSigned(r.sumChangePct)}</td>
                    <td className="cell-mono pnl-pos">{fmtSigned(r.greenSumChangePct)}</td>
                    <td className="cell-mono pnl-neg">{fmtSigned(r.redSumChangePct)}</td>
                    <td className={`cell-mono ${chgClass(r.cumulativeSumChangePct)}`}>
                      {fmtSigned(r.cumulativeSumChangePct)}
                    </td>
                    <td className="cell-mono pnl-pos">{fmtSigned(r.cumulativeGreenChangePct)}</td>
                    <td className="cell-mono pnl-neg">{fmtSigned(r.cumulativeRedChangePct)}</td>
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

function fmtUtcDate(ms) {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().slice(0, 10)
}

function chgClass(n) {
  if (!Number.isFinite(n) || n === 0) return ''
  return n > 0 ? 'pnl-pos' : 'pnl-neg'
}
