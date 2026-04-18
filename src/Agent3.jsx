import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Agent1ClosedTradesCumPnlChart } from './Agent1ClosedTradesCumPnlChart.jsx'
import { SpikeTpSlEquityLightChart, SpikeTpSlPerTradeCandleLightChart } from './spikeTpSlLightweightCharts.jsx'

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

async function fetchAgent3Settings() {
  const res = await fetch('/api/agents/agent3/settings', { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return {
    settings: data.settings,
    binanceAccountColumnReadable: data.binanceAccountColumnReadable !== false,
  }
}

async function saveAgent3Settings(payload) {
  const res = await fetch('/api/agents/agent3/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return {
    settings: data.settings,
    binanceAccountColumnReadable: data.binanceAccountColumnReadable !== false,
  }
}

async function fetchScanStatus() {
  const res = await fetch('/api/agents/agent3/scan-status', { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

async function fetchAgent3Execution() {
  const res = await fetch('/api/agents/agent3/execution', { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

async function fetchAgent3AccountMetrics() {
  const res = await fetch('/api/agents/agent3/account-metrics', { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

async function fetchSpikes() {
  const res = await fetch('/api/agents/agent3/spikes?limit=200', { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data.spikes ?? []
}

async function patchSpikeTradeTaken(id, tradeTaken) {
  const res = await fetch(`/api/agents/agent3/spikes/${encodeURIComponent(id)}`, {
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

function fmtUsd2(v) {
  const n = toNum(v)
  if (n == null) return '—'
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function Agent3() {
  const [tradeSizeUsd, setTradeSizeUsd] = useState('1')
  const [tradeSizeWalletPct, setTradeSizeWalletPct] = useState('0')
  const [minAvailableWalletPct, setMinAvailableWalletPct] = useState('30')
  const [leverage, setLeverage] = useState('10')
  const [marginMode, setMarginMode] = useState('cross')
  const [maxTpPct, setMaxTpPct] = useState('2')
  const [maxSlPct, setMaxSlPct] = useState('1')
  const [maxOpenPositions, setMaxOpenPositions] = useState('30')
  const [scanInterval, setScanInterval] = useState('5m')
  const [scanSecondsBeforeClose, setScanSecondsBeforeClose] = useState('20')
  const [scanThresholdPct, setScanThresholdPct] = useState('3')
  const [scanMinQuoteVolume, setScanMinQuoteVolume] = useState('0')
  const [scanMaxSymbols, setScanMaxSymbols] = useState('800')
  const [scanSpikeMetric, setScanSpikeMetric] = useState('body')
  const [scanDirection, setScanDirection] = useState('down')
  const [agentEnabled, setAgentEnabled] = useState(false)
  const [binanceAccount, setBinanceAccount] = useState('master')
  const [binanceAccountColumnReadable, setBinanceAccountColumnReadable] = useState(true)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState('')

  const [scanStatus, setScanStatus] = useState(null)
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
  const [accountMetrics, setAccountMetrics] = useState(null)
  const [accountMetricsError, setAccountMetricsError] = useState('')
  const [simModalOpen, setSimModalOpen] = useState(false)
  const [simRunLoading, setSimRunLoading] = useState(false)
  const [simError, setSimError] = useState('')
  const [simResult, setSimResult] = useState(null)
  const [simCandleCount, setSimCandleCount] = useState('500')
  const [simMinQuoteVol, setSimMinQuoteVol] = useState('10000000')
  const [simBtInterval, setSimBtInterval] = useState('5m')
  const [simThresholdPct, setSimThresholdPct] = useState('3')
  const [simMaxSlPct, setSimMaxSlPct] = useState('1')
  const [simTpR, setSimTpR] = useState('2')
  const [closedPnlCurve, setClosedPnlCurve] = useState(null)
  const [closedPnlCurveLoading, setClosedPnlCurveLoading] = useState(false)
  const [closedPnlCurveError, setClosedPnlCurveError] = useState('')
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

  const simEquityCurveNoBtc = useMemo(() => {
    const pts = simResult?.equityCurve
    if (!Array.isArray(pts) || pts.length === 0) return pts
    return pts.map((p) =>
      p && typeof p === 'object' ? { ...p, btcCloseUsd: undefined } : p,
    )
  }, [simResult?.equityCurve])

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

  const loadExecution = useCallback(async () => {
    try {
      const data = await fetchAgent3Execution()
      setExecution(data)
    } catch {
      setExecution(null)
    }
  }, [])

  const loadAccountMetrics = useCallback(async () => {
    setAccountMetricsError('')
    try {
      const data = await fetchAgent3AccountMetrics()
      setAccountMetrics(data)
    } catch (e) {
      setAccountMetrics(null)
      setAccountMetricsError(e instanceof Error ? e.message : 'Failed to load account metrics')
    }
  }, [])

  const loadClosedPnlCurve = useCallback(async () => {
    setClosedPnlCurveLoading(true)
    setClosedPnlCurveError('')
    try {
      const res = await fetch('/api/agents/agent3/closed-trades-pnl-curve?limit=1000', {
        cache: 'no-store',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`)
      }
      setClosedPnlCurve(data)
    } catch (e) {
      setClosedPnlCurve(null)
      setClosedPnlCurveError(e instanceof Error ? e.message : 'Failed to load closed PnL curve')
    } finally {
      setClosedPnlCurveLoading(false)
    }
  }, [])

  const openSimulationModal = useCallback(() => {
    setSimError('')
    setSimBtInterval(scanInterval)
    setSimThresholdPct(scanThresholdPct)
    setSimMaxSlPct(maxSlPct)
    setSimModalOpen(true)
  }, [maxSlPct, scanInterval, scanThresholdPct])

  const runAgent3Simulation = useCallback(async () => {
    setSimRunLoading(true)
    setSimError('')
    try {
      const n = Math.min(1500, Math.max(50, Number.parseInt(String(simCandleCount), 10) || 500))
      const vol = Math.max(0, Number.parseFloat(String(simMinQuoteVol)) || 0)
      const th = Number.parseFloat(String(simThresholdPct))
      if (!Number.isFinite(th) || th <= 0) {
        throw new Error('Threshold % must be a positive number')
      }
      const tpRN = Number.parseFloat(String(simTpR))
      const q = new URLSearchParams({
        minQuoteVolume24h: String(vol),
        interval: simBtInterval,
        candleCount: String(n),
        thresholdPct: String(th),
        strategy: 'short_red_spike',
        includeChartCandles: 'false',
      })
      const maxSlN = Number.parseFloat(String(simMaxSlPct))
      if (Number.isFinite(maxSlN) && maxSlN > 0) {
        q.set('maxSlPct', String(maxSlN))
      }
      if (Number.isFinite(tpRN) && tpRN > 0) {
        q.set('tpR', String(tpRN))
      }
      const res = await fetch(`/api/binance/spike-tpsl-backtest?${q}`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`)
      }
      setSimResult(data)
      setSimModalOpen(false)
    } catch (e) {
      setSimError(e instanceof Error ? e.message : 'Simulation failed')
    } finally {
      setSimRunLoading(false)
    }
  }, [
    simBtInterval,
    simCandleCount,
    simMaxSlPct,
    simMinQuoteVol,
    simThresholdPct,
    simTpR,
  ])

  useEffect(() => {
    let off = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const { settings: s, binanceAccountColumnReadable: colOk } = await fetchAgent3Settings()
        if (off) return
        setBinanceAccountColumnReadable(colOk)
        setTradeSizeUsd(String(s.tradeSizeUsd ?? '1'))
        setTradeSizeWalletPct(
          String(
            s.tradeSizeWalletPct != null && Number.isFinite(Number(s.tradeSizeWalletPct))
              ? s.tradeSizeWalletPct
              : '0',
          ),
        )
        setMinAvailableWalletPct(
          String(
            s.minAvailableWalletPct != null && Number.isFinite(Number(s.minAvailableWalletPct))
              ? s.minAvailableWalletPct
              : '30',
          ),
        )
        setLeverage(String(s.leverage ?? '10'))
        setMarginMode(String(s.marginMode ?? 'cross'))
        setMaxTpPct(String(s.maxTpPct ?? '2'))
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
        setScanDirection(String(s.scanDirection ?? 'down'))
        setAgentEnabled(s.agentEnabled !== false)
        setBinanceAccount(String(s.binanceAccount ?? 'master'))
        setSavedAt(String(s.updatedAt ?? ''))
      } catch (e) {
        if (!off) setError(e instanceof Error ? e.message : 'Failed to load Agent 3 settings')
      } finally {
        if (!off) setLoading(false)
      }
    }
    load()
    loadSpikes()
    loadScanStatus()
    loadExecution()
    loadAccountMetrics()
    const iv = setInterval(() => {
      loadScanStatus()
      loadSpikes()
      loadExecution()
      loadAccountMetrics()
    }, 30_000)
    return () => {
      off = true
      clearInterval(iv)
    }
  }, [loadAccountMetrics, loadExecution, loadSpikes, loadScanStatus])

  useEffect(() => {
    const onHeaderToggle = () => {
      loadScanStatus()
      ;(async () => {
        try {
          const { settings: s, binanceAccountColumnReadable: colOk } = await fetchAgent3Settings()
          setAgentEnabled(s.agentEnabled !== false)
          setBinanceAccountColumnReadable(colOk)
        } catch {
          /* keep previous */
        }
      })()
    }
    window.addEventListener('agent3-enabled-changed', onHeaderToggle)
    return () => window.removeEventListener('agent3-enabled-changed', onHeaderToggle)
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

  useEffect(() => {
    if (!simModalOpen) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') setSimModalOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [simModalOpen])

  const onSave = async () => {
    setSaving(true)
    setError('')
    try {
      const { settings: out, binanceAccountColumnReadable: colOk } = await saveAgent3Settings({
        tradeSizeUsd: Number.parseFloat(tradeSizeUsd),
        tradeSizeWalletPct: Number.parseFloat(tradeSizeWalletPct),
        minAvailableWalletPct: Number.parseInt(minAvailableWalletPct, 10),
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
        binanceAccount,
      })
      setTradeSizeUsd(String(out.tradeSizeUsd))
      setTradeSizeWalletPct(
        String(
          out.tradeSizeWalletPct != null && Number.isFinite(Number(out.tradeSizeWalletPct))
            ? out.tradeSizeWalletPct
            : '0',
        ),
      )
      setMinAvailableWalletPct(
        String(
          out.minAvailableWalletPct != null && Number.isFinite(Number(out.minAvailableWalletPct))
            ? out.minAvailableWalletPct
            : '30',
        ),
      )
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
      setBinanceAccount(String(out.binanceAccount ?? 'master'))
      setBinanceAccountColumnReadable(colOk)
      setSavedAt(String(out.updatedAt ?? new Date().toISOString()))
      loadAccountMetrics()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save Agent 3 settings')
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
      <nav className="agent1-tabs" aria-label="Agent 3 sections">
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
            Agent 3 (header):{' '}
            <strong>{scanStatus.agentEnabled !== false ? 'ON' : 'OFF'}</strong>
          </div>
          <div className="risk-chip">
            Scheduler:{' '}
            <strong>{scanStatus.schedulerEnabled ? 'enabled' : 'disabled'}</strong>
            {!scanStatus.schedulerEnabled ? (
              <span className="hourly-spikes-hint"> (API has AGENT3_SCAN_SCHEDULER=false)</span>
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
            Exec loop: <strong>{execution?.state?.running ? 'running' : 'idle'}</strong>
          </div>
          <div className="risk-chip">
            Exec lease: <strong>{execution?.state?.leaseOwner ? 'owner' : 'standby'}</strong>
          </div>
          <div className="risk-chip">
            Last placed: <strong>{execution?.state?.lastPlaced ?? 0}</strong>
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

      <h2 className="vol-screener-title agent1-section-title">Futures account</h2>
      {!binanceAccountColumnReadable ? (
        <p className="hourly-spikes-hint" role="alert" style={{ margin: '0 0 12px', color: '#b45309' }}>
          Database is missing <code>agent_settings.binance_account</code>. The server falls back to{' '}
          <strong>master</strong> credentials until you run{' '}
          <code>supabase/agent_settings_binance_account.sql</code> and restart. Sub-account env keys are ignored for
          routing until then.
        </p>
      ) : null}
      <div className="agent1-account-tablet">
        {accountMetricsError ? (
          <p className="vol-screener-lead agent1-account-tablet__err" role="alert">
            {accountMetricsError}
          </p>
        ) : null}
        <div className="agent1-account-tablet__grid">
          <div className="agent1-account-tablet__cell">
            <span className="agent1-account-tablet__label">Wallet (USDT-M)</span>
            <strong className="agent1-account-tablet__value">
              {accountMetrics ? `${fmtUsd2(accountMetrics.futuresWalletUsdt)} USDT` : '—'}
            </strong>
          </div>
          <div className="agent1-account-tablet__cell">
            <span className="agent1-account-tablet__label">Unrealized PnL</span>
            <strong
              className={`agent1-account-tablet__value ${
                toNum(accountMetrics?.unrealizedPnlUsdt) != null && toNum(accountMetrics.unrealizedPnlUsdt) < 0
                  ? 'agent1-account-tablet__value--neg'
                  : toNum(accountMetrics?.unrealizedPnlUsdt) != null && toNum(accountMetrics.unrealizedPnlUsdt) > 0
                    ? 'agent1-account-tablet__value--pos'
                    : ''
              }`}
            >
              {accountMetrics ? `${fmtSignedUsd(accountMetrics.unrealizedPnlUsdt, 2)} USDT` : '—'}
            </strong>
          </div>
          <div className="agent1-account-tablet__cell">
            <span className="agent1-account-tablet__label">Open positions</span>
            <strong className="agent1-account-tablet__value">
              {accountMetrics ? String(accountMetrics.openPositionCount ?? 0) : '—'}
            </strong>
          </div>
          <div className="agent1-account-tablet__cell">
            <span className="agent1-account-tablet__label">Trade size (margin)</span>
            <strong className="agent1-account-tablet__value">
              {accountMetrics && typeof accountMetrics.tradeMarginUsd === 'number'
                ? `${fmtUsd2(accountMetrics.tradeMarginUsd)} USDT`
                : accountMetrics
                  ? `${fmtUsd2(Number.parseFloat(tradeSizeUsd))} USDT`
                  : '—'}
            </strong>
            {accountMetrics && typeof accountMetrics.tradeMarginDetail === 'string' ? (
              <span className="agent1-account-tablet__sub">{accountMetrics.tradeMarginDetail}</span>
            ) : null}
          </div>
        </div>
        <p className="hourly-spikes-hint agent1-account-tablet__hint">
          Binance route: <strong>{accountMetrics?.binanceAccount ?? binanceAccount}</strong>
          {accountMetrics?.fetchedAt ? (
            <>
              {' '}
              · updated {fmtIst(accountMetrics.fetchedAt)}
            </>
          ) : null}
        </p>
      </div>

      <div className="agent1-form-actions" style={{ marginBottom: '0.75rem' }}>
        <button type="button" className="backtest1-btn" onClick={openSimulationModal}>
          Generate simulation
        </button>
        <button
          type="button"
          className="backtest1-btn backtest1-btn--secondary"
          onClick={loadAccountMetrics}
        >
          Refresh account metrics
        </button>
      </div>
      {simResult ? (
        <div className="agent1-sim-result">
          <div className="agent1-sim-metrics-tablet">
            <div className="agent1-sim-metrics-tablet__grid">
              <div className="agent1-account-tablet__cell">
                <span className="agent1-account-tablet__label">Total trades</span>
                <strong className="agent1-account-tablet__value">
                  {simResult.summary?.totalTrades != null ? String(simResult.summary.totalTrades) : '—'}
                </strong>
              </div>
              <div className="agent1-account-tablet__cell">
                <span className="agent1-account-tablet__label">Cum Σ price %</span>
                <strong className="agent1-account-tablet__value">
                  {Number.isFinite(Number(simResult.summary?.finalPnlPctFromStart))
                    ? `${Number(simResult.summary.finalPnlPctFromStart).toFixed(3)}%`
                    : '—'}
                </strong>
              </div>
              <div className="agent1-account-tablet__cell">
                <span className="agent1-account-tablet__label">Avg % / trade</span>
                <strong className="agent1-account-tablet__value">
                  {Number.isFinite(Number(simResult.summary?.avgPnlPctPerTrade))
                    ? `${Number(simResult.summary.avgPnlPctPerTrade).toFixed(4)}%`
                    : '—'}
                </strong>
              </div>
              <div className="agent1-account-tablet__cell">
                <span className="agent1-account-tablet__label">Max DD (cum %)</span>
                <strong className="agent1-account-tablet__value agent1-account-tablet__value--neg">
                  {Number.isFinite(Number(simResult.summary?.maxDrawdownPnlPct))
                    ? `${Number(simResult.summary.maxDrawdownPnlPct).toFixed(3)}%`
                    : '—'}
                </strong>
              </div>
              <div className="agent1-account-tablet__cell">
                <span className="agent1-account-tablet__label">Run (IST)</span>
                <strong className="agent1-account-tablet__value">
                  {simResult.fetchedAt ? fmtIst(simResult.fetchedAt) : '—'}
                </strong>
              </div>
            </div>
          </div>
          <h3 className="agent1-sim-chart-title">Cumulative Σ price % (short spike strategy)</h3>
          <SpikeTpSlEquityLightChart points={simEquityCurveNoBtc} showFootnote={false} />
          <h3 className="agent1-sim-chart-title">Cumulative Σ price % · per-trade candles</h3>
          <SpikeTpSlPerTradeCandleLightChart
            perTradePricePctChron={simResult.perTradePricePctChron}
            tradesFallback={simResult.trades}
            totalTradeRows={simResult.totalTradeRows}
            serverSubsampled={Boolean(simResult.perTradePricePctSubsampled)}
            emaFastPeriod={10}
            emaSlowPeriod={50}
            cumulativePnlScale="pnlFromZero"
            showFooterHint={false}
          />
        </div>
      ) : (
        <p className="hourly-spikes-hint">No simulation yet — use Generate simulation.</p>
      )}

      {simModalOpen ? (
        <div
          className="agent1-sim-modal-backdrop"
          role="presentation"
          onClick={() => !simRunLoading && setSimModalOpen(false)}
        >
          <div
            className="agent1-sim-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent3-sim-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="agent3-sim-modal-title" className="agent1-sim-modal__title">
              Simulation parameters (short on red spikes)
            </h3>
            <p className="hourly-spikes-hint">
              Same engine as Agent 1, but <strong>strategy = short_red_spike</strong>: enter short at the next open after
              a <strong>red-body</strong> spike (same threshold % as live down spikes). R = spike high − spike close; SL
              and TP follow spike-tpsl shortRedSpike rules. Cumulative % = sum of per-trade price returns.
            </p>
            <div className="backtest1-form agent1-form agent1-sim-modal__form">
              <label className="backtest1-field">
                <span className="backtest1-label">Candles per symbol</span>
                <input
                  type="number"
                  className="backtest1-input"
                  min={50}
                  max={1500}
                  step={1}
                  value={simCandleCount}
                  onChange={(e) => setSimCandleCount(e.target.value)}
                  disabled={simRunLoading}
                />
              </label>
              <label className="backtest1-field">
                <span className="backtest1-label">Min 24h quote volume (USDT)</span>
                <input
                  type="number"
                  className="backtest1-input"
                  min={0}
                  step={100000}
                  value={simMinQuoteVol}
                  onChange={(e) => setSimMinQuoteVol(e.target.value)}
                  disabled={simRunLoading}
                />
              </label>
              <label className="backtest1-field">
                <span className="backtest1-label">Timeframe</span>
                <select
                  className="backtest1-input"
                  value={simBtInterval}
                  onChange={(e) => setSimBtInterval(e.target.value)}
                  disabled={simRunLoading}
                >
                  {AGENT1_SCAN_INTERVAL_OPTIONS.map((iv) => (
                    <option key={iv} value={iv}>
                      {iv}
                    </option>
                  ))}
                </select>
              </label>
              <label className="backtest1-field">
                <span className="backtest1-label">Spike threshold %</span>
                <input
                  type="number"
                  className="backtest1-input"
                  min={0.1}
                  step={0.1}
                  value={simThresholdPct}
                  onChange={(e) => setSimThresholdPct(e.target.value)}
                  disabled={simRunLoading}
                />
              </label>
              <label className="backtest1-field">
                <span className="backtest1-label">Max SL % cap (optional)</span>
                <input
                  type="number"
                  className="backtest1-input"
                  min={0.01}
                  step={0.01}
                  value={simMaxSlPct}
                  onChange={(e) => setSimMaxSlPct(e.target.value)}
                  disabled={simRunLoading}
                />
              </label>
              <label className="backtest1-field">
                <span className="backtest1-label">Take-profit (R multiple)</span>
                <input
                  type="number"
                  className="backtest1-input"
                  min={0.1}
                  max={100}
                  step={0.1}
                  value={simTpR}
                  onChange={(e) => setSimTpR(e.target.value)}
                  disabled={simRunLoading}
                />
              </label>
            </div>
            {simError ? (
              <p className="vol-screener-lead agent1-sim-modal__err" role="alert">
                {simError}
              </p>
            ) : null}
            <div className="agent1-sim-modal__actions">
              <button
                type="button"
                className="backtest1-btn backtest1-btn--secondary"
                onClick={() => !simRunLoading && setSimModalOpen(false)}
                disabled={simRunLoading}
              >
                Cancel
              </button>
              <button type="button" className="backtest1-btn" onClick={runAgent3Simulation} disabled={simRunLoading}>
                {simRunLoading ? 'Running…' : 'Run simulation'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <h2 ref={executionRef} className="vol-screener-title agent1-section-title agent1-anchor-target">
        Execution
      </h2>
      <p className="hourly-spikes-hint" style={{ marginTop: 0, marginBottom: '0.65rem' }}>
        Agent 3 shorts on <strong>down spikes</strong> only. Execution does not use Agent 1&apos;s EMA regime gate.
      </p>
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
          <span className="backtest1-label">Trade size (% of futures USDT wallet)</span>
          <input
            type="number"
            className="backtest1-input"
            min={0}
            max={100}
            step={0.1}
            value={tradeSizeWalletPct}
            onChange={(e) => setTradeSizeWalletPct(e.target.value)}
            disabled={loading || saving}
          />
          <span className="backtest1-footnote" style={{ gridColumn: '1 / -1', marginTop: 4 }}>
            0 = use fixed USDT margin only. If &gt; 0, each order uses that % of USDT-M wallet balance as margin
            (falls back to fixed margin if the wallet cannot be read).
          </span>
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Min available balance (% of wallet)</span>
          <input
            type="number"
            className="backtest1-input"
            min={0}
            max={100}
            step={1}
            value={minAvailableWalletPct}
            onChange={(e) => setMinAvailableWalletPct(e.target.value)}
            disabled={loading || saving}
          />
          <span className="backtest1-footnote" style={{ gridColumn: '1 / -1', marginTop: 4 }}>
            Block new entries when Binance <code>availableBalance</code> / <code>totalWalletBalance</code> is at or below
            this percent. Use 0 to disable. Uses server env default until you run{' '}
            <code>supabase/agent_settings_min_available_wallet_pct.sql</code> and save.
          </span>
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
          <span className="backtest1-label">Binance account</span>
          <select
            className="backtest1-input"
            value={binanceAccount}
            onChange={(e) => setBinanceAccount(e.target.value)}
            disabled={loading || saving}
          >
            <option value="master">Master (or BINANCE_API_KEY)</option>
            <option value="sub1">Sub 1</option>
            <option value="sub2">Sub 2</option>
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
            {saving ? 'Saving…' : 'Save Agent 3 Settings'}
          </button>
          <button
            type="button"
            className="backtest1-btn backtest1-btn--secondary"
            onClick={() => {
              loadSpikes()
              loadScanStatus()
              loadExecution()
              loadAccountMetrics()
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
        Ongoing trades (Agent 3 shorts)
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

      <h3 className="vol-screener-title agent1-section-title">Cumulative net PnL (Agent 3 closes)</h3>
      <p className="hourly-spikes-hint">
        On demand: up to the last <strong>1000</strong> rows in <code>agent3_trades</code> with status closed. Net USDT
        = realized + commission + funding. Not your full Binance account.
      </p>
      <div className="agent1-form-actions" style={{ marginBottom: '0.65rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <button
          type="button"
          className="backtest1-btn backtest1-btn--secondary"
          onClick={loadClosedPnlCurve}
          disabled={closedPnlCurveLoading}
        >
          {closedPnlCurveLoading ? 'Loading…' : 'Plot cumulative PnL (last 1000 closes)'}
        </button>
        {closedPnlCurve?.fetchedAt ? (
          <span className="hourly-spikes-hint" style={{ alignSelf: 'center' }}>
            Loaded {fmtIst(closedPnlCurve.fetchedAt)} ·{' '}
            <strong>{closedPnlCurve.tradesInCurve ?? 0}</strong> trades in curve
          </span>
        ) : null}
      </div>
      {closedPnlCurveError ? (
        <p className="backtest1-error" role="alert">
          {closedPnlCurveError}
        </p>
      ) : null}
      {closedPnlCurve && !closedPnlCurve.points?.length ? (
        <p className="hourly-spikes-hint" style={{ marginBottom: '0.75rem' }}>
          No closed rows returned — nothing to plot yet.
        </p>
      ) : null}
      {closedPnlCurve?.points?.length ? (
        <div className="spike-tpsl-lw-host" style={{ marginBottom: '1.1rem' }}>
          <Agent1ClosedTradesCumPnlChart points={closedPnlCurve.points} />
        </div>
      ) : null}

      <h2 className="vol-screener-title agent1-section-title agent1-section-title--table">
        Closed trades (Agent 3)
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
                  <th className="cell-right">Spike high</th>
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
                    <td className="cell-mono cell-right">
                      {r.spike_high != null ? Number(r.spike_high).toFixed(6) : '—'}
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
        Agent 3 logs
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
