// Web Worker: fetches daily NIM/USD prices for a date range from DefiLlama (free, keyless,
// CoinGecko-sourced). DefiLlama caps each response at 500 points, so we page the requested
// range in <=500-day chunks. Result is posted back as a { 'dd-mm-yyyy' -> priceUsd } map.
const PRICE_CHART_URL = 'https://coins.llama.fi/chart/coingecko:nimiq-2';

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
}

self.addEventListener('message', async (e) => {
  const { fromSec, toSec } = e.data || {};
  try {
    const DAY = 86400;
    const prices = {};
    const end = (Number.isFinite(toSec) ? toSec : Math.floor(Date.now() / 1000)) + DAY;
    let cursor = (Number.isFinite(fromSec) ? fromSec : end - 500 * DAY) - 2 * DAY;
    for (let guard = 0; cursor < end && guard < 30; guard++) {
      const span = Math.min(500, Math.ceil((end - cursor) / DAY) + 1);
      const res = await fetch(`${PRICE_CHART_URL}?start=${Math.floor(cursor)}&span=${span}&period=1d`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const pts = json?.coins?.['coingecko:nimiq-2']?.prices || [];
      if (!pts.length) break;
      for (const { timestamp, price } of pts) prices[fmtDate(timestamp)] = price;
      const lastTs = pts[pts.length - 1].timestamp;
      if (lastTs <= cursor) break;
      cursor = lastTs + DAY;
    }
    self.postMessage({ prices });
  } catch (err) {
    self.postMessage({ error: err.message || err.toString() });
  }
});
