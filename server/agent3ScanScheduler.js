import { computeFiveMinScreener } from './fiveMinScreener.js'
import { agent1IntervalMs, msUntilNextAgent1Scan } from './agent1ScanIntervals.js'

/** @typedef {{ nextFireAt: number | null, lastRunAt: number | null, lastError: string | null, lastSpikeCount: number | null, running: boolean }} Agent3SchedulerState */

/** @type {Agent3SchedulerState} */
export const agent3SchedulerState = {
  nextFireAt: null,
  lastRunAt: null,
  lastError: null,
  lastSpikeCount: null,
  running: false,
}

/**
 * Same cadence as Agent 1 scan; persists only down spikes to agent3_spikes.
 */
export function startAgent3ScanScheduler(deps) {
  const { futuresBase, isEnabled, readSettings, persistScan, logger = console } = deps
  let timer = null
  let stopped = false

  const stop = () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  if (!isEnabled()) {
    logger.log?.('[agent3-scan] scheduler off (set AGENT3_SCAN_SCHEDULER=true to enable)')
    return { stop, state: agent3SchedulerState }
  }

  async function scheduleNext() {
    if (stopped) return
    let s
    try {
      s = await readSettings()
    } catch (e) {
      agent3SchedulerState.lastError = e instanceof Error ? e.message : String(e)
      timer = setTimeout(scheduleNext, 60_000)
      return
    }
    const intervalMs = agent1IntervalMs(s.scanInterval)
    const { delayMs, nextFireAt } = msUntilNextAgent1Scan(
      Date.now(),
      s.scanSecondsBeforeClose,
      intervalMs,
    )
    agent3SchedulerState.nextFireAt = nextFireAt
    timer = setTimeout(runTick, delayMs)
  }

  async function runTick() {
    if (stopped) return
    agent3SchedulerState.running = true
    agent3SchedulerState.lastError = null
    try {
      const s = await readSettings()
      if (!s.agentEnabled) {
        return
      }
      const thresholdPct = Number(s.scanThresholdPct)
      const minQuoteVolume = Number(s.scanMinQuoteVolume)
      const maxSymbols = Number(s.scanMaxSymbols)
      const spikeMetric = String(s.scanSpikeMetric ?? 'body').toLowerCase()
      const spikeDirections = String(s.scanDirection ?? 'down').toLowerCase()
      const scanInterval = String(s.scanInterval ?? '5m').trim()

      const result = await computeFiveMinScreener(futuresBase, {
        candleCount: 1,
        interval: scanInterval,
        minQuoteVolume: Number.isFinite(minQuoteVolume) && minQuoteVolume >= 0 ? minQuoteVolume : 0,
        thresholdPct: Number.isFinite(thresholdPct) && thresholdPct > 0 ? thresholdPct : 3,
        spikeDirections: ['up', 'down', 'both'].includes(spikeDirections) ? spikeDirections : 'down',
        spikeMetric: spikeMetric === 'wick' ? 'wick' : 'body',
        maxSymbols: Number.isFinite(maxSymbols) && maxSymbols > 0 ? Math.min(800, maxSymbols) : undefined,
      })

      const { spikeCount } = await persistScan(result)
      agent3SchedulerState.lastRunAt = Date.now()
      agent3SchedulerState.lastSpikeCount = spikeCount
    } catch (e) {
      agent3SchedulerState.lastError = e instanceof Error ? e.message : String(e)
      deps.logger.error?.('[agent3-scan] tick failed', e)
    } finally {
      agent3SchedulerState.running = false
      scheduleNext()
    }
  }

  scheduleNext()
  logger.log?.('[agent3-scan] scheduler started (kline-aligned cadence from agent3 settings)')
  return { stop, state: agent3SchedulerState }
}
