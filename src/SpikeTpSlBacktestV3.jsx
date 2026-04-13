import { useCallback, useState } from 'react'
import {
  SpikeTpSlV3BtcDailyChart,
  SpikeTpSlV3CumulativeLineChart,
  SpikeTpSlV3TradesHistogramChart,
} from './spikeTpSlV3Charts.jsx'

const DEFAULT_THRESHOLD = 3
/** Must match server SPIKE_TPSL_V3_MAX_RANGE_DAYS */
const MAX_RANGE_DAYS_UTC = 31

function parseUtcDayStart(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = Date.UTC(y, mo - 1, d)
  if (
    new Date(t).getUTCFullYear() !== y ||
    new Date(t).getUTCMonth() !== mo - 1 ||
    new Date(t).getUTCDate() !== d
  ) {
    return null
  }
  return t
}

/** @returns {string | null} */
function validateRange(fromDate, toDate) {
  const f = String(fromDate ?? '').trim()
  const t = String(toDate ?? '').trim()
  if (!f || !t) return 'Set both From and To (UTC dates).'
  const fromMs = parseUtcDayStart(f)
  const toDayStart = parseUtcDayStart(t)
  if (fromMs == null || toDayStart == null) {
    return 'From and To must be valid YYYY-MM-DD (UTC).'
  }
  if (fromMs > toDayStart + 86400000 - 1) {
    return 'From must be on or before To.'
  }
  const spanDays = (toDayStart + 86400000 - fromMs) / 86400000
  if (spanDays > MAX_RANGE_DAYS_UTC) {
    return `Range cannot exceed ${MAX_RANGE_DAYS_UTC} UTC days (inclusive).`
  }
  return null
}

const INTERVAL_OPTIONS = [
  { value: '5m', label: '5m (heavy)' },
  { value: '15m', label: '15m (recommended)' },
  { value: '30m', label: '30m' },
  { value: '1h', label: '1h' },
  { value: '2h', label: '2h' },
  { value: '4h', label: '4h' },
]

