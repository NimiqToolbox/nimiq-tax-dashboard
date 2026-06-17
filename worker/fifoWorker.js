import { getAllTransactions, getPrice, saveRealized, saveGainsSummary } from '../storage.js';
import { classifyStaking, normAddr, isCoinbaseReward } from '../staking.js';

function formatDateStr(ts) {
  const d = new Date(ts * 1000);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

self.onmessage = async (e) => {
  const { addresses, coinbase } = e.data;
  if (!addresses?.length) {
    self.postMessage({ error: 'No addresses' });
    return;
  }
  const addressSet = new Set(addresses.map(a => a.toLowerCase()));
  const ownNorm = new Set(addresses.map(normAddr)); // staking classification (space/case-insensitive)
  const coinbaseNorm = coinbase ? normAddr(coinbase) : null; // Policy.COINBASE_ADDRESS, for block rewards
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
    const stakingIncomeByYear = {}; // year -> USD of restaked staking-reward income

    for (const tx of txs) {
      const senderIn = addressSet.has((tx.sender || '').toLowerCase());
      const recipientIn = addressSet.has((tx.recipient || '').toLowerCase());
      const internal = senderIn && recipientIn;
      if (internal) continue; // ignore

      // Tax-neutral: drop refund legs and the fundings of refunded (failed) swaps.
      if (isRefund(tx)) continue;
      if (isFunding(tx) && refundedHtlcs.has((tx.recipient || '').toLowerCase())) continue;

      // Staking. Tax treatment differs from a plain transfer, so classify before the
      // acquisition/disposal logic. stake-in / unstake / admin are tax-neutral: the user keeps
      // ownership (NIM just moves into/out of the staking contract), so the FIFO lot pool is left
      // untouched — skipping them also prevents an "add stake" from being mistaken for a sale.
      // A restaked reward (kind === 'reward') is handled below (income + new cost-basis lot).
      const staking = classifyStaking(tx, ownNorm);
      if (staking && staking.kind !== 'reward') continue;

      const nimValue = tx.value / 1e5; // NIM
      const dateStr = formatDateStr(tx.__timestamp || 0); // the tx's own date (for realized rows)
      // Price for the tx date, falling back to the nearest on-or-before day (up to 5 days)
      // so a single missing daily point doesn't drop the tx from the gains calc.
      let price;
      for (let back = 0; back <= 5 && price === undefined; back++) {
        price = await getPrice(formatDateStr((tx.__timestamp || 0) - back * 86400));
      }
      if (price === undefined) continue; // still no price within 5 days -> skip

      // Staking rewards are ordinary income at the day's fair value, and establish a cost-basis lot
      // so a later disposal is taxed only on the change since receipt. Two on-chain forms:
      //  • restaked reward — an add-stake the validator/pool sends crediting our stake (kind 'reward');
      //  • coinbase reward — a block reward whose sender is the protocol coinbase address.
      if ((staking && staking.kind === 'reward') || isCoinbaseReward(tx, coinbaseNorm, ownNorm)) {
        lots.push({ remaining: nimValue, costPer: price });
        const y = dateStr.split('-')[2];
        stakingIncomeByYear[y] = (stakingIncomeByYear[y] || 0) + nimValue * price;
        continue;
      }

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
    const ensureYear = (y) => (summary[y] ||= { year: y, proceeds: 0, cost: 0, gain: 0, stakingIncome: 0 });
    for (const row of realizedRows) {
      const s = ensureYear(row.year);
      s.proceeds += row.proceeds;
      s.cost += row.costBasis;
      s.gain += row.gain;
    }
    // Staking-reward income is ordinary income, tracked separately from capital gains.
    for (const [y, usd] of Object.entries(stakingIncomeByYear)) {
      ensureYear(y).stakingIncome += usd;
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