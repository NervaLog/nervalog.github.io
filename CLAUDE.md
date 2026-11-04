# CLAUDE.md

This repository is Nerva's site, `index.html`, served by GitHub Pages from `main`'s root at
<https://nervalog.github.io/>. Nerva itself is `NervaLog/nerva`; read its README and
`docs/PRODUCTION.md` before changing what the page says.

- A push to `main` publishes. Change the page on a branch and open a pull request unless the owner
  says otherwise.
- The status data at the top of the script (`SITE`, `GOALS`, `PRODUCTION`, `NEXT`, `RELEASES`)
  matches the Production table in Nerva's README. Never mark anything delivered before its demo is
  green in Nerva's CI, and never show output as recorded that was not recorded.
- No build step, no npm. External resources only as the page already uses them.
