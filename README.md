# EON Jira Dashboards

Live governance dashboards on Jira data: Hygiene Tracker, Sprint Health, Program Delivery Intelligence and Executive Dashboard, behind an Atlassian login. Static pages in `public/`, serverless functions in `api/`, shared logic in `lib/`, deployed on Vercel.

Start with **HANDOVER.md** (setup, rules, change process). Environment variables are listed in `.env.example`.

## Notes
- Sign-in uses Atlassian OAuth (`read:me` only). Jira data itself is fetched with the shared `JIRA_API_TOKEN`; the login only gates who can see it. Sessions are a signed 12-hour cookie.
- The "Generate with Claude" button on Sprint Health and the Executive summary need `ANTHROPIC_API_KEY` (billed per use). Without it those panels stay hidden.
- If Jira rejects a call, check Vercel: Project > Deployments > your deployment > Functions logs.
- If a Jira admin changes a custom field ID (Dev ETA, QA ETA, Acceptance Criteria), update the constants at the top of `lib/jira.js`.
