'use strict';
/**
 * A person's agenda read by a first-party service for them (today.agenda.read, contracts 0.280.0; plan L48 V3, Vibe's
 * "plan my day"): the service names the person with X-OV-Subject and gets that person's own agenda, read-only. A
 * service without the capability, an app, and a request that names nobody are refused; another person's events never
 * show; the person's own token still reads it as before.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const at = (min) => new Date(Date.now() + min * 60_000).toISOString();
    try {
        const mine = (await t.get('/api/v1/events', { as: alice, json: { kind: 'event', title: 'Dentist', starts_at: at(90), tz: 'UTC' } })).json();
        const theirs = (await t.get('/api/v1/events', { as: bob, json: { kind: 'event', title: 'Bob only', starts_at: at(90), tz: 'UTC' } })).json();
        const now = Math.floor(Date.now() / 1000);
        const token = (sub, cap) => t.network.signJwt({ iss: t.network.issuer(), sub, actor_type: sub.startsWith('svc:') ? 'service' : 'app', aud: ['openvibe.today'], cap, iat: now, exp: now + 300, jti: `tok_${Math.random().toString(36).slice(2)}` });
        const read = (tok, subject, q = '?days=1') => t.get(`/api/v1/me/agenda${q}`, { headers: { authorization: `Bearer ${tok}`, ...(subject ? { 'x-ov-subject': subject } : {}) } });

        await check('Vibe reads the named person\'s day, and only theirs', async () => {
            const r = await read(token('svc:chat', ['today.agenda.read']), alice.subject);
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            const titles = body.events.map((e) => e.title);
            assert.ok(titles.includes('Dentist'), titles.join(','));
            assert.ok(!titles.includes('Bob only'), 'another person\'s event never shows');
            assert.strictEqual(body.days, 1);
            assert.strictEqual(body.events.find((e) => e.id === mine.id).own, true);
            assert.strictEqual(typeof body.follows_unavailable, 'boolean');
            assert.strictEqual(r.headers.get('cache-control'), 'no-store');
            const v = require('openvibe-contracts').validate('today.agenda@1', body);
            assert.ok(v.valid, JSON.stringify(v.errors));
            assert.ok(theirs.id);
        });

        await check('without the capability, as an app, or naming nobody: refused', async () => {
            assert.strictEqual((await read(token('svc:games', []), alice.subject)).status, 403);
            assert.strictEqual((await read(token('svc:chat', ['today.reminder.write']), alice.subject)).status, 403, 'writing reminders is not reading the day');
            assert.ok([401, 403].includes((await read(token('app:01J8Z3Q4R5S6T7V8W9X0Y1Z2A1', ['today.agenda.read']), alice.subject)).status), 'an app never');
            assert.strictEqual((await read(token('svc:chat', ['today.agenda.read']), null)).status, 400, 'the person must be named');
            assert.strictEqual((await read(token('svc:chat', ['today.agenda.read']), alice.subject, '?days=90')).status, 400);
        });

        await check('the person still reads their own agenda with their own sign-in', async () => {
            const r = await t.get('/api/v1/me/agenda?days=1', { as: alice });
            assert.strictEqual(r.status, 200);
            assert.ok(r.json().events.some((e) => e.title === 'Dentist'));
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
