/** In-memory atomic-at-the-call-boundary attempt store for M0 proof tests. */
export function createM0AttemptStore() {
  const records = new Map()
  const transitions = []

  return {
    records,
    transitions,

    async recordPreflightFailure({ recordKey, state, errorCode }) {
      if (records.has(recordKey)) return false
      const record = { recordKey, state, errorCode }
      records.set(recordKey, record)
      transitions.push({ recordKey, state })
      return true
    },

    async claimPrepared(attempt) {
      const existing = records.get(attempt.recordKey)
      if (existing) return { created: false, record: { ...existing } }

      const record = { ...attempt, state: 'prepared' }
      records.set(attempt.recordKey, record)
      transitions.push({ recordKey: attempt.recordKey, state: 'prepared' })
      return { created: true, record: { ...record } }
    },

    async setState(recordKey, state) {
      const existing = records.get(recordKey)
      if (!existing) throw new Error('Attempt was not reserved')
      if (existing.state === 'accepted' && state === 'unknown') return false
      if (!['accepted', 'unknown', 'failed'].includes(state)) throw new Error('Unsupported attempt transition')
      if (state === 'failed' && existing.state !== 'prepared') throw new Error('A sent attempt can only fail on an explicit paid-transport response')

      records.set(recordKey, { ...existing, state })
      transitions.push({ recordKey, state })
      return true
    },
  }
}
