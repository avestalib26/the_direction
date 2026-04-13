import { useCallback, useEffect, useMemo, useState } from 'react'

const DEFAULT_QUOTE_VOLUME_USDT = 1_000_000

async function fetch24hVolumes() {
  const res = await fetch('/api/binance/futures-24h-volumes', { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function formatVol(n) {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function formatPx(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const d = abs >= 1 ? 4 : 8
  return n.toLocaleString(undefined, { maximumFractionDigits: d })
}

function formatPct(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  const s = n >= 0 ? '+' : ''
  return `${s}${n.toFixed(2)}%`
}

export function VolumeScreener() {
  const [volumeInput, setVolumeInput] = useState(String(DEFAULT_QUOTE_VOLUME_USDT))
  const [mode, setMode] = useState('above')
  const [rows, setRows] = useState([])
  const [fetchedAt, setFetchedAt] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetch24hVolumes()
      setRows(Array.isArray(data.rows) ? data.rows : [])
      setFetchedAt(data.fetchedAt ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
      setRows([])
      setFetchedAt(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const threshold = useMemo(() => {
    const n = Number.parseFloat(String(volumeInput).replace(/,/g, '').trim())
    return Number.isFinite(n) && n >= 0 ? n : null
  }, [volumeInput])

  const filtered = useMemo(() => {
    if (threshold == null) return []
    if (mode === 'above') {
      return rows.filter((r) => r.quoteVolume24h >= threshold)
    }
    return rows.filter((r) => r.quoteVolume24h <= threshold)
  }, [rows, threshold, mode])

  return (
    <div className="vol-screener">
      <h1 className="vol-screener-title">24h volume screener</h1>
      <p className="vol-screener-lead">
        USDT-M <strong>perpetual</strong> pairs only. Volume is Binance{' '}
        <strong>24h quote volume</strong> in <strong>USDT</strong> (not base-asset
        units). Compare each symbol&apos;s volume to your threshold.
      </p>

      <div className="vol-screener-form">
        <label className="vol-screener-field">
          <span className="vol-screener-label">Min / max volume (USDT, 24h)</span>
          <input
            type="text"
            className="vol-screener-input"
            inputMode="decimal"
            value={volumeInput}
            onChange={(e) => setVolumeInput(e.target.value)}
            placeholder="1000000"
            disabled={loading}
            autoComplete="off"
          />
          <span className="vol-screener-hint">
            Default <strong>1,000,000</strong> (1M USDT 24h quote volume).
          </span>
        </label>

        <fieldset className="vol-screener-toggle">
          <legend className="vol-screener-legend">Filter</legend>
          <div className="vol-screener-toggle-row" role="group" aria-label="Above or below threshold">
            <button
              type="button"
              className={`vol-screener-mode ${mode === 'above' ? 'vol-screener-mode--active' : ''}`}
              onClick={() => setMode('above')}
              disabled={loading}
            >
              Above or equal
            </button>
            <button
              type="button"
              className={`vol-screener-mode ${mode === 'below' ? 'vol-screener-mode--active' : ''}`}
              onClick={() => setMode('below')}
              disabled={loading}
            >
              Below or equal
            </button>
          </div>
          <p className="vol-screener-toggle-hint">
            <strong>Above or equal</strong>: quote volume ≥ threshold.{' '}
            <strong>Below or equal</strong>: quote volume ≤ threshold.
          </p>
        </fieldset>

        <div className="vol-screener-actions">
          <button
            type="button"
            className="btn-refresh"
            onClick={load}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Refresh data'}
          </button>
        </div>
      </div>

      {loading && rows.length === 0 && !error && (
        <p className="positions-status" role="status">
          Loading 24h ticker data…
        </p>
      )}

      {error && (
        <div className="positions-error" role="alert">
          <p className="positions-error-title">Could not load 24h data</p>
          <p className="positions-error-msg">{error}</p>
        </div>
      )}

      {fetchedAt && !error && (
        <p className="positions-meta vol-screener-meta">
          Updated {new Date(fetchedAt).toLocaleString()} ·{' '}
          <strong>{rows.length}</strong> perpetual USDT pairs · showing{' '}
          <strong>{filtered.length}</strong> with{' '}
          {mode === 'above' ? '≥' : '≤'}{' '}
          {threshold != null ? formatVol(threshold) : '—'} USDT
        </p>
      )}

      {!loading && rows.length > 0 && threshold == null && (
        <p className="vol-screener-warn" role="status">
          Enter a valid non‑negative number for the volume threshold.
        </p>
      )}

      {rows.length > 0 && threshold != null && filtered.length === 0 && (
        <p className="positions-empty">
          No pairs match this filter. Try another threshold or switch above/below.
        </p>
      )}

      {rows.length > 0 && threshold != null && filtered.length > 0 && (
        <div className="table-wrap vol-screener-table-wrap">
          <table className="positions-table vol-screener-table zebra">
            <thead>
              <tr>
                <th>#</th>
                <th>Symbol</th>
                <th>24h volume (USDT)</th>
                <th>Last</th>
                <th>24h %</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.symbol}>
                  <td className="cell-mono">{i + 1}</td>
                  <td className="cell-mono">{r.symbol}</td>
                  <td className="cell-mono">{formatVol(r.quoteVolume24h)}</td>
                  <td className="cell-mono">{formatPx(r.lastPrice)}</td>
                  <td
                    className={`cell-mono cell-pnl ${
                      r.priceChangePercent == null
                        ? ''
                        : r.priceChangePercent >= 0
                          ? 'pnl-pos'
                          : 'pnl-neg'
                    }`}
                  >
                    {formatPct(r.priceChangePercent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <p className="positions-empty">
          No data yet. Click <strong>Refresh data</strong>.
        </p>
      )}
    </div>
  )
}
