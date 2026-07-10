// CSV export utilities ---------------------------------------------
function toCsv(rows, headers) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = v.toString();
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [];
  lines.push(headers.join(','));
  for (const r of rows) {
    lines.push(headers.map(h => escape(r[h])).join(','));
  }
  return lines.join('\n');
}

// --- Transaction exports (multi-format) ------------------------------------------------------
// Each lookup produces normalized rows shaped like:
//   { ts, hash, counterparty, nim, feeNim, usd, price, dir:'in'|'out'|'internal', type, taxCat }
// where taxCat is one of:
//   'income'  — staking / pool / coinbase reward  → taxable income
//   'in'      — acquisition (received from a third party / swap-in)
//   'out'     — disposal (sent to a third party / settled swap-out)
//   'neutral' — own-movement (internal transfer, stake/unstake, HTLC recovery): NOT a taxable
//               event and NOT the user's counterparty, so it is OMITTED from the tax-tool formats
//               (including it as a send/receive would invent a phantom disposal and misstate the
//               NIM balance — staked NIM is still yours). The "generic" full ledger keeps it.
// The reward/deposit/withdrawal convention (rather than forcing buy/sell) matches how established
// on-chain exporters like staketaxcsv feed these tools: the fair USD value travels with the row so
// the destination tool can treat a withdrawal as a disposal when you confirm it was one.

const NIM = 'NIM', USD = 'USD';

function pad2(n) { return String(n).padStart(2, '0'); }
// UTC "YYYY-MM-DD HH:MM:SS" (+ optional suffix, e.g. " UTC" for Koinly).
function dateUTC(tsSec, suffix = '') {
  const d = new Date((tsSec || 0) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} `
       + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}${suffix}`;
}
// luna-derived NIM has at most 5 decimals; render exactly, trimming trailing zeros for compactness.
function fmtNim(n) {
  let s = (n || 0).toFixed(5);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}
function usdStr(u) { return u != null ? u.toFixed(2) : ''; }

const TYPE_LABEL = {
  'send': 'Sent', 'receive': 'Received', 'internal': 'Internal transfer (own → own)',
  'staking-reward': 'Staking reward', 'pool-reward': 'Pool payout',
  'stake': 'Stake (to staking contract)', 'unstake': 'Unstake (from staking contract)',
  'swap-out': 'Atomic swap out', 'swap-in': 'Atomic swap in', 'swap-refund': 'Atomic swap refund',
  'pay-sent': 'Nimiq Pay sent', 'pay-received': 'Nimiq Pay received', 'pay-recovery': 'Nimiq Pay recovery',
};

// Human description: type + resolved swap counter-asset + counterparty.
function describe(r) {
  let d = TYPE_LABEL[r.type] || r.type || '';
  const asset = r.swapRef && r.swapRef.counterAsset; // resolved asynchronously after render
  if (asset && r.type === 'swap-out') d = `Atomic swap: NIM → ${asset}`;
  if (asset && r.type === 'swap-in')  d = `Atomic swap: ${asset} → NIM`;
  if (r.counterparty) d += ` · ${r.dir === 'in' ? 'from' : 'to'} ${r.counterparty}`;
  return d;
}
// For formats without a dedicated fiat-value column, fold the USD value into the description so
// "value in USD" is present in every export.
function descWithUsd(r) {
  const base = describe(r);
  return r.usd != null ? `${base} · $${r.usd.toFixed(2)} USD` : base;
}

const taxable = (records) => records.filter((r) => r.taxCat !== 'neutral');
const isIn = (r) => r.taxCat === 'income' || r.taxCat === 'in'; // lands in a "received" column
const feeIfSent = (r) => (r.taxCat === 'out' && r.feeNim ? fmtNim(r.feeNim) : ''); // only the sender pays

