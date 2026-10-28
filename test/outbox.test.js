'use strict';
/**
 * The outbox publisher: each row is sent once under the evt_ id fixed when it was written, a failure records the
 * attempt and backs off, a later retry publishes the same fixed id, and a new publisher over the same rows does not
 * duplicate anything.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createPublisher } = require('../server/events/publisher');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const at = new Date(Date.now() + 60 * 60_000).toISOString();
    const make = async (title) => (await t.get('/api/v1/events', { as: alice, json: { kind: 'stream', title, starts_at: at, tz: 'UTC' } })).json();

    await check('each row is published once, with its fixed evt_ id and the payload Today defined', async () => {
        const a = await make('First');
        const b = await make('Second');
        const rows = await t.ctx.s.db.many('SELECT * FROM today_outbox ORDER BY created_at');
        assert.strictEqual(rows.length, 2);
        for (const row of rows) assert.match(row.event_id, /^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
        const r = await t.ctx.publisher.runOnce();
        assert.deepStrictEqual(r, { configured: true, claimed: 2, published: 2, failed: 0 });
        const token = t.network.tokenRequests.find((x) => x.audience === 'openvibe.events');
        assert.ok(token, 'an Events token was requested');
        assert.strictEqual(token.scope, 'events.event.publish', 'OpenVibe.Events\' publish capability');
        assert.strictEqual(t.network.publishedEvents.length, 2);
        const ids = new Set(t.network.publishedEvents.map((e) => e.event_id));
        for (const row of rows) assert.ok(ids.has(row.event_id));
        const first = t.network.publishedEvents.find((e) => e.payload.event_id === a.id);
        assert.strictEqual(first.event_type, 'today.event.scheduled');
        assert.strictEqual(first.source, 'today');
        assert.deepStrictEqual(first.subject, { type: 'user', id: alice.subject });
        assert.deepStrictEqual(Object.keys(first.payload).sort(), ['channel', 'ends_at', 'event_id', 'kind', 'seq', 'starts_at', 'status', 'title', 'tz', 'url', 'visibility']);
        assert.strictEqual(first.payload.title, 'First');
        assert.strictEqual(first.payload.channel, 'alice');
        const again = await t.ctx.publisher.runOnce();
        assert.strictEqual(again.claimed, 0);
        assert.strictEqual(t.network.publishedEvents.length, 2, 'nothing sent twice');
        assert.ok(b.id);
    });

    await check('a failure records attempts/last_error, backs off, then retries the same id', async () => {
        const e = await make('Retry me');
        t.network.failEvents(1);
        const failed = await t.ctx.publisher.runOnce();
        assert.strictEqual(failed.failed, 1);
        let row = await t.ctx.s.db.maybe("SELECT * FROM today_outbox WHERE payload->>'event_id' = $1", [e.id]);
        assert.strictEqual(row.attempts, 1);
        assert.match(row.last_error, /events 503/);
        assert.strictEqual(row.published_at, null);
        assert.ok(new Date(row.next_attempt_at).getTime() > Date.now(), 'backed off into the future');
        assert.strictEqual((await t.ctx.publisher.runOnce()).claimed, 0, 'not due yet');
        await t.ctx.s.db.exec("UPDATE today_outbox SET next_attempt_at = now() - interval '1 second' WHERE event_id = $1", [row.event_id]);
        const retried = await t.ctx.publisher.runOnce();
        assert.deepStrictEqual(retried, { configured: true, claimed: 1, published: 1, failed: 0 });
        row = await t.ctx.s.db.maybe('SELECT * FROM today_outbox WHERE event_id = $1', [row.event_id]);
        assert.ok(row.published_at);
        assert.strictEqual(row.attempts, 1, 'the attempt that failed is recorded');
        const event = t.network.publishedEvents.find((x) => x.event_id === row.event_id);
        assert.strictEqual(event.payload.event_id, e.id);
    });

    await check('a new publisher over the same rows does not duplicate', async () => {
        const before = t.network.publishedEvents.length;
        const restarted = createPublisher({ config: t.config, s: t.ctx.s, fetchImpl: globalThis.fetch, log: { warn() {}, log() {}, error() {} } });
        assert.strictEqual((await restarted.runOnce()).claimed, 0);
        assert.strictEqual(t.network.publishedEvents.length, before);
        assert.strictEqual(await t.ctx.publisher.pending(), 0);
    });

    await t.close();
    done();
})();
