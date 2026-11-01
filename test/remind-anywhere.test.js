'use strict';
/**
 * "Remind me" from anywhere (plan L48 R3): /remind?title=&at=&url=&from= from any OpenVibe site. Signed out, sign in
 * and come back; signed in, the time in the person's own zone and how long before; a one-off reminder before it, the
 * same thing set twice set once, a past time refused, a lead too long for the time left made as soon as it can be, a
 * link that is not https dropped, and only openvibe.today itself may post it.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const ana = t.network.addUser('ana');
    const hour = 3_600_000;
    const at = new Date(Math.ceil((Date.now() + 3 * 24 * hour) / hour) * hour).toISOString();
    const q = new URLSearchParams({ title: 'Surf race, heat 3', at, url: 'https://openvibe.live/@surfwax', from: 'openvibe.live' });
    const paris = (iso) => {
        const d = new Date(iso);
        return `${new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', weekday: 'short', month: 'short', day: 'numeric' }).format(d)} at ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(d)}`;
    };
    const rows = () => t.ctx.s.db.many("SELECT * FROM today_my_reminders WHERE source <> 'today' ORDER BY created_at");
    try {
        await check('signed out: sign in, and come back to the same reminder', async () => {
            const r = await t.get(`/remind?${q}`);
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /Remind me: Surf race, heat 3/);
            assert.ok(r.text.includes(encodeURIComponent(`/remind?${q}`)), 'the sign-in comes back here');
            const post = await t.get('/remind', { form: Object.fromEntries(q), origin: t.config.baseUrl });
            assert.strictEqual(post.status, 303);
            assert.match(post.headers.get('location'), /^\/auth\/login\?next=%2Fremind%3F/);
        });

        await check('signed in: the time in the person\'s zone, and how long before', async () => {
            const r = await t.get(`/remind?${q}`, { as: ana, headers: { cookie: 'td_tz=Europe%2FParis' } });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /<div class="td-wrap td-page-pad td-narrow" id="td-remind" data-tz="Europe\/Paris">/);
            assert.ok(r.text.includes(paris(at)), `the time in Paris: ${paris(at)}`);
            assert.match(r.text, /from openvibe\.live/);
            assert.match(r.text, /<input type="radio" name="lead" value="10" checked>/, '10 minutes before, unless they choose');
            assert.match(r.text, /href="https:\/\/openvibe\.live\/@surfwax">Back to openvibe\.live/);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        });

        await check('set: a one-off before it, the way back, and set once', async () => {
            const form = { ...Object.fromEntries(q), lead: '60', tz: 'Europe/Paris' };
            const r = await t.get('/remind', { as: ana, form });
            assert.strictEqual(r.status, 201, r.text.slice(0, 300));
            assert.match(r.text, /Reminder set/);
            assert.match(r.text, /Back to openvibe\.live/);
            const [row] = await rows();
            assert.strictEqual(new Date(row.next_at).toISOString(), new Date(Date.parse(at) - hour).toISOString(), 'an hour before');
            assert.deepStrictEqual([row.title, row.url, row.source, row.tz, row.status], ['Surf race, heat 3', 'https://openvibe.live/@surfwax', 'live', 'Europe/Paris', 'active']);
            assert.strictEqual((typeof row.rule === 'string' ? JSON.parse(row.rule) : row.rule).kind, 'once');
            const again = await t.get('/remind', { as: ana, form });
            assert.strictEqual(again.status, 200);
            assert.match(again.text, /Already set/);
            assert.strictEqual((await rows()).length, 1, 'set once');
            assert.ok((await t.get('/me', { as: ana })).text.includes('Surf race, heat 3'), 'on the agenda');
        });

        await check('a past time, a lead longer than the time left, a link that is not https, someone else\'s site', async () => {
            const past = await t.get('/remind', { as: ana, form: { title: 'Gone', at: new Date(Date.now() - hour).toISOString(), lead: '10' } });
            assert.strictEqual(past.status, 422);
            assert.match(past.text, /That time has already passed/);
            const soon = await t.get('/remind', { as: ana, form: { title: 'Soon', at: new Date(Date.now() + 2 * hour).toISOString(), lead: '1440' } });
            assert.strictEqual(soon.status, 201);
            const s = await t.ctx.s.db.maybe("SELECT * FROM today_my_reminders WHERE title = 'Soon'");
            assert.ok(Date.parse(s.next_at) - Date.now() < 5 * 60_000, 'the day before has passed: as soon as it can, never in the past');
            const odd = await t.get(`/remind?${new URLSearchParams({ title: '<b>Odd</b>', at, url: 'javascript:alert(1)' })}`, { as: ana });
            assert.ok(odd.text.includes('&lt;b&gt;Odd&lt;/b&gt;') && !odd.text.includes('<b>Odd</b>'), 'the title is text');
            assert.ok(!odd.text.includes('javascript:'), 'a link that is not https is dropped');
            const cross = await t.get('/remind', { as: ana, form: { ...Object.fromEntries(q), lead: '10' }, origin: 'https://evil.example' });
            assert.strictEqual(cross.status, 403, 'only openvibe.today itself may set it');
            const blank = await t.get('/remind?title=&at=', { as: ana });
            assert.match(blank.text, /Nothing to remind you of/);
        });
    } finally {
        await done(t);
    }
})();