// Koinly custom CSV — direction via Sent/Received, fiat value in Net Worth, staking income label.
// Ref: https://help.koinly.io/en/articles/3662999-how-to-create-a-custom-csv-file-with-your-data
const KOINLY_HEADERS = [
  'Date', 'Sent Amount', 'Sent Currency', 'Received Amount', 'Received Currency',
  'Fee Amount', 'Fee Currency', 'Net Worth Amount', 'Net Worth Currency', 'Label', 'Description', 'TxHash',
];
function koinlyCsv(records) {
  return toCsv(taxable(records).map((r) => {
    const inn = isIn(r), fee = feeIfSent(r);
    return {
      'Date': dateUTC(r.ts, ' UTC'),
      'Sent Amount': inn ? '' : fmtNim(r.nim), 'Sent Currency': inn ? '' : NIM,
      'Received Amount': inn ? fmtNim(r.nim) : '', 'Received Currency': inn ? NIM : '',
      'Fee Amount': fee, 'Fee Currency': fee ? NIM : '',
      'Net Worth Amount': usdStr(r.usd), 'Net Worth Currency': r.usd != null ? USD : '',
      'Label': r.taxCat === 'income' ? 'staking' : '',
      'Description': describe(r), 'TxHash': r.hash || '',
    };
  }), KOINLY_HEADERS);
}

// CoinTracking custom CSV — Buy = received, Sell = sent; fiat in "…Value in Account Currency".
const CT_HEADERS = [
  'Type', 'Buy Amount', 'Buy Currency', 'Sell Amount', 'Sell Currency', 'Fee', 'Fee Currency',
  'Exchange', 'Trade-Group', 'Comment', 'Date', 'Tx-ID', 'Buy Value in Account Currency', 'Sell Value in Account Currency',
];
function cointrackingCsv(records) {
  return toCsv(taxable(records).map((r) => {
    const inn = isIn(r), fee = feeIfSent(r);
    return {
      'Type': r.taxCat === 'income' ? 'Staking' : inn ? 'Deposit' : 'Withdrawal',
      'Buy Amount': inn ? fmtNim(r.nim) : '', 'Buy Currency': inn ? NIM : '',
      'Sell Amount': inn ? '' : fmtNim(r.nim), 'Sell Currency': inn ? '' : NIM,
      'Fee': fee, 'Fee Currency': fee ? NIM : '',
      'Exchange': 'Nimiq', 'Trade-Group': '', 'Comment': describe(r),
      'Date': dateUTC(r.ts), 'Tx-ID': r.hash || '',
      'Buy Value in Account Currency': inn ? usdStr(r.usd) : '',
      'Sell Value in Account Currency': inn ? '' : usdStr(r.usd),
    };
  }), CT_HEADERS);
}

// CryptoTaxCalculator advanced CSV — single-asset movements as transfer-in/out (+ staking income).
const CALC_HEADERS = [
  'Timestamp (UTC)', 'Type', 'Base Currency (Optional)', 'Base Amount (Optional)',
  'Quote Currency (Optional)', 'Quote Amount (Optional)', 'Fee Currency (Optional)', 'Fee Amount (Optional)',
  'From (Optional)', 'To (Optional)', 'ID (Optional)', 'Description (Optional)',
];
function calculatorCsv(records) {
  return toCsv(taxable(records).map((r) => {
    const inn = isIn(r), fee = feeIfSent(r);
    return {
      'Timestamp (UTC)': dateUTC(r.ts),
      'Type': r.taxCat === 'income' ? 'staking' : inn ? 'transfer-in' : 'transfer-out',
      'Base Currency (Optional)': NIM, 'Base Amount (Optional)': fmtNim(r.nim),
      'Quote Currency (Optional)': '', 'Quote Amount (Optional)': '',
      'Fee Currency (Optional)': fee ? NIM : '', 'Fee Amount (Optional)': fee,
      'From (Optional)': inn ? (r.counterparty || '') : '', 'To (Optional)': inn ? '' : (r.counterparty || ''),
      'ID (Optional)': r.hash || '', 'Description (Optional)': descWithUsd(r),
    };
  }), CALC_HEADERS);
}

