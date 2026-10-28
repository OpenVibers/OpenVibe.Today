'use strict';
/**
 * The events API: create (validation, the stream channel from the token, Idempotency-Key), patch (seq + 1),
 * cancel (idempotent), the per-owner cap, followers-only visibility, the cross-site refusal, and the outbox row
 * written in the same transaction as the event (a failed outbox insert leaves neither).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const iso = (ms) => new Date(ms).toISOString();

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const soon = () => iso(Date.now() + 60 * 60_000);

    await check('a stream takes its channel and URL from the token, never from the body', async () => {
        const r = await t.get('/api/v1/events', { as: alice, json: { kind: 'stream', channel: 'evil', url: 'https://evil.example', title: 'Live soon', starts_at: soon(), tz: 'Europe/Berlin' } });
        assert.strictEqual(r.status, 201, r.text);
        const e = r.json();
        assert.match(e.id, /^tev_[0-9A-HJKMNP-TV-Z]{20}$/);
        assert.strictEqual(e.channel, 'alice');
        assert.strictEqual(e.url, 'https://openvibe.live/@alice');
        assert.strictEqual(e.status, 'scheduled');
        assert.strictEqual(e.seq, 0);
        assert.strictEqual(e.owner_subject, alice.subject);
    });

    await check('validation errors are 400 today.invalid with the field', async () => {
        const cases = [
            [{ kind: 'nope', title: 'x', starts_at: soon(), tz: 'UTC' }, 'kind'],
            [{ kind: 'event', title: '', starts_at: soon(), tz: 'UTC' }, 'title'],
            [{ kind: 'event', title: 'x'.repeat(121), starts_at: soon(), tz: 'UTC' }, 'title'],
            [{ kind: 'event', title: 'x', starts_at: iso(Date.now() - 10 * 60_000), tz: 'UTC' }, 'starts_at'],
            [{ kind: 'event', title: 'x', starts_at: iso(Date.now() + 367 * 24 * 60 * 60_000), tz: 'UTC' }, 'starts_at'],
            [{ kind: 'event', title: 'x', starts_at: soon(), ends_at: iso(Date.now() + 30 * 60_000), tz: 'UTC' }, 'ends_at'],
            [{ kind: 'event', title: 'x', starts_at: soon(), ends_at: iso(Date.now() + 26 * 60 * 60_000), tz: 'UTC' }, 'ends_at'],
            [{ kind: 'event', title: 'x', starts_at: soon(), tz: 'Not/AZone' }, 'tz'],
            [{ kind: 'event', title: 'x', starts_at: soon(), tz: 'UTC', description: 'd'.repeat(1001) }, 'description'],
            [{ kind: 'event', title: 'x', starts_at: 'tomorrow', tz: 'UTC' }, 'starts_at'],
        ];
        for (const [body, field] of cases) {
            const r = await t.get('/api/v1/events', { as: alice, json: body });
            assert.strictEqual(r.status, 400, `${field}: ${r.text}`);
            const b = r.json();
            assert.strictEqual(b.code, 'today.invalid');
            assert.strictEqual(b.field, field, `${field}: ${r.text}`);
            assert.ok(b.message);
        }
    });

    await check('a repeated Idempotency-Key returns the first event, never a second one', async () => {
        const headers = { 'Idempotency-Key': 'fixture-key-1' };
        const body = { kind: 'event', title: 'Idempotent', starts_at: soon(), tz: 'UTC' };
        const a = await t.get('/api/v1/events', { as: alice, json: body, headers });
        const b = await t.get('/api/v1/events', { as: alice, json: body, headers });
        assert.strictEqual(a.status, 201);
        assert.strictEqual(b.status, 200);
        assert.strictEqual(a.json().id, b.json().id);
        const n = await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_events WHERE title = $1', ['Idempotent']);
        assert.strictEqual(n, 1);
        const long = await t.get('/api/v1/events', { as: alice, json: body, headers: { 'Idempotency-Key': 'k'.repeat(101) } });
        assert.strictEqual(long.status, 400);
        assert.strictEqual(long.json().field, 'idempotency_key');
    });

    await check('PATCH bumps seq and writes today.event.updated in the same transaction', async () => {
        const created = await t.get('/api/v1/events', { as: alice, json: { kind: 'event', title: 'Before', starts_at: soon(), tz: 'UTC' } });
        const id = created.json().id;
        const r = await t.get(`/api/v1/events/${id}`, { as: alice, method: 'PATCH', json: { title: 'After', visibility: 'followers' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().title, 'After');
        assert.strictEqual(r.json().visibility, 'followers');
        assert.strictEqual(r.json().seq, 1);
        const rows = await t.ctx.s.db.many('SELECT topic, payload FROM today_outbox WHERE payload->>$1 = $2 ORDER BY created_at', ['event_id', id]);
        assert.deepStrictEqual(rows.map((x) => x.topic), ['today.event.scheduled', 'today.event.updated']);
        assert.strictEqual(rows[1].payload.seq, 1);
    });

    await check('a followers-only event is 404 to everyone but its owner and absent from the public list', async () => {
        const created = await t.get('/api/v1/events', { as: alice, json: { kind: 'event', title: 'Followers only', starts_at: soon(), tz: 'UTC', visibility: 'followers' } });
        const id = created.json().id;
        assert.strictEqual((await t.get(`/api/v1/events/${id}`)).status, 404);
        assert.strictEqual((await t.get(`/api/v1/events/${id}`, { as: bob })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/events/${id}`, { as: alice })).status, 200);
        const list = await t.get('/api/v1/events?limit=100');
        assert.ok(!list.json().events.some((e) => e.id === id));
    });

    await check('a session write from another origin is 403 today.cross_site', async () => {
        const r = await t.get('/api/v1/events', { as: alice, origin: 'https://evil.example', json: { kind: 'event', title: 'Cross', starts_at: soon(), tz: 'UTC' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json().code, 'today.cross_site');
        const same = await t.get('/api/v1/events', { as: alice, origin: 'https://openvibe.today', json: { kind: 'event', title: 'Same', starts_at: soon(), tz: 'UTC' } });
        assert.strictEqual(same.status, 201);
        const bearer = await t.get('/api/v1/events', { bearer: t.network.userToken(alice), origin: 'https://evil.example', json: { kind: 'event', title: 'Bearer', starts_at: soon(), tz: 'UTC' } });
        assert.strictEqual(bearer.status, 201, 'a Bearer token is not a browser session');
    });

    await check('DELETE cancels idempotently, bumps seq once, drops reminders and writes one cancelled row', async () => {
        const created = await t.get('/api/v1/events', { as: alice, json: { kind: 'stream', title: 'To cancel', starts_at: soon(), tz: 'UTC' } });
        const id = created.json().id;
        assert.strictEqual((await t.get(`/api/v1/events/${id}/remind`, { as: bob, json: { minutes_before: 5 } })).status, 200);
        const a = await t.get(`/api/v1/events/${id}`, { as: alice, method: 'DELETE' });
        assert.strictEqual(a.status, 200, a.text);
        assert.strictEqual(a.json().status, 'cancelled');
        assert.strictEqual(a.json().seq, 1);
        const b = await t.get(`/api/v1/events/${id}`, { as: alice, method: 'DELETE' });
        assert.strictEqual(b.status, 200);
        assert.strictEqual(b.json().seq, 1);
        const cancelled = await t.ctx.s.db.many("SELECT * FROM today_outbox WHERE topic = 'today.event.cancelled' AND payload->>'event_id' = $1", [id]);
        assert.strictEqual(cancelled.length, 1);
        assert.strictEqual(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_reminders WHERE event_id = $1', [id]), 0);
        const get = await t.get(`/api/v1/events/${id}`);
        assert.strictEqual(get.status, 200);
        assert.strictEqual(get.json().status, 'cancelled');
    });

    await check('PATCH is refused once cancelled, and another owner is 404', async () => {
        const created = await t.get('/api/v1/events', { as: alice, json: { kind: 'event', title: 'Locked', starts_at: soon(), tz: 'UTC' } });
        const id = created.json().id;
        assert.strictEqual((await t.get(`/api/v1/events/${id}`, { as: bob, method: 'PATCH', json: { title: 'mine now' } })).status, 404);
        await t.get(`/api/v1/events/${id}`, { as: alice, method: 'DELETE' });
        const r = await t.get(`/api/v1/events/${id}`, { as: alice, method: 'PATCH', json: { title: 'nope' } });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json().code, 'today.locked');
    });

    await check('at most 60 scheduled future events per owner (409 today.too_many)', async () => {
        const u = t.network.addUser('capped');
        const at = soon();
        const created = [];
        for (let i = 0; i < 60; i++) {
            const r = await t.get('/api/v1/events', { as: u, json: { kind: 'event', title: `Event ${i}`, starts_at: at, tz: 'UTC' } });
            assert.strictEqual(r.status, 201, r.text);
            created.push(r.json().id);
        }
        const over = await t.get('/api/v1/events', { as: u, json: { kind: 'event', title: 'One too many', starts_at: at, tz: 'UTC' } });
        assert.strictEqual(over.status, 409);
        assert.strictEqual(over.json().code, 'today.too_many');
        // A cancelled event no longer counts, so the owner can schedule again.
        await t.get(`/api/v1/events/${created[0]}`, { as: u, method: 'DELETE' });
        const again = await t.get('/api/v1/events', { as: u, json: { kind: 'event', title: 'Room again', starts_at: at, tz: 'UTC' } });
        assert.strictEqual(again.status, 201);
    });

    await check('a failed outbox insert leaves neither the event nor the outbox row', async () => {
        const u = t.network.addUser('atomic');
        await t.ctx.s.db.exec('DELETE FROM today_outbox');
        await t.ctx.s.db.exec("ALTER TABLE today_outbox ADD CONSTRAINT outbox_never CHECK (topic <> 'today.event.scheduled')");
        try {
            const r = await t.get('/api/v1/events', { as: u, json: { kind: 'event', title: 'Atomic', starts_at: soon(), tz: 'UTC' } });
            assert.strictEqual(r.status, 500);
        } finally {
            await t.ctx.s.db.exec('ALTER TABLE today_outbox DROP CONSTRAINT outbox_never');
        }
        assert.strictEqual(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_events WHERE title = $1', ['Atomic']), 0);
        assert.strictEqual(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_outbox WHERE payload->>$1 = $2', ['title', 'Atomic']), 0);
    });

    await t.close();
    done();
})();
