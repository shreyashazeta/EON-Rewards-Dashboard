// Maps this Jira instance's real statuses (confirmed live on Aug 6, 2026) to
// canonical delivery-lifecycle stages. Anything not in this map falls back to
// category "other" and is still shown, just not specially classified.
//
// category meanings:
//   active   - real engineering/QA work is happening
//   waiting  - the ticket is sitting in a queue for someone/something
//   blocked  - explicitly blocked (tracked separately from ordinary waiting)
//   terminal - a closed/done state, not counted in active/waiting totals
//   exception- closed-but-not-delivered (rejected, invalid) — excluded from
//              flow-efficiency averages since they didn't complete the flow
const STATUS_MAP = {
  'New':                          { stage: 'Backlog',          category: 'waiting' },
  'To Do':                        { stage: 'Backlog',          category: 'waiting' },
  'Groomed':                      { stage: 'Groomed',          category: 'waiting' },
  'Dev In Progress':              { stage: 'Development',      category: 'active' },
  'In Peer Review':                { stage: 'PR Review',        category: 'waiting' },
  'Dev to QA Handover Pending':   { stage: 'QA Handover',       category: 'waiting' },
  'QA In progress':               { stage: 'QA',                category: 'active' },
  'Product Demo Pending (UAT)':   { stage: 'Product Demo',      category: 'waiting' },
  'Bank Demo Pending (UAT)':      { stage: 'Bank/UAT',          category: 'waiting' },
  'Blocked':                      { stage: 'Blocked',           category: 'blocked' },
  'Done/Closed':                  { stage: 'Done',              category: 'terminal' },
  'Done':                         { stage: 'Done',              category: 'terminal' },
  'Closed':                       { stage: 'Done',              category: 'terminal' },
  'Rejected':                     { stage: 'Rejected',          category: 'exception' },
  'Invalid Defect':               { stage: 'Invalid',           category: 'exception' },
};

// Fallback for statuses not listed in STATUS_MAP (another program's workflow
// may name its statuses differently). A keyword guess keeps those tickets in
// a sensible lifecycle bucket instead of an unclassified "other" bucket.
function heuristicClassify(statusName) {
  const s = String(statusName || '').toLowerCase();
  if (/done|closed|resolved|complete/.test(s)) return { stage: statusName, category: 'terminal' };
  if (/block/.test(s)) return { stage: statusName, category: 'blocked' };
  if (/reject|invalid|won.?t do|cancel|duplicate|abandon/.test(s)) return { stage: statusName, category: 'exception' };
  if (/progress|review|qa|test|dev|demo|uat|build|implement/.test(s)) return { stage: statusName, category: 'active' };
  return { stage: statusName, category: 'waiting' };
}

function classify(statusName) {
  return STATUS_MAP[statusName] || heuristicClassify(statusName);
}

// Lifecycle stages this org's vision names that Jira has NO status for at all.
// Shown in the UI as an honest "not trackable yet" list — never fabricated.
const UNTRACKED_STAGES = [
  { stage: 'PR Raised', note: 'No distinct status — folded into "In Peer Review"' },
  { stage: 'PR Approved', note: 'No distinct status — folded into "In Peer Review"' },
  { stage: 'Merge', note: 'No distinct status — folded into "In Peer Review"' },
  { stage: 'CMR Raised', note: 'No Jira status exists for this at all' },
  { stage: 'CMR Approved', note: 'No Jira status exists for this at all' },
  { stage: 'Deployment', note: 'No distinct status — not tracked as an event' },
  { stage: 'Development Complete', note: 'No status between "Dev In Progress" and "In Peer Review"' },
];

