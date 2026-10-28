'use strict';

/**
 * Due reminders: every 60 s, one Network notification each. The row is claimed with an atomic
 * `UPDATE … SET sent_at = now() WHERE … AND sent_at IS NULL RETURNING`, so two processes never send twice. A send
 * failure puts the claim back for the next tick; a cancelled or done event's reminder never sends.
 */
function createReminders({ config, s, events, notifier, log = console, intervalMs = 60_000 }) {
    let timer = null;
    const stats = { sent: 0, failed: 0, skipped: 0, last_error: null, last_run: null };

    async function runOnce({ now = s.now() } = {}) {
        const due = await events.dueReminders(now);
        let sent = 0;
        let failed = 0;
        let skipped = 0;
        for (const row of due) {
            const claimed = await events.claimReminder(row.subject, row.event_id, now);
            if (!claimed) { skipped++; continue; }
            try {
                const out = await notifier.sendReminder({ subject: row.subject, event: claimed.event, now });
                if (out && out.ok) { sent++; stats.sent++; } else { skipped++; stats.skipped++; }
            } catch (err) {
                failed++;
                stats.failed++;
                stats.last_error = String((err && err.message) || err).slice(0, 300);
                log.warn(`[OpenVibe.Today] reminder ${row.event_id} not sent: ${stats.last_error}`);
                await events.releaseReminder(row.subject, row.event_id).catch(() => {});
            }
        }
        stats.last_run = new Date(now).toISOString();
        return { due: due.length, sent, failed, skipped };
    }

    function start() {
        if (timer || config.drill) return false;
        timer = setInterval(() => { runOnce().catch((err) => log.warn('[OpenVibe.Today] reminder tick failed:', err.message)); }, intervalMs);
        if (timer.unref) timer.unref();
        return true;
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { runOnce, start, stop, stats: () => ({ ...stats }) };
}

module.exports = { createReminders };