async function fetchV3(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v == null) continue
    q.set(k, String(v))
  }
  const res = await fetch(`/api/binance/spike-tpsl-backtest-v3?${q}`, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function fmtInt(n) {
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return '—'
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`
}

function fmtR(x) {
  if (x == null || !Number.isFinite(x)) return '—'
  return `${x.toFixed(2)}R`
}

export function SpikeTpSlBacktestV3() {
  const [interval, setInterval] = useState('15m')
  const [thresholdPct, setThresholdPct] = useState(String(DEFAULT_THRESHOLD))
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [strategy, setStrategy] = useState('long')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const re = validateRange(fromDate, toDate)
      if (re) throw new Error(re)
      const th = Number.parseFloat(String(thresholdPct))
      const out = await fetchV3({
        fromDate: String(fromDate).trim(),
        toDate: String(toDate).trim(),
        interval,
        thresholdPct: th,
        strategy,
      })
      setData(out)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }, [fromDate, toDate, interval, thresholdPct, strategy])

  const sm = data?.summaryMonth

  return (
    <div className="vol-screener spike-tpsl-bt spike-tpsl-v3">
      <h1 className="vol-screener-title">2R backtest v3 (monthly)</h1>
      <p className="vol-screener-lead">
        <strong>No volume filter</strong>: scans the first <strong>N</strong> USDT-M perpetuals (alphabetical,
        cap via <code className="inline-code">SPIKE_TPSL_V3_MAX_SYMBOLS</code>, default 80). Fetches your full{' '}
        <strong>UTC date range</strong> (up to {MAX_RANGE_DAYS_UTC} inclusive days) at the chosen intraday
        timeframe with <strong>paged klines</strong> and conservative concurrency (
        <code className="inline-code">SPIKE_TPSL_V3_CONCURRENCY</code>, default 2). Same spike / 2R rules as v1;
        trades are grouped by <strong>entry day</strong> (UTC). Response includes daily metrics, cumulative Σ
        price %, and <strong>BTCUSDT 1d</strong> candles for comparison.
      </p>
      <p className="hourly-spikes-hint spike-tpsl-api-hint">
        Large jobs: prefer <strong>15m+</strong> and lower symbol cap if you hit rate limits or timeouts. Optional{' '}
        <code className="inline-code">SPIKE_TPSL_V3_PAGE_DELAY_MS</code> between kline pages (same family as other
        spike env vars).
      </p>

      <div className="vol-screener-form">
        <label className="vol-screener-field">
          <span className="vol-screener-label">From (UTC)</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">To (UTC)</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Timeframe</span>
          <select
            className="vol-screener-input"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Min spike body (% vs open)</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="text"
            inputMode="decimal"
            value={thresholdPct}
            onChange={(e) => setThresholdPct(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Side</span>
          <select
            className="vol-screener-input"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
          >
            <option value="long">Long — TP +2R / SL −1R (green spike)</option>
            <option value="shortSpikeLow">Short — TP spike low / SL +2R (green spike)</option>
            <option value="shortRedSpike">Short — TP −2R / SL +1R (red spike)</option>
          </select>
        </label>
        <div className="vol-screener-actions">
          <button type="button" className="btn-refresh" onClick={run} disabled={loading}>
            {loading ? 'Running…' : 'Run month backtest'}
          </button>
        </div>
        <p className="hourly-spikes-hint spike-tpsl-range-hint">
          Max <strong>{MAX_RANGE_DAYS_UTC} UTC days</strong> inclusive (~one month). Example: 30-day window =30
          calendar days from first through last date.
        </p>
      </div>

      {error && (
        <p className="vol-screener-warn" role="alert">
          {error}
        </p>
      )}

      {data && !error && (
        <>
          <p className="vol-screener-meta">
            <strong>{data.interval}</strong> · UTC <strong>{data.fromDate}</strong> → <strong>{data.toDate}</strong>{' '}
            · body ≥ <strong>{data.thresholdPct}%</strong> · <strong>{fmtInt(data.symbolCount)}</strong> symbols
            OK
            {data.symbolsCapped ? ` (capped ${data.cappedAt} of ${fmtInt(data.requestedSymbols)})` : ''}
            {data.skipped > 0 ? ` · ${data.skipped} symbol errors` : ''}
            {data.binancePublicApiKeySent ? ' · API key header on' : ''}
            {sm?.sumPricePct != null && Number.isFinite(sm.sumPricePct) ? (
              <>
                {' '}
                · month Σ price %{' '}
                <strong className={sm.sumPricePct >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                  {fmtPct(sm.sumPricePct)}
                </strong>
              </>
            ) : null}
          </p>

          {sm && (
            <div className="backtest1-summary-grid spike-tpsl-summary spike-tpsl-v3-summary">
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Total trades (month)</span>
                <span className="backtest1-stat-value">{fmtInt(sm.totalTrades)}</span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">{data.tpStatLabel ?? 'TP'}</span>
                <span className="backtest1-stat-value pnl-pos">{fmtInt(sm.tpHits)}</span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">{data.slStatLabel ?? 'SL'}</span>
                <span className="backtest1-stat-value pnl-neg">{fmtInt(sm.slHits)}</span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">EOD</span>
                <span className="backtest1-stat-value">{fmtInt(sm.eodHits)}</span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Sum R</span>
                <span className={`backtest1-stat-value ${(sm.sumR ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
                  {fmtR(sm.sumR)}
                </span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Wins / losses / BE</span>
                <span className="backtest1-stat-value">
                  {fmtInt(sm.winningTrades)} / {fmtInt(sm.losingTrades)} / {fmtInt(sm.breakevenTrades)}
                </span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Max bars / symbol</span>
                <span className="backtest1-stat-value">{fmtInt(data.maxSymbolBarCount)}</span>
              </div>
            </div>
          )}

          <section className="hourly-spikes-section spike-tpsl-v3-charts">
            <h2 className="hourly-spikes-h2">Daily cumulative Σ price %</h2>
            <SpikeTpSlV3CumulativeLineChart daily={data.daily} />
            <h3 className="hourly-spikes-h3 spike-tpsl-v3-h3">Trades opened per day</h3>
            <SpikeTpSlV3TradesHistogramChart daily={data.daily} />
            <h2 className="hourly-spikes-h2">BTCUSDT daily (compare)</h2>
            <SpikeTpSlV3BtcDailyChart btcDaily={data.btcDaily} />
          </section>

          <section className="hourly-spikes-section">
            <h2 className="hourly-spikes-h2">Daily breakdown (UTC)</h2>
            <div className="table-wrap hourly-spikes-table-scroll">
              <table className="positions-table spike-tpsl-v3-daily-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="cell-right">Trades</th>
                    <th className="cell-right">Day Σ %</th>
                    <th className="cell-right">Cum Σ %</th>
                    <th className="cell-right">Ref 100+Σ</th>
                    <th className="cell-right">TP</th>
                    <th className="cell-right">SL</th>
                    <th className="cell-right">EOD</th>
                    <th className="cell-right">W / L / BE</th>
                    <th className="cell-right">Sum R</th>
                    <th className="cell-right">TP/(TP+SL)</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.daily ?? []).map((r) => (
                    <tr key={r.date}>
                      <td className="cell-mono">{r.date}</td>
                      <td className="cell-mono cell-right">{fmtInt(r.totalTrades)}</td>
                      <td
                        className={`cell-mono cell-right ${
                          r.sumPricePct > 0 ? 'pnl-pos' : r.sumPricePct < 0 ? 'pnl-neg' : ''
                        }`}
                      >
                        {fmtPct(r.sumPricePct)}
                      </td>
                      <td
                        className={`cell-mono cell-right ${
                          r.cumulativeSumPricePct > 0
                            ? 'pnl-pos'
                            : r.cumulativeSumPricePct < 0
                              ? 'pnl-neg'
                              : ''
                        }`}
                      >
                        {fmtPct(r.cumulativeSumPricePct)}
                      </td>
                      <td className="cell-mono cell-right">
                        {r.referenceEquityPct != null && Number.isFinite(r.referenceEquityPct)
                          ? r.referenceEquityPct.toFixed(2)
                          : '—'}
                      </td>
                      <td className="cell-mono cell-right pnl-pos">{fmtInt(r.tpHits)}</td>
                      <td className="cell-mono cell-right pnl-neg">{fmtInt(r.slHits)}</td>
                      <td className="cell-mono cell-right">{fmtInt(r.eodHits)}</td>
                      <td className="cell-mono cell-right">
                        {fmtInt(r.winningTrades)}/{fmtInt(r.losingTrades)}/{fmtInt(r.breakevenTrades)}
                      </td>
                      <td
                        className={`cell-mono cell-right ${r.sumR >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                      >
                        {fmtR(r.sumR)}
                      </td>
                      <td className="cell-mono cell-right">
                        {r.winRateTpVsSlPct != null && Number.isFinite(r.winRateTpVsSlPct)
                          ? `${r.winRateTpVsSlPct.toFixed(1)}%`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {data.perSymbol?.length > 0 && (
            <section className="hourly-spikes-section">
              <h2 className="hourly-spikes-h2">Per symbol (month)</h2>
              {data.perSymbolTruncated && (
                <p className="hourly-spikes-hint">
                  Showing {data.perSymbol.length} symbols (list truncated in API).
                </p>
              )}
              <div className="table-wrap hourly-spikes-table-scroll">
                <table className="positions-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th className="cell-right">Bars</th>
                      <th className="cell-right">Trades</th>
                      <th className="cell-right">TP</th>
                      <th className="cell-right">SL</th>
                      <th className="cell-right">EOD</th>
                      <th className="cell-right">Sum R</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perSymbol.map((r) => (
                      <tr key={r.symbol}>
                        <td className="cell-mono">{r.symbol}</td>
                        <td className="cell-mono cell-right">{fmtInt(r.candleCount)}</td>
                        <td className="cell-mono cell-right">{fmtInt(r.tradeCount)}</td>
                        <td className="cell-mono cell-right pnl-pos">{fmtInt(r.tpCount)}</td>
                        <td className="cell-mono cell-right pnl-neg">{fmtInt(r.slCount)}</td>
                        <td className="cell-mono cell-right">{fmtInt(r.eodCount)}</td>
                        <td
                          className={`cell-mono cell-right ${r.sumR >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                        >
                          {Number.isFinite(r.sumR) ? r.sumR.toFixed(2) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
