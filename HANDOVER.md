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

## TCP view: date changes and risk remarks
- **Dev Forecast Date** (Jira "Dev completion ETA") and **Committed UAT Sign off Date** (Jira "UAT Release ETA") are two columns on bugs and stories. Field IDs are found by name at runtime (`DEV_FORECAST_NAMES`, `UAT_COMMIT_NAMES` in `lib/saas.js`). The current date shows on top; every earlier date is struck through below it in the same cell, with the full was/now/days-moved/who/when on hover. Earlier dates come from the Jira changelog for that one field, and Jira returns only the latest 100 entries per search, so very old moves can be missing. If a field name does not exist on the SaaS site the cell says "Field not found" and the Method box lists it as unresolved.
- **Story detail pop-up:** clicking a story summary on the TCP tab opens a pop-up window in the middle of the screen with the effort estimate (Jira "High-Level Effort Estimate (Story Points)", found by name in `EFFORT_NAMES`) and every bug linked to that story, split into Prod and UAT. Links come from the story's Jira issue links (any link type); a linked issue counts as a bug if its key starts with SPB- or its issue type contains "bug" or "defect". All priorities and closed bugs are shown (closed ones greyed). A bug with no Zone counts as UAT, same as the bug counts. Linked bugs are fetched in one extra query per 100 links (`key in (...)`), not one per story.
- **Risk remarks** are typed on the page, one per ticket, up to 600 characters, saved to the Blob store under `saas-remarks/<KEY>/` (random URL suffix, replaced on each save, cleared by saving empty). Any signed-in user can add, edit or clear a remark. They are saved through `POST /api/hygiene?view=saas-remark`; no new API file was added (the Hobby limit of 12 stays).
- Remarks are internal notes today. Do not screen-share this tab with a client without reading them first.
- **Test case creation (column + pop-up box):** QA posts the test case sheet as a comment on the Jira ticket. The TCP story table shows **Completed** (with an "Open sheet" link, author and date) when any comment on the story carries a spreadsheet link (Google Sheets, SharePoint/OneDrive, or a URL ending .xlsx/.xls/.csv) or a spreadsheet attachment, and **Pending** when no comment does. A comment with no sheet in it does not count. The same result shows in the story pop-up. Comments come from the same story search (`comment` field); if Jira returns only part of a long thread, the full thread is fetched for that story only (no new `api/*.js` file). To match a different kind of link, set the env var `TESTCASE_LINK_PATTERN` to a regex (for example `testrail\\.io`). Limits: it proves a sheet was posted, not that it covers the story or was reviewed, and it does not check that it was posted a sprint ahead.

## Open items
- Remove the duplicate "Tachyon Rewards JAS 26" stream from Rewards PLE (Manage Programs > Edit).
- Next phase: Teams/email digest, CMR (Change Management Record) rules integration, release quarter as a real Jira field instead of a label.
