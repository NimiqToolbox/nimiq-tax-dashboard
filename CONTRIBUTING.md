# Contributing

Thanks for your interest in improving the Nimiq Tax Dashboard! Contributions of all sizes are
welcome — bug reports, fixes, and features.

## Getting started

This is a dependency-free static site: **no build step, no package manager, no configuration.**
Just serve the folder over HTTP and open it (see [README — Run it locally](README.md#run-it-locally)):

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Project layout

See [README — How it works](README.md#how-it-works) for the directory map. In short: first-party
code lives in `index.html`, `script.js`, `storage.js`, `export.js`, `worker/`, and `design/`
(the dashboard CSS). Everything under `nimiq-core/`, `lib/`, `launcher/`, `vendor/`, and the
`design/` brand assets/fonts is vendored third-party code — please don't hand-edit it; update it
from upstream instead.

## Reporting bugs & requesting features

Open a [GitHub issue](https://github.com/nimiqtoolbox/nimiq-tax-dashboard/issues). For bugs,
please include your browser/OS and the steps to reproduce. **Never paste private keys, seed
phrases, or other secrets** — only public addresses are ever needed.

## Pull requests

1. Fork and create a branch.
2. Keep changes focused and match the existing style (vanilla ES modules, 2-space indentation,
   descriptive comments where logic is non-obvious — see `.editorconfig`).
3. Test manually in the browser: run a lookup, confirm prices and FIFO gains render, and that both
   CSV exports download without console errors.
4. Open the PR with a clear description of what changed and why.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
