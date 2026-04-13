import { useCallback, useMemo, useState } from 'react'
import {
  DEFAULT_BASE_MARGIN_USD,
  DEFAULT_LEVERAGE,
  DEFAULT_MARTINGALE_MULT,
  DEFAULT_RESET_STAGE,
  DEFAULT_STOP_LOSS_PCT,
  DEFAULT_TAKE_PROFIT_PCT,
  runMartingaleBacktest,
} from './backtest4Sim'

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

function formatMoney(n) {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatTs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

export function Backtest4() {
  const [symbol, setSymbol] = useState('BTC')
  const [interval, setInterval] = useState('1h')
  const [limit, setLimit] = useState(200)
  const [baseMargin, setBaseMargin] = useState(String(DEFAULT_BASE_MARGIN_USD))
  const [leverage, setLeverage] = useState(String(DEFAULT_LEVERAGE))
  const [martingaleMult, setMartingaleMult] = useState(String(DEFAULT_MARTINGALE_MULT))
  const [resetStage, setResetStage] = useState(String(DEFAULT_RESET_STAGE))
  const [takeProfitPct, setTakeProfitPct] = useState(String(DEFAULT_TAKE_PROFIT_PCT))
  const [stopLossPct, setStopLossPct] = useState(String(DEFAULT_STOP_LOSS_PCT))
  const [side, setSide] = useState('long')
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
      const lim = Number.parseInt(String(limit), 10)
      if (!Number.isFinite(lim) || lim < 20 || lim > 1500) {
        throw new Error('Candles: use 20–1500')
      }

      const bm = Number.parseFloat(String(baseMargin).replace(/,/g, '').trim())
      if (!Number.isFinite(bm) || bm <= 0) {
        throw new Error('Base margin (USDT) must be positive')
      }
      const lev = Number.parseFloat(String(leverage).replace(/,/g, '').trim())
      if (!Number.isFinite(lev) || lev <= 0) {
        throw new Error('Leverage must be positive')
      }
      const mm = Number.parseFloat(String(martingaleMult).replace(/,/g, '').trim())
      if (!Number.isFinite(mm) || mm < 1) {
        throw new Error('Martingale multiplier must be ≥ 1')
      }
      const rs = Number.parseInt(String(resetStage).trim(), 10)
      if (!Number.isFinite(rs) || rs < 1) {
        throw new Error('Reset stage must be an integer ≥ 1 (e.g. 4 = reset after 4 losses in a row)')
      }

      const tp = Number.parseFloat(String(takeProfitPct).replace(/,/g, '').trim())
      const sl = Number.parseFloat(String(stopLossPct).replace(/,/g, '').trim())
      if (!Number.isFinite(tp) || tp <= 0) {
        throw new Error('Take profit % must be a positive number')
      }
      if (!Number.isFinite(sl) || sl <= 0) {
        throw new Error('Stop loss % must be a positive number')
      }

      const data = await fetchKlines(symbol, interval, lim)
      const candles = data.candles ?? []
      if (candles.length < 1) {
        throw new Error('No candles returned')
      }

      const { trades: t, summary: s } = runMartingaleBacktest(candles, {
        baseMarginUsd: bm,
        leverage: lev,
        martingaleMultiplier: mm,
        resetStage: rs,
        takeProfitPct: tp,
        stopLossPct: sl,
        side: side === 'short' ? 'short' : 'long',
      })

      setMeta({
        symbol: data.symbol,
        interval: data.interval,
        candleCount: candles.length,
        fetchedAt: data.fetchedAt,
        side: s.side,
      })
      setTrades(t)
      setSummary(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backtest failed')
    } finally {
      setLoading(false)
    }
  }, [
    symbol,
    interval,
    limit,
    baseMargin,
    leverage,
    martingaleMult,
    resetStage,
    takeProfitPct,
    stopLossPct,
    side,
  ])

  return (
    <div className="backtest1">
      <h1 className="backtest1-title">Backtest 4 · Martingale (reset)</h1>
      <p className="backtest1-lead">
        Single <strong>USDT-M perpetual</strong>. Choose <strong>long only</strong> or{' '}
        <strong>short only</strong> (no random direction). Entry at each trade&apos;s{' '}
        <strong>open</strong>; <strong>TP %</strong> and <strong>SL %</strong> are from entry. Long:
        TP above, SL below. Short: TP below, SL above. Each following candle&apos;s{' '}
        <strong>high/low</strong> is scanned until TP or SL hits (same bar:{' '}
        <strong>SL first</strong> if both touch). If data ends first, <strong>END</strong> uses the
        last close. <strong>Win</strong> = PnL &gt; 0. Martingale scales margin after losses;{' '}
        <strong>reset stage</strong> clears the streak. PnL = <strong>margin × leverage ×</strong>{' '}
        return to exit (no fees).
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
          <span className="backtest1-label">Side</span>
          <select
            className="backtest1-select"
            value={side}
            onChange={(e) => setSide(e.target.value)}
            disabled={loading}
          >
            <option value="long">Long only</option>
            <option value="short">Short only</option>
          </select>
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Candle interval</span>
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
          <span className="backtest1-label">Number of candles</span>
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
          <span className="backtest1-label">Base margin (USDT)</span>
          <input
            type="text"
            className="backtest1-input backtest1-input--narrow"
            inputMode="decimal"
            value={baseMargin}
            onChange={(e) => setBaseMargin(e.target.value)}
            disabled={loading}
          />
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Leverage (×)</span>
          <input
            type="text"
            className="backtest1-input backtest1-input--narrow"
            inputMode="decimal"
            value={leverage}
            onChange={(e) => setLeverage(e.target.value)}
            disabled={loading}
          />
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Take profit (% from entry)</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={0.01}
            step={0.1}
            value={takeProfitPct}
            onChange={(e) => setTakeProfitPct(e.target.value)}
            disabled={loading}
          />
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Stop loss (% from entry)</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={0.01}
            step={0.1}
            value={stopLossPct}
            onChange={(e) => setStopLossPct(e.target.value)}
            disabled={loading}
          />
          <span className="backtest1-chart-hint" style={{ marginTop: '0.35rem' }}>
            Defaults <strong>{DEFAULT_TAKE_PROFIT_PCT}%</strong> /{' '}
            <strong>{DEFAULT_STOP_LOSS_PCT}%</strong>. Intrabar via high/low.
          </span>
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Martingale multiplier</span>
          <input
            type="text"
            className="backtest1-input backtest1-input--narrow"
            inputMode="decimal"
            value={martingaleMult}
            onChange={(e) => setMartingaleMult(e.target.value)}
            disabled={loading}
          />
          <span className="backtest1-chart-hint" style={{ marginTop: '0.35rem' }}>
            Applied to <strong>margin</strong> after each loss. Use <strong>1</strong> to disable
            scaling.
          </span>
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Reset after consecutive losses</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={1}
            step={1}
            value={resetStage}
            onChange={(e) => setResetStage(e.target.value)}
            disabled={loading}
          />
          <span className="backtest1-chart-hint" style={{ marginTop: '0.35rem' }}>
            e.g. <strong>4</strong> = after 4 losses in a row, streak clears and next trade uses
            base margin.
          </span>
        </label>

        <div className="backtest1-actions">
          <button type="button" className="btn-refresh" onClick={run} disabled={loading}>
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
        <section className="backtest1-results" aria-label="Backtest 4 results">
          <h2 className="backtest1-results-title">Results</h2>
          <p className="backtest1-meta">
            <strong>{meta.symbol}</strong> ·{' '}
            <strong>{meta.side === 'short' ? 'SHORT' : 'LONG'}</strong> · {meta.interval} ·{' '}
            {meta.candleCount} candles
            {meta.fetchedAt && (
              <>
                {' '}
                · fetched {new Date(meta.fetchedAt).toLocaleString()}
              </>
            )}
          </p>

          <p className="backtest2-final-pnl" role="status">
            <span className="backtest2-final-pnl-label">Total PnL (USDT)</span>
            <span
              className={`backtest2-final-pnl-value ${summary.totalPnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
            >
              {formatMoney(summary.totalPnlUsd)}
            </span>
          </p>

          <div className="backtest1-summary-grid">
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Trades</span>
              <span className="backtest1-stat-value">{summary.count}</span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Wins / losses</span>
              <span className="backtest1-stat-value">
                {summary.wins} / {summary.losses}
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Win rate</span>
              <span className="backtest1-stat-value">{summary.winRatePct.toFixed(1)}%</span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Streak resets</span>
              <span className="backtest1-stat-value">{summary.streakResets}</span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Max margin used</span>
              <span className="backtest1-stat-value">{formatMoney(summary.maxMarginUsd)}</span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Max drawdown (cum. PnL)</span>
              <span className="backtest1-stat-value pnl-neg">
                {formatMoney(summary.maxDrawdownUsd)}
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">TP / SL / END (data end)</span>
              <span className="backtest1-stat-value">
                {summary.tpHits} / {summary.slHits} / {summary.endHits}
              </span>
            </div>
          </div>

          {trades.length > 0 && (
            <div className="table-wrap backtest1-table-wrap">
              <table className="positions-table backtest1-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Side</th>
                    <th>Entry (UTC)</th>
                    <th>Bars</th>
                    <th>Margin</th>
                    <th>Exit</th>
                    <th>Ret %</th>
                    <th>PnL</th>
                    <th>Streak</th>
                    <th>Reset</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={`${t.entryCandleIndex}-${t.exitCandleIndex}-${t.index}`}>
                      <td className="cell-mono">{t.index + 1}</td>
                      <td className={t.side === 'short' ? 'pnl-neg' : 'pnl-pos'}>
                        {t.side === 'short' ? 'SHORT' : 'LONG'}
                      </td>
                      <td className="cell-mono backtest1-ts">{formatTs(t.openTime)}</td>
                      <td className="cell-mono">{t.barsHeld}</td>
                      <td className="cell-mono">{formatMoney(t.marginUsd)}</td>
                      <td className="cell-mono">{t.exitReason}</td>
                      <td className={`cell-mono ${t.retPct >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
                        {t.retPct.toFixed(4)}%
                      </td>
                      <td
                        className={`cell-mono cell-pnl ${t.pnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                      >
                        {formatMoney(t.pnlUsd)}
                      </td>
                      <td className="cell-mono">{t.streakBefore}</td>
                      <td className="cell-mono">{t.resetAfterLoss ? 'yes' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="backtest1-footnote">
            Fixed side (long or short). TP/SL from entry, scanning forward until hit. END = last
            close if neither level touched before data ends. Martingale applies to margin;
            notional = margin × leverage. No fees, funding, or liquidation. For research only.
          </p>
        </section>
      )}
    </div>
  )
}
