// The program registry. This is the actual "no deployment to add a program"
// mechanism: every program's Jira config (project key, board, tracking
// streams) lives here — either the built-in EON default (from environment
// variables, unchanged from before) or a JSON record written to Vercel Blob
// at runtime by the "Add Program" form. Adding a program means writing a
// Blob object, not touching a file, not committing, not deploying.
//
// A program's `streams` array is intentionally unbounded — EON currently
// has two (LE / Add-On), Rewards PLE will have one, and any future program
// can have as many as it actually needs. Every dashboard and API in this
// project reads this array and renders however many streams it finds —
// nothing here assumes a fixed count.

const { list, put, del } = require('@vercel/blob');

const EON_BUILTIN = {
  id: 'eon',
  name: 'EON',
  quarter: 'Q3 FY2026',
  projectKey: process.env.JIRA_PROJECT_KEY || 'EON',
  boardId: process.env.JIRA_BOARD_ID || '5839',
  streams: (process.env.JIRA_HYGIENE_LABELS || 'LE_Bank_Requirement,Add_On_Bank_requirement')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(label => ({ label, name: label.replace(/_/g, ' ') })),
  builtIn: true,
  addedBy: null,
  addedAt: null,
};

let cache = null;
let cacheAt = 0;
const CACHE_MS = 15000; // short cache — a newly-added program should show up fast, not require a redeploy or a long wait

async function listPrograms() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const programs = [EON_BUILTIN];
  try {
    const { blobs } = await list({ prefix: 'programs/' });
    const fetched = await Promise.all(blobs.map(async b => {
      try {
        const res = await fetch(b.url);
        if (!res.ok) return null;
        return await res.json();
      } catch (e) { return null; }
    }));
    fetched.filter(Boolean).forEach(p => programs.push(p));
  } catch (e) {
    // Blob not configured, or genuinely empty — EON alone still works, so
    // this is a soft failure, not a thrown error that breaks every dashboard.
  }
  cache = programs;
  cacheAt = Date.now();
  return programs;
}

async function getProgram(id) {
  const all = await listPrograms();
  return all.find(p => p.id === id) || null;
}

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function addProgram({ name, quarter, projectKey, boardId, streams, addedBy }) {
  if (!name || !String(name).trim()) throw new Error('Program name is required.');
  if (!projectKey || !String(projectKey).trim()) throw new Error('Jira project key is required.');
  if (!boardId || !String(boardId).trim()) throw new Error('Jira board ID is required.');
  if (!Array.isArray(streams) || streams.length === 0) throw new Error('At least one tracking stream (label) is required.');
  const cleanStreams = streams
    .map(s => ({ label: String(s.label || '').trim(), name: String(s.name || s.label || '').trim() }))
    .filter(s => s.label);
  if (cleanStreams.length === 0) throw new Error('At least one tracking stream (label) is required.');

  const id = slugify(name);
  if (!id) throw new Error('Could not generate a valid ID from that program name.');
  const existing = await getProgram(id);
  if (existing) throw new Error(`A program with the ID "${id}" already exists.`);

  const record = {
    id,
    name: String(name).trim(),
    quarter: quarter ? String(quarter).trim() : '',
    projectKey: String(projectKey).trim(),
    boardId: String(boardId).trim(),
    streams: cleanStreams,
    builtIn: false,
    addedBy: addedBy || null,
    addedAt: new Date().toISOString(),
  };

  await put(`programs/${id}.json`, JSON.stringify(record), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    allowOverwrite: false,
  });

  cache = null; // force the next listPrograms() to pick up the new one immediately
  return record;
}

// Corrects an existing non-built-in program's config (project key, board ID,
// quarter, or stream labels/names) without ever touching Blob storage by
// hand or redeploying — the same "no manual config edits" principle the
// whole registry was built on. Partial updates only: any field left out of
// `updates` keeps its current value.
async function updateProgram(id, updates) {
  if (!id) throw new Error('Program id is required.');
  if (id === EON_BUILTIN.id) throw new Error('EON is a built-in program and cannot be edited here.');
  const existing = await getProgram(id);
  if (!existing) throw new Error(`No program with id "${id}" exists.`);

  const record = { ...existing };
  if (updates.name !== undefined) record.name = String(updates.name).trim() || record.name;
  if (updates.quarter !== undefined) record.quarter = String(updates.quarter).trim();
  if (updates.projectKey !== undefined && String(updates.projectKey).trim()) record.projectKey = String(updates.projectKey).trim();
  if (updates.boardId !== undefined && String(updates.boardId).trim()) record.boardId = String(updates.boardId).trim();
  if (updates.streams !== undefined) {
    const cleanStreams = (updates.streams || [])
      .map(s => ({ label: String(s.label || '').trim(), name: String(s.name || s.label || '').trim() }))
      .filter(s => s.label);
    if (cleanStreams.length === 0) throw new Error('At least one tracking stream (label) is required.');
    record.streams = cleanStreams;
  }

  await put(`programs/${id}.json`, JSON.stringify(record), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    allowOverwrite: true,
  });

  cache = null; // force the next listPrograms() to pick up the correction immediately
  return record;
}

// Removes a program entirely — deletes its Blob record so it (and its four
// dashboards) disappear from the shell immediately. Irreversible: there is
// no undo, and every dashboard link for this program stops resolving the
// moment this runs. EON is the built-in default and can never be deleted
// from here.
async function deleteProgram(id) {
  if (!id) throw new Error('Program id is required.');
  if (id === EON_BUILTIN.id) throw new Error('EON is a built-in program and cannot be deleted.');
  const existing = await getProgram(id);
  if (!existing) throw new Error(`No program with id "${id}" exists.`);

  await del(`programs/${id}.json`);

  cache = null; // force the next listPrograms() to drop it immediately
  return { id, name: existing.name };
}

// Optional destructive-action gate: if ADMIN_EMAILS is set (comma-separated,
// case-insensitive), only those signed-in emails can delete a program. If
// it's unset, every signed-in user can — same zero-config default as adding
// and editing a program — so setting this is opt-in hardening, not a
// requirement to use the platform.
function isAdmin(session) {
  const list = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;
  const email = (session && session.email || '').toLowerCase();
  return list.includes(email);
}

module.exports = { listPrograms, getProgram, addProgram, updateProgram, deleteProgram, isAdmin, EON_BUILTIN };
