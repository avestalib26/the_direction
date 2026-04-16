import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

async function fetchAgent1Regime() {
  const res = await fetch('/api/agents/agent1/regime', { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

async function fetchAgent1Execution() {
  const res = await fetch('/api/agents/agent1/execution', { cache: 'no-store' })
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

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtSignedUsd(v, digits = 4) {
  const n = toNum(v)
  if (n == null) return '—'
  const abs = Math.abs(n).toFixed(digits)
  if (n > 0) return `+${abs}`
  if (n < 0) return `-${abs}`
  return abs
}

export function Agent1() {
  const [tradeSizeUsd, setTradeSizeUsd] = useState('1')
  const [leverage, setLeverage] = useState('10')
  const [marginMode, setMarginMode] = useState('cross')
  const [maxTpPct, setMaxTpPct] = useState('1.5')
  const [maxSlPct, setMaxSlPct] = useState('1')
  const [maxOpenPositions, setMaxOpenPositions] = useState('30')
  const [scanInterval, setScanInterval] = useState('5m')
  const [scanSecondsBeforeClose, setScanSecondsBeforeClose] = useState('20')
  const [scanThresholdPct, setScanThresholdPct] = useState('3')
  const [scanMinQuoteVolume, setScanMinQuoteVolume] = useState('0')
  const [scanMaxSymbols, setScanMaxSymbols] = useState('800')
  const [scanSpikeMetric, setScanSpikeMetric] = useState('body')
  const [scanDirection, setScanDirection] = useState('both')
  const [agentEnabled, setAgentEnabled] = useState(true)
  const [emaGateEnabled, setEmaGateEnabled] = useState(true)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [emaGateSaving, setEmaGateSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState('')

  const [scanStatus, setScanStatus] = useState(null)
  const [regime, setRegime] = useState(null)
  const [execution, setExecution] = useState(null)
  const [spikes, setSpikes] = useState([])
  const [visibleSpikesCount, setVisibleSpikesCount] = useState(30)
  const [visibleOngoingCount, setVisibleOngoingCount] = useState(30)
  const [visibleClosedCount, setVisibleClosedCount] = useState(30)
  const [visibleLogCount, setVisibleLogCount] = useState(30)
  const [spikesLoading, setSpikesLoading] = useState(true)
  const [spikesError, setSpikesError] = useState('')
  const [togglingId, setTogglingId] = useState('')
  const [activeTab, setActiveTab] = useState('execution')
  const executionRef = useRef(null)
  const tradesRef = useRef(null)
  const spikesRef = useRef(null)
  const logsRef = useRef(null)

  const maxScanSecondsBeforeClose = useMemo(
    () => maxSecondsBeforeCloseForInterval(scanInterval),
    [scanInterval],
  )
  const visibleSpikes = useMemo(() => spikes.slice(0, Math.max(30, visibleSpikesCount)), [spikes, visibleSpikesCount])
  const ongoingTrades = Array.isArray(execution?.ongoingTrades) ? execution.ongoingTrades : []
  const visibleOngoingTrades = useMemo(
    () => ongoingTrades.slice(0, Math.max(30, visibleOngoingCount)),
    [ongoingTrades, visibleOngoingCount],
  )
  const closedTrades = Array.isArray(execution?.closedTrades) ? execution.closedTrades : []
  const visibleClosedTrades = useMemo(
    () => closedTrades.slice(0, Math.max(30, visibleClosedCount)),
    [closedTrades, visibleClosedCount],
  )
  const logs = Array.isArray(execution?.logs) ? execution.logs : []
  const visibleLogs = useMemo(
    () => logs.slice(0, Math.max(30, visibleLogCount)),
    [logs, visibleLogCount],
  )
  const sectionTabs = useMemo(
    () => [
      { id: 'execution', label: 'Execution', ref: executionRef },
      { id: 'trades', label: 'Trades', ref: tradesRef },
      { id: 'spikes', label: 'Spikes', ref: spikesRef },
      { id: 'logs', label: 'Logs', ref: logsRef },
    ],
    [],
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

  const loadRegime = useCallback(async () => {
    try {
      const data = await fetchAgent1Regime()
      setRegime(data?.regime ?? null)
    } catch {
      setRegime(null)
    }
  }, [])

  const loadExecution = useCallback(async () => {
    try {
      const data = await fetchAgent1Execution()
      setExecution(data)
    } catch {
      setExecution(null)
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
        setMaxOpenPositions(String(s.maxOpenPositions ?? '30'))
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
        setEmaGateEnabled(s.emaGateEnabled !== false)
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
    loadRegime()
    loadExecution()
    const iv = setInterval(() => {
      loadScanStatus()
      loadSpikes()
      loadRegime()
      loadExecution()
    }, 30_000)
    return () => {
      off = true
      clearInterval(iv)
    }
  }, [loadExecution, loadRegime, loadSpikes, loadScanStatus])

  useEffect(() => {
    const onHeaderToggle = () => {
      loadScanStatus()
      ;(async () => {
        try {
          const s = await fetchAgent1Settings()
          setAgentEnabled(s.agentEnabled !== false)
          setEmaGateEnabled(s.emaGateEnabled !== false)
        } catch {
          /* keep previous */
        }
      })()
    }
    window.addEventListener('agent1-enabled-changed', onHeaderToggle)
    return () => window.removeEventListener('agent1-enabled-changed', onHeaderToggle)
  }, [loadScanStatus])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const heads = sectionTabs.map((t) => t.ref.current).filter(Boolean)
    if (heads.length === 0) return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)
        const first = visible[0]
        if (!first) return
        const hit = sectionTabs.find((t) => t.ref.current === first.target)
        if (hit) setActiveTab(hit.id)
      },
      {
        root: null,
        rootMargin: '-120px 0px -55% 0px',
        threshold: [0.15, 0.35, 0.6],
      },
    )
    for (const el of heads) observer.observe(el)
    return () => observer.disconnect()
  }, [sectionTabs])

  const onClickTab = useCallback((tab) => {
    setActiveTab(tab.id)
    const el = tab.ref.current
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

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
        maxOpenPositions: Number.parseInt(maxOpenPositions, 10),
        scanInterval,
        scanSecondsBeforeClose: Number.parseInt(scanSecondsBeforeClose, 10),
        scanThresholdPct: Number.parseFloat(scanThresholdPct),
        scanMinQuoteVolume: Number.parseFloat(scanMinQuoteVolume),
        scanMaxSymbols: Number.parseInt(scanMaxSymbols, 10),
        scanSpikeMetric,
        scanDirection,
        agentEnabled,
        emaGateEnabled,
      })
      setTradeSizeUsd(String(out.tradeSizeUsd))
      setLeverage(String(out.leverage))
      setMarginMode(String(out.marginMode))
      setMaxTpPct(String(out.maxTpPct))
      setMaxSlPct(String(out.maxSlPct))
      setMaxOpenPositions(String(out.maxOpenPositions ?? '30'))
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
      setEmaGateEnabled(out.emaGateEnabled !== false)
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

  const onToggleEmaGate = async () => {
    if (loading || saving || emaGateSaving) return
    const next = !emaGateEnabled
    const ok = window.confirm(
      next
        ? 'Enable EMA gating for Agent 1 execution? Trades will be blocked when curve is below EMA.'
        : 'Disable EMA gating for Agent 1 execution? Agent will bypass regime gate and execute by spikes only.',
    )
    if (!ok) return
    setEmaGateSaving(true)
    setError('')
    try {
      const out = await saveAgent1Settings({ emaGateEnabled: next })
      setEmaGateEnabled(out.emaGateEnabled !== false)
      setSavedAt(String(out.updatedAt ?? new Date().toISOString()))
      loadExecution()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update EMA gate setting')
    } finally {
      setEmaGateSaving(false)
    }
  }

  return (
    <div className="vol-screener agent1-page">
      <nav className="agent1-tabs" aria-label="Agent 1 sections">
        {sectionTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`agent1-tab ${activeTab === tab.id ? 'agent1-tab--active' : ''}`}
            onClick={() => onClickTab(tab)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
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
          <div className="risk-chip">
            Curve PnL: <strong>{Number.isFinite(Number(regime?.latestCumPnlPct)) ? `${Number(regime.latestCumPnlPct).toFixed(3)}%` : '—'}</strong>
          </div>
          <div className="risk-chip">
            EMA50: <strong>{Number.isFinite(Number(regime?.emaValue)) ? `${Number(regime.emaValue).toFixed(3)}%` : '—'}</strong>
          </div>
          <div className="risk-chip">
            Gate:{' '}
            <strong>
              {emaGateEnabled ? (regime?.gateAllowLong ? 'ALLOW LONG' : 'BLOCK LONG') : 'DISABLED (BYPASS)'}
            </strong>
          </div>
          <div className="risk-chip">
            EMA gate: <strong>{emaGateEnabled ? 'ON' : 'OFF'}</strong>
          </div>
          <div className="risk-chip">
            Exec loop: <strong>{execution?.state?.running ? 'running' : 'idle'}</strong>
          </div>
          <div className="risk-chip">
            Exec lease: <strong>{execution?.state?.leaseOwner ? 'owner' : 'standby'}</strong>
          </div>
          <div className="risk-chip">
            Last placed: <strong>{execution?.state?.lastPlaced ?? 0}</strong>
          </div>
          <div className="risk-chip">
            Max open: <strong>{maxOpenPositions || '30'}</strong>
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

      <h2 ref={executionRef} className="vol-screener-title agent1-section-title agent1-anchor-target">
        Execution
      </h2>
      <div className="backtest1-form agent1-form" aria-busy={loading}>
        <div className="agent1-form-actions" style={{ gridColumn: '1 / -1', paddingTop: 0 }}>
          <button
            type="button"
            className={`backtest1-btn ${emaGateEnabled ? 'backtest1-btn--secondary' : ''}`}
            onClick={onToggleEmaGate}
            disabled={loading || saving || emaGateSaving}
          >
            {emaGateSaving
              ? 'Updating EMA gate…'
              : `EMA gate: ${emaGateEnabled ? 'ON (click to disable)' : 'OFF (click to enable)'}`}
          </button>
        </div>
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
        <label className="backtest1-field">
          <span className="backtest1-label">Max open positions</span>
          <input
            type="number"
            className="backtest1-input"
            min={1}
            max={300}
            step={1}
            value={maxOpenPositions}
            onChange={(e) => setMaxOpenPositions(e.target.value)}
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
              loadRegime()
              loadExecution()
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

      <h2
        ref={tradesRef}
        className="vol-screener-title agent1-section-title agent1-section-title--table agent1-anchor-target"
      >
        Ongoing trades by Agent 1
      </h2>
      {ongoingTrades.length === 0 ? (
        <p className="hourly-spikes-hint">No ongoing agent trades.</p>
      ) : (
        <>
          <div className="table-wrap agent1-spikes-wrap">
            <table className="positions-table agent1-spikes-table">
              <thead>
                <tr>
                  <th>Opened (IST)</th>
                  <th>Symbol</th>
                  <th>Lev</th>
                  <th className="cell-right">Qty</th>
                  <th className="cell-right">Entry</th>
                  <th className="cell-right">Unrealized</th>
                </tr>
              </thead>
              <tbody>
                {visibleOngoingTrades.map((t) => (
                  <tr
                    key={t.id}
                    className={
                      Number(t.unRealizedProfit) > 0
                        ? 'agent1-trade-row agent1-trade-row--pos'
                        : Number(t.unRealizedProfit) < 0
                          ? 'agent1-trade-row agent1-trade-row--neg'
                          : 'agent1-trade-row'
                    }
                  >
                    <td className="cell-mono">{fmtIst(t.opened_at)}</td>
                    <td className="cell-mono">{t.symbol}</td>
                    <td className="cell-mono">{t.applied_leverage ?? '—'}x</td>
                    <td className="cell-mono cell-right">{t.quantity != null ? Number(t.quantity).toFixed(4) : '—'}</td>
                    <td className="cell-mono cell-right">{t.entry_price != null ? Number(t.entry_price).toFixed(6) : '—'}</td>
                    <td
                      className={`cell-mono cell-right ${Number(t.unRealizedProfit) > 0 ? 'pnl-pos' : Number(t.unRealizedProfit) < 0 ? 'pnl-neg' : ''}`}
                    >
                      {fmtSignedUsd(t.unRealizedProfit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ongoingTrades.length > 30 ? (
            <div className="agent1-form-actions" style={{ paddingTop: 8, paddingBottom: 0 }}>
              <button
                type="button"
                className="backtest1-btn backtest1-btn--secondary"
                onClick={() => setVisibleOngoingCount((n) => Math.min(ongoingTrades.length, n + 100))}
                disabled={visibleOngoingTrades.length >= ongoingTrades.length}
              >
                View more (+100)
              </button>
              {visibleOngoingCount > 30 ? (
                <button
                  type="button"
                  className="backtest1-btn backtest1-btn--secondary"
                  onClick={() => setVisibleOngoingCount(30)}
                >
                  Show less (30)
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      <h2 className="vol-screener-title agent1-section-title agent1-section-title--table">
        Closed trades by Agent 1
      </h2>
      {closedTrades.length === 0 ? (
        <p className="hourly-spikes-hint">No closed agent trades yet.</p>
      ) : (
        <>
          <div className="table-wrap agent1-spikes-wrap">
            <table className="positions-table agent1-spikes-table">
              <thead>
                <tr>
                  <th>Opened (IST)</th>
                  <th>Closed (IST)</th>
                  <th>Symbol</th>
                  <th>Lev</th>
                  <th className="cell-right">Realized (USDT)</th>
                  <th className="cell-right">Commission</th>
                  <th className="cell-right">Funding</th>
                  <th className="cell-right">Net PnL (USDT)</th>
                  <th>Close reason</th>
                </tr>
              </thead>
              <tbody>
                {visibleClosedTrades.map((t) => {
                  const realized = toNum(t.realized_pnl_usdt)
                  const commission = toNum(t.commission_usdt)
                  const funding = toNum(t.funding_fee_usdt)
                  const net =
                    realized == null && commission == null && funding == null
                      ? null
                      : (realized ?? 0) + (commission ?? 0) + (funding ?? 0)
                  return (
                    <tr
                      key={t.id}
                      className={
                        net != null && net > 0
                          ? 'agent1-trade-row agent1-trade-row--pos'
                          : net != null && net < 0
                            ? 'agent1-trade-row agent1-trade-row--neg'
                            : 'agent1-trade-row'
                      }
                    >
                      <td className="cell-mono">{fmtIst(t.opened_at)}</td>
                      <td className="cell-mono">{fmtIst(t.closed_at)}</td>
                      <td className="cell-mono">{t.symbol}</td>
                      <td className="cell-mono">{t.applied_leverage ?? '—'}x</td>
                      <td
                        className={`cell-mono cell-right ${Number(t.realized_pnl_usdt) > 0 ? 'pnl-pos' : Number(t.realized_pnl_usdt) < 0 ? 'pnl-neg' : ''}`}
                      >
                        {fmtSignedUsd(t.realized_pnl_usdt)}
                      </td>
                      <td
                        className={`cell-mono cell-right ${Number(t.commission_usdt) > 0 ? 'pnl-pos' : Number(t.commission_usdt) < 0 ? 'pnl-neg' : ''}`}
                      >
                        {fmtSignedUsd(t.commission_usdt)}
                      </td>
                      <td
                        className={`cell-mono cell-right ${Number(t.funding_fee_usdt) > 0 ? 'pnl-pos' : Number(t.funding_fee_usdt) < 0 ? 'pnl-neg' : ''}`}
                      >
                        {fmtSignedUsd(t.funding_fee_usdt)}
                      </td>
                      <td className={`cell-mono cell-right ${net != null && net > 0 ? 'pnl-pos' : net != null && net < 0 ? 'pnl-neg' : ''}`}>
                        {fmtSignedUsd(net)}
                      </td>
                      <td>{t.close_reason ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {closedTrades.length > 30 ? (
            <div className="agent1-form-actions" style={{ paddingTop: 8, paddingBottom: 0 }}>
              <button
                type="button"
                className="backtest1-btn backtest1-btn--secondary"
                onClick={() => setVisibleClosedCount((n) => Math.min(closedTrades.length, n + 100))}
                disabled={visibleClosedTrades.length >= closedTrades.length}
              >
                View more (+100)
              </button>
              {visibleClosedCount > 30 ? (
                <button
                  type="button"
                  className="backtest1-btn backtest1-btn--secondary"
                  onClick={() => setVisibleClosedCount(30)}
                >
                  Show less (30)
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      <h2
        ref={spikesRef}
        className="vol-screener-title agent1-section-title agent1-section-title--table agent1-anchor-target"
      >
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
        <>
          <div className="table-wrap agent1-spikes-wrap">
            <table className="positions-table agent1-spikes-table">
              <thead>
                <tr>
                  <th>Stored (IST)</th>
                  <th>Candle open (IST)</th>
                  <th>Symbol</th>
                  <th>Dir</th>
                  <th className="cell-right">Spike %</th>
                  <th>Trade taken</th>
                  <th>Execution</th>
                </tr>
              </thead>
              <tbody>
                {visibleSpikes.map((r) => (
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
                    <td className="cell-mono" title={r.skip_reason ? String(r.skip_reason) : undefined}>
                      {r.trade_taken ? (
                        <span className="hourly-spikes-hint">Placed</span>
                      ) : r.execution_skipped ? (
                        <span className="hourly-spikes-hint" style={{ color: '#a16207' }}>
                          Skipped
                          {r.skip_reason
                            ? `: ${
                                String(r.skip_reason).length > 48
                                  ? `${String(r.skip_reason).slice(0, 48)}…`
                                  : String(r.skip_reason)
                              }`
                            : ''}
                        </span>
                      ) : (
                        <span className="hourly-spikes-hint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {spikes.length > 30 ? (
            <div className="agent1-form-actions" style={{ paddingTop: 8, paddingBottom: 0 }}>
              <button
                type="button"
                className="backtest1-btn backtest1-btn--secondary"
                onClick={() => setVisibleSpikesCount((n) => Math.min(spikes.length, n + 100))}
                disabled={visibleSpikes.length >= spikes.length}
              >
                View more (+100)
              </button>
              {visibleSpikesCount > 30 ? (
                <button
                  type="button"
                  className="backtest1-btn backtest1-btn--secondary"
                  onClick={() => setVisibleSpikesCount(30)}
                >
                  Show less (30)
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      <h2
        ref={logsRef}
        className="vol-screener-title agent1-section-title agent1-section-title--table agent1-anchor-target"
      >
        Agent 1 logs
      </h2>
      {logs.length === 0 ? (
        <p className="hourly-spikes-hint">No logs yet.</p>
      ) : (
        <>
          <div className="table-wrap agent1-spikes-wrap">
            <table className="positions-table agent1-spikes-table">
              <thead>
                <tr>
                  <th>Time (IST)</th>
                  <th>Level</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.map((l, idx) => (
                  <tr key={`${l.at}-${idx}`}>
                    <td className="cell-mono">{fmtIst(l.at)}</td>
                    <td className="cell-mono">{String(l.level ?? '').toUpperCase()}</td>
                    <td>{l.msg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {logs.length > 30 ? (
            <div className="agent1-form-actions" style={{ paddingTop: 8, paddingBottom: 0 }}>
              <button
                type="button"
                className="backtest1-btn backtest1-btn--secondary"
                onClick={() => setVisibleLogCount((n) => Math.min(logs.length, n + 100))}
                disabled={visibleLogs.length >= logs.length}
              >
                View more (+100)
              </button>
              {visibleLogCount > 30 ? (
                <button
                  type="button"
                  className="backtest1-btn backtest1-btn--secondary"
                  onClick={() => setVisibleLogCount(30)}
                >
                  Show less (30)
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
