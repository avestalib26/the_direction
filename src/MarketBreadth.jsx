import { useCallback, useMemo, useState } from 'react'
import { BreadthBarCharts } from './BreadthCharts'
import {
  buildCandleBreadthCsv,
  buildSymbolMatrixCsv,
  computeBreadthInsights,
  downloadTextFile,
  topMoversLastBar,
} from './breadthInsights'

const INTERVAL_OPTIONS = [
  { value: '1m', label: '1m' },
  { value: '3m', label: '3m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
  { value: '1h', label: '1h' },
  { value: '2h', label: '2h' },
  { value: '4h', label: '4h' },
  { value: '6h', label: '6h' },
  { value: '12h', label: '12h' },
  { value: '1d', label: '1d' },
  { value: '3d', label: '3d' },
  { value: '1w', label: '1w' },
  { value: '1M', label: '1M' },
]

const CANDLE_OPTIONS = [10, 20, 30, 50, 100, 200, 500]

async function fetchMarketBreadth(interval, limit) {
  const q = new URLSearchParams({ interval, limit: String(limit) })
  const res = await fetch(`/api/binance/market-breadth?${q}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

export function MarketBreadth() {
  const [interval, setInterval] = useState('5m')
  const [candleLimit, setCandleLimit] = useState(30)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)
  const [tableOrder, setTableOrder] = useState('oldest')

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchMarketBreadth(interval, candleLimit)
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [interval, candleLimit])

  const candles = useMemo(
    () => (Array.isArray(data?.candleBreadth) ? data.candleBreadth : []),
    [data],
  )
  const symbolRows = useMemo(
    () => (Array.isArray(data?.symbolRows) ? data.symbolRows : []),
    [data],
  )

  const insights = useMemo(() => computeBreadthInsights(candles), [candles])
  const movers = useMemo(
    () => topMoversLastBar(symbolRows, 8),
    [symbolRows],
  )

  const displayCandles = useMemo(() => {
    if (tableOrder === 'newest') return [...candles].reverse()
    return candles
  }, [candles, tableOrder])

  const latestIndex = candles.length > 0 ? candles.length - 1 : -1

  const exportCandles = () => {
    if (!candles.length) return
    downloadTextFile(
      `breadth-by-candle_${interval}_${candles.length}.csv`,
      buildCandleBreadthCsv(candles),
    )
  }

  const exportMatrix = () => {
    if (!candles.length || !symbolRows.length) return
    downloadTextFile(
      `breadth-symbols_${interval}_${candles.length}.csv`,
      buildSymbolMatrixCsv(candles, symbolRows),
    )
  }

  return (
    <div className="breadth">
      <div className="breadth-header">
        <h1 className="title">Market breadth</h1>
        <p className="subtitle">
          USDT-M perpetuals, single-candle open→close per bar. After you run,
          the <strong>four charts</strong> summarize counts, % breadth, sum of
          coin % per candle, and its cumulative line; open{' '}
          <strong>Tables &amp; export</strong> for
          raw grids and CSV.
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
              {INTERVAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Candles</span>
            <select
              className="field-input"
              value={candleLimit}
              onChange={(e) => setCandleLimit(Number(e.target.value))}
              disabled={loading}
            >
              {CANDLE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-refresh breadth-run"
            onClick={run}
            disabled={loading}
          >
            {loading ? 'Fetching…' : 'Run breadth'}
          </button>
        </div>

        {loading && (
          <p className="breadth-loading" role="status">
            Loading klines for all symbols — this can take up to a minute.
          </p>
        )}
      </div>

      {error && (
        <div className="positions-error" role="alert">
          <p className="positions-error-title">Breadth failed</p>
          <p className="positions-error-msg">{error}</p>
        </div>
      )}

      {candles.length > 0 && (
        <>
          {data.fetchedAt && (
            <p className="positions-meta breadth-charts-meta">
              Updated {new Date(data.fetchedAt).toLocaleString()} ·{' '}
              {data.symbolCount} listed · <strong>{data.nCoins}</strong> with
              full data · {data.skipped} skipped
            </p>
          )}
          <BreadthBarCharts candles={candles} symbolRows={symbolRows} />
        </>
      )}

      {candles.length > 0 && (
        <details className="breadth-details">
          <summary className="breadth-details-summary">
            Tables &amp; export
          </summary>
          {insights && (
        <section className="breadth-insights" aria-label="Trading readout">
          <h2 className="breadth-detail-title">Trading readout</h2>
          <p className="breadth-insights-hint">
            <strong>Green %</strong> = share of coins that printed a green candle
            on that bar. Compare <strong>latest</strong> vs <strong>earlier</strong>{' '}
            bars and vs your price chart on the same timeframe.
          </p>
          <div className="breadth-insight-cards">
            <div className="insight-card insight-card--hero">
              <span className="insight-label">Latest closed bar</span>
              <span className="insight-value">
                <span className="insight-pct pnl-pos">
                  {fmtPct(insights.latest.greenPct)} green
                </span>
                <span className="insight-sep">·</span>
                <span className="insight-pct pnl-neg">
                  {fmtPct(insights.latest.redPct)} red
                </span>
              </span>
              <span className="insight-sub">{insights.latestBias}</span>
              <span className="insight-time">
                {fmtUtc(insights.latest.openTime)} UTC
              </span>
            </div>
            <div className="insight-card">
              <span className="insight-label">vs prior bar (Δ green %)</span>
              <span
                className={`insight-mono insight-lg ${chgClass(
                  insights.deltaLatestVsPrior,
                )}`}
              >
                {insights.deltaLatestVsPrior == null
                  ? '—'
                  : fmtSigned(insights.deltaLatestVsPrior) + ' pp'}
              </span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Window avg green %</span>
              <span className="insight-mono insight-lg">
                {fmtPct(insights.meanGreenPct)}
              </span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Momentum (recent vs early)</span>
              <span
                className={`insight-mono insight-lg ${chgClass(insights.momentum)}`}
              >
                {fmtSigned(insights.momentum)} pp
              </span>
              <span className="insight-sub">{insights.trendLabel}</span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Streak at the end</span>
              <span className="insight-mono">
                {insights.greenStreakEnd > 0 && (
                  <span className="pnl-pos">
                    {insights.greenStreakEnd} green-majority
                  </span>
                )}
                {insights.greenStreakEnd > 0 &&
                  insights.redStreakEnd > 0 &&
                  ' · '}
                {insights.redStreakEnd > 0 && (
                  <span className="pnl-neg">
                    {insights.redStreakEnd} red-majority
                  </span>
                )}
                {insights.greenStreakEnd === 0 &&
                  insights.redStreakEnd === 0 &&
                  'No majority streak'}
              </span>
            </div>
            <div className="insight-card">
              <span className="insight-label">Bars with majority</span>
              <span className="insight-mono">
                <span className="pnl-pos">{insights.greenMajorityBars}</span>
                {' green · '}
                <span className="pnl-neg">{insights.redMajorityBars}</span> red
                <span className="insight-sub">
                  (of {insights.n} bars, &gt;50% side)
                </span>
              </span>
            </div>
          </div>

          {(movers.winners.length > 0 || movers.losers.length > 0) && (
            <div className="breadth-movers">
              <div>
                <h3 className="breadth-movers-title">Strongest last bar</h3>
                <ul className="breadth-movers-list">
                  {movers.winners.map((m) => (
                    <li key={m.symbol}>
                      <span className="cell-mono">{m.symbol}</span>{' '}
                      <span className="pnl-pos">{fmtSigned(m.changePct)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="breadth-movers-title">Weakest last bar</h3>
                <ul className="breadth-movers-list">
                  {movers.losers.map((m) => (
                    <li key={m.symbol}>
                      <span className="cell-mono">{m.symbol}</span>{' '}
                      <span className="pnl-neg">{fmtSigned(m.changePct)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="breadth-export-row">
            <button
              type="button"
              className="btn-secondary"
              onClick={exportCandles}
            >
              Download candle breadth CSV
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={exportMatrix}
              disabled={!symbolRows.length}
            >
              Download symbol matrix CSV
            </button>
          </div>
        </section>
          )}

        <section className="breadth-summary-section breadth-summary-inner" aria-live="polite">
          <div className="breadth-table-toolbar">
            <h2 className="breadth-detail-title breadth-table-title">
              Breadth by candle
            </h2>
            <label className="breadth-toggle">
              <span className="field-label">Order</span>
              <select
                className="field-input"
                value={tableOrder}
                onChange={(e) => setTableOrder(e.target.value)}
              >
                <option value="oldest">Oldest first (chronological)</option>
                <option value="newest">Newest first (latest on top)</option>
              </select>
            </label>
          </div>
          <div className="table-wrap breadth-by-candle-wrap">
            <table className="positions-table breadth-by-candle-table zebra">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Open (UTC)</th>
                  <th>Green</th>
                  <th>Red</th>
                  <th>Flat</th>
                  <th>Green %</th>
                  <th>Red %</th>
                  <th>Flat %</th>
                </tr>
              </thead>
              <tbody>
                {displayCandles.map((c) => (
                  <tr
                    key={c.index}
                    className={
                      c.index === latestIndex ? 'breadth-row--latest' : ''
                    }
                  >
                    <td className="cell-mono">{c.index + 1}</td>
                    <td className="cell-mono cell-time">
                      {fmtUtc(c.openTime)}
                    </td>
                    <td className="cell-mono cell-pnl pnl-pos">{c.green}</td>
                    <td className="cell-mono cell-pnl pnl-neg">{c.red}</td>
                    <td className="cell-mono">{c.neutral}</td>
                    <td className="cell-mono pnl-pos">{fmtPct(c.greenPct)}</td>
                    <td className="cell-mono pnl-neg">{fmtPct(c.redPct)}</td>
                    <td className="cell-mono">{fmtPct(c.neutralPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="breadth-legend">
            Highlighted row = <strong>latest closed</strong> bar in the sample.
            Green % &gt; 50% means more coins closed up than down on that candle.
          </p>
        </section>

      {symbolRows.length > 0 && (
        <section className="breadth-detail-section">
          <h2 className="breadth-detail-title">Per symbol — each candle %</h2>
          <div className="table-wrap breadth-wide-wrap">
            <table className="positions-table breadth-per-symbol-table zebra">
              <thead>
                <tr>
                  <th className="breadth-sticky-col">Symbol</th>
                  {candles.map((c) => (
                    <th
                      key={c.index}
                      className={`breadth-candle-head cell-mono ${c.index === latestIndex ? 'breadth-col--latest' : ''}`}
                      title={fmtUtc(c.openTime)}
                    >
                      {c.index + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {symbolRows.map((row) => (
                  <tr key={row.symbol}>
                    <th
                      scope="row"
                      className="breadth-sticky-col cell-mono breadth-symbol-cell"
                    >
                      {row.symbol}
                    </th>
                    {row.candles.map((c, i) => (
                      <td
                        key={`${row.symbol}-${c.openTime}-${i}`}
                        className={`cell-mono breadth-pct-cell ${chgClass(
                          c.changePct,
                        )} ${i === latestIndex ? 'breadth-cell--latest-col' : ''}`}
                      >
                        {c.changePct === null ? '—' : fmtSigned(c.changePct)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="breadth-legend">
            Column <strong>1 … {candles.length}</strong> matches the breadth table
            (oldest → newest). Latest column has a subtle highlight. Hover a
            header for open time.
          </p>
        </section>
      )}
        </details>
      )}
    </div>
  )
}

function fmtPct(n) {
  return `${n.toFixed(1)}%`
}

function fmtSigned(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const s = n > 0 ? '+' : ''
  return `${s}${n.toFixed(2)}`
}

function fmtUtc(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function chgClass(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return ''
  if (n > 0) return 'pnl-pos'
  if (n < 0) return 'pnl-neg'
  return ''
}
