import { useCallback, useEffect, useMemo, useState } from 'react'
import { TradeHistoryCharts } from './TradeHistoryCharts'
import { computeTradeHistoryMetrics } from './tradeHistoryMetrics'

const LIMIT = 1000

async function fetchClosedPositions() {
  const q = new URLSearchParams({ limit: String(LIMIT) })
  const res = await fetch(`/api/binance/closed-positions?${q}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

export function TradeHistory() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [closes, setCloses] = useState([])
  const [fetchedAt, setFetchedAt] = useState(null)
  const [meta, setMeta] = useState(null)

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

  const tableRows = useMemo(
    () => [...closes].sort((a, b) => b.closedAt - a.closedAt),
    [closes],
  )

  const metrics = useMemo(
    () => computeTradeHistoryMetrics(closes),
    [closes],
  )

  return (
    <div className="trade-history">
      <div className="trade-history-header">
        <h1 className="title">Trade history</h1>
        <p className="subtitle">
          Last <strong>{LIMIT}</strong> <strong>closed position</strong> outcomes
          on USDT-M futures: each row is the <strong>total realized PnL</strong>{' '}
          for one closing order (all fills sharing the same{' '}
          <code className="inline-code">orderId</code>), not raw income ticks or
          individual fills.
        </p>
        {meta?.note && (
          <p className="trade-history-note">{meta.note}</p>
        )}
        <button
          type="button"
          className="btn-refresh"
          onClick={load}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {loading && closes.length === 0 && (
        <p className="positions-status">Loading closed positions…</p>
      )}

      {error && (
        <div className="positions-error" role="alert">
          <p className="positions-error-title">Could not load history</p>
          <p className="positions-error-msg">{error}</p>
        </div>
      )}

      {!error && closes.length > 0 && (
        <>
          {fetchedAt && (
            <p className="positions-meta">
              Updated {new Date(fetchedAt).toLocaleString()} ·{' '}
              <strong>{closes.length}</strong> closes · symbols scanned:{' '}
              {meta?.symbolsScanned ?? '—'} · up to{' '}
              {meta?.tradesPerSymbolLimit ?? '—'} trades/symbol
            </p>
          )}

          {!metrics.empty && (
            <section
              className="trade-history-metrics"
              aria-label="Performance metrics"
            >
              <h2 className="breadth-detail-title trade-history-metrics-title">
                Metrics
              </h2>
              <p className="trade-history-metrics-scope">
                Based on the <strong>{metrics.sampleSize}</strong> closes loaded
                (max {LIMIT} from the API), not necessarily your full account
                history. <strong>Today</strong> uses your device&apos;s{' '}
                <strong>local calendar date</strong>.
              </p>

              <div className="trade-history-metrics-grid">
                <div className="trade-history-metric-card trade-history-metric-card--today">
                  <h3 className="trade-history-metric-heading">Today (local)</h3>
                  <dl className="trade-history-metric-dl">
                    <div>
                      <dt>Closes</dt>
                      <dd>{metrics.todayCount}</dd>
                    </div>
                    <div>
                      <dt>Win rate</dt>
                      <dd>{fmtPctOrDash(metrics.todayWinRatePct)}</dd>
                    </div>
                    <div>
                      <dt>Net PnL</dt>
                      <dd className={pnlClass(metrics.todayNetPnl)}>
                        {fmtPnl4OrDash(metrics.todayNetPnl)}
                      </dd>
                    </div>
                    <div>
                      <dt>Avg / trade</dt>
                      <dd className={pnlClass(metrics.todayAvgPnl)}>
                        {fmtPnl4OrDash(metrics.todayAvgPnl)}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="trade-history-metric-card">
                  <h3 className="trade-history-metric-heading">Last 7 days</h3>
                  <dl className="trade-history-metric-dl">
                    <div>
                      <dt>Closes</dt>
                      <dd>{metrics.count7d}</dd>
                    </div>
                    <div>
                      <dt>Win rate</dt>
                      <dd>{fmtPctOrDash(metrics.winRate7dPct)}</dd>
                    </div>
                    <div>
                      <dt>Net PnL</dt>
                      <dd className={pnlClass(metrics.net7d)}>
                        {fmtPnl4OrDash(metrics.net7d)}
                      </dd>
                    </div>
                    <div>
                      <dt>Avg win / avg loss</dt>
                      <dd>
                        <span className="pnl-pos">
                          {fmtPnl4OrDash(metrics.avgWin7d)}
                        </span>
                        {' · '}
                        <span className="pnl-neg">
                          {fmtPnl4OrDash(metrics.avgLoss7d)}
                        </span>
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="trade-history-metric-card">
                  <h3 className="trade-history-metric-heading">Last 30 days</h3>
                  <dl className="trade-history-metric-dl">
                    <div>
                      <dt>Closes</dt>
                      <dd>{metrics.count30d}</dd>
                    </div>
                    <div>
                      <dt>Win rate</dt>
                      <dd>{fmtPctOrDash(metrics.winRate30dPct)}</dd>
                    </div>
                    <div>
                      <dt>Net PnL</dt>
                      <dd className={pnlClass(metrics.net30d)}>
                        {fmtPnl4OrDash(metrics.net30d)}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="trade-history-metric-card trade-history-metric-card--wide">
                  <h3 className="trade-history-metric-heading">
                    All loaded closes
                  </h3>
                  <dl className="trade-history-metric-dl trade-history-metric-dl--wide">
                    <div>
                      <dt>Wins / losses / flat</dt>
                      <dd>
                        {metrics.winCount} / {metrics.lossCount} /{' '}
                        {metrics.flatCount}
                      </dd>
                    </div>
                    <div>
                      <dt>Win rate (all rows)</dt>
                      <dd>{fmtPctOrDash(metrics.winRateTotalPct)}</dd>
                    </div>
                    <div>
                      <dt>Win rate (excl. flat)</dt>
                      <dd>{fmtPctOrDash(metrics.winRateDecisivePct)}</dd>
                    </div>
                    <div>
                      <dt>Avg win</dt>
                      <dd className="pnl-pos">
                        {fmtPnl4OrDash(metrics.avgWin)}
                      </dd>
                    </div>
                    <div>
                      <dt>Avg loss</dt>
                      <dd className="pnl-neg">
                        {fmtPnl4OrDash(metrics.avgLoss)}
                      </dd>
                    </div>
                    <div>
                      <dt>Profit factor</dt>
                      <dd>{fmtProfitFactor(metrics.profitFactor)}</dd>
                    </div>
                    <div>
                      <dt>Expectancy / trade</dt>
                      <dd className={pnlClass(metrics.expectancy)}>
                        {fmtPnl4OrDash(metrics.expectancy)}
                      </dd>
                    </div>
                    <div>
                      <dt>Net PnL</dt>
                      <dd className={pnlClass(metrics.netPnl)}>
                        {fmtPnl4OrDash(metrics.netPnl)}
                      </dd>
                    </div>
                    <div>
                      <dt>Avg PnL / trade</dt>
                      <dd className={pnlClass(metrics.avgTradePnl)}>
                        {fmtPnl4OrDash(metrics.avgTradePnl)}
                      </dd>
                    </div>
                    <div>
                      <dt>Best / worst</dt>
                      <dd>
                        <span className="pnl-pos">
                          {fmtPnl4OrDash(metrics.largestWin)}
                        </span>
                        {' · '}
                        <span className="pnl-neg">
                          {fmtPnl4OrDash(metrics.largestLoss)}
                        </span>
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            </section>
          )}

          <section className="trade-history-chart-section">
            <h2 className="breadth-detail-title">Charts</h2>
            <TradeHistoryCharts
              key={fetchedAt ?? 'pending'}
              closes={closes}
            />
          </section>
          <section className="trade-history-table-section">
            <h2 className="breadth-detail-title">Closes (newest first)</h2>
            <div className="table-wrap">
              <table className="positions-table trade-history-table">
                <thead>
                  <tr>
                    <th>Closed (UTC)</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Order</th>
                    <th>Fills</th>
                    <th>Qty</th>
                    <th>Realized PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r, i) => (
                    <tr
                      key={`${r.orderId}-${r.symbol}-${r.closedAt}-${i}`}
                    >
                      <td className="cell-mono cell-time">
                        {fmtUtc(r.closedAt)}
                      </td>
                      <td className="cell-mono">{r.symbol}</td>
                      <td>{r.positionSide}</td>
                      <td className="cell-mono">{r.orderId}</td>
                      <td className="cell-mono">{r.fills}</td>
                      <td className="cell-mono">{r.qty}</td>
                      <td
                        className={`cell-mono cell-pnl ${chgClass(r.realizedPnl)}`}
                      >
                        {fmtSigned(r.realizedPnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {!error && !loading && closes.length === 0 && (
        <div className="positions-empty">
          <p>No closed-position rows returned.</p>
          {meta?.note && <p className="trade-history-note">{meta.note}</p>}
        </div>
      )}
    </div>
  )
}

function fmtUtc(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function fmtSigned(n) {
  if (!Number.isFinite(n)) return '—'
  const s = n > 0 ? '+' : ''
  return `${s}${n.toFixed(4)}`
}

function chgClass(n) {
  if (!Number.isFinite(n) || n === 0) return ''
  return n > 0 ? 'pnl-pos' : 'pnl-neg'
}

function pnlClass(n) {
  if (n == null || !Number.isFinite(n) || n === 0) return ''
  return n > 0 ? 'pnl-pos' : 'pnl-neg'
}

function fmtPctOrDash(p) {
  if (p == null || !Number.isFinite(p)) return '—'
  return `${p.toFixed(1)}%`
}

function fmtPnl4OrDash(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  return fmtSigned(n)
}

function fmtProfitFactor(pf) {
  if (pf == null) return '—'
  if (pf === Infinity) return '∞'
  if (!Number.isFinite(pf)) return '—'
  if (pf > 1e6) return '>1,000,000'
  return pf.toFixed(2)
}
