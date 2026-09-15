const { runDueContributions } = require('./ajo');
const { reconcilePendingFunding } = require('./funding');
const { reconcilePendingWithdrawals } = require('./withdrawals');

const TICK_MS = Number(process.env.AJO_TICK_MS || 60_000);
const PAYSTACK_TICK_MS = 60_000;

// Runs fn now and then every `ms`, skipping a tick while the last run is
// still going. Each job has its own guard, so a slow Paystack can't stall
// ajo collections.
function every(ms, label, fn) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[${label}] sweep failed:`, err);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, ms);
  timer.unref();
  tick();
  return timer;
}

async function ajoSweep() {
  const results = await runDueContributions();
  const worked = results.filter((r) => r.processed);
  for (const r of worked) {
    if (r.roundsPaid?.length) {
      console.log(`[ajo] ${r.id} paid out round(s) ${r.roundsPaid.join(', ')}`);
    }
    if (r.completed) console.log(`[ajo] ${r.id} completed its final round`);
  }
}

function startSchedulers() {
  every(TICK_MS, 'ajo', ajoSweep);
  every(PAYSTACK_TICK_MS, 'funding', reconcilePendingFunding);
  every(PAYSTACK_TICK_MS, 'withdrawal', reconcilePendingWithdrawals);
}

module.exports = { startSchedulers };
