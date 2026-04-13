/**
 * Enrich time-wise spike slots with wick imbalance and optional directional-next net.
 *
 * @param {object} slot - spikeSlotsTimeWiseV2 row from API
 * @returns {object} slot + wickSignedSum, sumNextAll, meanNextAll, directionalNet
 */
export function enrichSpikeSlot(slot) {
  const events = Array.isArray(slot.events) ? slot.events : []
  let wickSignedSum = 0
  let sumNextAll = 0
  let nextN = 0
  for (const e of events) {
    wickSignedSum += Number(e.spikePct) || 0
    if (e.nextCandlePct != null && Number.isFinite(e.nextCandlePct)) {
      sumNextAll += e.nextCandlePct
      nextN += 1
    }
  }
  const meanNextAll = nextN > 0 ? sumNextAll / nextN : 0
  /** Wick Σ > 0 → long total next % sum; < 0 → short that total (flip sign); 0 → flat. */
  let directionalNet = 0
  if (wickSignedSum > 0) directionalNet = sumNextAll
  else if (wickSignedSum < 0) directionalNet = -sumNextAll

  return {
    ...slot,
    wickSignedSum,
    sumNextAll,
    meanNextAll,
    directionalNet,
  }
}

export function enrichSpikeSlots(slots) {
  if (!Array.isArray(slots)) return []
  return slots.map(enrichSpikeSlot)
}
