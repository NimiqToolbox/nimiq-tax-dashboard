// Uses Nimiq Web Client to lookup transactions for a given address.
// This script is meant for a static page and does not require any bundler.
// Ensure you are hosting this page over HTTP(S); loading from the file:// protocol won\'t work
// because the WASM file needs to be fetched.

import init, { Client, ClientConfiguration, Policy } from './nimiq-core/index.js';
import { saveTransactions, getPrice, savePrices, getGainsSummary, getAllTransactions, getTransactionsForAddresses } from './storage.js';
import { toCsv, downloadCsv } from './export.js';
import Identicons from './design/assets/iqons.bundle.min.js';
import { classifyStaking, isCoinbaseReward, isPoolReward, classifySwap, htlcAddressOf } from './staking.js';

// Start price worker
const priceWorker = new Worker('./worker/priceWorker.js?v=' + Date.now(), { type: 'module' });
priceWorker.onmessage = async (e) => {
  const { prices, error } = e.data;
  if (error) {
    console.warn('Price worker error:', error);
    status('Price sync failed', 'error');
    return;
  }
  await savePrices(prices);
  status('Price data updated.', 'success');
};

const statusEl = document.getElementById('status');
const table = document.getElementById('results');
const tbody = table.querySelector('tbody');
const button = document.getElementById('lookup-btn');
const addressInput = document.getElementById('address-input');
const poolInput = document.getElementById('pool-input');
const limitInput = document.getElementById('limit-input');
let activeLimit = 0; // newest-N preview cap currently in effect (0 = full history)
const summaryEl = document.getElementById('summary');
const exportTxBtn = document.getElementById('export-tx');
const exportGainsBtn = document.getElementById('export-gains');
const txSection = document.getElementById('tx-section');

// Remember the optional pool payout addresses + preview limit in this browser across reloads.
if (poolInput) {
  const savedPools = localStorage.getItem('nimiq-tax-pool-addresses');
  if (savedPools) poolInput.value = savedPools;
}
if (limitInput) {
  const savedLimit = localStorage.getItem('nimiq-tax-limit');
  if (savedLimit) limitInput.value = savedLimit;
}

// ---- Address / identicon helpers (Nimiq design system) ----
function normAddr(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }
function chunk4(s) { return normAddr(s).replace(/(.{4})/g, '$1 ').trim(); }

const identiconCache = new Map(); // normalized address -> Promise<dataUrl|null>
function getIdenticon(addr) {
  const key = normAddr(addr);
  if (!identiconCache.has(key)) {
    identiconCache.set(key, Identicons.toDataUrl(key).catch(() => null));
  }
  return identiconCache.get(key);
}

// ---- Block explorer, formatting, clipboard helpers ----
// Mainnet explorer (same base for tx hashes and addresses), per the wallet's ExplorerUtils.ts
function explorerTxUrl(hash) { return 'https://nimiq.watch/#' + (hash || ''); }
function explorerAddrUrl(addr) { return 'https://nimiq.watch/#' + (addr || ''); }

