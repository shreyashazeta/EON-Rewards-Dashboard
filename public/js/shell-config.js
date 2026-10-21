// Central configuration for the Governance Dashboard shell.
// Adding a new program should mean adding an entry here — not touching
// shell.html, the nav, or the routing logic.
//
// `path` is the iframe src for a working dashboard. `connected: false`
// means the program/dashboard combination has no live Jira wiring yet —
// the shell will show an honest "not connected" placeholder instead of
// silently rendering nothing or fabricating data.

const GOVERNANCE_CONFIG = {
  programs: [
    {
      id: 'eon',
      name: 'EON',
      quarter: 'Q3 FY2026',
      dashboards: [
        { id: 'executive', name: 'Executive Dashboard', path: '/executive.html?program=eon', connected: true, apiUrl: null },
        { id: 'sprint-health', name: 'Sprint Health', path: '/sprint-health.html', connected: true, apiUrl: '/api/sprint-health' },
        { id: 'engineering-delivery', name: 'Program Delivery Intelligence', path: '/engineering_delivery_dashboard.html', connected: true, apiUrl: '/api/delivery-intelligence' },
        { id: 'hygiene', name: 'Hygiene', path: '/hygiene.html', connected: true, apiUrl: '/api/hygiene' },
      ],
    },
    {
      id: 'rewards-ple',
      name: 'Rewards PLE',
      quarter: 'Q3 FY2026',
      dashboards: [
        { id: 'executive', name: 'Executive Dashboard', path: '/executive.html?program=rewards-ple', connected: false, apiUrl: null },
        { id: 'sprint-health', name: 'Sprint Health', path: null, connected: false, apiUrl: null },
        { id: 'engineering-delivery', name: 'Program Delivery Intelligence', path: null, connected: false, apiUrl: null },
        { id: 'hygiene', name: 'Hygiene', path: null, connected: false, apiUrl: null },
      ],
    },
  ],
};

// Helpers used by shell.html — kept here so shell.html never has to
// know the shape of the config, just how to ask questions of it.
function govFindProgram(programId) {
  return GOVERNANCE_CONFIG.programs.find(p => p.id === programId) || GOVERNANCE_CONFIG.programs[0];
}
function govFindDashboard(program, dashboardId) {
  return (program.dashboards || []).find(d => d.id === dashboardId) || program.dashboards[0];
}
