/* Bug SLO: P1 must be closed within 5 days, P2 within 10 days of being raised.
   Clock = calendar days from the ticket's created date to today (same as the "Age (d)" column).
   Only open bugs are measured. Change the numbers here and every dashboard follows. */
(function (g) {
  var BUG_SLO_DAYS = { P1: 5, P2: 10 };
  var DUE_SOON_DAYS = 1; // amber when this many days or fewer are left

  function daysSince(iso, now) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, Math.floor(((now || Date.now()) - t) / 86400000));
  }
  // priority: 'P1' / 'P2' (anything else has no SLO). ageDays: whole days since created.
  function bugSlo(priority, ageDays) {
    var slo = BUG_SLO_DAYS[priority];
    if (!slo || ageDays == null) return { state: 'none', slo: slo || null, left: null, age: ageDays };
    var left = slo - ageDays;
    return { state: left < 0 ? 'breached' : (left <= DUE_SOON_DAYS ? 'due' : 'ok'), slo: slo, left: left, age: ageDays };
  }
  function sloText(r) {
    if (r.state === 'none') return '—';
    if (r.state === 'breached') return 'Breached by ' + (-r.left) + 'd';
    if (r.left === 0) return 'Due today';
    return r.left + 'd left';
  }
  function sloTitle(r, priority) {
    return r.state === 'none' ? 'No SLO set for this priority' : priority + ' SLO is ' + r.slo + ' days; open ' + r.age + ' days';
  }
  function sloBadge(priority, ageDays) {
    var r = bugSlo(priority, ageDays);
    var color = { breached: '#c62828', due: '#b26a00', ok: '#1b7a43', none: '#8a8a8a' }[r.state];
    var bg = { breached: '#fdecea', due: '#fff3e0', ok: '#e7f5ec', none: 'transparent' }[r.state];
    return '<span title="' + sloTitle(r, priority) + '" style="font-size:11px;font-weight:700;padding:2px 7px;border-radius:5px;white-space:nowrap;color:' +
      color + ';background:' + bg + ';">' + sloText(r) + '</span>';
  }
  // bugs: [{priority, ageDays}] -> counts of open bugs past SLO
  function sloSummary(bugs) {
    var out = { P1: { breached: 0, total: 0 }, P2: { breached: 0, total: 0 }, breached: 0 };
    bugs.forEach(function (b) {
      if (!BUG_SLO_DAYS[b.priority]) return;
      out[b.priority].total++;
      if (bugSlo(b.priority, b.ageDays).state === 'breached') { out[b.priority].breached++; out.breached++; }
    });
    return out;
  }
  // bugs: [{priority, ageDays}] -> how many are within SLO vs past it (P1 and P2 only)
  function sloCounts(bugs) {
    var out = { within: 0, breached: 0, total: 0 };
    bugs.forEach(function (b) {
      if (!BUG_SLO_DAYS[b.priority] || b.ageDays == null) return; // unknown age is not claimed as within SLO
      out.total++;
      if (bugSlo(b.priority, b.ageDays).state === 'breached') out.breached++; else out.within++;
    });
    return out;
  }
  g.BugSLO = { sloCounts: sloCounts, DAYS: BUG_SLO_DAYS, daysSince: daysSince, bugSlo: bugSlo, sloText: sloText, sloBadge: sloBadge, sloSummary: sloSummary };
  if (typeof module !== 'undefined') module.exports = g.BugSLO;
})(typeof window !== 'undefined' ? window : globalThis);
