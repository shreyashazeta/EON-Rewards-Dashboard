const { jiraFetch, searchAll, deriveTicketFields, getBlockedSince } = require('../lib/jira');
const { getSession } = require('../lib/session');
const { getProgram } = require('../lib/programs');
const { sprintWorkingDayProgress } = require('../lib/workdays');

const FIELDS = [
  'summary', 'issuetype', 'status', 'assignee', 'customfield_10023',
  'customfield_10021', 'labels', 'priority', 'parent',
  'customfield_11037', 'customfield_11749', 'customfield_10447', 'customfield_11750',
  'created', 'resolution',
];

function setCors(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Not signed in.', loginUrl: '/api/auth/login?returnTo=/sprint-health.html' });
  }

  try {
    const programId = (req.query && req.query.program) || 'eon';
    const program = await getProgram(programId);
    if (!program) {
      return res.status(404).json({ error: `Unknown program "${programId}".` });
    }
    // 1. Find the board's current sprint: prefer active, fall back to most recently closed.
    const boardSprints = await jiraFetch(`/rest/agile/1.0/board/${program.boardId}/sprint?state=active,closed&maxResults=50`);
    const sprints = (boardSprints.values || []).sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));
    const active = sprints.find(s => s.state === 'active');
    const current = active || sprints.find(s => s.state === 'closed');

    if (!current) {
      return res.status(200).json({ error: 'No active or closed sprint found on this board.' });
    }

    // 2. Find the immediately previous sprint (for "carried in" framing).
    const prevSprint = sprints.find(s => s.id !== current.id && new Date(s.startDate || 0) < new Date(current.startDate || 0));

    // 3. Pull all non-epic issues in that sprint.
    const jql = `project = ${program.projectKey} AND sprint = ${current.id} AND issuetype != Epic ORDER BY status ASC`;
    const issues = await searchAll(jql, FIELDS);
    const tickets = issues.map(deriveTicketFields);

    // 4. For any currently-blocked ticket, fetch real "blocked since" aging from its changelog.
    const blockedKeys = tickets.filter(t => t.status === 'Blocked').map(t => t.k);
    for (const key of blockedKeys) {
      try {
        const since = await getBlockedSince(key);
        const t = tickets.find(x => x.k === key);
        if (t && since) t.blocked_since = since;
      } catch (e) {
        // Non-fatal — leave blocked_since unset for this ticket if changelog fetch fails.
      }
    }

    const now = new Date();
    const start = new Date(current.startDate);
    const end = new Date(current.endDate);
    // "Days left" and "% elapsed" count working days (Mon–Fri), not raw
    // calendar days. No public-holiday calendar is applied — only weekends,
    // in TEAM_TIMEZONE (default Asia/Kolkata). See lib/workdays.js.
    const { daysLeft, pctElapsed } = current.state === 'active'
      ? sprintWorkingDayProgress(start, end, now)
      : { daysLeft: 0, pctElapsed: 100 };

    res.status(200).json({
      meta: {
        programName: program.name,
        streams: program.streams,
        currentSprintName: current.name,
        currentSprintState: current.state, // active | closed
        currentSprintRange: `${start.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${end.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`,
        // Real start date for THIS sprint, on THIS program — previously
        // missing from this response entirely, so the frontend's "Scope
        // change" metric silently fell back to a hardcoded fixture date
        // baked into the page (2026-08-04), miscounting nearly every real
        // ticket as "added mid-sprint" on every program, not just this one.
        currentSprintStart: current.startDate,
        closedToday: current.completeDate ? (new Date(current.completeDate).toDateString() === now.toDateString()) : false,
        prevSprintName: prevSprint ? prevSprint.name : null,
        daysLeft,
        pctElapsed,
        dataPulledAt: now.toISOString(),
      },
      tickets,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
