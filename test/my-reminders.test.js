'use strict';
/**
 * A person's own reminders (plan L48, R1): plain words become a rule (server/when.js) that fires in the person's own
 * time zone, across a clock change; the API sets, lists, snoozes, stops and removes them, only for their owner; the
 * job sends one notification per time and moves the reminder on (a one-off is then done), never twice; /me has the
 * box and the list, and its forms work without the script.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const when = require('../server/when');

(async () => {
    await check('plain words become a rule, a title and the next time, in the person\'s zone', () => {
        const now = new Date('2026-11-02T14:20:00Z');            // Monday 6:20 am in Los Angeles
        const tz = 'America/Los_Angeles';
        const p = (t) => when.parse(t, { now, tz });
        const a = p('remind me to stretch every 2 hours from 9 to 5');
        assert.deepStrictEqual([a.title, a.summary], ['Stretch', 'Every 2 hours, 9 am–5 pm']);
        assert.strictEqual(a.next_at, '2026-11-02T17:00:00.000Z', '9 am in Los Angeles');
        assert.strictEqual(p('take my meds every day at 9am and 9pm').summary, 'Every day at 9 am and 9 pm');
        assert.strictEqual(p('standup weekdays at 9:30').summary, 'Weekdays at 9:30 am');
        assert.strictEqual(p('stream every Monday and Thursday at 7pm').summary, 'Mondays and Thursdays at 7 pm');
        assert.strictEqual(p('pay rent on the 1st of every month').next_at, '2026-12-01T17:00:00.000Z');
        assert.strictEqual(p('check the oven in 20 minutes').next_at, '2026-11-02T14:40:00.000Z');
        assert.strictEqual(p('call mom on Sunday at 6pm').summary, 'Sun, Nov 8 at 6 pm');
        assert.strictEqual(p('walk the dog tomorrow morning').summary, 'Tomorrow at 9 am');
        assert.strictEqual(p('drink water every 30 minutes').next_at, '2026-11-02T14:50:00.000Z', 'every 30 minutes from now');
        assert.ok(p('water plants').error, 'no time: asked');
        assert.ok(p('at 3pm').error, 'no what: asked');
        assert.ok(p('ping every 2 minutes').error, 'too often: refused');
    });

    await check('"every day at 9" stays 9 o\'clock across the clock change', () => {
        const tz = 'America/New_York';                              // clocks go back on Sunday 1 November 2026
        const rule = { kind: 'daily', times: ['09:00'] };
        const sat = when.next(rule, { after: new Date('2026-10-31T13:30:00Z'), tz });  // after 9:30 am EDT
        assert.strictEqual(sat.toISOString(), '2026-11-01T14:00:00.000Z', '9 am EST on Sunday is 14:00 UTC');
        const sun = when.next(rule, { after: sat, tz });
        assert.strictEqual(sun.toISOString(), '2026-11-02T14:00:00.000Z');
        assert.strictEqual(when.next({ kind: 'monthly', day: 31, time: '09:00' }, { after: new Date('2026-11-05T00:00:00Z'), tz: 'UTC' }).toISOString(), '2026-11-30T09:00:00.000Z', 'a month without the 31st uses its last day');
    });

    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const db = t.ctx.s.db;
    try {
        await check('the API sets, lists, snoozes, stops and removes a person\'s own reminders', async () => {
            const parsed = await t.get('/api/v1/reminders/parse', { as: alice, json: { text: 'stretch every 2 hours from 9 to 5', tz: 'Europe/Berlin' } });
            assert.strictEqual(parsed.status, 200, parsed.text);
            assert.strictEqual(parsed.json().summary, 'Every 2 hours, 9 am–5 pm');
            const vague = await t.get('/api/v1/reminders/parse', { as: alice, json: { text: 'water plants', tz: 'Europe/Berlin' } });
            assert.strictEqual(vague.status, 422);
            const made = await t.get('/api/v1/reminders', { as: alice, json: { text: 'stretch every 2 hours from 9 to 5', tz: 'Europe/Berlin', url: 'https://openvibe.live/@alice', source: 'live' } });
            assert.strictEqual(made.status, 201, made.text);
            const r = made.json();
            assert.ok(/^rem_/.test(r.id) && r.repeats && r.url === 'https://openvibe.live/@alice' && r.source === 'live');
            const unsafe = await t.get('/api/v1/reminders', { as: alice, json: { text: 'x at 3pm', tz: 'UTC', url: 'javascript:alert(1)' } });
            assert.strictEqual(unsafe.json().url, null, 'only an https link is kept');
            const list = (await t.get('/api/v1/reminders', { as: alice })).json().reminders;
            assert.ok(list.some((x) => x.id === r.id));
            assert.strictEqual((await t.get(`/api/v1/reminders/${r.id}/done`, { as: bob, json: {} })).status, 404, 'another person cannot touch it');
            const snoozed = (await t.get(`/api/v1/reminders/${r.id}/snooze`, { as: alice, json: { minutes: 60 } })).json();
            assert.ok(Math.abs(new Date(snoozed.next_at).getTime() - (Date.now() + 3600000)) < 120000, 'an hour from now');
            const stopped = (await t.get(`/api/v1/reminders/${r.id}/done`, { as: alice, json: {} })).json();
            assert.strictEqual(stopped.status, 'done');
            assert.strictEqual((await t.get(`/api/v1/reminders/${r.id}`, { as: alice, method: 'DELETE' })).status, 204);
            assert.strictEqual(await db.value('SELECT count(*)::int FROM today_my_reminders WHERE id = $1', [r.id]), 0);
        });

        await check('the job sends one notification per time and moves the reminder on; a one-off is then done', async () => {
            const rep = (await t.get('/api/v1/reminders', { as: alice, json: { text: 'drink water every 30 minutes', tz: 'UTC' } })).json();
            const once = (await t.get('/api/v1/reminders', { as: alice, json: { text: 'check the oven in 20 minutes', tz: 'UTC' } })).json();
            await db.exec("UPDATE today_my_reminders SET next_at = now() - interval '1 minute' WHERE id = ANY($1)", [[rep.id, once.id]]);
            const before = t.network.notifications.length;
            const [a, b] = await Promise.all([t.ctx.reminders.runOnce(), t.ctx.reminders.runOnce()]);
            assert.strictEqual(a.sent + b.sent, 2, 'two reminders, two notifications, never four');
            const sent = t.network.notifications.slice(before);
            assert.deepStrictEqual(sent.map((n) => n.title).sort(), ['Check the oven', 'Drink water']);
            assert.ok(sent.every((n) => n.type === 'TODAY_REMINDER' && n.service === 'today' && n.user_id === alice.id));
            assert.match(sent.find((n) => n.title === 'Drink water').message, /Every 30 minutes/);
            const after = await db.many('SELECT id, status, next_at, sent_count FROM today_my_reminders WHERE id = ANY($1)', [[rep.id, once.id]]);
            const repRow = after.find((x) => x.id === rep.id), onceRow = after.find((x) => x.id === once.id);
            assert.ok(repRow.status === 'active' && new Date(repRow.next_at) > new Date(), 'the repeat moved on');
            assert.ok(onceRow.status === 'done' && onceRow.next_at === null, 'the one-off is done');
            assert.strictEqual(Number(repRow.sent_count), 1);
        });

        await check('a first-party service with today.reminder.write sets a person\'s reminder for them, and nothing else can', async () => {
            const now = Math.floor(Date.now() / 1000);
            const token = (sub, cap) => t.network.signJwt({ iss: t.network.issuer(), sub, actor_type: sub.startsWith('svc:') ? 'service' : 'app', aud: ['openvibe.today'], cap, iat: now, exp: now + 300, jti: `tok_${Math.random().toString(36).slice(2)}` });
            const vibe = token('svc:chat', ['today.reminder.write']);
            const call = (tok, subject, json) => t.get('/api/v1/reminders', { headers: { authorization: `Bearer ${tok}`, ...(subject ? { 'x-ov-subject': subject } : {}) }, ...(json ? { json } : {}) });
            const made = await call(vibe, alice.subject, { text: 'stand up and stretch every hour', tz: 'UTC' });
            assert.strictEqual(made.status, 201, made.text);
            assert.strictEqual(made.json().source, 'chat', 'it says which site set it');
            assert.strictEqual(await db.value('SELECT subject FROM today_my_reminders WHERE id = $1', [made.json().id]), alice.subject, 'it is the named person\'s');
            const listed = (await call(vibe, alice.subject)).json().reminders;
            assert.ok(listed.some((x) => x.id === made.json().id) && listed.every((x) => true));
            assert.ok(!(await call(vibe, bob.subject)).json().reminders.some((x) => x.id === made.json().id), 'another person\'s list never shows it');
            assert.strictEqual((await call(token('svc:games', []), alice.subject, { text: 'x at 3pm', tz: 'UTC' })).status, 403, 'a service without the capability');
            assert.ok([401, 403].includes((await call(token('app:01J8Z3Q4R5S6T7V8W9X0Y1Z2A1', ['today.reminder.write']), alice.subject, { text: 'x at 3pm', tz: 'UTC' })).status), 'an app never');
            assert.strictEqual((await call(vibe, null, { text: 'x at 3pm', tz: 'UTC' })).status, 400, 'the person must be named');
            assert.strictEqual((await t.get('/api/v1/events', { headers: { authorization: `Bearer ${vibe}` }, json: { kind: 'event', title: 'x', starts_at: new Date(Date.now() + 3600e3).toISOString(), tz: 'UTC' } })).status, 403, 'and it reaches nothing but reminders');
        });

        await check('/me has the box and the list, and its forms work without the script', async () => {
            const me = await t.get('/me', { as: bob });
            assert.match(me.text, /<section class="td-card td-remind" id="reminders"/);
            assert.match(me.text, /<form method="post" action="\/me\/reminders" class="td-remind-form" data-remind-preview="\/api\/v1\/reminders\/parse">/);
            const add = await t.get('/me/reminders', { as: bob, form: { text: 'call mom on Sunday at 6pm', tz: 'America/Chicago' } });
            assert.strictEqual(add.status, 303);
            assert.strictEqual(add.headers.get('location'), '/me#reminders');
            const page = await t.get('/me', { as: bob });
            assert.match(page.text, /<b>Call mom<\/b>[\s\S]*?at 6 pm/);
            const bad = await t.get('/me/reminders', { as: bob, form: { text: 'water plants', tz: 'UTC' } });
            assert.match(decodeURIComponent(bad.headers.get('location')), /problem=Say when/);
            const id = await db.value("SELECT id FROM today_my_reminders WHERE subject = $1 AND title = 'Call mom'", [bob.subject]);
            const foreign = await t.get(`/me/reminders/${id}/remove`, { as: bob, form: { x: '1' }, headers: { origin: 'https://evil.example' } });
            assert.strictEqual(foreign.status, 403, 'a post from another site is refused');
            const rm = await t.get(`/me/reminders/${id}/remove`, { as: bob, form: { x: '1' } });
            assert.strictEqual(rm.status, 303);
            assert.strictEqual(await db.value('SELECT count(*)::int FROM today_my_reminders WHERE id = $1', [id]), 0);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
