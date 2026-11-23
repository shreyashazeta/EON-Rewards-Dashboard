// Writes one short comment on a Jira ticket when an escalation is tracked: the subject and the date,
// nothing else (no issue text, no summary, no email body). Posted as the account that owns the
// dashboard's JIRA_API_TOKEN, so that account needs "Add comments" on the ticket.
// SPI- and SPB- tickets live on the SaaS Jira site; every other key is tried on the EON Jira site.
const SAAS_KEY = /^(SPI|SPB)-/;

function commentText(subject, date) {
  const s = String(subject || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `Escalation raised on ${date}${s ? ': ' + s : ''} (logged from the EON dashboard)`;
}

async function postEscalationComment(key, subject, date) {
  const body = { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: commentText(subject, date) }] }] } };
  const onSaas = SAAS_KEY.test(key);
  const call = onSaas ? require('./saas').saasFetch : require('./jira').jiraFetch;
  const site = onSaas ? 'SaaS Jira' : 'EON Jira';
  try {
    const r = await call(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', body: JSON.stringify(body) });
    return { status: 'posted', id: r && r.id ? String(r.id) : null, site, at: new Date().toISOString() };
  } catch (e) {
    let reason;
    if (e.status === 404) reason = `${key} was not found on ${site}${onSaas ? '' : ' (only the EON Jira site is checked for this key)'}`;
    else if (e.status === 401 || e.status === 403) reason = `the dashboard's Jira account is not allowed to comment on ${key} (${site})`;
    else if (/Missing .*(JIRA|SAAS)/i.test(e.message)) reason = 'Jira credentials are not set on the server';
    else reason = `${site} said: ${String(e.message).replace(/\s+/g, ' ').slice(0, 160)}`;
    return { status: 'failed', error: reason, site, at: new Date().toISOString() };
  }
}

module.exports = { postEscalationComment, commentText };