// Truncated address for list cells: "NQ12 34…7Z9Q"
function shortAddr(addr) {
  const a = normAddr(addr);
  if (a.length <= 12) return a;
  const head = a.slice(0, 6).replace(/(.{4})/g, '$1 ').trim();
  return `${head}…${a.slice(-4)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDate(tsSec) {
  const d = new Date((tsSec || 0) * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Nimiq Albatross (PoS) plain-tx timestamps are in MILLISECONDS; older/other sources use
// seconds. Normalize everything to SECONDS — the unit the rest of this file and the price
// date-keys assume. (Same heuristic the wallet's toSecs() uses.)
function toSecs(t) { return t > 1e12 ? Math.floor(t / 1000) : (t || 0); }

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch (_) { /* ignore */ }
  document.body.removeChild(ta);
}
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  // force reflow so the transition runs even on rapid repeats
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 250);
  }, 1400);
}

// Counterparty cell: identicon (links to the explorer address page) + a short, click-to-copy address.
function counterpartyCell(addr) {
  const wrap = document.createElement('div');
  wrap.className = 'addr-cell';
  if (!addr) { wrap.innerHTML = '<span class="muted">—</span>'; return wrap; }

  const link = document.createElement('a');
  link.className = 'identicon-link';
  link.href = explorerAddrUrl(addr);
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = 'View address on nimiq.watch';
  const img = document.createElement('img');
  img.className = 'identicon';
  img.width = 26; img.height = 26; img.alt = '';
  link.appendChild(img);

  const text = document.createElement('span');
  text.className = 'addr-text addr-copy';
  text.textContent = shortAddr(addr);
  text.title = `${addr}  ·  click to copy`;
  text.addEventListener('click', () => { copyToClipboard(addr); showToast('Address copied'); });

  wrap.append(link, text);
  getIdenticon(addr).then(url => { if (url) img.src = url; });
  return wrap;
}

// HTLC swap / Nimiq Pay classification (classifySwap) lives in staking.js — imported above.

// Resolve a swap's counter-asset (BTC / USDC / USDT / EUR) from a NIM HTLC address via the
// public Fastspot API — the same lookup the Nimiq Wallet uses (GET /contracts/NIM/{address}
// returns both swap legs as info.from/info.to). Cached per HTLC address; returns null when
// Fastspot no longer tracks the contract (e.g. old, long-settled swaps).
const FASTSPOT_API = 'https://api.go.fastspot.io/fast/v1';
const FASTSPOT_KEY = 'c20d43d0-8f60-4fca-a298-85e80f64d042'; // Nimiq's public publishable key
const swapAssetCache = new Map(); // htlc address -> Promise<string|null>

function prettySwapAsset(symbol) {
  return String(symbol || '').replace(/_MATIC$/i, '').toUpperCase(); // USDC_MATIC -> USDC
}

function lookupSwapAsset(htlcAddress) {
  if (!htlcAddress) return Promise.resolve(null);
  if (!swapAssetCache.has(htlcAddress)) {
    swapAssetCache.set(htlcAddress, (async () => {
      try {
        const res = await fetch(`${FASTSPOT_API}/contracts/NIM/${encodeURIComponent(htlcAddress)}`,
          { headers: { 'X-FAST-ApiKey': FASTSPOT_KEY } });
        if (!res.ok) return null; // 404 -> Fastspot no longer has this contract
        const data = await res.json();
        const symbols = [data?.info?.from?.[0]?.symbol, data?.info?.to?.[0]?.symbol].filter(Boolean);
        const counter = symbols.find(s => prettySwapAsset(s) !== 'NIM');
        return counter ? prettySwapAsset(counter) : null;
      } catch (e) {
        return null;
      }
    })());
  }
  return swapAssetCache.get(htlcAddress);
}

// Tax-treatment note for an HTLC (swap / Nimiq Pay) row, from the per-HTLC fund-flow analysis.
function htlcFlowNote(tx, kind, htlcStatus, htlcFunded) {
  if (kind === 'funding') {
    const s = htlcStatus.get(normAddr(tx.recipient));
    return s === 'recovered' ? 'recovered later — tax-neutral'
      : s === 'pending' ? 'still held in the contract — not taxed yet'
      : 'settled to the recipient — counts as a disposal';
  }
  return htlcFunded.has(normAddr(tx.sender))
    ? 'recovery of your own funds — tax-neutral'
    : 'received — counts as an acquisition';
}

// Human tooltip explaining the tax treatment of a staking row.
function stakingTitle(s) {
  switch (s.kind) {
    case 'reward':   return "Restaked staking reward — counted as income at the day's NIM price";
    case 'stake-in': return 'Stake added to the Nimiq staking contract — not a taxable disposal (you still own it)';
    case 'unstake':  return 'Stake returned from the Nimiq staking contract — return of your own NIM, not income';
    default:         return 'Nimiq staking operation (no change of ownership)';
  }
}

// Fetch an address's full NIM history the way the Nimiq Wallet does: one big paginated
// getTransactionsByAddress sweep, seeded with the transactions we already have
// (knownTransactionDetails) so the client skips re-deriving them and repeat look-ups only
// pull what's new. Termination is by "no new / no progress" (NOT page.length === limit), so
// it stays correct even if a history node caps the page size.
// Run async `fn` over items with bounded concurrency, so many addresses fetch in parallel
// without flooding the light client with unbounded simultaneous queries.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const HISTORY_PAGE = 100; // the Nimiq core's supported max per query (the wallet caps here too)
async function fetchAddressHistory(client, addr, onProgress, maxCount) {
  // What we already have, newest-first. We pass a bounded slice (<= page size) as
  // knownTransactions so the client skips re-deriving them — but never more than the cap,
  // which is what triggers "maximum number of transactions exceeds the one supported".
  let known = [];
  try {
    known = await getTransactionsForAddresses(new Set([addr.toLowerCase()]));
    known.sort((a, b) => (b.blockHeight || 0) - (a.blockHeight || 0));
  } catch (_) { /* no cache yet */ }

  const result = new Map();
  for (const t of known) result.set(t.transactionHash || t.hash, t);
  const knownHint = known.slice(0, HISTORY_PAGE); // <= cap

  let startAt;
  let prevOldest = null;
  let fetched = 0;
  while (true) {
    let page;
    try {
      page = await client.getTransactionsByAddress(
        addr,
        /* sinceBlockHeight   */ undefined,
        /* knownTransactions  */ knownHint,
        /* startAt            */ startAt,
        /* limit (per page)   */ HISTORY_PAGE,
        /* minPeers (default) */ undefined,
      );
    } catch (e) {
      console.warn('getTransactionsByAddress failed', e);
      break;
    }
    if (!page.length) break;

    let added = 0;
    let oldest = null;
    for (const tx of page) {
      const h = tx.transactionHash || tx.hash;
      if (!result.has(h)) added++;
      result.set(h, tx);
      oldest = h;
    }
    if (onProgress && added) onProgress(added);

    fetched += page.length;
    if (maxCount && fetched >= maxCount) break; // preview: stop once we have the newest maxCount

    if (oldest === prevOldest) break;   // node didn't advance — avoid looping
    prevOldest = oldest;
    startAt = oldest;
    if (added === 0) break;             // reached already-known txs
    if (page.length < HISTORY_PAGE) break; // partial page -> end of history
  }
  return Array.from(result.values());
}

exportTxBtn.addEventListener('click', async () => {
  status('Building transactions CSV…');
  const rows = await getAllTransactions();
  const headers = ['hash','sender','recipient','value','blockHeight','timestamp'];
  const csv = toCsv(rows, headers);
  downloadCsv('nimiq_transactions.csv', csv);
  status('Transactions CSV downloaded');
});

exportGainsBtn.addEventListener('click', async () => {
  status('Building gains CSV…');
  const rows = await getGainsSummary();
  const headers = ['year','proceeds','cost','gain','stakingIncome'];
  const csv = toCsv(rows, headers);
  downloadCsv('nimiq_yearly_gains.csv', csv);
  status('Gains CSV downloaded');
});

// FIFO worker
const fifoWorker = new Worker('./worker/fifoWorker.js?v=' + Date.now(), { type: 'module' });
fifoWorker.onmessage = (e) => {
  const { summary, error, htlc } = e.data;
  if (error) {
    console.warn('FIFO worker error', error);
    status('FIFO calc failed', 'error');
    return;
  }
  if (summary) {
    renderSummary(summary, htlc);
  }
};

function renderSummary(summaryArr, htlc) {
  summaryArr.sort((a, b) => a.year - b.year);
  let html = '<section class="panel">';
  html += '<h2 class="panel-title">Yearly gains (FIFO)</h2>';
  html += '<table class="gains-table"><thead><tr>';
  html += '<th>Year</th><th>Proceeds (USD)</th><th>Cost basis (USD)</th><th>Capital gain (USD)</th><th>Staking income (USD)</th>';
  html += '</tr></thead><tbody>';
  summaryArr.forEach(s => {
    const gainClass = s.gain >= 0 ? 'gain-pos' : 'gain-neg';
    const income = s.stakingIncome || 0;
    html += `<tr><td>${s.year}</td><td>${s.proceeds.toFixed(2)}</td>`
         +  `<td>${s.cost.toFixed(2)}</td><td class="${gainClass}">${s.gain.toFixed(2)}</td>`
         +  `<td>${income ? income.toFixed(2) : '—'}</td></tr>`;
  });
  html += '</tbody></table>';
  html += '<p class="card-note">FIFO method · capital gains from disposals; staking rewards counted as income at the day\'s price; stake/unstake transfers are tax-neutral · disposals without a prior tracked acquisition use a zero cost basis · not tax advice.</p>';
  if (htlc && (htlc.settled || htlc.pending || htlc.recovered)) {
    const parts = [];
    if (htlc.recovered) parts.push(`${htlc.recovered} recovered (neutral)`);
    if (htlc.pending) parts.push(`${htlc.pending} still pending (not taxed yet)`);
    if (htlc.settled) parts.push(`${htlc.settled} settled — counted as disposals`);
    html += `<p class="card-note">HTLC payments/swaps you funded: ${parts.join(' · ')}.</p>`;
  }
  if (activeLimit) {
    html += `<p class="card-note">⚠️ Preview limited to the newest ${activeLimit} transactions — gains are incomplete (missing older cost basis and possibly some HTLC recovery legs).</p>`;
  }
  html += '</section>';
  summaryEl.innerHTML = html;
  exportGainsBtn.disabled = false;
}

// Caches for efficiency
const blockTimestampCache = new Map(); // blockHeight -> timestamp (seconds)
const priceCache = new Map(); // dateStr dd-mm-yyyy -> price in USD

function formatDateStr(ts) {
  const d = new Date(ts * 1000); // seconds -> ms
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

async function getBlockTimestamp(client, height) {
  if (blockTimestampCache.has(height)) return blockTimestampCache.get(height);
  try {
    const block = await client.getBlockAt(height);
    const ts = block.timestamp || block.time || block._timestamp || 0;
    blockTimestampCache.set(height, ts);
    return ts;
  } catch (e) {
    console.warn('Failed fetching block', height, e);
    return 0;
  }
}

async function fetchNimPrice(dateStr) {
  if (priceCache.has(dateStr)) return priceCache.get(dateStr);
  // No API fallback — rely on dataset. If missing, we return undefined.
  return undefined;
}

// Fetch daily NIM/USD prices for [fromSec, toSec] from DefiLlama (free, keyless — and it
// sources its data from CoinGecko, so it's the same prices). CoinGecko's own keyless API now
// 401s on full history; DefiLlama doesn't need a key and sets CORS for browsers. It caps each
// response at 500 points, so we page the range in <=500-day chunks.
const PRICE_CHART_URL = 'https://coins.llama.fi/chart/coingecko:nimiq-2';
async function fetchNimDailyPrices(fromSec, toSec) {
  const DAY = 86400;
  const out = {}; // 'dd-mm-yyyy' -> priceUsd
  const end = (Number.isFinite(toSec) ? toSec : Math.floor(Date.now() / 1000)) + DAY;
  let cursor = (Number.isFinite(fromSec) ? fromSec : end - 500 * DAY) - 2 * DAY; // pad start
  for (let guard = 0; cursor < end && guard < 30; guard++) {
    const span = Math.min(500, Math.ceil((end - cursor) / DAY) + 1);
    const res = await fetch(`${PRICE_CHART_URL}?start=${Math.floor(cursor)}&span=${span}&period=1d`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const prices = json?.coins?.['coingecko:nimiq-2']?.prices || [];
    if (!prices.length) break;
    for (const { timestamp, price } of prices) out[formatDateStr(timestamp)] = price;
    const lastTs = prices[prices.length - 1].timestamp;
    if (lastTs <= cursor) break; // no progress
    cursor = lastTs + DAY;
  }
  return out;
}

async function fetchPricesDataset(fromSec, toSec) {
  try {
    const prices = await fetchNimDailyPrices(fromSec, toSec);
    for (const [date, price] of Object.entries(prices)) priceCache.set(date, price);
  } catch (e) {
    console.warn('DefiLlama price fetch failed', e);
  }
}

// Price for a timestamp, using the nearest on-or-before day (walks back up to 5 days) so a
// single missing daily point doesn't leave a transaction unpriced.
async function priceForTs(tsSec) {
  for (let back = 0; back <= 5; back++) {
    const ds = formatDateStr((tsSec || 0) - back * 86400);
    let p = priceCache.get(ds);
    if (p === undefined) { p = await getPrice(ds); if (p !== undefined) priceCache.set(ds, p); }
    if (p !== undefined) return p;
  }
  return undefined;
}

let clientPromise = null; // Promise<Client>

// Lazily and idempotently create the Nimiq client + start pico sync. Called eagerly on page
// load (so consensus is establishing before you enter an address) and again by lookup().
function getClient() {
  if (!clientPromise) {
    clientPromise = initClient();
    clientPromise.catch((err) => {
      console.error(err);
      status('Error: ' + (err.message || err), 'error');
      clientPromise = null; // reset so a later lookup retries the sync from scratch
    });
  }
  return clientPromise;
}

// Canonical Nimiq mainnet seed nodes (same list the official Nimiq Wallet uses).
const NIMIQ_SEED_NODES = [
  '/dns4/aurora.seed.nimiq.com/tcp/443/wss',
  '/dns4/catalyst.seed.nimiq.network/tcp/443/wss',
  '/dns4/cipher.seed.nimiq-network.com/tcp/443/wss',
  '/dns4/eclipse.seed.nimiq.cloud/tcp/443/wss',
  '/dns4/lumina.seed.nimiq.systems/tcp/443/wss',
  '/dns4/nebula.seed.nimiq.com/tcp/443/wss',
  '/dns4/nexus.seed.nimiq.network/tcp/443/wss',
  '/dns4/polaris.seed.nimiq-network.com/tcp/443/wss',
  '/dns4/photon.seed.nimiq.cloud/tcp/443/wss',
  '/dns4/pulsar.seed.nimiq.systems/tcp/443/wss',
  '/dns4/quasar.seed.nimiq.com/tcp/443/wss',
  '/dns4/solstice.seed.nimiq.network/tcp/443/wss',
  '/dns4/vortex.seed.nimiq.cloud/tcp/443/wss',
  '/dns4/zenith.seed.nimiq.systems/tcp/443/wss',
];

const CONSENSUS_TIMEOUT_MS = 30000;   // how long to wait for pico consensus before a reconnect+retry
const MAX_CONSENSUS_RETRIES = 10;     // retries (with backoff) — never falls back to another sync mode

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message || 'timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function initClient() {
  status('Loading Nimiq Web Client…');
  await init();

  // Match the official Nimiq Wallet: PICO sync on mainnet. Pico is the fast path;
  // the default ("light") header-syncs every epoch's validator keys, which is why
  // sync crawled. We use pico EXCLUSIVELY — on failure we retry pico, and never
  // fall back to light/full/history (the core has no auto-fallback either).
  const config = new ClientConfiguration();
  config.network('mainalbatross');
  config.seedNodes(NIMIQ_SEED_NODES);
  config.syncMode('pico');
  // onlySecureWsConnections stays at its default (true) for HTTPS hosting.

  const client = await Client.create(config.build());

  for (let attempt = 1; attempt <= MAX_CONSENSUS_RETRIES; attempt++) {
    status(attempt === 1
      ? 'Establishing consensus (pico sync)…'
      : `Pico sync retry ${attempt}/${MAX_CONSENSUS_RETRIES}…`);
    try {
      await withTimeout(client.waitForConsensusEstablished(), CONSENSUS_TIMEOUT_MS, 'Pico sync timed out');
      status('Connected — ready to query the blockchain.', 'success');
      return client;
    } catch (e) {
      console.warn(`[pico] consensus attempt ${attempt} failed:`, e);
      if (attempt === MAX_CONSENSUS_RETRIES) {
        throw new Error(`Pico sync failed after ${MAX_CONSENSUS_RETRIES} attempts (no fallback to other sync modes).`);
      }
      // Reconnect on the SAME pico client and retry — no sync-mode change.
      try { await client.connectNetwork(); } catch (re) { console.warn('[pico] reconnect failed:', re); }
      await sleep(500 * attempt); // increasing backoff, like the wallet's retry()
    }
  }
}

function status(text, kind) {
  statusEl.className = 'status' + (kind ? ' is-' + kind : '');
  statusEl.textContent = '';
  if (!text) return;
  const dot = document.createElement('span');
  dot.className = 'dot';
  statusEl.append(dot, text);
}

function formatLunaToNIM(luna) {
  // 1 NIM = 100_000 = 1e5 luna
  return (luna / 1e5).toLocaleString(undefined, { minimumFractionDigits: 5, maximumFractionDigits: 5 });
}

function clearTable() {
  tbody.innerHTML = '';
  txSection.hidden = true;
}

async function lookup() {
  const raw = addressInput.value.trim();
  const addresses = raw.split(/\n+/).map(a => a.trim()).filter(Boolean);

  if (!addresses.length) {
    status('Please enter at least one address.');
    return;
  }

  const addressSet = new Set(addresses.map(a => a.toLowerCase()));
  const ownNorm = new Set(addresses.map(normAddr)); // canonical (space/case-insensitive) set for staking
  const poolRaw = (poolInput?.value || '').trim();
  const poolAddrs = poolRaw.split(/\n+/).map(a => a.trim()).filter(Boolean);
  const poolNorm = new Set(poolAddrs.map(normAddr)); // declared pool payout addresses → reward income
  try { localStorage.setItem('nimiq-tax-pool-addresses', poolRaw); } catch (_) { /* storage may be blocked */ }
  const limitVal = parseInt((limitInput?.value || '').trim(), 10); // optional "newest N total" preview
  const limit = Number.isFinite(limitVal) && limitVal > 0 ? limitVal : 0;
  activeLimit = limit;
  try { localStorage.setItem('nimiq-tax-limit', limit ? String(limit) : ''); } catch (_) { /* storage may be blocked */ }

  button.disabled = true;
  clearTable();
  try {
    const client = await getClient();
    // The protocol coinbase address marks block-reward coins; read once (WASM is initialised now).
    const coinbaseAddr = (() => { try { return Policy.COINBASE_ADDRESS; } catch (_) { return null; } })();
    const coinbaseNorm = coinbaseAddr ? normAddr(coinbaseAddr) : null;
    status('Querying transactions…');

    const txMap = new Map(); // hash -> tx
    let fetchedTotal = 0;
    // Fetch every address concurrently (each address still paginates sequentially — the page
    // cursor is serial — but different addresses run in parallel, bounded to a few at a time).
    const histories = await mapLimit(addresses, 6, (addr) =>
      fetchAddressHistory(client, addr, (added) => {
        fetchedTotal += added;
        status(`Fetched ${fetchedTotal} transaction(s)…`);
      }, limit),
    );
    for (const history of histories) {
      for (const tx of history) txMap.set(tx.transactionHash || tx.hash, tx);
    }

    const txs = Array.from(txMap.values());

    if (!txs.length) {
      status('No transactions found for the provided address(es).');
      return;
    }

    // Sort newest to oldest by block height (fall back to 0 if undefined)
    txs.sort((a, b) => (b.blockHeight || 0) - (a.blockHeight || 0));
    if (limit && txs.length > limit) txs.splice(limit); // preview: keep only the newest N in total

    // Determine timestamps and collect unique dates
    status('Resolving block timestamps…');
    const dateSet = new Set();
    await Promise.all(txs.map(async (tx) => {
      let ts = tx.timestamp || tx.blockTimestamp;
      if (!ts && tx.blockHeight !== undefined) {
        ts = await getBlockTimestamp(client, tx.blockHeight);
      }
      tx.__timestamp = toSecs(ts || 0); // normalize ms (Albatross) -> seconds
      const dateStr = formatDateStr(tx.__timestamp);
      dateSet.add(dateStr);
    }));

    // Fetch prices (range-based to minimize API calls)
    status('Fetching historical price data…');
    const times = txs.map(tx => tx.__timestamp).filter(Boolean);
    const minSec = times.length ? Math.min(...times) : undefined;
    const maxSec = times.length ? Math.max(...times) : undefined;
    await fetchPricesDataset(minSec, maxSec);
    // Also fetch + persist prices in the worker (for the off-thread FIFO gains calc)
    priceWorker.postMessage({ fromSec: minSec, toSec: maxSec });

    // Ensure any missing dates are fetched individually (fallback)
    await Promise.all(Array.from(dateSet).map(fetchNimPrice));

    // --- HTLC fund-flow analysis (atomic swaps + Nimiq Pay) ---------------------------------------
    // Link each HTLC's funding to its resolution by contract address. For fundings that did NOT come
    // back to us, ask the chain whether the contract still holds the funds (pending) or was emptied
    // (settled to the recipient = a disposal). The client lives here; the FIFO worker consumes the
    // resulting per-funding `tx.__htlcStatus`. Also collects hashRoots for Pay-app detection.
    const htlcHashRoots = new Map();       // normAddr(HTLC) -> hashRoot
    const htlcFunded = new Map();          // normAddr(HTLC) -> HTLC address (funded by us)
    const htlcResolvedToOwned = new Set(); // normAddr(HTLC) where funds returned to an owned address
    for (const tx of txs) {
      const isFund = tx.recipientType === 'htlc' || tx.data?.type === 'htlc';
      const isResolve = tx.senderType === 'htlc';
      if (isFund && tx.recipient) {
        if (tx.data?.hashRoot != null) htlcHashRoots.set(normAddr(tx.recipient), tx.data.hashRoot);
        if (ownNorm.has(normAddr(tx.sender))) htlcFunded.set(normAddr(tx.recipient), tx.recipient);
      }
      if (isResolve && tx.sender && ownNorm.has(normAddr(tx.recipient))) htlcResolvedToOwned.add(normAddr(tx.sender));
    }
    const htlcStatus = new Map(); // normAddr(HTLC) -> 'recovered' | 'pending' | 'settled'
    for (const [h] of htlcFunded) if (htlcResolvedToOwned.has(h)) htlcStatus.set(h, 'recovered');
    const htlcToProbe = [...htlcFunded.entries()].filter(([h]) => !htlcResolvedToOwned.has(h));
    if (htlcToProbe.length) {
      status(`Checking ${htlcToProbe.length} payment contract(s)…`);
      await mapLimit(htlcToProbe, 6, async ([h, addr]) => {
        try {
          const acc = await client.getAccount(addr);
          htlcStatus.set(h, acc && acc.balance > 0 ? 'pending' : 'settled');
        } catch (_) {
          htlcStatus.set(h, 'settled'); // can't read the contract -> assume it resolved out of our wallet
        }
      });
    }
    for (const tx of txs) {
      if (tx.recipientType === 'htlc' || tx.data?.type === 'htlc') {
        tx.__htlcStatus = htlcStatus.get(normAddr(tx.recipient)) || 'settled';
      }
    }

    // Save fetched txs to DB (fire & forget)
    saveTransactions(txs).catch(console.error);
    exportTxBtn.disabled = false;

    // Populate table (peer-centric: one counterparty per row)
    for (const tx of txs) {
      const row = tbody.insertRow();
      const hash = tx.transactionHash || tx.hash || '';
      const sender = tx.sender || '';
      const recipient = tx.recipient || '';
      const isOut = !!sender && addressSet.has(sender.toLowerCase());
      const isIn = !!recipient && addressSet.has(recipient.toLowerCase());
      const internal = isOut && isIn;
      const incoming = isIn && !isOut;
      const outgoing = isOut && !isIn;
      if (internal) row.classList.add('internal');
      // Swap (HTLC) takes precedence; otherwise check staking-contract interactions.
      const swap = classifySwap(tx, htlcHashRoots);
      const staking = swap ? null : classifyStaking(tx, ownNorm);
      const coinbaseReward = (!swap && !staking) && isCoinbaseReward(tx, coinbaseNorm, ownNorm);
      const poolReward = (!swap && !staking && !coinbaseReward) && isPoolReward(tx, poolNorm, ownNorm);
      tx.__swap = swap || undefined;
      tx.__staking = staking || undefined;
      const isReward = staking?.kind === 'reward' || coinbaseReward || poolReward; // reward credited to us (income, +)
      const counterparty = outgoing ? recipient : sender; // the "other" party (HTLC / contract / validator)
      const signClass = (incoming || isReward) ? 'amt-in' : outgoing ? 'amt-out' : '';
      const sign = (incoming || isReward) ? '+' : outgoing ? '-' : '';

      // Date
      const dateCell = row.insertCell();
      dateCell.className = 'col-date';
      dateCell.textContent = tx.__timestamp ? formatDate(tx.__timestamp) : '—';

      // Counterparty — identicon (-> explorer) + short address (click to copy)
      row.insertCell().appendChild(counterpartyCell(counterparty));

      // Direction pill — atomic-swap HTLC legs get a distinct "Swap" pill, with the
      // counter-asset (BTC/USDC/USDT/…) resolved asynchronously via Fastspot.
      const dir = row.insertCell();
      if (swap && swap.payApp) {
        // Nimiq Pay app HTLC — a hash-locked recovery contract, NOT an atomic swap; skip Fastspot.
        row.classList.add('swap');
        const label = swap.kind === 'funding' ? 'Pay sent' : swap.kind === 'redeem' ? 'Pay received' : 'Pay recovery';
        const pill = document.createElement('span');
        pill.className = 'dir pay';
        pill.textContent = label;
        pill.title = 'Nimiq Pay app HTLC — not an atomic swap · ' + htlcFlowNote(tx, swap.kind, htlcStatus, htlcFunded);
        dir.appendChild(pill);
      } else if (swap) {
        row.classList.add('swap');
        const base = swap.kind === 'funding' ? 'Swap out' : swap.kind === 'redeem' ? 'Swap in' : 'Swap refund';
        const arrow = swap.kind === 'funding' ? '→' : swap.kind === 'redeem' ? '←' : '↺';
        const flow = htlcFlowNote(tx, swap.kind, htlcStatus, htlcFunded);
        const pill = document.createElement('span');
        pill.className = swap.kind === 'refund' ? 'dir refund' : 'dir swap';
        pill.textContent = base;
        pill.title = `Atomic-swap HTLC · ${flow} · resolving counter-asset via Fastspot…`;
        dir.appendChild(pill);
        const htlcAddr = swap.kind === 'funding' ? tx.recipient : tx.sender;
        lookupSwapAsset(htlcAddr).then(asset => {
          if (asset) {
            tx.__swap.counterAsset = asset;
            pill.textContent = `${base} ${arrow} ${asset}`;
            pill.title = `Atomic swap NIM ${arrow} ${asset} · ${flow}`;
          } else {
            pill.title = `Atomic-swap HTLC · ${flow} (counter-asset unavailable from Fastspot)`;
          }
        });
      } else if (staking) {
        row.classList.add('staking');
        const pill = document.createElement('span');
        pill.className = staking.kind === 'reward' ? 'dir reward'
          : staking.kind === 'unstake' ? 'dir unstake' : 'dir stake';
        pill.textContent = staking.label;
        pill.title = stakingTitle(staking);
        dir.appendChild(pill);
      } else if (coinbaseReward) {
        row.classList.add('staking');
        const pill = document.createElement('span');
        pill.className = 'dir reward';
        pill.textContent = 'Staking reward';
        pill.title = "Block reward from the protocol coinbase — counted as income at the day's NIM price";
        dir.appendChild(pill);
      } else if (poolReward) {
        row.classList.add('staking');
        const pill = document.createElement('span');
        pill.className = 'dir reward';
        pill.textContent = 'Pool reward';
        pill.title = "Incoming transfer from a pool payout address you configured — counted as staking income at the day's NIM price";
        dir.appendChild(pill);
      } else if (internal) dir.innerHTML = '<span class="dir internal">Internal</span>';
      else if (isOut) dir.innerHTML = '<span class="dir out">Out</span>';
      else if (isIn) dir.innerHTML = '<span class="dir in">In</span>';

      // Amount (NIM) — signed + colored by direction
      const amt = row.insertCell();
      amt.className = `col-num amount ${signClass}`.trim();
      amt.textContent = `${sign}${formatLunaToNIM(tx.value)}`;

      // Value (USD) — same sign/color; per-NIM price in the tooltip (nearest on-or-before day)
      const price = await priceForTs(tx.__timestamp);
      const usdCell = row.insertCell();
      usdCell.className = `col-num usd ${signClass}`.trim();
      if (price) {
        usdCell.textContent = `${sign}$${((tx.value / 1e5) * price).toFixed(2)}`;
        usdCell.title = `@ $${price.toFixed(4)} / NIM`;
      } else {
        usdCell.textContent = '—';
      }

      // Tx — block-explorer link (nimiq.watch)
      const txCell = row.insertCell();
      const a = document.createElement('a');
      a.className = 'tx-link';
      a.href = explorerTxUrl(hash);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = hash ? `${hash.slice(0, 8)}… ↗` : '↗';
      a.title = hash || '';
      txCell.appendChild(a);
    }

    txSection.hidden = false;
    status(`${txs.length} transaction(s) loaded${activeLimit ? ` · preview limited to newest ${activeLimit}` : ''} across ${addresses.length} address(es).`, 'success');

    // Trigger FIFO calculation (non-blocking)
    fifoWorker.postMessage({ addresses, coinbase: coinbaseAddr, pool: poolAddrs });
  } catch (err) {
    console.error(err);
    status('Error: ' + (err.message || err), 'error');
  } finally {
    button.disabled = false;
  }
}

button.addEventListener('click', lookup);
addressInput.addEventListener('keyup', (e) => {
  if (e.key === 'Enter') lookup();
});

// Start pico sync immediately on page load, so consensus is ready by the time you look up.
getClient(); 