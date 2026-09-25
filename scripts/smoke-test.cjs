// Headless end-to-end check that the site works with the vendored Nimiq web client: serves the repo,
// opens the page in Chromium, waits for the light client to reach consensus on mainnet, then looks up
// the newest transactions of the staking contract (a public protocol address) and expects table rows.
// Run by .github/workflows/update-nimiq-core.yml before a client update is committed.
//
//   NODE_PATH=<dir containing playwright> node scripts/smoke-test.cjs
// CommonJS on purpose, so NODE_PATH can point at a throwaway Playwright install.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ADDRESS = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001'; // staking contract
const TIMEOUT_MS = 4 * 60 * 1000;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff',
};

const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
});

// Resolves with the page-side check's truthy result ('ok: …' / 'fail: …').
async function waitFor(page, check) {
  return (await page.waitForFunction(check, null, { timeout: TIMEOUT_MS, polling: 250 })).jsonValue();
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);

    const synced = await waitFor(page, () => {
      const s = document.getElementById('status').textContent;
      return /Connected/.test(s) ? 'ok: ' + s : /Error/.test(s) ? 'fail: ' + s : false;
    });
    console.log('consensus', synced);
    if (!synced.startsWith('ok')) throw new Error(synced);

    await page.fill('#address-input', ADDRESS);
    await page.fill('#limit-input', '3');
    await page.click('#lookup-btn');
    const looked = await waitFor(page, () => {
      const s = document.getElementById('status').textContent;
      if (/Error|No transactions/.test(s)) return 'fail: ' + s;
      const rows = document.querySelectorAll('#results tbody tr').length;
      return !document.getElementById('tx-section').hidden && rows > 0 ? `ok: ${rows} rows · ${s}` : false;
    });
    console.log('lookup', looked);
    if (!looked.startsWith('ok')) throw new Error(looked);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error('Smoke test failed:', e.message);
  process.exit(1);
});
