// Shared helpers for talking to Jira Cloud REST API and deriving the
// same fields the dashboards already expect.

const JIRA_BASE_URL = process.env.JIRA_BASE_URL; // e.g. https://zeta-tm.atlassian.net
const JIRA_EMAIL = process.env.JIRA_EMAIL;       // the account that owns the API token
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// Custom field IDs — confirmed earlier in this project against your Jira instance.
// If your instance ever changes these (rare), update here only.
const FIELDS = {
  AC: 'customfield_11798',        // User Acceptance Criteria
  DEV_ETA: 'customfield_11037',   // Dev ETA
  DEV_ETA_ALT: 'customfield_11749', // Dev-ETA (secondary/legacy field seen on some tickets)
  QA_ETA: 'customfield_10447',    // QA Expected Complete Date (used on stories)
  QA_ETA_ALT: 'customfield_11750', // "QA-ETA" — confirmed present on Epics
  STORY_POINTS: 'customfield_10023',
  SPRINT: 'customfield_10021',
};

function authHeader() {
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

async function jiraFetch(path, opts = {}) {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error('Missing JIRA_BASE_URL, JIRA_EMAIL, or JIRA_API_TOKEN environment variable.');
  }
  const res = await fetch(`${JIRA_BASE_URL}${path}`, {
    ...opts,
    headers: {
      'Authorization': authHeader(),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Jira API ${res.status} ${res.statusText} for ${path}: ${body.slice(0, 300)}`);
    err.status = res.status;
    // Jira sends this on 429s specifying the real cooldown in seconds — a fixed
    // guessed backoff is nearly useless against this if the real wait is longer.
    const retryAfterHeader = res.headers.get('Retry-After');
    if (retryAfterHeader) err.retryAfterMs = parseInt(retryAfterHeader, 10) * 1000;
    throw err;
  }
  return res.json();
}

// Paginated JQL search. Fetches all pages up to a safety cap.
async function searchAll(jql, fields, maxTotal = 300) {
  let all = [];
  let nextPageToken = undefined;
  do {
    const body = {
      jql,
      fields,
      maxResults: 100,
      ...(nextPageToken ? { nextPageToken } : {}),
    };
    const page = await jiraFetch('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    all = all.concat(page.issues || []);
    nextPageToken = page.nextPageToken;
    if (page.isLast) break;
  } while (nextPageToken && all.length < maxTotal);
  return all;
}

function empty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// Turns a raw Jira issue into the flat shape both dashboards expect.
function deriveTicketFields(issue) {
  const f = issue.fields;
  const a = f.assignee;
  const parent = f.parent;
  const sprintArr = f[FIELDS.SPRINT] || [];
  const devEta = f[FIELDS.DEV_ETA] || f[FIELDS.DEV_ETA_ALT];
  const qaEta = f[FIELDS.QA_ETA] || f[FIELDS.QA_ETA_ALT];
  const created = f.created;
  const now = new Date();
  const ageDays = created ? Math.floor((now - new Date(created)) / 86400000) : null;

  return {
    k: issue.key,
    sum: f.summary,
    t: f.issuetype ? f.issuetype.name : null,
    status: f.status ? f.status.name : null,
    cat: f.status && f.status.statusCategory ? f.status.statusCategory.name : null,
    a: a ? a.displayName : 'Unassigned',
    open: f.status && f.status.statusCategory ? f.status.statusCategory.name !== 'Done' : true,
    ac: empty(f[FIELDS.AC]),
    eta: empty(devEta),
    qa: empty(qaEta),
    sp: typeof f[FIELDS.STORY_POINTS] === 'number' ? f[FIELDS.STORY_POINTS] : 0,
    sp_missing: empty(f[FIELDS.STORY_POINTS]),
    un: !a,
    due: empty(f.duedate),
    fix: empty(f.fixVersions),
    comp: empty(f.components),
    age: ageDays,
    new: ageDays !== null && ageDays <= 7,
    sprint: sprintArr.length ? sprintArr[sprintArr.length - 1].name : null,
    sprints: sprintArr.map(s => s.name),
    priority: f.priority ? f.priority.name : null,
    parent_key: parent ? parent.key : null,
    parent_sum: parent && parent.fields ? parent.fields.summary : null,
    dev_eta: devEta || null,
    qa_eta: qaEta || null,
    created,
    labels: f.labels || [],
    res: f.resolution ? f.resolution.name : null,
  };
}

// For a blocked ticket, walk its changelog to find the most recent
// transition INTO the "Blocked" status, so we can show real aging.
async function getBlockedSince(issueKey) {
  const data = await jiraFetch(`/rest/api/3/issue/${issueKey}/changelog?maxResults=100`);
  const histories = (data.values || []).slice().reverse(); // oldest first isn't guaranteed; sort by created just in case
  histories.sort((a, b) => new Date(a.created) - new Date(b.created));
  let mostRecent = null;
  for (const h of histories) {
    for (const item of h.items || []) {
      if (item.field === 'status' && item.toString === 'Blocked') {
        mostRecent = h.created;
      }
    }
  }
  return mostRecent;
}

module.exports = { jiraFetch, searchAll, deriveTicketFields, getBlockedSince, FIELDS, empty };
