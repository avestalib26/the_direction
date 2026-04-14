import { useCallback, useEffect, useMemo, useState } from 'react'

/** Must match server `AGENT1_SCAN_INTERVALS` / `AGENT1_INTERVAL_MS`. */
const AGENT1_INTERVAL_MS = Object.freeze({
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
})

const AGENT1_SCAN_INTERVAL_OPTIONS = Object.freeze([
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
])

function maxSecondsBeforeCloseForInterval(interval) {
  const ms = AGENT1_INTERVAL_MS[interval] ?? AGENT1_INTERVAL_MS['5m']
  return Math.min(299, Math.floor(ms / 1000) - 1)
}

async function fetchAgent1Settings() {
  const res = await fetch('/api/agents/agent1/settings', { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data.settings
}

async function saveAgent1Settings(payload) {
  const res = await fetch('/api/agents/agent1/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data.settings
}

async function fetchScanStatus() {
  const res = await fetch('/api/agents/agent1/scan-status', { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

async function fetchSpikes() {
  const res = await fetch('/api/agents/agent1/spikes?limit=200', { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data.spikes ?? []
}

async function patchSpikeTradeTaken(id, tradeTaken) {
  const res = await fetch(`/api/agents/agent1/spikes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tradeTaken }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data.spike
}

const IST_TZ = 'Asia/Kolkata'

/** Wall-clock time in India Standard Time (IST), independent of the viewer's locale. */
function fmtIst(msOrIso) {
  if (msOrIso == null) return '—'
  const d = typeof msOrIso === 'number' ? new Date(msOrIso) : new Date(msOrIso)
  if (Number.isNaN(d.getTime())) return '—'
  return (
    d.toLocaleString('en-GB', {
      timeZone: IST_TZ,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) + ' IST'
  )
}

export function Agent1() {
  const [tradeSizeUsd, setTradeSizeUsd] = useState('1')
  const [leverage, setLeverage] = useState('10')
  const [marginMode, setMarginMode] = useState('cross')
  const [maxTpPct, setMaxTpPct] = useState('1.5')
  const [maxSlPct, setMaxSlPct] = useState('1')
  const [scanInterval, setScanInterval] = useState('5m')
  const [scanSecondsBeforeClose, setScanSecondsBeforeClose] = useState('20')
  const [scanThresholdPct, setScanThresholdPct] = useState('3')
  const [scanMinQuoteVolume, setScanMinQuoteVolume] = useState('0')
  const [scanMaxSymbols, setScanMaxSymbols] = useState('800')
  const [scanSpikeMetric, setScanSpikeMetric] = useState('body')
  const [scanDirection, setScanDirection] = useState('both')
  const [agentEnabled, setAgentEnabled] = useState(true)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState('')

  const [scanStatus, setScanStatus] = useState(null)
  const [spikes, setSpikes] = useState([])
  const [spikesLoading, setSpikesLoading] = useState(true)
  const [spikesError, setSpikesError] = useState('')
  const [togglingId, setTogglingId] = useState('')

  const maxScanSecondsBeforeClose = useMemo(
    () => maxSecondsBeforeCloseForInterval(scanInterval),
    [scanInterval],
  )

  const loadSpikes = useCallback(async () => {
    setSpikesError('')
    try {
      const rows = await fetchSpikes()
      setSpikes(rows)
    } catch (e) {
      setSpikesError(e instanceof Error ? e.message : 'Failed to load spikes')
      setSpikes([])
    } finally {
      setSpikesLoading(false)
    }
  }, [])

  const loadScanStatus = useCallback(async () => {
    try {
      const st = await fetchScanStatus()
      setScanStatus(st)
    } catch {
      setScanStatus(null)
    }
  }, [])

  useEffect(() => {
    let off = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const s = await fetchAgent1Settings()
        if (off) return
        setTradeSizeUsd(String(s.tradeSizeUsd ?? '1'))
        setLeverage(String(s.leverage ?? '10'))
        setMarginMode(String(s.marginMode ?? 'cross'))
        setMaxTpPct(String(s.maxTpPct ?? '1.5'))
        setMaxSlPct(String(s.maxSlPct ?? '1'))
        const loadedInterval = String(s.scanInterval ?? '5m').trim()
        setScanInterval(
          AGENT1_INTERVAL_MS[loadedInterval] != null ? loadedInterval : '5m',
        )
        setScanSecondsBeforeClose(String(s.scanSecondsBeforeClose ?? '20'))
        setScanThresholdPct(String(s.scanThresholdPct ?? '3'))
        setScanMinQuoteVolume(String(s.scanMinQuoteVolume ?? '0'))
        setScanMaxSymbols(String(s.scanMaxSymbols ?? '800'))
        setScanSpikeMetric(String(s.scanSpikeMetric ?? 'body'))
        setScanDirection(String(s.scanDirection ?? 'both'))
        setAgentEnabled(s.agentEnabled !== false)
        setSavedAt(String(s.updatedAt ?? ''))
      } catch (e) {
        if (!off) setError(e instanceof Error ? e.message : 'Failed to load Agent 1 settings')
      } finally {
        if (!off) setLoading(false)
      }
    }
    load()
    loadSpikes()
    loadScanStatus()
    const iv = setInterval(() => {
      loadScanStatus()
      loadSpikes()
    }, 30_000)
    return () => {
      off = true
      clearInterval(iv)
    }
  }, [loadSpikes, loadScanStatus])

  useEffect(() => {
    const onHeaderToggle = () => {
      loadScanStatus()
      ;(async () => {
        try {
          const s = await fetchAgent1Settings()
          setAgentEnabled(s.agentEnabled !== false)
        } catch {
          /* keep previous */
        }
      })()
    }
    window.addEventListener('agent1-enabled-changed', onHeaderToggle)
    return () => window.removeEventListener('agent1-enabled-changed', onHeaderToggle)
  }, [loadScanStatus])

  const onSave = async () => {
    setSaving(true)
    setError('')
    try {
      const out = await saveAgent1Settings({
        tradeSizeUsd: Number.parseFloat(tradeSizeUsd),
        leverage: Number.parseInt(leverage, 10),
        marginMode,
        maxTpPct: Number.parseFloat(maxTpPct),
        maxSlPct: Number.parseFloat(maxSlPct),
        scanInterval,
        scanSecondsBeforeClose: Number.parseInt(scanSecondsBeforeClose, 10),
        scanThresholdPct: Number.parseFloat(scanThresholdPct),
        scanMinQuoteVolume: Number.parseFloat(scanMinQuoteVolume),
        scanMaxSymbols: Number.parseInt(scanMaxSymbols, 10),
        scanSpikeMetric,
        scanDirection,
        agentEnabled,
      })
      setTradeSizeUsd(String(out.tradeSizeUsd))
      setLeverage(String(out.leverage))
      setMarginMode(String(out.marginMode))
      setMaxTpPct(String(out.maxTpPct))
      setMaxSlPct(String(out.maxSlPct))
      const outInterval = String(out.scanInterval ?? '5m').trim()
      setScanInterval(
        AGENT1_INTERVAL_MS[outInterval] != null ? outInterval : '5m',
      )
      setScanSecondsBeforeClose(String(out.scanSecondsBeforeClose))
      setScanThresholdPct(String(out.scanThresholdPct))
      setScanMinQuoteVolume(String(out.scanMinQuoteVolume))
      setScanMaxSymbols(String(out.scanMaxSymbols))
      setScanSpikeMetric(String(out.scanSpikeMetric))
      setScanDirection(String(out.scanDirection))
      setAgentEnabled(out.agentEnabled !== false)
      setSavedAt(String(out.updatedAt ?? new Date().toISOString()))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save Agent 1 settings')
    } finally {
      setSaving(false)
    }
  }

  const onToggleTradeTaken = async (id, nextVal) => {
    setTogglingId(id)
    setSpikesError('')
    try {
      await patchSpikeTradeTaken(id, nextVal)
      await loadSpikes()
    } catch (e) {
      setSpikesError(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setTogglingId('')
    }
  }

  return (
    <div className="vol-screener agent1-page">
      {scanStatus ? (
        <div className="risk-summary agent1-risk-summary">
          <div className="risk-chip">
            Agent (master):{' '}
            <strong>{scanStatus.agentEnabled !== false ? 'ON' : 'OFF'}</strong>
            <span className="hourly-spikes-hint"> (header)</span>
          </div>
          <div className="risk-chip">
            Scheduler:{' '}
            <strong>{scanStatus.schedulerEnabled ? 'enabled' : 'disabled'}</strong>
            {!scanStatus.schedulerEnabled ? (
              <span className="hourly-spikes-hint"> (API has AGENT1_SCAN_SCHEDULER=false)</span>
            ) : null}
          </div>
          <div className="risk-chip">
            Next run: <strong>{fmtIst(scanStatus.nextFireAt)}</strong>
          </div>
          <div className="risk-chip">
            Last run: <strong>{fmtIst(scanStatus.lastRunAt)}</strong>
          </div>
          <div className="risk-chip">
            Last spikes written: <strong>{scanStatus.lastSpikeCount ?? '—'}</strong>
          </div>
          <div className="risk-chip">
            Scan timeframe: <strong>{scanStatus.scanInterval ?? '—'}</strong>
          </div>
          {scanStatus.running ? (
            <div className="risk-chip">
              <strong>Scan in progress…</strong>
            </div>
          ) : null}
          {scanStatus.lastError ? (
            <div className="risk-chip" style={{ color: '#b91c1c' }}>
              Error: {scanStatus.lastError}
            </div>
          ) : null}
        </div>
      ) : null}

      <h2 className="vol-screener-title agent1-section-title">Execution</h2>
      <div className="backtest1-form agent1-form" aria-busy={loading}>
        <label className="backtest1-field">
          <span className="backtest1-label">Trade size (USDT margin)</span>
          <input
            type="number"
            className="backtest1-input"
            min={0.01}
            step={0.01}
            value={tradeSizeUsd}
            onChange={(e) => setTradeSizeUsd(e.target.value)}
            disabled={loading || saving}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Leverage</span>
          <input
            type="number"
            className="backtest1-input"
            min={1}
            max={125}
            step={1}
            value={leverage}
            onChange={(e) => setLeverage(e.target.value)}
            disabled={loading || saving}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Margin mode</span>
          <select
            className="backtest1-input"
            value={marginMode}
            onChange={(e) => setMarginMode(e.target.value)}
            disabled={loading || saving}
          >
            <option value="cross">Cross</option>
            <option value="isolated">Isolated</option>
          </select>
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Max TP %</span>
          <input
            type="number"
            className="backtest1-input"
            min={0.01}
            step={0.01}
            value={maxTpPct}
            onChange={(e) => setMaxTpPct(e.target.value)}
            disabled={loading || saving}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Max SL %</span>
          <input
            type="number"
            className="backtest1-input"
            min={0.01}
            step={0.01}
            value={maxSlPct}
            onChange={(e) => setMaxSlPct(e.target.value)}
            disabled={loading || saving}
          />
        </label>
      </div>

      <h2 className="vol-screener-title agent1-section-title">Kline spike scan (pre-close)</h2>
      <div className="backtest1-form agent1-form">
        <label className="backtest1-field">
          <span className="backtest1-label">Timeframe</span>
          <select
            className="backtest1-input"
            value={scanInterval}
            onChange={(e) => {
              const next = e.target.value
              setScanInterval(next)
              const cap = maxSecondsBeforeCloseForInterval(next)
              const cur = Number.parseInt(scanSecondsBeforeClose, 10)
              if (Number.isFinite(cur) && cur > cap) {
                setScanSecondsBeforeClose(String(cap))
              }
            }}
            disabled={loading || saving}
          >
            {AGENT1_SCAN_INTERVAL_OPTIONS.map((iv) => (
              <option key={iv} value={iv}>
                {iv}
              </option>
            ))}
          </select>
        </label>
        <p className="hourly-spikes-hint" style={{ gridColumn: '1 / -1', margin: 0 }}>
          Uses the latest kline from Binance, which is the open candle until it closes.
        </p>
        <label className="backtest1-field">
          <span className="backtest1-label">Seconds before candle close</span>
          <input
            type="number"
            className="backtest1-input"
            min={1}
            max={maxScanSecondsBeforeClose}
            step={1}
            value={scanSecondsBeforeClose}
            onChange={(e) => setScanSecondsBeforeClose(e.target.value)}
            disabled={loading || saving}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Spike threshold %</span>
          <input
            type="number"
            className="backtest1-input"
            min={0.1}
            step={0.1}
            value={scanThresholdPct}
            onChange={(e) => setScanThresholdPct(e.target.value)}
            disabled={loading || saving}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Min 24h quote volume (USDT)</span>
          <input
            type="number"
            className="backtest1-input"
            min={0}
            step={100000}
            value={scanMinQuoteVolume}
            onChange={(e) => setScanMinQuoteVolume(e.target.value)}
            disabled={loading || saving}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Max symbols (≤800)</span>
          <input
            type="number"
            className="backtest1-input"
            min={1}
            max={800}
            step={50}
            value={scanMaxSymbols}
            onChange={(e) => setScanMaxSymbols(e.target.value)}
            disabled={loading || saving}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Spike measure</span>
          <select
            className="backtest1-input"
            value={scanSpikeMetric}
            onChange={(e) => setScanSpikeMetric(e.target.value)}
            disabled={loading || saving}
          >
            <option value="body">Body %</option>
            <option value="wick">Wick %</option>
          </select>
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Direction</span>
          <select
            className="backtest1-input"
            value={scanDirection}
            onChange={(e) => setScanDirection(e.target.value)}
            disabled={loading || saving}
          >
            <option value="up">Up</option>
            <option value="down">Down</option>
            <option value="both">Both</option>
          </select>
        </label>
        <div className="agent1-form-actions">
          <button type="button" className="backtest1-btn" onClick={onSave} disabled={loading || saving}>
            {saving ? 'Saving…' : 'Save Agent 1 Settings'}
          </button>
          <button
            type="button"
            className="backtest1-btn backtest1-btn--secondary"
            onClick={() => {
              loadSpikes()
              loadScanStatus()
            }}
            disabled={spikesLoading}
          >
            Refresh spikes / status
          </button>
        </div>
      </div>
      {savedAt ? (
        <p className="hourly-spikes-hint">Last saved: {fmtIst(savedAt)}</p>
      ) : null}
      {error ? (
        <p className="vol-screener-lead" role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </p>
      ) : null}

      <h2 className="vol-screener-title agent1-section-title agent1-section-title--table">
        Recent spikes (last 200)
      </h2>
      {spikesError ? (
        <p className="vol-screener-lead" role="alert" style={{ color: '#b91c1c' }}>
          {spikesError}
        </p>
      ) : null}
      {spikesLoading && spikes.length === 0 ? (
        <p className="hourly-spikes-hint">Loading spikes…</p>
      ) : spikes.length === 0 ? (
        <p className="hourly-spikes-hint">No spikes stored yet. Run the SQL migration and wait for the next scan.</p>
      ) : (
        <div className="table-wrap agent1-spikes-wrap">
          <table className="positions-table agent1-spikes-table">
            <thead>
              <tr>
                <th>Stored (IST)</th>
                <th>Candle open (IST)</th>
                <th>Symbol</th>
                <th>Dir</th>
                <th className="cell-right">Spike %</th>
                <th className="cell-right">24h vol</th>
                <th>Trade taken</th>
              </tr>
            </thead>
            <tbody>
              {spikes.map((r) => (
                <tr key={r.id}>
                  <td className="cell-mono">{r.created_at ? fmtIst(r.created_at) : '—'}</td>
                  <td className="cell-mono">
                    {r.candle_open_time_ms != null ? fmtIst(Number(r.candle_open_time_ms)) : '—'}
                  </td>
                  <td className="cell-mono">{r.symbol}</td>
                  <td>{r.direction}</td>
                  <td className="cell-mono cell-right">
                    {r.spike_pct != null ? `${Number(r.spike_pct).toFixed(3)}%` : '—'}
                  </td>
                  <td className="cell-mono cell-right">
                    {r.quote_volume_24h != null ? Number(r.quote_volume_24h).toFixed(0) : '—'}
                  </td>
                  <td>
                    <label className="backtest1-field" style={{ margin: 0, flexDirection: 'row', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(r.trade_taken)}
                        disabled={togglingId === r.id}
                        onChange={(e) => onToggleTradeTaken(r.id, e.target.checked)}
                      />
                      <span className="hourly-spikes-hint">{r.trade_taken ? 'Yes' : 'No'}</span>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
