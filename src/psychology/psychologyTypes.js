/**
 * Reference types for the psychology dashboard (JSDoc — project is plain JS).
 *
 * @typedef {Object} NormalizedTrade
 * @property {string} symbol
 * @property {number|string} orderId
 * @property {string} positionSide
 * @property {number} closedAt
 * @property {number} realizedPnl
 * @property {number} fills
 * @property {number} qty
 * @property {number} [chartTime]
 *
 * @typedef {Object} EquityPoint
 * @property {number} chartTime
 * @property {number} closedAt
 * @property {string} symbol
 * @property {number|string} orderId
 * @property {number} cum
 * @property {number} peak
 * @property {number} drawdownFromPeak
 * @property {NormalizedTrade} trade
 *
 * @typedef {Object} TimelineEvent
 * @property {number} chartTime
 * @property {number} closedAt
 * @property {'peak'|'drawdown'|'burst'|'session'} kind
 * @property {string} label
 * @property {string} detail
 */

export const TYPES_DOC = true
