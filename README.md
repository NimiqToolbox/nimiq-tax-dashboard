# Nimiq Tax Dashboard

> Paste your Nimiq addresses and get a tax-ready, FIFO realized-gains report — computed entirely in your browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Runs 100% locally](https://img.shields.io/badge/runs-100%25%20locally-21BCA5.svg)
![No backend](https://img.shields.io/badge/backend-none-1F2348.svg)

**Live app:** <https://nimiqtoolbox.github.io/nimiq-tax-dashboard/>

The Nimiq Tax Dashboard fetches your full on-chain NIM transaction history straight from the
Nimiq network using the official light client (compiled to WebAssembly), values every transaction
at the historical NIM/USD price for its date, detects atomic swaps, computes **FIFO realized
capital gains per year**, and lets you export everything as CSV.

It's a single static page — no build step, no server, no account.

## Features

- 🔎 **Multi-address lookup** — paste one or many Nimiq addresses; histories are fetched in parallel.
- ⛓️ **Trustless data** — history comes directly from the Nimiq Albatross network via the in-browser light client, not a third-party indexer.
- 💵 **Historical pricing** — each transaction is valued at its date's NIM/USD price (CoinGecko via DefiLlama).
- 🔁 **Swap detection** — NIM↔BTC/USDC/USDT/EUR atomic swaps are recognised via the public Fastspot API.
- 📊 **FIFO gains** — realized capital gains per calendar year using a first-in-first-out cost basis.
- 📁 **CSV export** — download both the transaction ledger and the yearly gains summary.
- ⚡ **Off-thread** — pricing and FIFO run in Web Workers, so the UI stays responsive.

## Privacy & security

**Everything runs locally in your browser. Your addresses never touch a server we control.**

- There is **no backend** — the page is 100% static.
- Your addresses and transactions are processed **on your device** and cached only in your
  browser's IndexedDB (`nimiq-tax-db`). Clear your browser data to wipe them.
- No accounts, no analytics, no tracking.
- The only network calls are to public, read-only services (see [Data sources](#data-sources)).
- It's open-source — read every line before you trust it.

## Run it locally

The app must be served over **HTTP(S)** — opening `index.html` directly from the `file://`
protocol will not work, because the WebAssembly client is fetched at runtime. There is no build
step and no configuration.

Any static file server works:

```bash
# Python (preinstalled on macOS/Linux)
python3 -m http.server 8000

# …or Node
npx serve .

# …or Docker (no host tooling required)
docker run --rm -p 8000:8000 -v "$PWD":/app -w /app python:3-alpine python -m http.server 8000
```

Then open <http://localhost:8000>.

## How it works

```
index.html            App shell + markup
script.js             Main app logic (lookup, render, orchestration)
storage.js            IndexedDB persistence (transactions, prices, gains)
export.js             CSV helpers
worker/
  priceWorker.js      Fetches historical NIM/USD prices off the main thread
  fifoWorker.js       Computes FIFO realized gains off the main thread
nimiq-core/           Nimiq light client (WebAssembly) + Comlink glue
launcher/browser/     Comlink worker proxies for the client
lib/                  Nimiq web utilities (bundled)
design/               Nimiq Design System: tokens, fonts, components, brand assets
vendor/               Tailwind (utility CSS)
```

The Nimiq light client establishes consensus directly with the network from your browser.
Price lookups and FIFO calculations run in dedicated Web Workers, and all persistence is local
(IndexedDB).

## Data sources

All read-only and public:

| Service | Used for |
| --- | --- |
| Nimiq Albatross network (seed nodes) | Transaction history & consensus, via the in-browser light client |
| [DefiLlama](https://defillama.com/) (`coins.llama.fi`, CoinGecko `nimiq-2`) | Historical NIM/USD prices |
| [Fastspot](https://fastspot.io/) public API | Atomic-swap counter-asset detection (uses Nimiq's public publishable key) |
| [nimiq.watch](https://nimiq.watch/) | Block-explorer deep links |

## Disclaimer

**Not tax advice.** This tool is for informational purposes only and is not tax, accounting,
legal, or financial advice. Figures are best-effort and may be incomplete. FIFO gains assume each
disposal's cost basis comes from your prior looked-up acquisitions — NIM acquired before your
earliest transaction here, from staking, or off-chain is treated as **zero cost basis**, which
overstates gains. Always confirm with a qualified tax professional before filing.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security issue,
see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © NimiqToolbox.

Built with open-source components from the Nimiq ecosystem and others — see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
