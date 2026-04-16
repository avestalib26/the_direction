import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Agent2ClosedTradesCharts } from './Agent2ClosedTradesCharts.jsx'

const UI_POLL_MS = 12_000

const IST_TZ = 'Asia/Kolkata'

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

function formatAgo(fromMs, nowMs) {
  const sec = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  if (sec < 1) return 'just now'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ${sec % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatCountdown(targetMs, nowMs) {
  const sec = Math.max(0, Math.ceil((targetMs - nowMs) / 1000))
  if (sec <= 0) return 'due now'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** Green body % from spike OHLC; matches scan gate (body vs open). */
function spikeBodyPct(r) {
  const o = Number(r.spike_open)
  const c = Number(r.spike_close)
  if (!Number.isFinite(o) || o <= 0 || !Number.isFinite(c) || !(c > o)) return null
  return ((c - o) / o) * 100
}

async function fetchJson(url, options) {
  const res = await fetch(url, { cache: 'no-store', ...options })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export function Agent2() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState(null)
  const [scanStatus, setScanStatus] = useState(null)
  const [execution, setExecution] = useState(null)
  const [spikes, setSpikes] = useState([])
  const [error, setError] = useState(null)
  const [dataFreshAt, setDataFreshAt] = useState(null)
  const [dataLoading, setDataLoading] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const [activeTab, setActiveTab] = useState('scan')
  const scanRef = useRef(null)
  const riskRef = useRef(null)
  const executionRef = useRef(null)
  const spikesRef = useRef(null)
  const logsRef = useRef(null)

  const sectionTabs = useMemo(
    () => [
      { id: 'scan', label: 'Scan', ref: scanRef },
      { id: 'risk', label: 'Risk & scan', ref: riskRef },
      { id: 'execution', label: 'Execution', ref: executionRef },
      { id: 'spikes', label: 'Spikes', ref: spikesRef },
      { id: 'logs', label: 'Logs', ref: logsRef },
    ],
    [],
  )

  const loadAll = useCallback(async () => {
    setError(null)
    setDataLoading(true)
    try {
      const [s, sc, ex, sp] = await Promise.all([
        fetchJson('/api/agents/agent2/settings'),
        fetchJson('/api/agents/agent2/scan-status'),
        fetchJson('/api/agents/agent2/execution'),
        fetchJson('/api/agents/agent2/spikes?limit=500'),
      ])
      setSettings(s.settings ?? null)
      setScanStatus(sc)
      setExecution(ex)
      setSpikes(sp.spikes ?? [])
      setDataFreshAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setLoading(false)
      setDataLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAll()
    const t = setInterval(() => void loadAll(), UI_POLL_MS)
    return () => clearInterval(t)
  }, [loadAll])

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const on = () => void loadAll()
    window.addEventListener('agent2-settings-changed', on)
    return () => window.removeEventListener('agent2-settings-changed', on)
  }, [loadAll])

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

  const [visiblePendingCount, setVisiblePendingCount] = useState(30)
  const [visibleOpenCount, setVisibleOpenCount] = useState(30)
  const [visibleSpikesCount, setVisibleSpikesCount] = useState(30)
  const [visibleLogCount, setVisibleLogCount] = useState(30)

  const pendingOrdersAll = useMemo(
    () =>
      (execution?.entryOrders ?? []).filter((o) =>
        ['NEW', 'PARTIALLY_FILLED'].includes(String(o.status ?? '').toUpperCase()),
      ),
    [execution],
  )
  const ongoingTradesAll = useMemo(() => execution?.ongoingTrades ?? [], [execution])
  const closedTradesAll = useMemo(() => execution?.closedTrades ?? [], [execution])
  const logsAll = useMemo(
    () => (Array.isArray(execution?.logs) ? execution.logs : []),
    [execution],
  )

  const visiblePendingOrders = useMemo(
    () => pendingOrdersAll.slice(0, Math.max(30, visiblePendingCount)),
    [pendingOrdersAll, visiblePendingCount],
  )
  const visibleOngoingTrades = useMemo(
    () => ongoingTradesAll.slice(0, Math.max(30, visibleOpenCount)),
    [ongoingTradesAll, visibleOpenCount],
  )
  const visibleSpikesRows = useMemo(
    () => spikes.slice(0, Math.max(30, visibleSpikesCount)),
    [spikes, visibleSpikesCount],
  )
  const visibleLogs = useMemo(
    () => logsAll.slice(0, Math.max(30, visibleLogCount)),
    [logsAll, visibleLogCount],
  )

  const saveSettings = async (partial) => {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      const merged = { ...settings, ...partial }
      const { id: _i, updatedAt: _u, ...body } = merged
      const data = await fetchJson('/api/agents/agent2/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setSettings(data.settings ?? merged)
      window.dispatchEvent(new Event('agent2-settings-changed'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const runScanNow = async () => {
    setError(null)
    try {
      const data = await fetchJson('/api/agents/agent2/scan-now', { method: 'POST' })
      if (data?.skipped === 'not_scan_lease_owner') {
        setError('Scan not run: another server holds the Agent 2 scan lease (see AGENT2_SCAN_WRITER_ID).')
      }
      await loadAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed')
    }
  }

  if (loading && !settings) {
    return (
      <div className="vol-screener agent1-page agent2-page">
        <p className="muted">Loading Agent 2…</p>
      </div>
    )
  }

  const s = settings ?? {}
  const pendingOrders = pendingOrdersAll
  const ongoingTrades = ongoingTradesAll
  const closedTrades = closedTradesAll

  const schedOn = scanStatus?.schedulerEnabled !== false
  const interval = String(scanStatus?.scanInterval ?? s.scanInterval ?? '5m')
  const secAfterClose = Number(scanStatus?.scanSecondsAfterClose ?? s.scanSecondsAfterClose ?? 5)
  const nextFireAt = scanStatus?.nextFireAt
  const nextFireMs = typeof nextFireAt === 'number' && Number.isFinite(nextFireAt) ? nextFireAt : null
  const scanRunning = scanStatus?.running === true
  const signalsWillRun = s.agentEnabled === true && s.signalsSchedulerEnabled === true
  const execRunning = execution?.state?.running === true

  return (
    <div className="vol-screener agent1-page agent2-page">
      <nav className="agent1-tabs" aria-label="Agent 2 sections">
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
              <span className="hourly-spikes-hint"> (set AGENT2_SCAN_SCHEDULER=false)</span>
            ) : null}
          </div>
          <div className="risk-chip">
            Signals scan: <strong>{s.signalsSchedulerEnabled === true ? 'ON' : 'OFF'}</strong>
          </div>
          <div className="risk-chip">
            Trading: <strong>{s.tradingEnabled === true ? 'ON' : 'OFF'}</strong>
            <span className="hourly-spikes-hint"> (header)</span>
          </div>
          <div className="risk-chip">
            Next run: <strong>{fmtIst(scanStatus.nextFireAt)}</strong>
            {nextFireMs != null ? (
              <span className="hourly-spikes-hint"> ({formatCountdown(nextFireMs, clock)})</span>
            ) : null}
          </div>
          <div className="risk-chip">
            Last run: <strong>{fmtIst(scanStatus.lastRunAt)}</strong>
          </div>
          <div className="risk-chip">
            Last spikes written: <strong>{scanStatus.lastSpikeCount ?? '—'}</strong>
          </div>
          <div className="risk-chip">
            Scan timeframe: <strong>{scanStatus.scanInterval ?? interval}</strong>
          </div>
          <div className="risk-chip">
            Scan delay:{' '}
            <strong>
              {secAfterClose}s after bar close
            </strong>
          </div>
          <div className="risk-chip">
            Body threshold: <strong>{s.scanThresholdPct ?? '—'}%</strong>
          </div>
          <div className="risk-chip">
            Regime / EMA gate: <strong>—</strong>
            <span className="hourly-spikes-hint"> (not used on Agent 2)</span>
          </div>
          <div className="risk-chip">
            Exec loop: <strong>{execRunning ? 'running' : 'idle'}</strong>
          </div>
          <div className="risk-chip">
            Scan lease:{' '}
            <strong>
              {scanStatus.scanLeaseOwner === true
                ? 'owner'
                : scanStatus.scanLeaseOwner === false
                  ? 'standby'
                  : 'inactive'}
            </strong>
            <span className="hourly-spikes-hint">
              {scanStatus.scanLeaseOwner === true || scanStatus.scanLeaseOwner === false
                ? ' (Supabase lock)'
                : ' (no scan tick yet, or agent/signals scan off)'}
            </span>
          </div>
          <div className="risk-chip">
            Exec lease: <strong>{execution?.state?.leaseOwner ? 'owner' : 'standby'}</strong>
          </div>
          <div className="risk-chip">
            Pending entries: <strong>{pendingOrders.length}</strong>
          </div>
          <div className="risk-chip">
            Open trades:{' '}
            <strong>
              {ongoingTrades.length} / {s.maxOpenPositions ?? 10}
            </strong>
          </div>
          <div className="risk-chip">
            UI data:{' '}
            <strong>
              {dataLoading ? 'fetching…' : dataFreshAt != null ? `${formatAgo(dataFreshAt, clock)} ago` : '—'}
            </strong>
            <span className="hourly-spikes-hint"> ({UI_POLL_MS / 1000}s poll)</span>
          </div>
          {scanRunning ? (
            <div className="risk-chip">
              <strong>Scan in progress…</strong>
            </div>
          ) : null}
          {!signalsWillRun && schedOn ? (
            <div className="risk-chip">
              <span className="hourly-spikes-hint">
                Scheduled scan no-ops until master + signals scan are on.
              </span>
            </div>
          ) : null}
          {scanStatus.lastError ? (
            <div className="risk-chip pnl-neg">
              <strong>Scan error:</strong> {scanStatus.lastError}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="pnl-neg" role="alert" style={{ margin: '0.35rem 0 0.75rem' }}>
          {error}
        </p>
      ) : null}

      <h2 ref={scanRef} className="vol-screener-title agent1-section-title agent1-anchor-target">
        Scan scheduler
      </h2>
      <div className="backtest1-form agent1-form agent2-scan-scheduler">
        <p className="muted agent2-scan-scheduler__intro">
          Next run, last run, spike count, and bar timing are in the <strong>metrics row</strong> above. Use{' '}
          <strong>Signals</strong> here; <strong>Trading</strong> lives in the header.
        </p>
        <div className="agent1-form-actions agent2-scan-scheduler__row">
          <button type="button" className="btn-refresh" onClick={() => void loadAll()} disabled={loading}>
            Refresh
          </button>
          <button type="button" className="btn-refresh" onClick={() => void runScanNow()}>
            Scan now
          </button>
          <button
            type="button"
            className={`backtest1-btn ${s.signalsSchedulerEnabled === true ? '' : 'backtest1-btn--secondary'}`}
            onClick={() =>
              void saveSettings({ signalsSchedulerEnabled: s.signalsSchedulerEnabled !== true })
            }
            disabled={saving || s.agentEnabled !== true}
            title={
              s.agentEnabled !== true
                ? 'Turn master on in the header first'
                : s.signalsSchedulerEnabled
                  ? 'Stop writing spikes on scheduled scans'
                  : 'Start writing spikes on scheduled scans'
            }
          >
            {saving
              ? 'Saving…'
              : s.signalsSchedulerEnabled
                ? 'Signals: ON'
                : 'Signals: OFF'}
          </button>
        </div>
      </div>

      <h2 ref={riskRef} className="vol-screener-title agent1-section-title agent1-anchor-target">
        Risk &amp; scan
      </h2>
      <div className="backtest1-form agent1-form">
        <label className="backtest1-field">
          <span className="backtest1-label">Trade size (USD)</span>
          <input
            type="number"
            className="backtest1-input"
            min={0.01}
            step="any"
            value={s.tradeSizeUsd ?? ''}
            onChange={(e) => setSettings({ ...s, tradeSizeUsd: Number.parseFloat(e.target.value) })}
            onBlur={() => void saveSettings({ tradeSizeUsd: s.tradeSizeUsd })}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Leverage</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={1}
            max={125}
            value={s.leverage ?? ''}
            onChange={(e) => setSettings({ ...s, leverage: Number.parseInt(e.target.value, 10) })}
            onBlur={() => void saveSettings({ leverage: s.leverage })}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Max SL %</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            step="0.01"
            value={s.maxSlPct ?? ''}
            onChange={(e) => setSettings({ ...s, maxSlPct: Number.parseFloat(e.target.value) })}
            onBlur={() => void saveSettings({ maxSlPct: s.maxSlPct })}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Max TP % (cap)</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            step="0.01"
            value={s.maxTpPct ?? ''}
            onChange={(e) => setSettings({ ...s, maxTpPct: Number.parseFloat(e.target.value) })}
            onBlur={() => void saveSettings({ maxTpPct: s.maxTpPct })}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">TP R (vs risk width)</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            step="0.1"
            value={s.tpR ?? ''}
            onChange={(e) => setSettings({ ...s, tpR: Number.parseFloat(e.target.value) })}
            onBlur={() => void saveSettings({ tpR: s.tpR })}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">TP at spike high</span>
          <input
            type="checkbox"
            checked={s.longRetestTpAtSpikeHigh === true}
            onChange={(e) => void saveSettings({ longRetestTpAtSpikeHigh: e.target.checked })}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Body spike threshold %</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            step="0.1"
            value={s.scanThresholdPct ?? ''}
            onChange={(e) => setSettings({ ...s, scanThresholdPct: Number.parseFloat(e.target.value) })}
            onBlur={() => void saveSettings({ scanThresholdPct: s.scanThresholdPct })}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Min24h quote volume</span>
          <input
            type="number"
            className="backtest1-input"
            value={s.scanMinQuoteVolume ?? ''}
            onChange={(e) => setSettings({ ...s, scanMinQuoteVolume: Number.parseFloat(e.target.value) })}
            onBlur={() => void saveSettings({ scanMinQuoteVolume: s.scanMinQuoteVolume })}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Max symbols</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={1}
            max={800}
            value={s.scanMaxSymbols ?? ''}
            onChange={(e) => setSettings({ ...s, scanMaxSymbols: Number.parseInt(e.target.value, 10) })}
            onBlur={() => void saveSettings({ scanMaxSymbols: s.scanMaxSymbols })}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Seconds after bar close</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={0}
            max={120}
            step={1}
            value={s.scanSecondsAfterClose ?? ''}
            onChange={(e) =>
              setSettings({ ...s, scanSecondsAfterClose: Number.parseInt(e.target.value, 10) })
            }
            onBlur={() => void saveSettings({ scanSecondsAfterClose: s.scanSecondsAfterClose })}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Max open positions</span>
          <input
            type="number"
            className="backtest1-input backtest1-input--narrow"
            min={1}
            max={50}
            value={s.maxOpenPositions ?? ''}
            onChange={(e) => setSettings({ ...s, maxOpenPositions: Number.parseInt(e.target.value, 10) })}
            onBlur={() => void saveSettings({ maxOpenPositions: s.maxOpenPositions })}
          />
        </label>
        <label className="backtest1-field">
          <span className="backtest1-label">Entry working type</span>
          <select
            className="backtest1-input"
            value={s.workingType ?? 'MARK_PRICE'}
            onChange={(e) => void saveSettings({ workingType: e.target.value })}
          >
            <option value="MARK_PRICE">MARK_PRICE</option>
            <option value="CONTRACT_PRICE">CONTRACT_PRICE</option>
          </select>
        </label>
      </div>

      <h2 ref={executionRef} className="vol-screener-title agent1-section-title agent1-anchor-target">
        Execution
      </h2>

      <h3 className="vol-screener-title agent1-section-title">Pending entry orders</h3>
      <div className="table-wrap agent1-spikes-wrap">
        <table className="positions-table agent1-spikes-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Spike candle (IST)</th>
              <th>Trigger</th>
              <th>Status</th>
              <th>Exchange</th>
              <th>Algo id</th>
            </tr>
          </thead>
          <tbody>
            {pendingOrders.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  None
                </td>
              </tr>
            ) : (
              visiblePendingOrders.map((o) => (
                <tr key={o.id}>
                  <td>{o.symbol}</td>
                  <td className="cell-mono">
                    {o.spike_candle_open_time_ms != null ? fmtIst(o.spike_candle_open_time_ms) : '—'}
                  </td>
                  <td>{o.stop_price}</td>
                  <td>{o.status}</td>
                  <td className="cell-mono muted">{o.last_exchange_status ?? '—'}</td>
                  <td className="cell-mono">{o.binance_order_id ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pendingOrders.length > 30 ? (
        <div className="agent1-form-actions" style={{ paddingTop: 8, paddingBottom: 0 }}>
          <button
            type="button"
            className="backtest1-btn backtest1-btn--secondary"
            onClick={() => setVisiblePendingCount((n) => Math.min(pendingOrders.length, n + 100))}
            disabled={visiblePendingOrders.length >= pendingOrders.length}
          >
            View more (+100)
          </button>
          {visiblePendingCount > 30 ? (
            <button
              type="button"
              className="backtest1-btn backtest1-btn--secondary"
              onClick={() => setVisiblePendingCount(30)}
            >
              Show less (30)
            </button>
          ) : null}
        </div>
      ) : null}

      <h3 className="vol-screener-title agent1-section-title">Open positions (Agent 2 trades)</h3>
      <div className="table-wrap agent1-spikes-wrap">
        <table className="positions-table agent1-spikes-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Entry</th>
              <th>Bracket</th>
              <th>TP / SL</th>
            </tr>
          </thead>
          <tbody>
            {ongoingTrades.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  None
                </td>
              </tr>
            ) : (
              visibleOngoingTrades.map((t) => {
                const ur = Number(t.unRealizedProfit)
                const rowCls =
                  Number.isFinite(ur) && ur > 0
                    ? 'agent1-trade-row agent1-trade-row--pos'
                    : Number.isFinite(ur) && ur < 0
                      ? 'agent1-trade-row agent1-trade-row--neg'
                      : 'agent1-trade-row'
                return (
                  <tr key={t.id} className={rowCls}>
                    <td>{t.symbol}</td>
                    <td>{t.entry_price ?? '—'}</td>
                    <td>{t.bracket_state}</td>
                    <td>
                      {t.tp_trigger_price ?? '—'} / {t.sl_trigger_price ?? '—'}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      {ongoingTrades.length > 30 ? (
        <div className="agent1-form-actions" style={{ paddingTop: 8, paddingBottom: 0 }}>
          <button
            type="button"
            className="backtest1-btn backtest1-btn--secondary"
            onClick={() => setVisibleOpenCount((n) => Math.min(ongoingTrades.length, n + 100))}
            disabled={visibleOngoingTrades.length >= ongoingTrades.length}
          >
            View more (+100)
          </button>
          {visibleOpenCount > 30 ? (
            <button
              type="button"
              className="backtest1-btn backtest1-btn--secondary"
              onClick={() => setVisibleOpenCount(30)}
            >
              Show less (30)
            </button>
          ) : null}
        </div>
      ) : null}

      <h3 className="vol-screener-title agent1-section-title">Closed trades (this agent only)</h3>
      <p className="muted" style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem' }}>
        Last 100 closes (newest at top). Row tint = realized P&amp;L sign.
      </p>
      <Agent2ClosedTradesCharts closedTrades={closedTrades} />
      <div className="table-wrap agent1-spikes-wrap">
        <table className="positions-table agent1-spikes-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Opened</th>
              <th>Closed</th>
              <th>Entry</th>
              <th>TP / SL</th>
              <th>Reason</th>
              <th>Realized</th>
            </tr>
          </thead>
          <tbody>
            {closedTrades.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  None
                </td>
              </tr>
            ) : (
              closedTrades.map((t) => {
                const pnl = Number(t.realized_pnl_usdt)
                const rowCls = Number.isFinite(pnl)
                  ? pnl > 0
                    ? 'agent1-trade-row agent1-trade-row--pos'
                    : pnl < 0
                      ? 'agent1-trade-row agent1-trade-row--neg'
                      : 'agent1-trade-row'
                  : 'agent1-trade-row'
                const pnlCellCls =
                  Number.isFinite(pnl) && pnl > 0
                    ? 'cell-mono cell-right cell-pnl pnl-pos'
                    : Number.isFinite(pnl) && pnl < 0
                      ? 'cell-mono cell-right cell-pnl pnl-neg'
                      : 'cell-mono cell-right'
                return (
                  <tr key={t.id} className={rowCls}>
                    <td>{t.symbol}</td>
                    <td className="cell-mono">{t.opened_at != null ? fmtIst(t.opened_at) : '—'}</td>
                    <td className="cell-mono">{t.closed_at != null ? fmtIst(t.closed_at) : '—'}</td>
                    <td>{t.entry_price ?? '—'}</td>
                    <td className="cell-mono muted">
                      {t.tp_trigger_price ?? '—'} / {t.sl_trigger_price ?? '—'}
                    </td>
                    <td className="muted">{t.close_reason ?? '—'}</td>
                    <td className={pnlCellCls}>
                      {Number.isFinite(pnl) ? pnl.toFixed(4) : '—'}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <h2 ref={spikesRef} className="vol-screener-title agent1-section-title agent1-anchor-target">
        Recent spikes
      </h2>
      <div className="table-wrap agent1-spikes-wrap">
        <table className="positions-table agent1-spikes-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Symbol</th>
              <th>Low</th>
              <th>Body %</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {spikes.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  None yet
                </td>
              </tr>
            ) : (
              visibleSpikesRows.map((r) => {
                const issue =
                  String(r.status ?? '').toLowerCase() === 'arm_failed' ||
                  String(r.status ?? '').toLowerCase() === 'skipped'
                const bodyPct = spikeBodyPct(r)
                return (
                  <tr key={r.id} className={issue ? 'agent2-spike-row--issue' : undefined}>
                    <td className="cell-mono">
                      {r.candle_open_time_ms != null ? fmtIst(r.candle_open_time_ms) : '—'}
                    </td>
                    <td>{r.symbol}</td>
                    <td>{r.spike_low}</td>
                    <td className="cell-mono cell-right">
                      {bodyPct != null ? `${bodyPct.toFixed(2)}%` : '—'}
                    </td>
                    <td>{r.status}</td>
                    <td className="cell-mono muted" style={{ maxWidth: '24rem' }}>
                      {r.skip_reason ?? '—'}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      {spikes.length > 30 ? (
        <div className="agent1-form-actions" style={{ paddingTop: 8, paddingBottom: 0 }}>
          <button
            type="button"
            className="backtest1-btn backtest1-btn--secondary"
            onClick={() => setVisibleSpikesCount((n) => Math.min(spikes.length, n + 100))}
            disabled={visibleSpikesRows.length >= spikes.length}
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

      <h2 ref={logsRef} className="vol-screener-title agent1-section-title agent1-anchor-target">
        Logs
      </h2>
      <p className="muted" style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem' }}>
        Newest first (same order as Agent 1). Scan errors also appear in the metrics row above.
      </p>
      {logsAll.length === 0 ? (
        <p className="hourly-spikes-hint">No log lines yet.</p>
      ) : (
        <>
          <div className="table-wrap agent1-spikes-wrap">
            <table className="positions-table agent1-spikes-table" role="log" aria-label="Agent 2 logs">
              <thead>
                <tr>
                  <th>Time (IST)</th>
                  <th>Level</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.map((l, idx) => {
                  const lev = String(l.level ?? '').toLowerCase()
                  const rowClass =
                    lev === 'error'
                      ? 'agent2-log-row agent2-log-row--error'
                      : lev === 'warn'
                        ? 'agent2-log-row agent2-log-row--warn'
                        : 'agent2-log-row'
                  return (
                    <tr key={`${l.at}-${idx}`} className={rowClass}>
                      <td className="cell-mono">{fmtIst(l.at)}</td>
                      <td className="cell-mono">{String(l.level ?? '').toUpperCase()}</td>
                      <td>{l.msg}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {logsAll.length > 30 ? (
            <div className="agent1-form-actions" style={{ paddingTop: 8, paddingBottom: 0 }}>
              <button
                type="button"
                className="backtest1-btn backtest1-btn--secondary"
                onClick={() => setVisibleLogCount((n) => Math.min(logsAll.length, n + 100))}
                disabled={visibleLogs.length >= logsAll.length}
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
