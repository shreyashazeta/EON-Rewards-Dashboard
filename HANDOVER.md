# EON Jira Dashboards: handover quick start

Scope: the four dashboards (Hygiene Tracker, Sprint Health, Program Delivery Intelligence, Executive Dashboard) and the shell around them. Nothing else built from their data is included. The full written guide ("EON Jira Dashboards - Handover Guide") is shared alongside this repo.

## The four dashboards
| Dashboard | Page | API |
| --- | --- | --- |
| Hygiene Tracker | `public/hygiene.html` | `api/hygiene.js`, `api/sprint-coverage.js` |
| Sprint Health | `public/sprint-health.html` | `api/sprint-health.js`, `api/epic-delivery.js`, `api/summary.js` |
| Program Delivery Intelligence | `public/engineering_delivery_dashboard.html` | `api/delivery-intelligence.js` |
| Executive Dashboard | `public/executive.html` | `api/delivery-intelligence.js`, `api/epic-delivery.js`, `api/summary.js` |

Shell and admin: `public/index.html` (governance shell, tabs per program), `public/js/shell-config.js` (navigation), `public/add-program.html`, `public/manage-programs.html`, `api/programs.js`, `api/config.js`, `api/auth/*` (Atlassian login).
Shared code: `lib/jira.js` (Jira calls, custom field IDs), `lib/lifecycle.js` (status to stage mapping), `lib/workdays.js` (Mon-Fri sprint maths), `lib/programs.js` (program registry), `lib/session.js`, `lib/anthropic.js`.

## Stand it up
1. New private GitHub repo; push this folder's contents to `main`.
2. Vercel (Hobby is fine): Add New > Project > import the repo. No build command. Deploy once to get the URL.
3. Vercel Project > Storage: create and connect a Blob store (holds programs added in the UI).
4. developer.atlassian.com/console/myapps: OAuth 2.0 app, User identity API, scope `read:me`, callback `https://<your-url>/api/auth/callback`.
5. Set the environment variables listed in `.env.example`, then Redeploy.
6. Test in a private window: Atlassian login, dashboards load, the pill shows Live. Re-add Rewards PLE in Manage Programs if it is missing.

## Rules that must not break
- Hobby plan allows 12 serverless functions. `api/` has exactly 12 `.js` files; put new logic in `lib/`.
- Delivered = the epic's own Jira status is Done or Closed. Never inferred from child tickets.
- QA ETA lives on the epic (customfield_11750).
- End-to-end delivery and Roadmap show only epics carrying the label themselves.
- Missing Acceptance Criteria counts only Story and Tech Story.
- Sprint days left count Mon-Fri only (`TEAM_TIMEZONE`, default Asia/Kolkata); no holiday calendar.
- Custom field IDs are constants at the top of `lib/jira.js`. The Jira site URL is also hard-coded as `JIRA_BASE` near the top of the four dashboard pages; change it there if the Jira site ever moves.

## Every change
Check the real Jira data first, make a small edit, `node --check` each changed `.js`, confirm 12 files in `api/`, push, then confirm Vercel's Source tab shows your commit (stale deployments have happened). Hard-refresh the page or use its Refresh button when checking numbers.

## Open items
- Remove the duplicate "Tachyon Rewards JAS 26" stream from Rewards PLE (Manage Programs > Edit).
- Next phase: Teams/email digest, CMR (Change Management Record) rules integration, release quarter as a real Jira field instead of a label.
