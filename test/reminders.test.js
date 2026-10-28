'use strict';
/**
 * Due reminders: exactly one Network notification each, two concurrent runs never double-send, and a reminder on a
 * cancelled event never sends. The row is claimed with UPDATE … WHERE sent_at IS NULL RETURNING before the push.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const at = new Date(Date.now() + 10 * 60_000).toISOString();

    async function eventAndReminder({ title = 'Soon', kind = 'stream', user = alice, minutes = 10 } = {}) {
        const e = await t.get('/api/v1/events', { as: user, json: { kind, title, starts_at: at, tz: 'Europe/Berlin' } });
        assert.strictEqual(e.status, 201, e.text);
        const r = await t.get(`/api/v1/events/${e.json().id}/remind`, { as: bob, json: { minutes_before: minutes } });
        assert.strictEqual(r.status, 200, r.text);
        await t.ctx.s.db.exec("UPDATE today_reminders SET remind_at = now() - interval '1 minute' WHERE event_id = $1", [e.json().id]);
        return e.json();
    }

    await check('a due reminder sends one notification with the Today fields', async () => {
        const e = await eventAndReminder({ title: 'Morning show' });
        const r = await t.ctx.reminders.runOnce();
        assert.deepStrictEqual({ due: r.due, sent: r.sent, failed: r.failed }, { due: 1, sent: 1, failed: 0 });
        assert.strictEqual(t.network.notifications.length, 1);
        const n = t.network.notifications[0];
        assert.strictEqual(n.type, 'TODAY_REMINDER');
        assert.strictEqual(n.category, 'stream');
        assert.strictEqual(n.service, 'today');
        assert.match(n.title, /^Morning show starts in \d+ min$/);
        assert.strictEqual(n.url, `https://openvibe.today/e/${e.id}`);
        assert.strictEqual(n.user_id, bob.id);
        assert.ok(await t.ctx.s.db.value('SELECT sent_at IS NOT NULL FROM today_reminders WHERE event_id = $1 AND subject = $2', [e.id, bob.subject]));
    });

    await check('two concurrent runs never double-send', async () => {
        const before = t.network.notifications.length;
        const e = await eventAndReminder({ title: 'Concurrent' });
        const [a, b] = await Promise.all([t.ctx.reminders.runOnce(), t.ctx.reminders.runOnce()]);
        assert.strictEqual(a.sent + b.sent, 1, `one send, got ${a.sent} + ${b.sent}`);
        assert.strictEqual(t.network.notifications.length, before + 1);
        assert.strictEqual(t.network.notifications.filter((x) => x.title.startsWith('Concurrent')).length, 1);
        assert.strictEqual(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_reminders WHERE event_id = $1 AND sent_at IS NOT NULL', [e.id]), 1);
    });

    await check('an event that is live sends "is live now"', async () => {
        const e = await eventAndReminder({ title: 'Live now', kind: 'event' });
        await t.ctx.s.db.exec("UPDATE today_events SET status = 'live' WHERE id = $1", [e.id]);
        await t.ctx.reminders.runOnce();
        const n = t.network.notifications.find((x) => x.title.startsWith('Live now'));
        assert.ok(n);
        assert.strictEqual(n.title, 'Live now is live now');
        assert.strictEqual(n.category, 'system');
    });

    await check('a cancelled event\'s reminder never sends, even if a row survives a race', async () => {
        const before = t.network.notifications.length;
        const e = await eventAndReminder({ title: 'Cancelled' });
        await t.get(`/api/v1/events/${e.id}`, { as: alice, method: 'DELETE' });
        // A reminder row that raced the cancellation: insert it by hand to prove the claim checks the event status.
        await t.ctx.s.db.exec(
            `INSERT INTO today_reminders (subject, event_id, remind_at, created_at) VALUES ($1, $2, now() - interval '1 minute', now())
             ON CONFLICT (subject, event_id) DO UPDATE SET remind_at = EXCLUDED.remind_at, sent_at = NULL`,
            [bob.subject, e.id],
        );
        const r = await t.ctx.reminders.runOnce();
        assert.strictEqual(r.due, 0, 'a cancelled event is not due');
        assert.strictEqual(t.network.notifications.length, before);
    });

    await check('a failed push releases the claim so the next run retries', async () => {
        const e = await eventAndReminder({ title: 'Retry push' });
        const orig = t.network.notifications.length;
        const { createReminders } = require('../server/reminders');
        const failing = createReminders({
            config: t.config, s: t.ctx.s, events: t.ctx.events,
            notifier: { sendReminder: async () => { throw new Error('push down'); } },
            log: { warn() {} },
        });
        const first = await failing.runOnce();
        assert.strictEqual(first.failed, 1);
        assert.strictEqual(await t.ctx.s.db.value('SELECT sent_at IS NULL FROM today_reminders WHERE event_id = $1 AND subject = $2', [e.id, bob.subject]), true);
        const retry = await t.ctx.reminders.runOnce();
        assert.strictEqual(retry.sent, 1);
        assert.strictEqual(t.network.notifications.length, orig + 1);
        assert.strictEqual(t.network.notifications.at(-1).title.startsWith('Retry push'), true);
    });

    await t.close();
    done();
})();
