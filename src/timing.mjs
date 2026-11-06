// How long a run took, folded from its ledger events. Pure: the live coordinator
// and the read-only dashboard pass the same rows and get the same numbers.
//
// accumulatedMs counts wall time from the first approval (else the start) while
// the run is neither paused, blocked, cancelled nor settled. attentionMs is the
// part of that with at least one ticket in NEEDS_ATTENTION, usually waiting for a
// person. Per-ticket workerMs is wall time of each attempt and is not clipped by a
// pause, which only stops admission: claimed until submitted, or until the attempt
// ended without a submission. A span still open counts up to now, or up to endedAt
// once the run has stopped, so a worker nobody settled does not grow forever.
//
// queueMs is submitted until the integration lane starts on the ticket, and
// verifyMs sums its finished check commands. A ticket with no verify_started has
// neither number (null), and totals are null while any integrated ticket lacks
// one: a ledger from before these events cannot split the two.

// Each of these means the ticket left whatever state it was in.
const SETTLES_TICKET = new Set([
  'claimed',
  'pending',
  'submitted',
  'publishing',
  'integrated',
  'needs_attention',
  'cancelled',
  'conflict_requeued',
  'retry_deferred',
  'retry_requested',
  'isolated_retry_requested',
])

// run_started records the mode it began in. A ledger from before that shows a
// plan still under review only by never having claimed a ticket.
function awaitingApproval(started, events) {
  const mode = started?.details?.mode
  return mode === undefined ? !events.some((e) => e.type === 'claimed') : mode === 'staged'
}

/**
 * @param events - the run's event rows in ledger order, with parsed details.
 * @param now - the current time in epoch milliseconds.
 * @returns the timing, or null while the plan waits for approval.
 */
export function runTiming(events, now) {
  const started = events.find((e) => e.type === 'run_started')
  const approved = events.find((e) => e.type === 'run_approved')
  const origin = approved ?? started
  if (!origin || (!approved && awaitingApproval(started, events))) return null

  let accumulatedMs = 0
  let attentionMs = 0
  let cursor = origin.createdAt
  let runningSince = origin.createdAt
  let endedAt = null
  // A pause holds even across a completion, and an append only wakes a settled run.
  let paused = false
  let settled = false
  let cancelled = false
  const totals = { workerMs: 0, queueMs: 0, verifyMs: 0, checkRuns: 0, checkFailures: 0, conflicts: 0, attempts: 0 }
  const tickets = new Map()
  const inAttention = new Set()

  const ticketOf = (id) => {
    let t = tickets.get(id)
    if (!t) {
      t = { attempts: 0, workerMs: 0, queueMs: 0, verifyMs: 0, attentionMs: 0 }
      t.claimedAt = t.submittedAt = null
      t.verified = t.integrated = false
      tickets.set(id, t)
    }
    return t
  }
  const closeWorker = (t, at) => {
    if (t.claimedAt !== null) t.workerMs += Math.max(0, at - t.claimedAt)
    t.claimedAt = null
  }
  const closeQueue = (t, at) => {
    if (t.submittedAt !== null) t.queueMs += Math.max(0, at - t.submittedAt)
    t.submittedAt = null
  }
  const advance = (at) => {
    if (at <= cursor) return
    if (runningSince !== null) {
      const span = at - cursor
      accumulatedMs += span
      if (inAttention.size) attentionMs += span
      for (const t of inAttention) t.attentionMs += span
    }
    cursor = at
  }
  // Called after every run-level event: opens or closes the segment it changed.
  const applyRunState = (at) => {
    const running = !paused && !settled && !cancelled
    if (running && runningSince === null) {
      runningSince = at
      endedAt = null
    } else if (!running && runningSince !== null) {
      runningSince = null
      endedAt = at
    }
  }

  for (const e of events.slice(events.indexOf(origin) + 1)) {
    const at = e.createdAt
    advance(at)
    switch (e.type) {
      case 'run_paused':
      case 'run_blocked':
        paused = true
        break
      case 'run_cancelled':
        cancelled = true
        break
      case 'run_completed':
        settled = true
        break
      case 'run_active':
      case 'run_approved':
        paused = false
        break
      case 'tickets_appended':
        settled = false
        break
    }
    applyRunState(at)
    if (!e.ticketId) continue
    const t = ticketOf(e.ticketId)
    if (SETTLES_TICKET.has(e.type)) {
      closeWorker(t, at)
      closeQueue(t, at)
      inAttention.delete(t)
    }
    switch (e.type) {
      case 'claimed':
        t.attempts++
        t.claimedAt = at
        break
      case 'submitted':
        t.submittedAt = at
        break
      case 'needs_attention':
        inAttention.add(t)
        break
      case 'integrated':
        t.integrated = true
        break
      case 'conflict_requeued':
        totals.conflicts++
        break
      case 'verify_started':
        closeQueue(t, at)
        t.verified = true
        break
      case 'check_finished':
        t.verifyMs += Number.isFinite(e.details?.ms) ? e.details.ms : 0
        totals.checkRuns++
        // A check stopped by cancel or shutdown says nothing about the code.
        if (e.details?.ok === false && !e.details.aborted) totals.checkFailures++
        break
    }
  }

  const running = runningSince !== null
  if (running) advance(now)
  const openUntil = running ? now : endedAt
  let timedAll = tickets.size > 0
  let timedAny = false
  const report = {}
  for (const [id, t] of tickets) {
    closeWorker(t, openUntil)
    closeQueue(t, openUntil)
    report[id] = {
      attempts: t.attempts,
      workerMs: t.workerMs,
      queueMs: t.verified ? t.queueMs : null,
      verifyMs: t.verified ? t.verifyMs : null,
      attentionMs: t.attentionMs,
    }
    totals.attempts += t.attempts
    totals.workerMs += t.workerMs
    if (t.verified) {
      timedAny = true
      totals.queueMs += t.queueMs
      totals.verifyMs += t.verifyMs
    } else if (t.integrated) timedAll = false
  }
  if (!timedAny || !timedAll) totals.queueMs = totals.verifyMs = null

  return {
    startedAt: origin.createdAt,
    endedAt,
    accumulatedMs,
    runningSince,
    attentionMs,
    tickets: report,
    totals,
  }
}
