# CLAUDE.md

This repository is Nerva's site, `index.html`, published as a Cloudflare Worker of static
assets (P410) at <https://nerva.pro/>. Nerva itself is `NervaLog/nerva`; read its README and
`docs/PRODUCTION.md` before changing what the page says.

- A push to `main` publishes, through Cloudflare's build from `main`. Change the page on a branch and open a pull request unless the owner
  says otherwise.
- The status data at the top of the script (`SITE`, `GOALS`, `PRODUCTION`, `NEXT`, `RELEASES`)
  matches the Production table in Nerva's README. Never mark anything delivered before its demo is
  green in Nerva's CI, and never show output as recorded that was not recorded.
- No build step, no npm. External resources only as the page already uses them.
- The page carries no signing key, no fingerprint and no repository line: it links to Nerva's
  `docs/INSTALL.md`. The key is only at its WKD path (`.well-known/openpgpkey/`), a copy of Nerva's
  `packaging/keys/nerva-release.asc` at the newest published `v*` tag on `main` (NRV-E1162). Only a
  release pull request changes it, together with `index.html`, both WKD files or neither. No WKD
  file is added by hand.
- The Worker build refuses these names (NRV-E1152), and `site-check` refuses them first:
  `functions/`, `_worker.js`, `_routes.json`, `wrangler.*`, and everything not on its allow-list
  (`index.html`, `404.html`, `_headers`, `.well-known`, `.git`, `.github`, `.nojekyll`, `README.md`,
  `LICENSE`, `CLAUDE.md`), symlinks and dangling ones included.
