// Nimiq Albatross staking — classify staking transactions and (restaked) staking
// rewards purely from on-chain plain-transaction details. No external indexer.
//
// All staking activity flows through a single Staking Contract. We read the same fields the
// official Nimiq Wallet does (StakingUtils.ts):
//   • recipient === STAKING_CONTRACT  -> an "incoming" staking op; the operation is in
//     tx.data.type (e.g. 'add-stake', 'create-staker'). For raw data it is the first byte.
//   • sender === STAKING_CONTRACT     -> an "outgoing" op (funds leaving the contract back to a
//     staker/validator); the operation is in tx.senderData.type (e.g. 'remove-stake').
//
// Rewards: Albatross pays staking rewards to the validator's reward address, not to individual
// stakers, so a delegator has no personal "reward" transaction — EXCEPT when the validator/pool
// auto-compounds ("restakes") the reward back into the staker's stake. That restake is an
// 'add-stake' transaction sent BY the validator (sender not owned by the user) that credits the
// user's stake (tx.data.staker is one of the user's addresses). That restake is the only staking
// reward observable on-chain through the light client, and we treat it as income at fair value on
// the day it is received. (Direct payouts to a wallet, and raw validator block-reward inherents,
// are not distinguishable / not exposed by the light client — see README.)

export const STAKING_CONTRACT_ADDRESS = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001';

// Canonical address compare: ignore spacing/case (plain-tx addresses are space-grouped).
export function normAddr(a) { return String(a || '').replace(/\s+/g, '').toUpperCase(); }

const STAKING_NORM = normAddr(STAKING_CONTRACT_ADDRESS);
export function isStakingContract(addr) { return normAddr(addr) === STAKING_NORM; }

// Block rewards (validator/staking reward inherents) are surfaced by the history as transactions
// whose SENDER is the protocol coinbase address — Policy.COINBASE_ADDRESS, "the address we use to
// denote that some coins originated from a coinbase event." Read that address once from
// Policy.COINBASE_ADDRESS, pass it here normalized via normAddr(). Counts only when the reward is
// credited to the user: paid to an owned address, or restaked to the contract crediting our staker.
export function isCoinbaseReward(tx, coinbaseNorm, ownSet) {
  if (!coinbaseNorm || normAddr(tx?.sender) !== coinbaseNorm) return false;
  const recipientOwned = ownSet.has(normAddr(tx?.recipient));
  const stakerOwned = !!tx?.data && 'staker' in tx.data && ownSet.has(normAddr(tx.data.staker));
  return recipientOwned || stakerOwned;
}

// User-declared pool payout addresses. A staking pool that pays rewards as plain transfers (an
// off-chain payout) leaves no protocol marker, so we can only treat it as income if the user tells
// us which address the pool pays from. Any incoming transfer (to an owned address) whose sender is
// one of those declared pool addresses is counted as a staking reward. poolSet/ownSet are Sets of
// normAddr() values.
export function isPoolReward(tx, poolSet, ownSet) {
  if (!poolSet || poolSet.size === 0) return false;
  if (!poolSet.has(normAddr(tx?.sender))) return false;
  return ownSet.has(normAddr(tx?.recipient));
}

// Incoming staking-op codes (first byte of raw recipient data) -> canonical type string.
const INCOMING_OP_BY_BYTE = {
  '00': 'create-validator', '01': 'update-validator', '02': 'deactivate-validator',
  '03': 'reactivate-validator', '04': 'retire-validator', '05': 'create-staker',
  '06': 'add-stake', '07': 'update-staker', '08': 'set-active-stake', '09': 'retire-stake',
};

const LABELS = {
  'create-validator': 'Create validator', 'update-validator': 'Update validator',
  'deactivate-validator': 'Deactivate validator', 'reactivate-validator': 'Reactivate validator',
  'retire-validator': 'Retire validator', 'delete-validator': 'Delete validator',
  'create-staker': 'Start staking', 'add-stake': 'Add stake', 'update-staker': 'Switch validator',
  'set-active-stake': 'Set active stake', 'retire-stake': 'Retire stake', 'remove-stake': 'Unstake',
};

function incomingOp(tx) {
  const t = tx?.data?.type;
  if (t && t !== 'raw') return t;
  const raw = (t === 'raw' && tx?.data?.raw) ? tx.data.raw : '';
  return INCOMING_OP_BY_BYTE[raw.substring(0, 2)] || null;
}

// Classify a transaction's staking role relative to the user's own addresses (a Set of
// normAddr() values). Returns null when the transaction does not touch the staking contract.
//
// kind:
//   'reward'        – a restaked reward credited to the user (taxable income at receipt)
//   'stake-in'      – user moves their own NIM into stake / validator deposit (tax-neutral; still owned)
//   'unstake'       – user's NIM returns from the contract (tax-neutral; principal/already-taxed)
//   'staking-admin' – validator/staker config op, no ownership change (tax-neutral)
export function classifyStaking(tx, ownSet) {
  const toContract = isStakingContract(tx?.recipient);
  const fromContract = isStakingContract(tx?.sender);
  if (!toContract && !fromContract) return null;

  if (toContract) {
    const op = incomingOp(tx);
    if (op === 'add-stake') {
      const senderOwned = ownSet.has(normAddr(tx.sender));
      const stakerOwned = !!tx.data && 'staker' in tx.data && ownSet.has(normAddr(tx.data.staker));
      // Someone else (the validator/pool) adding to OUR stake = a restaked reward.
      if (!senderOwned && stakerOwned) return { op, kind: 'reward', label: 'Staking reward' };
      return { op, kind: 'stake-in', label: 'Add stake' };
    }
    if (op === 'create-staker') return { op, kind: 'stake-in', label: LABELS[op] };
    if (op === 'create-validator') return { op, kind: 'stake-in', label: LABELS[op] }; // locks the deposit
    if (op && op.endsWith('-validator')) return { op, kind: 'staking-admin', label: LABELS[op] || 'Validator' };
    // update-staker / set-active-stake / retire-stake — staking-state changes, no ownership change.
    return { op: op || 'staking', kind: 'staking-admin', label: LABELS[op] || 'Staking' };
  }

  // fromContract: funds leaving the staking contract back to a staker/validator.
  const op = tx?.senderData?.type || 'remove-stake';
  return { op, kind: 'unstake', label: LABELS[op] || 'Unstake' };
}
