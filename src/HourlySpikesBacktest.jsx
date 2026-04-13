import { useCallback, useMemo, useState } from 'react'

const DEFAULT_CANDLE_COUNT = 500
const DEFAULT_MIN_VOL = 1_000_000
const DEFAULT_THRESHOLD = 3

async function fetchHourlySpikes(candleCount, minQuoteVolume, thresholdPct, spikeDirections) {
  const q = new URLSearchParams({
    candleCount: String(candleCount),
    minQuoteVolume: String(minQuoteVolume),
    thresholdPct: String(thresholdPct),
    spikeDirections: String(spikeDirections),
  })
  const res = await fetch(`/api/binance/hourly-spikes-backtest?${q}`, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function fmtInt(n) {
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString()
}

export function HourlySpikesBacktest() {
  const [candleCount, setCandleCount] = useState(String(DEFAULT_CANDLE_COUNT))
  const [minVol, setMinVol] = useState(String(DEFAULT_MIN_VOL))
  const [threshold, setThreshold] = useState(String(DEFAULT_THRESHOLD))
  const [spikeDirections, setSpikeDirections] = useState('up')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const cc = Number.parseInt(String(candleCount).replace(/,/g, ''), 10)
      const mv = Number.parseFloat(String(minVol).replace(/,/g, ''))
      const th = Number.parseFloat(String(threshold))
      const result = await fetchHourlySpikes(cc, mv, th, spikeDirections)
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [candleCount, minVol, threshold, spikeDirections])

  const utcHourMax = useMemo(() => {
    const arr = data?.spikesByUtcHour
    if (!Array.isArray(arr) || arr.length === 0) return 1
    let m = 0
    for (const x of arr) {
      if (x.spikeCount > m) m = x.spikeCount
    }
    return m > 0 ? m : 1
  }, [data])

  return (
    <div className="vol-screener hourly-spikes">
      <h1 className="vol-screener-title">Hourly spikes</h1>
      <p className="vol-screener-lead">
        USDT-M <strong>1h</strong> candles: filter symbols by <strong>24h quote volume</strong>, fetch
        up to <strong>1500</strong> hourly bars each, flag wick spikes vs open above your
        threshold, then aggregate <strong>spike counts per hour (UTC)</strong> and per candle
        interval across filtered markets.
      </p>

      <div className="vol-screener-form">
        <label className="vol-screener-field">
          <span className="vol-screener-label">Min 24h volume (USDT)</span>
          <input
            className="vol-screener-input"
            type="text"
            inputMode="numeric"
            value={minVol}
            onChange={(e) => setMinVol(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Hourly candles per symbol</span>
          <input
            className="vol-screener-input"
            type="text"
            inputMode="numeric"
            value={candleCount}
            onChange={(e) => setCandleCount(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Wick vs open ≥ (%)</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="text"
            inputMode="decimal"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Directions</span>
          <select
            className="vol-screener-input"
            value={spikeDirections}
            onChange={(e) => setSpikeDirections(e.target.value)}
          >
            <option value="up">Up wick only</option>
            <option value="down">Down wick only</option>
            <option value="both">Both</option>
          </select>
        </label>
        <div className="vol-screener-actions">
          <button
            type="button"
            className="btn-refresh"
            onClick={run}
            disabled={loading}
          >
            {loading ? 'Running…' : 'Run scan'}
          </button>
        </div>
      </div>

      {error && (
        <p className="vol-screener-warn" role="alert">
          {error}
        </p>
      )}

      {data && !error && (
        <>
          <p className="vol-screener-meta">
            Fetched {fmtInt(data.symbolCount)} symbols (≥ {fmtInt(data.minQuoteVolume)} USDT 24h
            vol){data.symbolsCapped ? ` · capped at ${data.cappedAt}` : ''}
            {data.skipped > 0 ? ` · ${data.skipped} fetch errors` : ''} · threshold{' '}
            <strong>{data.thresholdPct}%</strong> · <strong>{data.spikeDirections}</strong> ·{' '}
            <strong>{data.candleCount}</strong> × 1h bars · total spikes{' '}
            <strong>{fmtInt(data.totalSpikes)}</strong>
          </p>

          <section className="hourly-spikes-section" aria-label="Spikes by UTC hour">
            <h2 className="hourly-spikes-h2">Spikes per UTC hour of day (0–23)</h2>
            <p className="hourly-spikes-hint">
              Counts all spike events whose candle <code className="inline-code">openTime</code>{' '}
              falls in that clock hour (UTC), across the sample.
            </p>
            <div className="hourly-spikes-bars" role="img" aria-label="Histogram by UTC hour">
              {data.spikesByUtcHour.map(({ utcHour, spikeCount }) => (
                <div key={utcHour} className="hourly-spikes-bar-wrap">
                  <div
                    className="hourly-spikes-bar"
                    style={{ height: `${(spikeCount / utcHourMax) * 100}%` }}
                    title={`${utcHour}:00 UTC — ${spikeCount} spikes`}
                  />
                  <span className="hourly-spikes-bar-label">{utcHour}</span>
                </div>
              ))}
            </div>
            <div className="table-wrap hourly-spikes-table-wrap">
              <table className="positions-table hourly-spikes-hour-table">
                <thead>
                  <tr>
                    <th>UTC hour</th>
                    <th className="cell-right">Spikes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.spikesByUtcHour.map(({ utcHour, spikeCount }) => (
                    <tr key={utcHour}>
                      <td className="cell-mono">
                        {String(utcHour).padStart(2, '0')}:00
                      </td>
                      <td className="cell-mono cell-right">{fmtInt(spikeCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="hourly-spikes-section" aria-label="Spikes per candle interval">
            <h2 className="hourly-spikes-h2">Spikes per 1h candle (interval)</h2>
            <p className="hourly-spikes-hint">
              Each row is one global 1h open time: how many spike events occurred in that hour
              across all filtered symbols.
            </p>
            <div className="table-wrap hourly-spikes-table-scroll">
              <table className="positions-table">
                <thead>
                  <tr>
                    <th>Candle open (local)</th>
                    <th className="cell-right">Spikes</th>
                    <th className="cell-right">Symbols w/ spike</th>
                    <th className="cell-right">Spikes / symbol (avg)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.timeline.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="hourly-spikes-empty">
                        No spikes in range.
                      </td>
                    </tr>
                  ) : (
                    [...data.timeline]
                      .sort((a, b) => b.openTime - a.openTime)
                      .map((t) => (
                        <tr key={t.openTime}>
                          <td className="cell-mono">{fmtTime(t.openTime)}</td>
                          <td className="cell-mono cell-right">{fmtInt(t.spikeCount)}</td>
                          <td className="cell-mono cell-right">
                            {fmtInt(t.uniqueSymbolCount)}
                          </td>
                          <td className="cell-mono cell-right">
                            {t.uniqueSymbolCount > 0
                              ? (t.spikeCount / t.uniqueSymbolCount).toFixed(2)
                              : '—'}
                          </td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="hourly-spikes-section" aria-label="Per symbol">
            <h2 className="hourly-spikes-h2">Per symbol</h2>
            <div className="table-wrap hourly-spikes-table-scroll">
              <table className="positions-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="cell-right">24h vol</th>
                    <th className="cell-right">Spikes</th>
                    <th className="cell-right">Spikes / candle</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.symbol}>
                      <td className="cell-mono">{r.symbol}</td>
                      <td className="cell-mono cell-right">
                        {fmtInt(r.quoteVolume24h)}
                      </td>
                      <td className="cell-mono cell-right">{fmtInt(r.spikeCount)}</td>
                      <td className="cell-mono cell-right">
                        {r.candleCount > 0
                          ? `${(r.spikeCount / r.candleCount).toFixed(3)}`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
