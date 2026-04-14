import { computeFiveMinScreener } from './fiveMinScreener.js'
import { agent1IntervalMs, msUntilNextAgent1Scan } from './agent1ScanIntervals.js'

/** @typedef {{ nextFireAt: number | null, lastRunAt: number | null, lastError: string | null, lastSpikeCount: number | null, running: boolean }} Agent1SchedulerState */

/** @type {Agent1SchedulerState} */
export const agent1SchedulerState = {
  nextFireAt: null,
  lastRunAt: null,
  lastError: null,
  lastSpikeCount: null,
  running: false,
}

/**
 * @param {object} deps
 * @param {string} deps.futuresBase
 * @param {() => boolean} deps.isEnabled
 * @param {() => Promise<object>} deps.readSettings — Agent 1 settings including scan_* fields
 * @param {(scanResult: object) => Promise<{ spikeCount: number }>} deps.persistScan
 * @param {{ log?: typeof console.log, error?: typeof console.error }} [deps.logger]
 */
export function startAgent1ScanScheduler(deps) {
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
    logger.log?.('[agent1-scan] scheduler off (set AGENT1_SCAN_SCHEDULER=true to enable)')
    return { stop, state: agent1SchedulerState }
  }

  async function scheduleNext() {
    if (stopped) return
    let s
    try {
      s = await readSettings()
    } catch (e) {
      agent1SchedulerState.lastError = e instanceof Error ? e.message : String(e)
      timer = setTimeout(scheduleNext, 60_000)
      return
    }
    const intervalMs = agent1IntervalMs(s.scanInterval)
    const { delayMs, nextFireAt } = msUntilNextAgent1Scan(
      Date.now(),
      s.scanSecondsBeforeClose,
      intervalMs,
    )
    agent1SchedulerState.nextFireAt = nextFireAt
    timer = setTimeout(runTick, delayMs)
  }

  async function runTick() {
    if (stopped) return
    agent1SchedulerState.running = true
    agent1SchedulerState.lastError = null
    try {
      const s = await readSettings()
      if (!s.agentEnabled) {
        return
      }
      const thresholdPct = Number(s.scanThresholdPct)
      const minQuoteVolume = Number(s.scanMinQuoteVolume)
      const maxSymbols = Number(s.scanMaxSymbols)
      const spikeMetric = String(s.scanSpikeMetric ?? 'body').toLowerCase()
      const spikeDirections = String(s.scanDirection ?? 'both').toLowerCase()
      const scanInterval = String(s.scanInterval ?? '5m').trim()

      const result = await computeFiveMinScreener(futuresBase, {
        candleCount: 1,
        interval: scanInterval,
        minQuoteVolume: Number.isFinite(minQuoteVolume) && minQuoteVolume >= 0 ? minQuoteVolume : 0,
        thresholdPct: Number.isFinite(thresholdPct) && thresholdPct > 0 ? thresholdPct : 3,
        spikeDirections: ['up', 'down', 'both'].includes(spikeDirections) ? spikeDirections : 'both',
        spikeMetric: spikeMetric === 'wick' ? 'wick' : 'body',
        maxSymbols: Number.isFinite(maxSymbols) && maxSymbols > 0 ? Math.min(800, maxSymbols) : undefined,
      })

      const { spikeCount } = await persistScan(result)
      agent1SchedulerState.lastRunAt = Date.now()
      agent1SchedulerState.lastSpikeCount = spikeCount
    } catch (e) {
      agent1SchedulerState.lastError = e instanceof Error ? e.message : String(e)
      deps.logger.error?.('[agent1-scan] tick failed', e)
    } finally {
      agent1SchedulerState.running = false
      scheduleNext()
    }
  }

  scheduleNext()
  logger.log?.('[agent1-scan] scheduler started (kline-aligned cadence from settings)')
  return { stop, state: agent1SchedulerState }
}
