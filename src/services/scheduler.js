const { runDueContributions } = require('./ajo');

// Ajo rounds are due on a date, not a clock time, so a sweep every minute is
// plenty — it exists to notice "today is the due date", not to be real-time.
const TICK_MS = Number(process.env.AJO_TICK_MS || 60_000);

/**
 * Periodically start contributions whose date has arrived, collect due
 * rounds, and pay out completed ones.
 *
 * The `running` guard keeps a slow sweep from overlapping the next one. The
 * engine is safe against that anyway (SKIP LOCKED plus deterministic
 * idempotency keys), this just avoids pointless work.
 */
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
