# nervalog.github.io

The site for [Nerva](https://github.com/NervaLog/nerva), served at <https://nerva.pro/>.

`index.html` is the whole site: a static page with no build step of its own. It is published as a
Cloudflare Worker of static assets (P410): a push to `main` is a deploy, and the Worker's build
copies only `index.html`, `404.html`, `_headers` and `.well-known`.

The page carries no signing key and no fingerprint; it links to Nerva's `docs/INSTALL.md`. The key
is only at its WKD path, `.well-known/openpgpkey/hu/ndqm47zydhyqyzabecddtdk1q3bponab` with an empty
`policy` beside it: a copy of Nerva's `packaging/keys/nerva-release.asc` (NRV-E1162).

The build refuses `functions/`, `_worker.js`, `_routes.json`, `wrangler.*` and every name off its
allow-list (NRV-E1152); `site-check` refuses the same names in a pull request.

## Status

The page shows Nerva's status from the data at the top of its script (`SITE`, `GOALS`,
`PRODUCTION`, `NEXT`, `RELEASES`). It must match the Production table in Nerva's README: change
them together, never mark anything delivered before its demo is green in Nerva's CI, and never show
output as recorded that was not recorded in a real run.
