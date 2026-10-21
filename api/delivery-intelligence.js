const { jiraFetch, searchAll } = require('../lib/jira');
const { getSession } = require('../lib/session');
const { getProgram } = require('../lib/programs');
const { buildStatusSegments, computeMetrics, buildAssigneeTimeline, UNTRACKED_STAGES } = require('../lib/lifecycle');

const TICKET_FIELDS = ['summary', 'issuetype', 'status', 'assignee', 'created', 'labels', 'parent', 'customfield_10021', 'priority'];
const EPIC_FIELDS = ['summary', 'status', 'created'];

function setCors(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchChangelog(issueKey) {
  const data = await jiraFetch(`/rest/api/3/issue/${issueKey}/changelog?maxResults=200`);
  return data.values || [];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// A single changelog fetch, retried on transient failures. Previously used a
// fixed 200ms/400ms backoff regardless of cause — but Jira's 429 responses
// specify the real required cooldown via Retry-After, which is often longer
// than that guess. A backoff shorter than the real cooldown means every retry
// lands inside the same rate-limit window and fails again — deterministically,
// not just occasionally, which is exactly the "every time" failure this fixes.
async function fetchChangelogWithRetry(issueKey, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchChangelog(issueKey);
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const backoff = e.retryAfterMs ? Math.min(e.retryAfterMs, 6000) : 400 * attempt;
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

// Fetch changelogs concurrently in small bounded batches with a short pause
// between batches — keeps this within Jira's rate limits. Batch size reduced
// from 6 to 4: fewer concurrent requests per burst means less chance of
// tripping the rate limit in the first place, not just recovering faster
// once it's tripped.
// deadlineAt: if given, stop starting new batches once we're past this time —
// better to return partial real data than risk Vercel killing the whole
// function mid-flight, which would fail every ticket instead of just some.
async function fetchAllChangelogs(keys, batchSize = 4, deadlineAt = null) {
  const results = {};
  for (let i = 0; i < keys.length; i += batchSize) {
    if (deadlineAt && Date.now() > deadlineAt) {
      keys.slice(i).forEach(k => { results[k] = null; }); // mark the rest as not-fetched, not an error
      break;
    }
    const batch = keys.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async k => {
      try { return [k, await fetchChangelogWithRetry(k)]; }
      catch (e) { return [k, null]; }
    }));
    batchResults.forEach(([k, v]) => { results[k] = v; });
    if (i + batchSize < keys.length) await sleep(120); // brief pause between batches
  }
  return results;
}

function getSprintInfo(f) {
  const arr = f.customfield_10021 || [];
  return {
    sprint: arr.length ? arr[arr.length - 1].name : null,
    sprints: arr.map(s => s.name),
  };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  const startedAt = Date.now();
  try {
    const programId = (req.query && req.query.program) || 'eon';
    const program = await getProgram(programId);
    if (!program) {
      return res.status(404).json({ error: `Unknown program "${programId}".` });
    }
    const STREAMS = program.streams.map(s => s.label);

    const now = new Date().toISOString();
    const streams = {};

    for (const label of STREAMS) {
      // --- Non-epic tickets: the main lifecycle/flow-efficiency analysis ---
      const issues = await searchAll(`project = "${program.projectKey}" AND labels = "${label}" AND issuetype != Epic`, TICKET_FIELDS, 300);
      const keys = issues.map(i => i.key);
      const changelogs = await fetchAllChangelogs(keys, 4, startedAt + 24000);

      const tickets = issues.map(iss => {
        const f = iss.fields;
        const a = f.assignee;
        const histories = changelogs[iss.key];
        const { sprint, sprints } = getSprintInfo(f);
        if (!histories) {
          return { k: iss.key, sum: f.summary, t: f.issuetype ? f.issuetype.name : null, currentStatus: f.status ? f.status.name : null, currentCategory: f.status && f.status.statusCategory ? f.status.statusCategory.name : null, priority: f.priority ? f.priority.name : null, error: 'changelog fetch failed', sprint, sprints };
        }
        const segments = buildStatusSegments(histories, f.created, f.status ? f.status.name : null, now);
        const metrics = computeMetrics(segments);
        const assigneeTimeline = buildAssigneeTimeline(histories, f.created, a ? a.displayName : 'Unassigned', now);

        return {
          k: iss.key,
          sum: f.summary,
          t: f.issuetype ? f.issuetype.name : null,
          currentStatus: f.status ? f.status.name : null,
          currentCategory: f.status && f.status.statusCategory ? f.status.statusCategory.name : null,
          priority: f.priority ? f.priority.name : null,
          a: a ? a.displayName : 'Unassigned',
          created: f.created,
          parent_key: f.parent ? f.parent.key : null,
          sprint, sprints,
          segments: segments.map(s => ({ status: s.status, stage: s.stage, category: s.category, enteredAt: s.enteredAt, exitedAt: s.exitedAt, durationMs: s.durationMs })),
          metrics,
          assigneeTimeline: assigneeTimeline.map(t => ({ assignee: t.assignee, from: t.from, to: t.to, durationMs: t.durationMs })),
        };
      });

      // --- Epics: quarterly-commitment view, shown separately at page bottom ---
      // Epics often have sparser changelogs than stories (sometimes just one
      // status change ever), but we now compute the same segments/metrics for
      // them as stories — a short flow bar is still real signal (e.g. "sat in
      // Backlog 40 days, then moved to Dev In Progress 3 days ago").
      const epicIssues = await searchAll(`project = "${program.projectKey}" AND labels = "${label}" AND issuetype = Epic`, EPIC_FIELDS, 200);
      const epicKeys = epicIssues.map(i => i.key);
      const epicChangelogs = await fetchAllChangelogs(epicKeys, 4, startedAt + 27000);

      const byParent = {};
      tickets.forEach(t => { if (t.parent_key) (byParent[t.parent_key] = byParent[t.parent_key] || []).push(t); });

      const epics = epicIssues.map(iss => {
        const f = iss.fields;
        const histories = epicChangelogs[iss.key];
        const kids = byParent[iss.key] || [];
        const done = kids.filter(k => k.currentCategory === 'Done');
        const lastStatus = f.status ? f.status.name : null;

        let idleSinceMs = null, segments = [], metrics = null;
        if (histories) {
          segments = buildStatusSegments(histories, f.created, lastStatus, now);
          metrics = computeMetrics(segments);
          idleSinceMs = segments[segments.length - 1].durationMs;
        }

        return {
          key: iss.key,
          sum: f.summary,
          status: lastStatus,
          createdAt: f.created,
          idleMs: idleSinceMs,
          ageMs: new Date(now) - new Date(f.created),
          tickets: kids.length,
          done: done.length,
          blocked: kids.filter(k => k.currentStatus === 'Blocked').length,
          segments: segments.map(s => ({ status: s.status, stage: s.stage, category: s.category, enteredAt: s.enteredAt, exitedAt: s.exitedAt, durationMs: s.durationMs })),
          metrics,
        };
      });

      streams[label] = { tickets, epics };
    }

    res.status(200).json({
      meta: {
        programName: program.name,
        dataPulledAt: now,
        computeMs: Date.now() - startedAt,
        untrackedStages: UNTRACKED_STAGES,
      },
      streams,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, partialComputeMs: Date.now() - startedAt });
  }
};
