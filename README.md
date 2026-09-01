# School Tracker

One always-running desktop app that pulls every assignment, quiz, project, and
exam into a single radar — so nothing scattered across Canvas, Gradescope,
Google Calendar, Ed, and Perusall sneaks up on you.

- **Radar** — everything sorted Overdue / Today / Tomorrow / This week, with a
  computed "do this next" highlight on the top three. Quick-add tasks in plain
  English: `finish lab report by fri 5pm`.
- **Week** — Mon–Sun grid of due dates and calendar events, so crunch days are visible.
- **Planner** — drag tasks onto days and timeslots to time-block your day. Your
  calendar events show as busy background. With the Claude CLI installed, **Plan
  my day** proposes a schedule you can accept or tweak.
- **Morning digest email** — what's due today/tomorrow/this week, in your inbox
  (and on your phone) every morning. With the Claude CLI, it opens with a short
  written brief of the day.
- **Windows toasts** — a heads-up 48h and 24h before anything unsubmitted is
  due, when new assignments appear, and if the Gradescope session expires.
- **Global quick capture** — `Ctrl+Shift+Space` anywhere in Windows to jot a
  task before the thought escapes.
- Statuses (not started / in progress / done) are yours: they survive every
  re-sync. Manual tasks (research, personal) are first-class.

## Sources

| Source | How it connects |
| --- | --- |
| Canvas | Sign in once with your school login (GT blocks student access tokens; the app keeps the session and uses Canvas's own API with it). Schools that allow tokens can paste one instead. Perusall/LTI assignments come through here. |
| Google Calendar | The calendar's "Secret address in iCal format" (Settings → Integrate calendar). No OAuth. |
| Ed Discussions | API token (Settings → API Tokens). Announcements land in a rail; deadlines mentioned in them are extracted onto the radar. |
| Gradescope | No API exists. The app opens a real sign-in window once (school SSO + Duo) and keeps the session. When it expires, you get a toast to reconnect. |

Tokens are stored locally, encrypted with Windows DPAPI. Nothing leaves your machine
except the requests to those services and the digest email you send yourself.

## Run it (dev)

```
npm install
npm start          # the Electron app (tray icon, auto-start registers on first run)
npm run setup      # optional: Desktop/Start Menu shortcuts
npm run server     # headless API on :4747 for development
npm test           # date + ICS parser tests
```

First launch opens onboarding — paste the tokens, hit Finish, and the first
sync fills the radar.

## Install (no node needed)

`npm run dist` produces a Windows installer under `dist/`. Share that .exe;
Windows SmartScreen will warn because it's unsigned — **More info → Run
anyway**. Everything works without AI for people who don't have the Claude
CLI; the AI features (morning brief, Plan my day, announcement date reading)
light up automatically when `claude` is on the PATH.

## Notes

- Sync runs every 30 min (configurable) while the app is in the tray; closing
  the window doesn't stop it. Quit from the tray menu.
- Google refreshes private ICS feeds lazily — calendar events can lag a few
  hours. Canvas is the ground truth for coursework.
- If Gradescope changes its markup, the sync fails loudly and saves the HTML
  to `data/debug/` so the parser can be fixed against reality.
