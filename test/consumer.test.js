'use strict';
/**
 * POST /internal/events: a signed live.stream.started turns the channel's scheduled event (start within 2 h of now)
 * live, live.stream.ended makes a live one done, a replayed delivery changes nothing, and a bad signature is refused.
 */
const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');

const SECRET = `fixture_${'consumer'.repeat(6)}`;
const bodyOf = (event) => JSON.stringify({ event, seq: 1 });
const started = (id) => ({ event_id: 'evt_01M61F7R3WXM5T5ET9CRGNHEP1', event_type: 'live.stream.started', source: 'live', payload: { stream_id: 7, channel: { username: 'alice' }, title: 'Hello', started_at: new Date().toISOString() } });
const ended = (id) => ({ event_id: 'evt_01M61F7R3WXM5T5ET9CRGNHEP2', event_type: 'live.stream.ended', source: 'live', payload: { stream_id: 7, channel: { username: 'alice' }, title: 'Hello', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), duration_seconds: 60 } });

(async () => {
    const t = await boot({ env: { TODAY_EVENTS_SECRET: SECRET } });
    const alice = t.network.addUser('alice');
    const starts = new Date(Date.now() + 30 * 60_000).toISOString();
    const created = await t.get('/api/v1/events', { as: alice, json: { kind: 'stream', title: 'Hello', starts_at: starts, tz: 'UTC' } });
    assert.strictEqual(created.status, 201);
    const id = created.json().id;

    const post = (b, extra = {}) => t.get('/internal/events', { method: 'POST', body: b, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(b, SECRET), ...extra } });

    await check('a signed live.stream.started makes the scheduled event live', async () => {
        const b = bodyOf(started(id));
        const r = await post(b);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().outcome, 'live');
        const e = await t.get(`/api/v1/events/${id}`);
        assert.strictEqual(e.json().status, 'live');
        assert.strictEqual(e.json().seq, 1);
        assert.strictEqual(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_processed WHERE event_id = $1', [started(id).event_id]), 1);
    });

    await check('the bus remembers the channel\'s Network subject and gives it to an imported on-now row', async () => {
        await t.ctx.s.db.exec(
            `INSERT INTO today_events (id, owner_subject, kind, channel, title, starts_at, tz, status, visibility, source, source_id, source_kind)
             VALUES ('tev_01JZ0000000000000000001', 'chan:alice', 'stream', 'alice', 'Imported now', now(), 'UTC', 'live', 'public', 'live', 'stream:7', 'on_now')`,
        );
        const event = {
            ...started(id),
            event_id: 'evt_01M61F7R3WXM5T5ET9CRGNHEP3',
            payload: { ...started(id).payload, channel: { username: 'alice', subject: { type: 'user', id: alice.subject } } },
        };
        const r = await post(bodyOf(event));
        assert.strictEqual(r.status, 200, r.text);
        const mapping = await t.ctx.s.db.maybe('SELECT * FROM today_channels WHERE username = $1', ['alice']);
        assert.strictEqual(mapping.subject, alice.subject);
        const imported = await t.ctx.s.db.maybe("SELECT * FROM today_events WHERE source = 'live' AND source_id = 'stream:7'");
        assert.strictEqual(imported.owner_subject, alice.subject, 'the public-list row learns its subject');
    });

    await check('a replayed delivery changes nothing', async () => {
        const b = bodyOf(started(id));
        const r = await post(b);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json().duplicate, true);
        const e = await t.get(`/api/v1/events/${id}`);
        assert.strictEqual(e.json().status, 'live');
        assert.strictEqual(e.json().seq, 1, 'no second bump');
        assert.strictEqual(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_processed WHERE event_id = $1', [started(id).event_id]), 1);
    });

    await check('a signed live.stream.ended makes the live event done', async () => {
        const r = await post(bodyOf(ended(id)));
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().outcome, 'done');
        const e = await t.get(`/api/v1/events/${id}`);
        assert.strictEqual(e.json().status, 'done');
        assert.strictEqual(e.json().seq, 2);
    });

    await check('a bad signature is refused (401) and a forwarded request (403)', async () => {
        const b = bodyOf(started(id));
        const bad = await t.get('/internal/events', { method: 'POST', body: b, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(b, `${'wrong'.repeat(8)}`) } });
        assert.strictEqual(bad.status, 401);
        const forwarded = await t.get('/internal/events', { method: 'POST', body: b, headers: { 'content-type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...signDeliveryHeaders(b, SECRET) } });
        assert.strictEqual(forwarded.status, 403);
        const missing = await t.get('/internal/events', { method: 'POST', body: b, headers: { 'content-type': 'application/json' } });
        assert.strictEqual(missing.status, 401);
    });

    await check('with no secret configured the route answers 503', async () => {
        const t2 = await boot();
        const r = await t2.get('/internal/events', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
        assert.strictEqual(r.status, 503);
        await t2.close();
    });

    await t.close();
    done();
})();