// Turns raw changelog histories (Jira's /changelog endpoint shape) into an
// ordered list of status "segments" — each with how long the ticket actually
// sat in that status.
function buildStatusSegments(histories, createdAt, currentStatus, now) {
  const statusEvents = [];
  for (const h of histories || []) {
    for (const item of h.items || []) {
      if (item.field === 'status') {
        statusEvents.push({ at: h.created, from: item.fromString, to: item.toString });
      }
    }
  }
  statusEvents.sort((a, b) => new Date(a.at) - new Date(b.at));

  const segments = [];
  let cursorStatus = statusEvents.length ? statusEvents[0].from : currentStatus;
  let cursorStart = createdAt;

  for (const ev of statusEvents) {
    segments.push({
      status: cursorStatus,
      enteredAt: cursorStart,
      exitedAt: ev.at,
      durationMs: new Date(ev.at) - new Date(cursorStart),
    });
    cursorStatus = ev.to;
    cursorStart = ev.at;
  }
  // Final open segment, running up to "now" (or resolution time if terminal).
  segments.push({
    status: cursorStatus,
    enteredAt: cursorStart,
    exitedAt: now,
    durationMs: new Date(now) - new Date(cursorStart),
  });

  return segments.map(s => ({ ...s, ...classify(s.status) }));
}

// Computes the headline metrics from a ticket's status segments.
function computeMetrics(segments) {
  let activeMs = 0, waitingMs = 0, blockedMs = 0;
  const stageTime = {};
  const statusVisits = {};

  segments.forEach(s => {
    statusVisits[s.status] = (statusVisits[s.status] || 0) + 1;
    stageTime[s.stage] = (stageTime[s.stage] || 0) + s.durationMs;
    if (s.category === 'active') activeMs += s.durationMs;
    else if (s.category === 'waiting') waitingMs += s.durationMs;
    else if (s.category === 'blocked') blockedMs += s.durationMs;
  });

  const leadTimeMs = activeMs + waitingMs + blockedMs;
  const flowEfficiencyPct = leadTimeMs > 0 ? Math.round((activeMs / leadTimeMs) * 100) : null;

  // Rework: any transition that goes "backward" in the canonical stage order,
  // e.g. QA -> Development. Approximated by re-entering a category='active'
  // stage after having already left it once.
  const seenActive = new Set();
  let reworkCount = 0;
  segments.forEach(s => {
    if (s.category === 'active') {
      if (seenActive.has(s.stage) === false) seenActive.add(s.stage);
    }
  });
  // Count re-entries into any stage visited more than once (oscillation proxy).
  const oscillationCount = Object.values(statusVisits).reduce((sum, n) => sum + Math.max(0, n - 1), 0);
  // Rework proxy: number of times status moved back to Dev In Progress after
  // having been in QA/PR Review/Blocked at least once before.
  let sawForward = false;
  segments.forEach((s, i) => {
    if (['PR Review', 'QA', 'QA Handover'].includes(s.stage)) sawForward = true;
    if (sawForward && s.stage === 'Development' && i > 0) reworkCount++;
  });

  return {
    leadTimeMs, activeMs, waitingMs, blockedMs, flowEfficiencyPct,
    stageTime, statusVisits, reworkCount, oscillationCount,
  };
}

// Assignee ownership timeline from changelog "assignee" field events.
function buildAssigneeTimeline(histories, createdAt, createdAssigneeName, now) {
  const events = [];
  for (const h of histories || []) {
    for (const item of h.items || []) {
      if (item.field === 'assignee') {
        events.push({ at: h.created, from: item.fromString, to: item.toString });
      }
    }
  }
  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  const timeline = [];
  let cursor = events.length ? (events[0].from || 'Unassigned') : (createdAssigneeName || 'Unassigned');
  let cursorStart = createdAt;
  for (const ev of events) {
    timeline.push({ assignee: cursor, from: cursorStart, to: ev.at, durationMs: new Date(ev.at) - new Date(cursorStart) });
    cursor = ev.to || 'Unassigned';
    cursorStart = ev.at;
  }
  timeline.push({ assignee: cursor, from: cursorStart, to: now, durationMs: new Date(now) - new Date(cursorStart) });
  return timeline;
}

module.exports = { STATUS_MAP, UNTRACKED_STAGES, classify, buildStatusSegments, computeMetrics, buildAssigneeTimeline };
