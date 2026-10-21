const { searchAll, deriveTicketFields } = require('../lib/jira');
const { getSession } = require('../lib/session');
const { getProgram } = require('../lib/programs');

const CHILD_FIELDS = [
  'summary', 'issuetype', 'status', 'assignee', 'customfield_10023',
  'customfield_11798', 'customfield_11037', 'customfield_11749', 'customfield_10447', 'customfield_11750', 'parent',
  'labels',
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
    return res.status(401).json({ error: 'Not signed in.' });
  }

  try {
    const programId = (req.query && req.query.program) || 'eon';
    const program = await getProgram(programId);
    if (!program) {
      return res.status(404).json({ error: `Unknown program "${programId}".` });
    }

    // Normally this walks every formally-configured stream. But a sub-label
    // that lives on TOP of a stream (a quarter tag like
    // "Tachyon_Rewards_JAS_26" on top of "Tachyon_Rewards") is not itself a
    // registered stream, and its epics/tickets are not necessarily a subset
    // of any one stream's already-fetched epics — some may carry the
    // sub-label without carrying the parent stream's label at all. So
    // filtering client-side within an already-fetched stream silently
    // undercounts. `?label=` runs this exact same computation independently
    // for any label, formally registered or not, giving the true, complete
    // set every time — used by the label-filter dropdown on demand.
    const adHocLabel = req.query && req.query.label;
    const labelsToCompute = adHocLabel ? [String(adHocLabel)] : program.streams.map(s => s.label);

    const data = {};
    for (const label of labelsToCompute) {
      data[label] = await computeLabelEpics(program, label);
    }

    res.status(200).json({
      meta: { dataPulledAt: new Date().toISOString(), programName: program.name, streams: program.streams },
      data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const EPIC_META_FIELDS = ['summary', 'status', 'assignee', 'created', 'customfield_11037', 'customfield_11749', 'customfield_10447', 'customfield_11750', 'labels'];

// Computes the full end-to-end epic rollup for one label, whether that label
// is a formally-configured program stream or an ad-hoc sub-label picked from
// the label-filter dropdown — same logic either way.
//
// Only epics that carry the label THEMSELVES are included. An earlier
// version also pulled in epics whose own label was missing but one of their
// children carried it, but that quietly inflated counts with epics the label
// search itself wouldn't return (confirmed on EON: 21 directly-labeled LE
// epics vs 31 once child-implied ones were mixed in). If an epic's own label
// is missing in Jira, the fix is labeling the epic in Jira, not working
// around it here.
async function computeLabelEpics(program, label) {
  const directEpicIssues = await searchAll(`project = "${program.projectKey}" AND labels = "${label}" AND issuetype = Epic`, EPIC_META_FIELDS, 200);

  const epics = directEpicIssues.map(i => {
    const derived = deriveTicketFields(i); // reads the EPIC's own Dev ETA/QA-ETA fields directly — not a rollup from children
    return {
      key: i.key,
      sum: i.fields.summary,
      epicStatus: i.fields.status ? i.fields.status.name : null,
      devEtaMissing: derived.eta,   // true = epic's own Dev ETA field is empty
      qaEtaMissing: derived.qa,     // true = epic's own QA-ETA field is empty
      devEta: derived.dev_eta,
      qaEta: derived.qa_eta,
      labels: i.fields.labels || [], // e.g. a quarter sub-tag like "Tachyon_Rewards_JAS_26" layered on top of the stream label
    };
  });

  if (epics.length === 0) return [];

  // All children of those epics, regardless of sprint or their own labels — one batched query.
  const epicKeys = epics.map(e => e.key).join(',');
  const childIssues = await searchAll(`parent in (${epicKeys})`, CHILD_FIELDS, 1000);
  const children = childIssues.map(deriveTicketFields);

  const byParent = {};
  children.forEach(c => {
    (byParent[c.parent_key] = byParent[c.parent_key] || []).push(c);
  });

  // Roll each epic up from its real children.
  return epics.map(e => {
    const kids = byParent[e.key] || [];
    const done = kids.filter(k => k.cat === 'Done');
    return {
      key: e.key,
      sum: e.sum,
      epicStatus: e.epicStatus,
      devEtaMissing: e.devEtaMissing,
      qaEtaMissing: e.qaEtaMissing,
      devEta: e.devEta,
      qaEta: e.qaEta,
      labels: e.labels,
      childLabels: [...new Set(kids.flatMap(k => k.labels || []))], // sub-labels present anywhere among this epic's children, for the label-filter dropdown
      tickets: kids.length,
      done: done.length,
      spTotal: kids.reduce((s, k) => s + k.sp, 0),
      spDone: done.reduce((s, k) => s + k.sp, 0),
      blocked: kids.filter(k => k.status === 'Blocked').length,
      acMissing: kids.filter(k => k.ac).length,
      etaMissing: kids.filter(k => k.eta).length,
      qaMissing: kids.filter(k => k.qa).length,
      assignees: [...new Set(kids.filter(k => k.a !== 'Unassigned').map(k => k.a))],
      children: kids.map(k => ({ k: k.k, sum: k.sum, status: k.status, a: k.a })),
    };
  });
}
