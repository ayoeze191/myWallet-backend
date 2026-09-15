const { runDueContributions } = require('./ajo');

const TICK_MS = Number(process.env.AJO_TICK_MS || 60_000);

function startAjoScheduler() {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const results = await runDueContributions();
      const worked = results.filter((r) => r.processed);
      for (const r of worked) {
        if (r.roundsPaid?.length) {
          console.log(`[ajo] ${r.id} paid out round(s) ${r.roundsPaid.join(', ')}`);
        }
        if (r.completed) console.log(`[ajo] ${r.id} completed its final round`);
      }
    } catch (err) {
      console.error('[ajo] scheduler sweep failed:', err);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  tick();
  return timer;
}

module.exports = { startAjoScheduler };
