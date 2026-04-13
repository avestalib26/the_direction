import { useCallback, useMemo, useState } from 'react'
import { Backtest1CumulativeChart } from './Backtest1CumulativeChart'
import { runCoinTossBacktest } from './backtest1Sim'

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
]

const LIMIT_PRESETS = [50, 100, 200, 300, 500, 800, 1200, 1500]

async function fetchKlines(symbol, interval, limit) {
  const q = new URLSearchParams({
    symbol: symbol.trim(),
    interval,
    limit: String(limit),
  })
  const res = await fetch(`/api/binance/futures-klines?${q}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function formatTs(ms) {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

function fmtPx(n) {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const d = abs >= 1 ? 4 : 8
  return n.toLocaleString(undefined, { maximumFractionDigits: d })
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return '—'
  const s = n >= 0 ? '+' : ''
  return `${s}${n.toFixed(2)}%`
}

export function Backtest1() {
  const [symbol, setSymbol] = useState('BTC')
  const [interval, setInterval] = useState('1h')
  const [limit, setLimit] = useState(200)
  const [tpPct, setTpPct] = useState(2)
  const [slPct, setSlPct] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [meta, setMeta] = useState(null)
  const [trades, setTrades] = useState([])
  const [summary, setSummary] = useState(null)

  const limitSelectValue = useMemo(() => {
    return LIMIT_PRESETS.includes(limit) ? String(limit) : 'custom'
  }, [limit])

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    setTrades([])
    setSummary(null)
    setMeta(null)
    try {
      const tp = Number.parseFloat(String(tpPct))
      const sl = Number.parseFloat(String(slPct))
      if (!Number.isFinite(tp) || tp <= 0) {
        throw new Error('Take-profit % must be a positive number')
      }
      if (!Number.isFinite(sl) || sl <= 0) {
        throw new Error('Stop-loss % must be a positive number')
      }
      const lim = Number.parseInt(String(limit), 10)
      if (!Number.isFinite(lim) || lim < 20 || lim > 1500) {
        throw new Error('Candles: use 20–1500')
      }

      const data = await fetchKlines(symbol, interval, lim)
      const candles = data.candles ?? []
      if (candles.length < 20) {
        throw new Error('Not enough candles returned')
      }

      const { trades: t, summary: s } = runCoinTossBacktest(candles, {
        tpPct: tp,
        slPct: sl,
      })

      setMeta({
        symbol: data.symbol,
        interval: data.interval,
        candleCount: candles.length,
        fetchedAt: data.fetchedAt,
      })
      setTrades(t)
      setSummary(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backtest failed')
    } finally {
      setLoading(false)
    }
  }, [symbol, interval, limit, tpPct, slPct])

  return (
    <div className="backtest1">
      <h1 className="backtest1-title">Backtest 1 · Coin toss</h1>
      <p className="backtest1-lead">
        Each trade picks <strong>LONG</strong> or <strong>SHORT</strong> at random.
        Entry = that candle&apos;s <strong>open</strong>. Exit on{' '}
        <strong>TP</strong> or <strong>SL</strong> (% vs entry). If both touch in
        the same candle, <strong>SL</strong> is assumed first. Next trade starts
        on the <strong>next</strong> candle after exit. If neither hits before
        data ends, the last close is used (<strong>END</strong>).
      </p>

      <div className="backtest1-form">
        <label className="backtest1-field">
          <span className="backtest1-label">Symbol</span>
          <input
            type="text"
            className="backtest1-input"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="BTC or BTCUSDT"
            disabled={loading}
            autoComplete="off"
          />
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Candles (count)</span>
          <div className="backtest1-limit-row">
            <select
              className="backtest1-select"
              value={limitSelectValue}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'custom') return
                setLimit(Number.parseInt(v, 10))
              }}
              disabled={loading}
            >
              {LIMIT_PRESETS.map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
            <input
              type="number"
              className="backtest1-input backtest1-input--narrow"
              min={20}
              max={1500}
              value={limit}
              onChange={(e) =>
                setLimit(Number.parseInt(e.target.value, 10) || 0)
              }
              disabled={loading}
            />
          </div>
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Interval</span>
          <select
            className="backtest1-select"
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

        <label className="backtest1-field">
          <span className="backtest1-label">Take profit (%)</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={0.01}
            step={0.1}
            value={tpPct}
            onChange={(e) => setTpPct(e.target.value)}
            disabled={loading}
          />
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Stop loss (%)</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={0.01}
            step={0.1}
            value={slPct}
            onChange={(e) => setSlPct(e.target.value)}
            disabled={loading}
          />
        </label>

        <div className="backtest1-actions">
          <button
            type="button"
            className="btn-refresh"
            onClick={run}
            disabled={loading}
          >
            {loading ? 'Loading & running…' : 'Run backtest'}
          </button>
        </div>
      </div>

      {error && (
        <div className="backtest1-error" role="alert">
          {error}
        </div>
      )}

      {meta && summary && (
        <section className="backtest1-results" aria-label="Backtest results">
          <h2 className="backtest1-results-title">Results</h2>
          <p className="backtest1-meta">
            <strong>{meta.symbol}</strong> · {meta.interval} · {meta.candleCount}{' '}
            candles
            {meta.fetchedAt && (
              <>
                {' '}
                · fetched {new Date(meta.fetchedAt).toLocaleString()}
              </>
            )}
          </p>

          <div className="backtest1-summary-grid">
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Trades</span>
              <span className="backtest1-stat-value">{summary.count}</span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">TP / SL / END</span>
              <span className="backtest1-stat-value">
                {summary.tpHits} / {summary.slHits} / {summary.endHits}
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Win rate (PnL &gt; 0)</span>
              <span className="backtest1-stat-value">
                {summary.winRatePct.toFixed(1)}%
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Sum PnL % (simple)</span>
              <span
                className={`backtest1-stat-value ${summary.totalPnlPct >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
              >
                {fmtPct(summary.totalPnlPct)}
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Avg PnL % / trade</span>
              <span className="backtest1-stat-value">
                {fmtPct(summary.avgPnlPct)}
              </span>
            </div>
          </div>

          <Backtest1CumulativeChart trades={trades} />

          {trades.length > 0 && (
            <div className="table-wrap backtest1-table-wrap">
              <table className="positions-table backtest1-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Dir</th>
                    <th>Entry time</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Outcome</th>
                    <th>Bars</th>
                    <th>PnL %</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.tradeNum}>
                      <td className="cell-mono">{t.tradeNum}</td>
                      <td
                        className={
                          t.direction === 'LONG' ? 'pnl-pos' : 'pnl-neg'
                        }
                      >
                        {t.direction}
                      </td>
                      <td className="cell-mono backtest1-ts">
                        {formatTs(t.entryTime)}
                      </td>
                      <td className="cell-mono">{fmtPx(t.entry)}</td>
                      <td className="cell-mono">{fmtPx(t.exitPrice)}</td>
                      <td className="cell-mono">{t.outcome}</td>
                      <td className="cell-mono">{t.barsHeld}</td>
                      <td
                        className={`cell-mono cell-pnl ${t.pnlPct >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                      >
                        {fmtPct(t.pnlPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="backtest1-footnote">
            Sum/avg PnL % compounds path-dependent effects only as a naive sum of
            per-trade % moves — not reinvested equity. For entertainment / research;
            not a strategy recommendation.
          </p>
        </section>
      )}
    </div>
  )
}
