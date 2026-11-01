'use strict';
/**
 * ADR-033: Today's part of an account export (events, reminders, feed row without its token, briefs, idempotency
 * keys) and of a deletion, applied through /internal/events with a stand-in Network. A deletion erases the person's
 * rows, other people's reminders on their events and pending outbox rows for those events, and confirms with counts;
 * a redelivery changes nothing.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { createNetworkSender, uncovered } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { TABLES } = require('../server/identity/account-data');
const { testDb } = require('./helpers/db');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';
const SECRET = `fixture_${'account'.repeat(6)}`;
const WRONG = `fixture_${'mismatch'.repeat(6)}`;

const exportEvent = { event_id: 'evt_01JZ0000000000000000000E01', event_type: 'network.account.export_requested', source: 'network', payload: { export_id: EXP, subject: A } };
const deleteEvent = { event_id: 'evt_01JZ0000000000000000000D01', event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: DEL, subject: A, aliases: [] } };
const bodyOf = (ev) => JSON.stringify({ event: ev, seq: 1 });

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_today', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw.toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    await check('every table that names a person is covered or exempted with a reason', async () => {
        const d = await testDb();
        try {
            const missing = await uncovered(d.db, {
                tables: TABLES,
                exempt: {account_data_events: 'the ledger of requests itself: which export and deletion today applied'},
            });
            assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
        } finally { await d.close(); }
    });

    const stub = await startNetworkStub();
    const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'today', clientSecret: 'today-secret' });
    // The mock Network's people use generated subjects; the account events name fixed fixtures, so the rows are
    // inserted directly with those subjects.
    const t = await boot({ env: { TODAY_EVENTS_SECRET: SECRET }, accountSend: sender });
    try {
        const db = t.ctx.s.db;
        const at = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
        await db.exec(`INSERT INTO today_events (id, owner_subject, kind, channel, title, description, starts_at, ends_at, tz, status, visibility, url, seq)
                       VALUES ('tev_01JZ000000000000000000AA', $1, 'stream', 'a', 'A stream', NULL, $2::timestamptz, NULL, 'UTC', 'scheduled', 'public', 'https://openvibe.live/@a', 0),
                              ('tev_01JZ000000000000000000BB', $3, 'stream', 'b', 'B stream', NULL, $2::timestamptz, NULL, 'UTC', 'scheduled', 'public', 'https://openvibe.live/@b', 0)`, [A, at, B]);
        await db.exec(`INSERT INTO today_reminders (subject, event_id, remind_at, created_at) VALUES
            ($1, 'tev_01JZ000000000000000000BB', $2::timestamptz, now()),
            ($3, 'tev_01JZ000000000000000000AA', $2::timestamptz, now()),
            ($3, 'tev_01JZ000000000000000000BB', $2::timestamptz, now())`, [A, at, B]);
        await db.exec(`INSERT INTO today_feeds (subject, token, created_at) VALUES ($1, 'feedtokenA_fixture', now()), ($2, 'feedtokenB_fixture', now())`, [A, B]);
        await db.exec(`INSERT INTO today_briefs (subject, day, body, created_at) VALUES ($1, '2026-10-28'::date, '[]'::jsonb, now()), ($2, '2026-10-28'::date, '[]'::jsonb, now())`, [A, B]);
        await db.exec(`INSERT INTO today_idempotency (subject, key, event_id, created_at) VALUES ($1, 'a-key', 'tev_01JZ000000000000000000AA', now())`, [A]);
        await db.exec(`INSERT INTO today_outbox (event_id, topic, payload, created_at) VALUES ('evt_01JZ0000000000000000000A1', 'today.event.scheduled', '{"event_id":"tev_01JZ000000000000000000AA"}'::jsonb, now())`);
        // The address of a calendar A imported: theirs alone, so it is never exported.
        await db.exec(`INSERT INTO today_calendar_imports (id, subject, url, name, created_at) VALUES
            ('cal_01JZ00000000000000000AA', $1, 'https://secret.example.com/a.ics', 'A calendar', now()),
            ('cal_01JZ00000000000000000BB', $2, 'https://secret.example.com/b.ics', 'B calendar', now())`, [A, B]);
        await db.exec(`INSERT INTO today_calendar_import_cache (import_id, body, fetched_at) VALUES
            ('cal_01JZ00000000000000000AA', 'BEGIN:VCALENDAR', now())`);

        await check('an export carries only A\'s rows, and never the feed token', async () => {
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'exported');
            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
            assert.ok(part, 'the part was pushed to Network');
            assert.strictEqual(part.auth, 'Bearer tok_today');
            assert.strictEqual(part.body.subject, A);
            assert.deepStrictEqual(part.body.files.map((f) => f.name).sort(), ['briefs.json', 'events.json', 'feeds.json', 'idempotency.json', 'reminders.json']);
            const all = JSON.stringify(part.body);
            assert.ok(all.includes('A stream'));
            assert.ok(!all.includes('B stream'), 'nobody else\'s event');
            assert.ok(!all.includes('feedtokenA_fixture'), 'the feed token is never exported');
            assert.ok(!all.includes('feedtokenB_fixture'));
            assert.ok(!all.includes('secret.example.com'), 'the address of an imported calendar is never exported');
            const events = part.body.files.find((f) => f.name === 'events.json').content;
            assert.deepStrictEqual(events.map((e) => e.id), ['tev_01JZ000000000000000000AA']);
            const reminders = part.body.files.find((f) => f.name === 'reminders.json').content;
            assert.deepStrictEqual(reminders.map((r) => r.event_id), ['tev_01JZ000000000000000000BB']);
        });

        await check('a deletion erases A\'s rows, other people\'s reminders on A\'s events, and confirms with counts', async () => {
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'erased');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_events WHERE owner_subject = $1', [A]), 0);
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_reminders WHERE subject = $1', [A]), 0);
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_reminders WHERE event_id = $1', ['tev_01JZ000000000000000000AA']), 0, 'B\'s reminder on A\'s event is an orphan and goes');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_feeds WHERE subject = $1', [A]), 0);
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_briefs WHERE subject = $1', [A]), 0);
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_idempotency WHERE subject = $1', [A]), 0);
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_calendar_imports WHERE subject = $1', [A]), 0, 'the imported calendar goes with the account');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_calendar_import_cache WHERE import_id = $1', ['cal_01JZ00000000000000000AA']), 0, 'and the copy of it');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_calendar_imports WHERE subject = $1', [B]), 1, 'B\'s calendar stays');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_events WHERE owner_subject = $1', [B]), 1, 'B\'s event stays');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_reminders WHERE subject = $1', [B]), 1, 'B\'s own reminder stays');
            const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
            assert.ok(confirmation, 'the confirmation was sent');
            assert.ok(confirmation.body.erased.today_events >= 1);
            assert.ok(confirmation.body.erased.today_reminders >= 1);
            assert.ok(!Number.isNaN(Date.parse(confirmation.body.completed_at)));
        });

        await check('a redelivery changes nothing; a new row made afterwards stays', async () => {
            await db.exec(`INSERT INTO today_events (id, owner_subject, kind, channel, title, starts_at, tz, status, visibility, seq) VALUES ('tev_01JZ000000000000000000AC', $1, 'event', NULL, 'written later', now() + interval '1 hour', 'UTC', 'scheduled', 'public', 0)`, [A]);
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'unchanged');
            assert.strictEqual(await db.value('SELECT COUNT(*)::int AS n FROM today_events WHERE owner_subject = $1', [A]), 1);
        });

        await check('the internal route refuses a bad signature (401) and a forwarded request (403)', async () => {
            const bad = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), WRONG) } });
            assert.strictEqual(bad.status, 401);
            const forwarded = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(forwarded.status, 403);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
