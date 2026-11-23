// Tracked escalations (the "Escalations" tab on the TCP page). Only created when the PM answers
// "Yes" to "Track this escalation?". One small JSON blob per escalation, replaced on every change
// (same pattern as the risk remarks), so two edits never share a file.
const { list, put, del } = require('@vercel/blob');

const PREFIX = 'saas-escalations/';
const TZ = process.env.TEAM_TIMEZONE || 'Asia/Kolkata';
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;
const ID_RE = /^e[a-z0-9]{6,24}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIMITS = { issue: 2000, summary: 4000, subject: 300, note: 600 };

function fail(status, message) { const e = new Error(message); e.status = status; return e; }
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const who = u => (u && (u.name || u.email)) || 'unknown';

async function readAll() {
  const { blobs } = await list({ prefix: PREFIX, limit: 1000 });
  const newest = {};
  for (const b of blobs) {
    const id = b.pathname.split('/')[1];
    if (!newest[id] || String(b.uploadedAt) > String(newest[id].uploadedAt)) newest[id] = b;
  }
  const rows = await Promise.all(Object.values(newest).map(async b => {
    try {
      const r = await fetch(`${b.url}?v=${encodeURIComponent(b.uploadedAt || '')}`, { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }));
  return rows.filter(r => r && r.id);
}

// Open first (the ones still needing a push), then newest activity first.
function sortForDisplay(rows) {
  return rows.slice().sort((a, b) =>
    (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) ||
    String(b.escalatedOn[0]).localeCompare(String(a.escalatedOn[0])) ||
    String(b.createdAt).localeCompare(String(a.createdAt)));
}
async function listEscalations() { return sortForDisplay(await readAll()); }

async function find(id) {
  if (!ID_RE.test(String(id || ''))) throw fail(400, 'Invalid escalation id.');
  const { blobs } = await list({ prefix: `${PREFIX}${id}/`, limit: 100 });
  if (!blobs.length) throw fail(404, 'That escalation no longer exists.');
  const newest = blobs.reduce((a, b) => (String(b.uploadedAt) > String(a.uploadedAt) ? b : a));
  const r = await fetch(`${newest.url}?v=${encodeURIComponent(newest.uploadedAt || '')}`, { cache: 'no-store' });
  if (!r.ok) throw fail(502, 'Could not read the escalation.');
  return { record: await r.json(), old: blobs };
}
async function write(record, old) {
  await put(`${PREFIX}${record.id}/escalation.json`, JSON.stringify(record), {
    access: 'public', addRandomSuffix: true, contentType: 'application/json', cacheControlMaxAge: 60,
  });
  if (old && old.length) await del(old.map(b => b.url)); // only versions that existed before this write
  return record;
}
const text = (v, max, what, required) => {
  const s = String(v == null ? '' : v).trim();
  if (required && !s) throw fail(400, `${what} is required.`);
  if (s.length > max) throw fail(400, `${what} is too long (max ${max} characters).`);
  return s;
};

async function createEscalation(input, user, today = todayStr()) {
  const i = input || {};
  const ticket = String(i.ticket || '').trim().toUpperCase();
  if (ticket && ticket !== 'N/A' && !KEY_RE.test(ticket)) throw fail(400, 'Ticket must look like SPI-123, or be N/A.');
  const record = {
    id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    ticket: ticket && ticket !== 'N/A' ? ticket : null,
    issue: text(i.issue, LIMITS.issue, 'The issue', true),
    summary: text(i.summary, LIMITS.summary, 'The summary', false),
    subject: text(i.subject, LIMITS.subject, 'The subject', false),
    status: 'open',
    escalatedOn: [today],            // newest first; the first one is the current date of escalation
    resolvedOn: null,
    followUps: [],                   // oldest first: { date, note, by }
    createdBy: who(user), createdAt: new Date().toISOString(),
  };
  return write(record, []);
}

async function bumpEscalation(id, note, user, today = todayStr()) {
  const { record, old } = await find(id);
  if (record.status !== 'open') throw fail(409, 'This escalation is resolved. Reopen it to follow up.');
  record.followUps.push({ date: today, note: text(note, LIMITS.note, 'The follow-up note', false), by: who(user) });
  if (record.escalatedOn[0] !== today) record.escalatedOn.unshift(today);
  return write(record, old);
}

async function resolveEscalation(id, date, today = todayStr()) {
  const { record, old } = await find(id);
  const d = String(date || today).trim();
  if (!DATE_RE.test(d)) throw fail(400, 'Use a date like 2026-12-05.');
  if (d > today) throw fail(400, 'The resolution date cannot be in the future.');
  const first = record.escalatedOn[record.escalatedOn.length - 1];
  if (d < first) throw fail(400, `The resolution date cannot be before the first escalation date (${first}).`);
  record.status = 'resolved'; record.resolvedOn = d;
  return write(record, old);
}

async function reopenEscalation(id) {
  const { record, old } = await find(id);
  record.status = 'open'; record.resolvedOn = null;
  return write(record, old);
}

async function deleteEscalation(id) {
  const { old } = await find(id);
  await del(old.map(b => b.url));
  return { deleted: id };
}

async function handleAction(body, user) {
  const b = body && typeof body === 'object' ? body : {};
  switch (b.action) {
    case 'create': return { escalation: await createEscalation(b, user) };
    case 'bump': return { escalation: await bumpEscalation(b.id, b.note, user) };
    case 'resolve': return { escalation: await resolveEscalation(b.id, b.date) };
    case 'reopen': return { escalation: await reopenEscalation(b.id) };
    case 'delete': return await deleteEscalation(b.id);
    default: throw fail(400, 'Unknown action.');
  }
}

module.exports = { listEscalations, createEscalation, bumpEscalation, resolveEscalation, reopenEscalation, deleteEscalation, handleAction, sortForDisplay, KEY_RE };