// CoinLedger CSV — Asset Sent / Asset Received pair + a Type column.
const CL_HEADERS = [
  'Date (UTC)', 'Platform (Optional)', 'Asset Sent', 'Amount Sent', 'Asset Received', 'Amount Received',
  'Fee Currency (Optional)', 'Fee Amount (Optional)', 'Type', 'Description (Optional)', 'TxHash (Optional)',
];
function coinledgerCsv(records) {
  return toCsv(taxable(records).map((r) => {
    const inn = isIn(r), fee = feeIfSent(r);
    return {
      'Date (UTC)': dateUTC(r.ts), 'Platform (Optional)': 'Nimiq',
      'Asset Sent': inn ? '' : NIM, 'Amount Sent': inn ? '' : fmtNim(r.nim),
      'Asset Received': inn ? NIM : '', 'Amount Received': inn ? fmtNim(r.nim) : '',
      'Fee Currency (Optional)': fee ? NIM : '', 'Fee Amount (Optional)': fee,
      'Type': r.taxCat === 'income' ? 'Staking' : inn ? 'Deposit' : 'Withdrawal',
      'Description (Optional)': descWithUsd(r), 'TxHash (Optional)': r.hash || '',
    };
  }), CL_HEADERS);
}

// Generic full ledger — EVERY transaction (including tax-neutral ones), self-describing columns,
// importable into any tool via its column-mapping step.
const GENERIC_HEADERS = [
  'Date (UTC)', 'Direction', 'Type', 'Tax Category', 'Counterparty',
  'Amount NIM', 'Value USD', 'Price USD/NIM', 'Fee NIM', 'Tx Hash',
];
const TAXCAT_LABEL = { income: 'income', in: 'acquisition', out: 'disposal', neutral: 'neutral' };
function genericCsv(records) {
  return toCsv(records.map((r) => ({
    'Date (UTC)': dateUTC(r.ts), 'Direction': r.dir, 'Type': r.type,
    'Tax Category': TAXCAT_LABEL[r.taxCat] || r.taxCat, 'Counterparty': r.counterparty || '',
    'Amount NIM': fmtNim(r.nim), 'Value USD': usdStr(r.usd),
    'Price USD/NIM': r.price != null ? r.price.toFixed(6) : '',
    'Fee NIM': r.feeNim ? fmtNim(r.feeNim) : '', 'Tx Hash': r.hash || '',
  })), GENERIC_HEADERS);
}

const EXPORTERS = {
  koinly:              { name: 'Koinly',              file: 'nimiq_transactions_koinly.csv',              csv: koinlyCsv },
  cointracking:        { name: 'CoinTracking',        file: 'nimiq_transactions_cointracking.csv',        csv: cointrackingCsv },
  cryptotaxcalculator: { name: 'CryptoTaxCalculator', file: 'nimiq_transactions_cryptotaxcalculator.csv', csv: calculatorCsv },
  coinledger:          { name: 'CoinLedger',          file: 'nimiq_transactions_coinledger.csv',          csv: coinledgerCsv },
  generic:             { name: 'Generic full ledger', file: 'nimiq_transactions_full.csv',                csv: genericCsv },
};

// Build the transactions CSV for the chosen tool. Returns { name, filename, csv }.
function buildTransactionsCsv(format, records) {
  const e = EXPORTERS[format] || EXPORTERS.koinly;
  return { name: e.name, filename: e.file, csv: e.csv(records) };
}

// Per-disposal realised capital gains (FIFO), one row per taxable disposal.
// rows: { txHash, date, nim, proceeds, costBasis, gain, year }
const REALIZED_HEADERS = ['Date', 'Tx Hash', 'Amount NIM', 'Proceeds USD', 'Cost Basis USD', 'Capital Gain USD', 'Year'];
function toRealizedCsv(rows) {
  const mapped = rows.slice()
    .sort((a, b) => (a.year - b.year) || String(a.date).localeCompare(String(b.date)))
    .map((r) => ({
      'Date': r.date, 'Tx Hash': r.txHash || '', 'Amount NIM': fmtNim(r.nim),
      'Proceeds USD': (r.proceeds || 0).toFixed(2), 'Cost Basis USD': (r.costBasis || 0).toFixed(2),
      'Capital Gain USD': (r.gain || 0).toFixed(2), 'Year': r.year,
    }));
  return toCsv(mapped, REALIZED_HEADERS);
}

function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export { toCsv, downloadCsv, buildTransactionsCsv, toRealizedCsv };