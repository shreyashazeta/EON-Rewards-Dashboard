const { getSession } = require('../lib/session');
const { callClaude } = require('../lib/anthropic');

function setCors(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const SYSTEM_PROMPT = `You are helping a software team read live data from their Jira-backed delivery dashboards.
You will receive a JSON digest of real, current data pulled from Jira moments ago — this may be
sprint-level ticket data, or epic/roadmap-level delivery data, depending on which dashboard sent it.
Produce a concise, specific readout — not generic scrum advice. Reference actual ticket keys,
epic names, and people from the digest wherever relevant. Assume the reader is a mix of PM,
engineering manager, and a senior stakeholder skimming quickly.

Respond with ONLY valid JSON, no markdown fences, no commentary outside the JSON, in this exact shape:
{
  "summary": "2-3 sentence executive summary of where the sprint stands right now",
  "risks": ["specific risk 1, naming tickets/people/epics where relevant", "risk 2", "..."],
  "actions": ["specific, concrete recommended action 1", "action 2", "..."]
}
Include 3-5 risks and 3-5 actions. If something looks healthy, say so plainly rather than inventing a risk.`;

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  try {
    const digest = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const userPrompt = `Here is the current sprint digest:\n\n${JSON.stringify(digest, null, 2)}\n\nGenerate the executive summary JSON now.`;
    const raw = await callClaude(SYSTEM_PROMPT, userPrompt);

    let parsed;
    try {
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: 'Claude returned unparseable output.', raw });
    }

    res.status(200).json({ ...parsed, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
