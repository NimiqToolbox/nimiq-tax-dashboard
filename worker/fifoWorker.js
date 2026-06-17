import { getAllTransactions, getPrice, saveRealized, saveGainsSummary } from '../storage.js';

function formatDateStr(ts) {
  const d = new Date(ts * 1000);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

self.onmessage = async (e) => {
  const { addresses } = e.data;
  if (!addresses?.length) {
    self.postMessage({ error: 'No addresses' });
    return;
  }
  const addressSet = new Set(addresses.map(a => a.toLowerCase()));
  try {
    const txs = await getAllTransactions();
    // sort oldest -> newest by timestamp (we stored __timestamp)
    txs.sort((a, b) => (a.__timestamp || 0) - (b.__timestamp || 0));

    // Atomic-swap HTLC legs. A funding+refund pair is a round-trip of the user's own NIM
    // through a FAILED swap, so we treat both legs as tax-neutral (no disposal, no
    // acquisition). Successful swaps keep their normal treatment: funding = disposal,
    // redeem-in = acquisition.
    const isFunding = (tx) => tx.recipientType === 'htlc' || tx.data?.type === 'htlc';
    const isRefund = (tx) => tx.senderType === 'htlc'
      && (tx.proof?.type === 'timeout-resolve' || tx.proof?.type === 'early-resolve');
    const refundedHtlcs = new Set();
    for (const tx of txs) {
      if (isRefund(tx)) refundedHtlcs.add((tx.sender || '').toLowerCase()); // sender = HTLC address
    }

    const lots = [];// queue of { remaining_luna, cost_usd_per_nim }
    const realizedRows = [];

    for (const tx of txs) {
      const senderIn = addressSet.has((tx.sender || '').toLowerCase());
      const recipientIn = addressSet.has((tx.recipient || '').toLowerCase());
      const internal = senderIn && recipientIn;
      if (internal) continue; // ignore

      // Tax-neutral: drop refund legs and the fundings of refunded (failed) swaps.
      if (isRefund(tx)) continue;
      if (isFunding(tx) && refundedHtlcs.has((tx.recipient || '').toLowerCase())) continue;

      const nimValue = tx.value / 1e5; // NIM
      const dateStr = formatDateStr(tx.__timestamp || 0); // the tx's own date (for realized rows)
      // Price for the tx date, falling back to the nearest on-or-before day (up to 5 days)
      // so a single missing daily point doesn't drop the tx from the gains calc.
      let price;
      for (let back = 0; back <= 5 && price === undefined; back++) {
        price = await getPrice(formatDateStr((tx.__timestamp || 0) - back * 86400));
      }
      if (price === undefined) continue; // still no price within 5 days -> skip

      if (recipientIn) {
        // Incoming purchase
        lots.push({ remaining: nimValue, costPer: price });
      } else if (senderIn) {
        // Outgoing disposal -> FIFO match
        let remainingSell = nimValue;
        let costBasis = 0;
        while (remainingSell > 0 && lots.length) {
          const lot = lots[0];
          const take = Math.min(remainingSell, lot.remaining);
          costBasis += take * lot.costPer;
          lot.remaining -= take;
          remainingSell -= take;
          if (lot.remaining <= 1e-8) lots.shift(); // exhausted
        }
        const proceeds = nimValue * price;
        const gain = proceeds - costBasis;
        realizedRows.push({
          txHash: tx.hash || tx.transactionHash,
          date: dateStr,
          nim: nimValue,
          proceeds,
          costBasis,
          gain,
          year: dateStr.split('-')[2]
        });
      }
    }

    // Aggregate yearly
    const summary = {};
    for (const row of realizedRows) {
      const y = row.year;
      if (!summary[y]) summary[y] = { year: y, proceeds: 0, cost: 0, gain: 0 };
      summary[y].proceeds += row.proceeds;
      summary[y].cost += row.costBasis;
      summary[y].gain += row.gain;
    }
    const summaryArr = Object.values(summary);

    // Save
    await saveRealized(realizedRows);
    await saveGainsSummary(summaryArr);

    self.postMessage({ ok: true, summary: summaryArr });
  } catch (err) {
    self.postMessage({ error: err.message || err.toString() });
  }
}; 