import { useCallback, useMemo, useState } from 'react'
import { Backtest2WeightedChart } from './Backtest2CumulativeChart'
import {
  DEFAULT_LEVERAGE,
  DEFAULT_MARGIN_USD,
  runMartingaleBacktest,
} from './backtest2Sim'

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

const DIRECTION_OPTIONS = [
  { value: 'random', label: 'Random (long or short)' },
  { value: 'long', label: 'Long only' },
  { value: 'short', label: 'Short only' },
]

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

function formatMoney(n) {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export function Backtest2() {
  const [symbol, setSymbol] = useState('BTC')
  const [interval, setInterval] = useState('1h')
  const [limit, setLimit] = useState(200)
  const [tpPct, setTpPct] = useState(2)
  const [slPct, setSlPct] = useState(1)
  const [martingaleMult, setMartingaleMult] = useState('2')
  const [marginUsd, setMarginUsd] = useState(String(DEFAULT_MARGIN_USD))
  const [leverage, setLeverage] = useState(String(DEFAULT_LEVERAGE))
  const [directionMode, setDirectionMode] = useState('random')
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
      const mm = Number.parseFloat(String(martingaleMult).trim())
      if (!Number.isFinite(tp) || tp <= 0) {
        throw new Error('Take-profit % must be a positive number')
      }
      if (!Number.isFinite(sl) || sl <= 0) {
        throw new Error('Stop-loss % must be a positive number')
      }
      if (!Number.isFinite(mm) || mm < 1) {
        throw new Error('Martingale multiplier must be at least 1')
      }
      const margin = Number.parseFloat(String(marginUsd).trim())
      const lev = Number.parseFloat(String(leverage).trim())
      if (!Number.isFinite(margin) || margin <= 0) {
        throw new Error('Margin (USDT) must be a positive number')
      }
      if (!Number.isFinite(lev) || lev <= 0) {
        throw new Error('Leverage must be a positive number')
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

      const { trades: t, summary: s } = runMartingaleBacktest(candles, {
        tpPct: tp,
        slPct: sl,
        martingaleMultiplier: mm,
        startMarginUsd: margin,
        leverage: lev,
        directionMode,
      })

      setMeta({
        symbol: data.symbol,
        interval: data.interval,
        candleCount: candles.length,
        fetchedAt: data.fetchedAt,
        martingaleMultiplier: mm,
        marginUsd: margin,
        leverage: lev,
        baseNotionalUsd: s.baseNotionalUsd,
        directionMode,
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
    tpPct,
    slPct,
    martingaleMult,
    marginUsd,
    leverage,
    directionMode,
  ])

  return (
    <div className="backtest1">
      <h1 className="backtest1-title">Backtest 2 · Martingale (stake sizing)</h1>
      <p className="backtest1-lead">
        Same mechanics as Backtest 1: each trade opens at the candle{' '}
        <strong>open</strong> as <strong>LONG</strong>, <strong>SHORT</strong>, or{' '}
        <strong>random</strong> (your choice below), exit on <strong>TP</strong>/
        <strong>SL</strong> (% vs entry), same-bar conflict → <strong>SL</strong>{' '}
        first. <strong>Sizing:</strong> default{' '}
        <strong>${DEFAULT_MARGIN_USD}</strong> margin at{' '}
        <strong>{DEFAULT_LEVERAGE}×</strong> → <strong>$1,000</strong> base notional
        per unit stake. <strong>Martingale:</strong> stake starts at{' '}
        <strong>1×</strong> that notional; after a <strong>loss</strong>, stake ×
        multiplier; after a <strong>win</strong>, reset to 1.{' '}
        <strong>USDT PnL</strong> per trade = notional × (PnL % ÷ 100).
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
          <span className="backtest1-label">Direction</span>
          <select
            className="backtest1-select"
            value={directionMode}
            onChange={(e) => setDirectionMode(e.target.value)}
            disabled={loading}
          >
            {DIRECTION_OPTIONS.map((o) => (
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

        <label className="backtest1-field">
          <span className="backtest1-label">Margin (USDT)</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={0.01}
            step={1}
            value={marginUsd}
            onChange={(e) => setMarginUsd(e.target.value)}
            disabled={loading}
          />
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Leverage (×)</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={1}
            step={1}
            value={leverage}
            onChange={(e) => setLeverage(e.target.value)}
            disabled={loading}
          />
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Martingale multiplier</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={1}
            step={0.1}
            value={martingaleMult}
            onChange={(e) => setMartingaleMult(e.target.value)}
            disabled={loading}
          />
        </label>
        <p className="backtest1-chart-hint backtest2-martingale-hint">
          Default <strong>2</strong> (double stake after each loss). Use{' '}
          <strong>1</strong> for fixed unit size (no martingale).
        </p>

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
            candles ·{' '}
            {meta.directionMode === 'random'
              ? 'random direction'
              : meta.directionMode === 'long'
                ? 'long only'
                : 'short only'}{' '}
            · {formatMoney(meta.marginUsd)} margin × {meta.leverage}× ≈{' '}
            {formatMoney(meta.baseNotionalUsd)} notional (1× stake) · martingale ×
            {meta.martingaleMultiplier}
            {meta.fetchedAt && (
              <>
                {' '}
                · fetched {new Date(meta.fetchedAt).toLocaleString()}
              </>
            )}
          </p>

          <p className="backtest2-final-pnl" role="status">
            <span className="backtest2-final-pnl-label">Final PnL (after backtest)</span>
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
              <span className="backtest1-stat-label">Max stake (× base notional)</span>
              <span className="backtest1-stat-value">
                {summary.maxStake.toLocaleString(undefined, {
                  maximumFractionDigits: 4,
                })}
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Max notional (USDT)</span>
              <span className="backtest1-stat-value">
                {formatMoney(summary.maxNotionalUsd)}
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Avg PnL / trade (USDT)</span>
              <span
                className={`backtest1-stat-value ${summary.avgPnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
              >
                {formatMoney(summary.avgPnlUsd)}
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

          <Backtest2WeightedChart trades={trades} />

          {trades.length > 0 && (
            <div className="table-wrap backtest1-table-wrap">
              <table className="positions-table backtest1-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Stake</th>
                    <th>Dir</th>
                    <th>Entry time</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Outcome</th>
                    <th>Bars</th>
                    <th>PnL %</th>
                    <th>Notional</th>
                    <th>PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.tradeNum}>
                      <td className="cell-mono">{t.tradeNum}</td>
                      <td className="cell-mono">{t.stake.toFixed(4)}</td>
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
                      <td className="cell-mono">{formatMoney(t.notionalUsd)}</td>
                      <td
                        className={`cell-mono cell-pnl ${t.pnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                      >
                        {formatMoney(t.pnlUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="backtest1-footnote">
            Random direction each trade (like Backtest 1). USDT PnL assumes{' '}
            <strong>linear PnL vs notional</strong> (no fees, funding, or
            liquidation). Real futures have margin requirements that may cap
            position size; this model is for research only, not advice.
          </p>
        </section>
      )}
    </div>
  )
}
