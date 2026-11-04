# nervalog.github.io

The site for [Nerva](https://github.com/NervaLog/nerva), served at <https://nervalog.github.io/>.

`index.html` is the whole site: a static page with no build step. GitHub Pages serves this
repository's `main` branch from its root, so a push to `main` is a deploy. `.nojekyll` turns off
Jekyll.

## Status

The page shows Nerva's status from the data at the top of its script (`SITE`, `GOALS`,
`PRODUCTION`, `NEXT`, `RELEASES`). It must match the Production table in Nerva's README: change
them together, never mark anything delivered before its demo is green in Nerva's CI, and never show
output as recorded that was not recorded in a real run.
