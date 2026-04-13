import { useCallback, useState } from 'react'
import {
  DEFAULT_LEVERAGE,
  DEFAULT_MARGIN_USD,
  runBacktest3Simulation,
} from './backtest3Sim'

const DEFAULT_MIN_VOL = 1_000_000
const EVEN_LIMIT_PRESETS = [40, 60, 80, 100, 120, 200, 300, 500]

async function fetchDataset(minQuoteVolume, mode, limit) {
  const q = new URLSearchParams({
    minQuoteVolume: String(minQuoteVolume),
    mode,
    limit: String(limit),
  })
  const res = await fetch(`/api/binance/backtest3-dataset?${q}`, { cache: 'no-store' })
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

function formatVol(n) {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function fmtTs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

export function Backtest3() {
  const [minVol, setMinVol] = useState(String(DEFAULT_MIN_VOL))
  const [mode, setMode] = useState('above')
  const [limit, setLimit] = useState(100)
  const [marginUsd, setMarginUsd] = useState(String(DEFAULT_MARGIN_USD))
  const [leverage, setLeverage] = useState(String(DEFAULT_LEVERAGE))
  const [takeProfitPct, setTakeProfitPct] = useState('')
  const [stopLossPct, setStopLossPct] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [datasetMeta, setDatasetMeta] = useState(null)
  const [result, setResult] = useState(null)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    setDatasetMeta(null)
    setResult(null)
    try {
      const mv = Number.parseFloat(String(minVol).replace(/,/g, '').trim())
      if (!Number.isFinite(mv) || mv < 0) {
        throw new Error('Min quote volume (USDT) must be a non-negative number')
      }
      const lim = Number.parseInt(String(limit), 10)
      if (!Number.isFinite(lim) || lim < 20 || lim > 1500) {
        throw new Error('1h candles: use 20–1500 (even number)')
      }
      if (lim % 2 !== 0) {
        throw new Error('Use an even number of 1h candles (each run is 2 hours)')
      }

      const margin = Number.parseFloat(String(marginUsd).replace(/,/g, '').trim())
      if (!Number.isFinite(margin) || margin <= 0) {
        throw new Error('Margin (USDT) must be a positive number')
      }
      const lev = Number.parseFloat(String(leverage).replace(/,/g, '').trim())
      if (!Number.isFinite(lev) || lev <= 0) {
        throw new Error('Leverage must be a positive number')
      }

      const tpStr = String(takeProfitPct).trim()
      const slStr = String(stopLossPct).trim()
      const tpParsed =
        tpStr === '' ? 0 : Number.parseFloat(tpStr.replace(/,/g, ''))
      const slParsed =
        slStr === '' ? 0 : Number.parseFloat(slStr.replace(/,/g, ''))
      if (tpStr !== '' && (!Number.isFinite(tpParsed) || tpParsed < 0)) {
        throw new Error('Take profit % must be empty or a non-negative number')
      }
      if (slStr !== '' && (!Number.isFinite(slParsed) || slParsed < 0)) {
        throw new Error('Stop loss % must be empty or a non-negative number')
      }

      const data = await fetchDataset(mv, mode, lim)
      const { cycles, summary } = runBacktest3Simulation(data.candlesBySymbol, {
        marginUsd: margin,
        leverage: lev,
        takeProfitPct: tpParsed,
        stopLossPct: slParsed,
        change24hBySymbol: data.change24hBySymbol,
      })

      setDatasetMeta(data)
      setResult({ cycles, summary })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backtest failed')
    } finally {
      setLoading(false)
    }
  }, [minVol, mode, limit, marginUsd, leverage, takeProfitPct, stopLossPct])

  const cycles = result?.cycles ?? []
  const summary = result?.summary

  return (
    <div className="backtest1">
      <h1 className="backtest1-title">Backtest 3 · Volume universe, 2h cycles</h1>
      <p className="backtest1-lead">
        Loads all USDT-M <strong>perpetuals</strong> whose <strong>24h quote volume</strong>{' '}
        is {mode === 'above' ? '≥' : '≤'} your threshold. On each <strong>2-hour cycle</strong>{' '}
        (two consecutive <strong>1h</strong> candles), every coin direction is based on current{' '}
        <strong>24h change</strong>: <strong>positive = LONG</strong>, otherwise{' '}
        <strong>SHORT</strong>, entered at the <strong>first hour&apos;s open</strong> with{' '}
        <strong>margin × leverage</strong> notional (set below). Optional <strong>TP/SL %</strong>{' '}
        from entry use each hour&apos;s high/low (if both hit the same hour, SL is assumed first).
        After <strong>hour 1 closes</strong>, losing positions are closed at that close if still
        open; winners stay open until <strong>hour 2 closes</strong> unless TP/SL hits. Then the
        next cycle uses
        the next pair of hours. Number of cycles = <strong>(1h candles ÷ 2)</strong>.
      </p>

      <div className="backtest1-form">
        <label className="backtest1-field">
          <span className="backtest1-label">24h quote volume (USDT)</span>
          <input
            type="text"
            className="backtest1-input"
            inputMode="decimal"
            value={minVol}
            onChange={(e) => setMinVol(e.target.value)}
            disabled={loading}
          />
          <span className="backtest1-chart-hint" style={{ marginTop: '0.35rem' }}>
            Default <strong>1,000,000</strong>. Same metric as the volume screener.
          </span>
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Filter</span>
          <select
            className="backtest1-select"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            disabled={loading}
          >
            <option value="above">Above or equal</option>
            <option value="below">Below or equal</option>
          </select>
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">1h candles (count)</span>
          <div className="backtest1-limit-row">
            <select
              className="backtest1-select"
              value={EVEN_LIMIT_PRESETS.includes(limit) ? String(limit) : 'custom'}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'custom') return
                setLimit(Number.parseInt(v, 10))
              }}
              disabled={loading}
            >
              {EVEN_LIMIT_PRESETS.map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
              <option value="custom">Custom (even)…</option>
            </select>
            <input
              type="number"
              className="backtest1-input backtest1-input--narrow"
              min={20}
              max={1500}
              step={2}
              value={limit}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                setLimit(Number.isFinite(n) ? n : 100)
              }}
              disabled={loading}
            />
          </div>
          <span className="backtest1-chart-hint" style={{ marginTop: '0.35rem' }}>
            Must be <strong>even</strong> (pairs of hours). Max 1500.
          </span>
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Margin (USDT)</span>
          <input
            type="text"
            className="backtest1-input backtest1-input--narrow"
            inputMode="decimal"
            value={marginUsd}
            onChange={(e) => setMarginUsd(e.target.value)}
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
            type="text"
            className="backtest1-input backtest1-input--narrow"
            inputMode="decimal"
            placeholder="Off"
            value={takeProfitPct}
            onChange={(e) => setTakeProfitPct(e.target.value)}
            disabled={loading}
          />
          <span className="backtest1-chart-hint" style={{ marginTop: '0.35rem' }}>
            Empty = disabled. Checked vs 1h high/low after entry.
          </span>
        </label>

        <label className="backtest1-field">
          <span className="backtest1-label">Stop loss (% from entry)</span>
          <input
            type="text"
            className="backtest1-input backtest1-input--narrow"
            inputMode="decimal"
            placeholder="Off"
            value={stopLossPct}
            onChange={(e) => setStopLossPct(e.target.value)}
            disabled={loading}
          />
          <span className="backtest1-chart-hint" style={{ marginTop: '0.35rem' }}>
            Empty = disabled. If TP and SL both touch in one hour, SL is assumed first.
          </span>
        </label>

        <div className="backtest1-actions">
          <button type="button" className="btn-refresh" onClick={run} disabled={loading}>
            {loading ? 'Fetching & simulating…' : 'Run backtest'}
          </button>
        </div>
      </div>

      {error && (
        <div className="backtest1-error" role="alert">
          {error}
        </div>
      )}

      {loading && (
        <p className="positions-status" role="status">
          Loading 24h tickers and 1h klines for every symbol in the universe — this can take
          a while.
        </p>
      )}

      {datasetMeta && summary && (
        <section className="backtest1-results" aria-label="Backtest 3 results">
          <h2 className="backtest1-results-title">Results</h2>
          <p className="backtest1-meta">
            Volume {datasetMeta.mode === 'above' ? '≥' : '≤'}{' '}
            {formatVol(datasetMeta.minQuoteVolume)} USDT ·{' '}
            <strong>{datasetMeta.symbolCount}</strong> symbols with full{' '}
            {datasetMeta.candleLimit} × 1h candles
            {datasetMeta.symbolsCapped && (
              <>
                {' '}
                (capped from {datasetMeta.requestedSymbols}; set BACKTEST3_MAX_SYMBOLS)
              </>
            )}
            {datasetMeta.skipped > 0 && (
              <>
                {' '}
                · {datasetMeta.skipped} kline fetch failures
              </>
            )}
            {datasetMeta.fetchedAt && (
              <>
                {' '}
                · data {new Date(datasetMeta.fetchedAt).toLocaleString()}
              </>
            )}
          </p>

          <p className="backtest2-final-pnl" role="status">
            <span className="backtest2-final-pnl-label">Total PnL (all cycles, all coins)</span>
            <span
              className={`backtest2-final-pnl-value ${summary.totalPnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
            >
              {formatMoney(summary.totalPnlUsd)}
            </span>
          </p>

          <div className="backtest1-summary-grid">
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">2h cycles</span>
              <span className="backtest1-stat-value">{summary.numCycles}</span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Coins / cycle</span>
              <span className="backtest1-stat-value">{summary.symbolCount}</span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Avg PnL / cycle</span>
              <span
                className={`backtest1-stat-value ${summary.avgCyclePnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
              >
                {formatMoney(summary.avgCyclePnlUsd)}
              </span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Best cycle</span>
              <span className="backtest1-stat-value pnl-pos">{formatMoney(summary.bestCycleUsd)}</span>
            </div>
            <div className="backtest1-stat">
              <span className="backtest1-stat-label">Worst cycle</span>
              <span className="backtest1-stat-value pnl-neg">{formatMoney(summary.worstCycleUsd)}</span>
            </div>
          </div>

          {cycles.length > 0 && (
            <div className="table-wrap backtest1-table-wrap">
              <table className="positions-table backtest1-table">
                <thead>
                  <tr>
                    <th>Cycle</th>
                    <th>H1 open (UTC)</th>
                    <th>Closed H1</th>
                    <th>To H2</th>
                    <th>Cycle PnL</th>
                    <th>Cumulative</th>
                  </tr>
                </thead>
                <tbody>
                  {cycles.map((cy) => (
                    <tr key={cy.cycleIndex}>
                      <td className="cell-mono">{cy.cycleIndex + 1}</td>
                      <td className="cell-mono backtest1-ts">{fmtTs(cy.hour1OpenTime)}</td>
                      <td className="cell-mono">{cy.closedAtH1}</td>
                      <td className="cell-mono">{cy.heldToH2}</td>
                      <td
                        className={`cell-mono cell-pnl ${cy.totalPnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                      >
                        {formatMoney(cy.totalPnlUsd)}
                      </td>
                      <td
                        className={`cell-mono cell-pnl ${cy.cumulativePnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                      >
                        {formatMoney(cy.cumulativePnlUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {cycles.length > 0 && (
            <details className="backtest3-details">
              <summary className="backtest3-details-summary">
                Per-symbol detail (last cycle only)
              </summary>
              <div className="table-wrap backtest1-table-wrap">
                <table className="positions-table backtest1-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>24h %</th>
                      <th>Side</th>
                      <th>Exit</th>
                      <th>PnL %</th>
                      <th>PnL USDT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cycles[cycles.length - 1].perSymbol.map((t) => (
                      <tr key={t.symbol}>
                        <td className="cell-mono">{t.symbol}</td>
                        <td className="cell-mono">
                          {Number.isFinite(t.change24h) ? `${t.change24h.toFixed(2)}%` : '—'}
                        </td>
                        <td className={t.long ? 'pnl-pos' : 'pnl-neg'}>
                          {t.long ? 'LONG' : 'SHORT'}
                        </td>
                        <td className="cell-mono">{t.exitAt}</td>
                        <td className="cell-mono">{t.pnlPct.toFixed(4)}%</td>
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
            </details>
          )}

          <p className="backtest1-footnote">
            Direction is fixed per coin from 24h change (positive = long, else short). No fees,
            funding, or liquidation. TP/SL uses candle high/low only (no intrabar order). Server
            may cap symbol count
            (BACKTEST3_MAX_SYMBOLS, default 250). For research only.
          </p>
        </section>
      )}
    </div>
  )
}
