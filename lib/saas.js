// SaaS Bugs & Stories: SPB (Prod Bugs) and SPI (product stories) for HDFC.
//
// These tickets live on a DIFFERENT Jira site from the EON programs
// (zeta-saas, not zeta-tm). Atlassian API tokens are account-wide, so the
// same JIRA_EMAIL / JIRA_API_TOKEN work here as long as that account can
// see the SaaS site.
//
// Bug counting reproduces the old fetch_jira.py / generate_html.py logic:
//   - one base JQL, two zones (Prod / UAT) differing only by the Zone clause
//   - only priority exactly P1 or P2 is counted; anything else is dropped
//     with a log line (a blank priority passes the JQL, then lands here)
//   - Prod P1, Prod P2, UAT P1, UAT P2 are stored once per day; re-running
//     the same day overwrites that day's entry

const { list, put, del } = require('@vercel/blob');

const SAAS_BASE = (process.env.SAAS_JIRA_BASE_URL || 'https://zeta-saas.atlassian.net').replace(/\/+$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const TZ = process.env.TEAM_TIMEZONE || 'Asia/Kolkata';

// "Primary Module" values excluded for SaaS Product = Tachyon Credit,
// copied verbatim from fetch_jira.py (identical for Prod and UAT).
// SAAS_EXCLUDED_MODULES (pipe-separated) replaces this list if set.
const DEFAULT_EXCLUDED_MODULES = [
  'Retail Revolving Credit Report Catalog',
  'Retail Revolving Credit Report Catalog - Account extracts',
  'Retail Revolving Credit Report Catalog - Authorization extracts',
  'Retail Revolving Credit Report Catalog - Card extracts',
  'Retail Revolving Credit Report Catalog - Customer extracts',
  'Retail Revolving Credit Report Catalog - Statement detail extracts',
  'Retail Revolving Credit Report Catalog - Statement summary extracts',
  'Retail Revolving Credit Report Catalog - Transaction extracts',
  'Revolving Credit Datamart',
  'Metis',
];
function excludedModules() {
  const raw = process.env.SAAS_EXCLUDED_MODULES;
  if (!raw || !raw.trim()) return DEFAULT_EXCLUDED_MODULES;
  return raw.split('|').map(s => s.trim()).filter(Boolean);
}

const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function bugBaseJql() {
  return [
    'project = "SaaS Defect"',
    'AND issuetype = "Prod Bug"',
    'AND Client = HDFC',
    'AND statusCategory != Done',
    'AND priority NOT IN (p3, p4, p5)',
    'AND (',
    '  "SaaS Product" IN ("Tachyon CLM", "Dispute SaaS", "Tachyon Kernel")',
    '  OR ("SaaS Product" = "Tachyon Credit"',
    `      AND "Primary Module" NOT IN (${excludedModules().map(q).join(', ')}))`,
    ')',
  ].join(' ');
}

const ZONES = {
  prod: 'Zone IN ("HDFC PROD")',
  uat: 'Zone IN ("HDFC UAT", EMPTY)',
};

function storiesJql() {
  return process.env.SAAS_SPI_JQL && process.env.SAAS_SPI_JQL.trim()
    ? process.env.SAAS_SPI_JQL.trim()
    : 'project = SPI AND Client = HDFC AND statusCategory != Done ORDER BY updated DESC';
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
}

async function saasFetch(path, opts = {}) {
  if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error('Missing JIRA_EMAIL or JIRA_API_TOKEN environment variable.');
  }
  const res = await fetch(SAAS_BASE + path, {
    ...opts,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`SaaS Jira ${res.status} for ${path}: ${body.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// The two delivery dates on the TCP view. The Jira field names are tried in
// order (case-insensitive), so either the field's own name or its ETA label works.
const DEV_FORECAST_NAMES = ['Dev Forecast Date', 'Dev completion ETA', 'Dev Completion ETA'];
const UAT_COMMIT_NAMES = ['Committed UAT Sign off Date', 'Committed UAT Sign-off Date', 'UAT Release ETA'];
function firstByName(byName, names) {
  const lower = {};
  for (const k of Object.keys(byName)) lower[k.toLowerCase()] = byName[k];
  for (const n of names) if (lower[n.toLowerCase()]) return lower[n.toLowerCase()];
  return null;
}

// Custom field IDs differ per site, so resolve them by name once per
// function instance instead of hard-coding IDs we can't verify.
let fieldIdCache = null;
async function fieldIds() {
  if (fieldIdCache) return fieldIdCache;
  const fields = await saasFetch('/rest/api/3/field');
  const byName = {};
  for (const f of fields) if (!byName[f.name]) byName[f.name] = f.id;
  fieldIdCache = {
    zone: byName['Zone'] || null,
    product: byName['SaaS Product'] || null,
    module: byName['Primary Module'] || null,
    client: byName['Client'] || null,
    devForecast: firstByName(byName, DEV_FORECAST_NAMES),
    uatCommit: firstByName(byName, UAT_COMMIT_NAMES),
  };
  return fieldIdCache;
}

async function searchAll(jql, fields, maxTotal = 500, expand = null) {
  let all = [];
  let nextPageToken;
  do {
    const page = await saasFetch('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, fields, maxResults: 100, ...(expand ? { expand } : {}), ...(nextPageToken ? { nextPageToken } : {}) }),
    });
    all = all.concat(page.issues || []);
    nextPageToken = page.nextPageToken;
    if (page.isLast) break;
  } while (nextPageToken && all.length < maxTotal);
  return all;
}

// Select, multi-select and cascading-select values all reduce to a label.
function optionText(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(optionText).filter(Boolean).join(', ') || null;
  if (typeof v === 'object') {
    const base = v.value || v.name || v.displayName || null;
    const child = v.child ? optionText(v.child) : null;
    return child ? `${base} › ${child}` : base;
  }
  return String(v);
}

const DAY = 86400000;
const daysSince = iso => (iso ? Math.floor((Date.now() - new Date(iso)) / DAY) : null);


// ---------- Date tracking (Dev forecast and committed UAT sign-off) ----------
// Each date shows its current value plus every earlier value, so the page can
// strike the old date through and show the new one on top in the same cell.
// Earlier values come from the Jira changelog for that one field.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const dayOnly = v => (v && ISO_DATE.test(String(v)) ? String(v).slice(0, 10) : (v ? String(v) : null));

// Whole days between two YYYY-MM-DD strings (positive = pushed later).
function dayDelta(from, to) {
  const a = dayOnly(from), b = dayOnly(to);
  if (!a || !b || !ISO_DATE.test(a) || !ISO_DATE.test(b)) return null;
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
}

// fieldId: the resolved Jira field ID (or null); names: accepted field names.
function trackDate(issue, fieldId, names) {
  const f = issue.fields || {};
  const current = fieldId ? dayOnly(f[fieldId]) : null;
  const log = issue.changelog;
  const lowerNames = names.map(n => n.toLowerCase());
  const changes = [];
  for (const h of ((log && log.histories) || [])) {
    for (const item of (h.items || [])) {
      const match = (fieldId && item.fieldId === fieldId) || lowerNames.includes(String(item.field || '').toLowerCase());
      if (!match) continue;
      const from = dayOnly(item.fromString || item.from || null);
      const to = dayOnly(item.toString || item.to || null);
      changes.push({ from, to, deltaDays: dayDelta(from, to), at: h.created || null, by: h.author ? (h.author.displayName || null) : null });
    }
  }
  changes.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  // Earlier dates, newest first, de-duplicated and never the current value.
  const previous = [];
  for (let k = changes.length - 1; k >= 0; k--) {
    const v = changes[k].from;
    if (v && v !== current && !previous.includes(v)) previous.push(v);
  }
  const moved = changes.filter(c => c.from && c.to);
  return {
    current,
    previous,
    changes,
    slips: moved.filter(c => c.deltaDays > 0).length,
    pushedDays: moved.reduce((n, c) => n + (c.deltaDays > 0 ? c.deltaDays : 0), 0),
    // Jira returns at most the latest 100 changelog entries on a search expand.
    partial: !!(log && typeof log.total === 'number' && log.maxResults && log.total > log.maxResults),
  };
}

// ---------- Risk remarks ----------
// One small blob per ticket version under saas-remarks/<KEY>/. The URL gets a
// random suffix so it cannot be guessed; only the server lists the prefix.
// Saving replaces older versions, and an empty remark clears the ticket.
const REMARK_PREFIX = 'saas-remarks/';
const REMARK_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const REMARK_MAX = 600;

async function readRemarks() {
  try {
    const { blobs } = await list({ prefix: REMARK_PREFIX, limit: 1000 });
    const newest = {};
    for (const b of blobs) {
      const key = b.pathname.split('/')[1];
      if (!newest[key] || String(b.uploadedAt) > String(newest[key].uploadedAt)) newest[key] = b;
    }
    const rows = await Promise.all(Object.values(newest).map(async b => {
      try {
        const r = await fetch(`${b.url}?v=${encodeURIComponent(b.uploadedAt || '')}`, { cache: 'no-store' });
        return r.ok ? await r.json() : null;
      } catch (e) { return null; }
    }));
    const map = {};
    for (const r of rows) if (r && r.key && r.text) map[r.key] = r;
    return map;
  } catch (e) {
    console.warn('[saas] could not read remarks:', e.message);
    return {};
  }
}

async function saveRemark(key, text, user) {
  key = String(key || '').trim().toUpperCase();
  if (!REMARK_KEY.test(key)) { const e = new Error('Invalid ticket key.'); e.status = 400; throw e; }
  text = String(text == null ? '' : text).trim();
  if (text.length > REMARK_MAX) { const e = new Error(`Remark is limited to ${REMARK_MAX} characters.`); e.status = 400; throw e; }

  const { blobs: old } = await list({ prefix: `${REMARK_PREFIX}${key}/`, limit: 100 });
  let record = null;
  if (text) {
    record = { key, text, by: (user && (user.name || user.email)) || 'unknown', at: new Date().toISOString() };
    await put(`${REMARK_PREFIX}${key}/remark.json`, JSON.stringify(record), {
      access: 'public',
      addRandomSuffix: true,
      contentType: 'application/json',
      cacheControlMaxAge: 60,
    });
  }
  // Delete only versions that existed before this write.
  if (old.length) await del(old.map(b => b.url));
  return record;
}

function flatten(issue, ids, remarks) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    summary: f.summary || '',
    status: f.status ? f.status.name : null,
    priority: f.priority ? f.priority.name : null,
    assignee: f.assignee ? f.assignee.displayName : 'Unassigned',
    type: f.issuetype ? f.issuetype.name : null,
    created: f.created || null,
    updated: f.updated || null,
    ageDays: daysSince(f.created),
    idleDays: daysSince(f.updated),
    zone: ids.zone ? optionText(f[ids.zone]) : null,
    product: ids.product ? optionText(f[ids.product]) : null,
    module: ids.module ? optionText(f[ids.module]) : null,
    devForecast: trackDate(issue, ids.devForecast, DEV_FORECAST_NAMES),
    uatCommit: trackDate(issue, ids.uatCommit, UAT_COMMIT_NAMES),
    remark: (remarks && remarks[issue.key]) || null,
    url: `${SAAS_BASE}/browse/${issue.key}`,
  };
}

function bucket(bugs, zoneName) {
  const p1 = bugs.filter(b => b.priority === 'P1');
  const p2 = bugs.filter(b => b.priority === 'P2');
  const dropped = bugs.length - p1.length - p2.length;
  if (dropped > 0) {
    console.log(`[saas] ${zoneName}: excluded ${dropped} bug(s) whose priority is not exactly P1 or P2`);
  }
  return { p1: p1.length, p2: p2.length, all: p1.length + p2.length, excluded: dropped, bugs: [...p1, ...p2] };
}

function todayIn(tz) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// One small blob per day, so a same-day rerun overwrites only that day and
// two viewers loading at once can never clobber each other's history.
const HISTORY_PREFIX = 'saas-bug-history/';

async function recordHistory(entry) {
  try {
    await put(`${HISTORY_PREFIX}${entry.date}.json`, JSON.stringify(entry), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 60,
    });
    return true;
  } catch (e) {
    console.warn('[saas] could not write bug history:', e.message);
    return false;
  }
}

async function readHistory(limitDays = 60) {
  try {
    const { blobs } = await list({ prefix: HISTORY_PREFIX, limit: 1000 });
    const recent = blobs
      .sort((a, b) => a.pathname.localeCompare(b.pathname))
      .slice(-limitDays);
    const rows = await Promise.all(recent.map(async b => {
      try {
        const r = await fetch(`${b.url}?v=${encodeURIComponent(b.uploadedAt || '')}`, { cache: 'no-store' });
        return r.ok ? await r.json() : null;
      } catch (e) { return null; }
    }));
    return rows.filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    console.warn('[saas] could not read bug history:', e.message);
    return [];
  }
}

async function getSaasData() {
  const ids = await fieldIds();
  const fields = ['summary', 'status', 'priority', 'assignee', 'issuetype', 'created', 'updated',
    ...[ids.zone, ids.product, ids.module, ids.devForecast, ids.uatCommit].filter(Boolean)];

  const base = bugBaseJql();
  const [prodRaw, uatRaw, storyRaw, remarks] = await Promise.all([
    searchAll(`${base} AND ${ZONES.prod} ORDER BY priority ASC, created ASC`, fields, 500, 'changelog'),
    searchAll(`${base} AND ${ZONES.uat} ORDER BY priority ASC, created ASC`, fields, 500, 'changelog'),
    searchAll(storiesJql(), fields, 500, 'changelog'),
    readRemarks(),
  ]);

  const prod = bucket(prodRaw.map(i => flatten(i, ids, remarks)), 'Prod');
  const uat = bucket(uatRaw.map(i => flatten(i, ids, remarks)), 'UAT');
  const stories = storyRaw.map(i => flatten(i, ids, remarks));

  const today = {
    date: todayIn(TZ),
    prodP1: prod.p1, prodP2: prod.p2, uatP1: uat.p1, uatP2: uat.p2,
    recordedAt: new Date().toISOString(),
  };
  const saved = await recordHistory(today);
  let history = await readHistory();
  // Blob reads can lag a fresh write by a few seconds; make sure today shows.
  history = history.filter(h => h.date !== today.date).concat(today).sort((a, b) => a.date.localeCompare(b.date));

  return {
    meta: {
      dataPulledAt: new Date().toISOString(),
      site: SAAS_BASE,
      timezone: TZ,
      historySaved: saved,
      excludedModules: excludedModules(),
      fieldsResolved: ids,
      jql: { bugBase: base, prodZone: ZONES.prod, uatZone: ZONES.uat, stories: storiesJql() },
    },
    bugs: { prod, uat },
    stories,
    history,
  };
}

module.exports = { getSaasData, bugBaseJql, ZONES, bucket, optionText, todayIn, trackDate, DEV_FORECAST_NAMES, UAT_COMMIT_NAMES, saveRemark, REMARK_MAX };
