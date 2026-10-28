'use strict';
/**
 * The brief: sections from real rows (later today, today's reminders), up to three Rundown items, the Rundown
 * section omitted when Live fails, and one stored brief per subject per day.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

async function startLive() {
    let fail = false;
    const server = http.createServer((req, res) => {
        if (req.url !== '/api/rundown') { res.writeHead(404); res.end('{}'); return; }
        if (fail) { res.writeHead(500); res.end('{}'); return; }
        const now = Date.now();
        const yesterday = new Date(now - 24 * 60 * 60_000).toISOString();
        const today = new Date(now).toISOString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            lead: { type: 'segment', stream_id: 11, said_at: yesterday, take: 'The lead take', user: { username: 'carl', display_name: 'Carl' }, topic: { slug: 'lead-topic', title: 'Lead topic' } },
            streams: [
                { stream_id: 12, said_at: yesterday, episode: { stream_id: 12, title: 'Episode twelve', aired_at: yesterday, user: { username: 'dana', display_name: 'Dana' } } },
                { stream_id: 13, said_at: yesterday, episode: { stream_id: 13, title: 'Episode thirteen', aired_at: yesterday, user: { username: 'erin', display_name: 'Erin' } } },
                { stream_id: 14, said_at: today, episode: { stream_id: 14, title: 'Today episode', aired_at: today, user: { username: 'frank' } } },
            ],
            trending: [{ slug: 'trend', title: 'A trend', headline: 'Trending headline', streamers: 3, last_seen_at: yesterday }],
        }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, fail(v) { fail = v; }, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const live = await startLive();
    const t = await boot({ env: { OV_LIVE_INTERNAL_URL: live.url } });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const now = Date.now();
    const at = (mins) => new Date(now + mins * 60_000).toISOString();
    // Choose a zone in which now and the next three hours are the same calendar day, so "later today" is stable
    // whatever time of day the suite runs.
    const { dayIn } = require('../server/brief');
    const tz = ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland', 'America/Los_Angeles']
        .find((z) => dayIn(z, now) === dayIn(z, now + 3 * 60 * 60_000)) || 'UTC';

    const own = (await t.get('/api/v1/events', { as: alice, json: { kind: 'stream', title: 'My later stream', starts_at: at(120), tz } })).json();
    const tomorrow = (await t.get('/api/v1/events', { as: alice, json: { kind: 'event', title: 'Tomorrow thing', starts_at: at(30 * 60), tz } })).json();
    const bobEvent = (await t.get('/api/v1/events', { as: bob, json: { kind: 'event', title: 'Bob reminder', starts_at: at(180), tz } })).json();
    await t.get(`/api/v1/events/${bobEvent.id}/remind`, { as: alice, json: { minutes_before: 30 } });

    await check('sections come from the agenda, today\'s reminders and the Rundown', async () => {
        const brief = await t.ctx.brief.buildBrief(alice.subject, { now, tz });
        assert.match(brief.day, /^\d{4}-\d{2}-\d{2}$/);
        const byId = Object.fromEntries(brief.sections.map((s) => [s.id, s]));
        assert.ok(byId['later-today'], 'Later today');
        assert.ok(byId['later-today'].items.some((i) => i.text.includes('My later stream')));
        assert.ok(!byId['later-today'].items.some((i) => i.text.includes('Tomorrow thing')), 'tomorrow is not today');
        assert.ok(byId['later-today'].items.every((i) => i.action === 'remind'));
        assert.ok(byId['later-today'].items.every((i) => i.url.startsWith('https://openvibe.today/e/')));
        assert.ok(byId['your-reminders'], 'Your reminders');
        assert.ok(byId['your-reminders'].items.some((i) => i.text.includes('Bob reminder')));
        assert.ok(byId.yesterday, 'Yesterday on OpenVibe');
        assert.ok(byId.yesterday.items.length <= 3);
        assert.ok(byId.yesterday.items.some((i) => i.url === 'https://openvibe.live/rundown/t/lead-topic'));
        assert.ok(byId.yesterday.items.some((i) => i.url.includes('/rundown/e/12')));
        assert.ok(!byId.yesterday.items.some((i) => i.url.includes('/rundown/e/14')), 'today\'s item is not yesterday');
        assert.ok(byId.yesterday.items.every((i) => i.action === null));
    });

    await check('GET /me/brief builds on demand and stores one brief per subject per day', async () => {
        const r = await t.get(`/api/v1/me/brief?tz=${encodeURIComponent(tz)}`, { as: alice });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(r.json().sections.some((s) => s.id === 'later-today'));
        const again = await t.get(`/api/v1/me/brief?tz=${encodeURIComponent(tz)}`, { as: alice });
        assert.strictEqual(again.status, 200);
        assert.strictEqual(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_briefs WHERE subject = $1', [alice.subject]), 1);
        assert.strictEqual((await t.get('/api/v1/me/brief?tz=Nope/Zone', { as: alice })).status, 400);
        assert.strictEqual((await t.get('/api/v1/me/brief')).status, 401);
    });

    await check('the Rundown section is omitted when Live fails', async () => {
        const carol = t.network.addUser('carol');
        await t.get('/api/v1/events', { as: carol, json: { kind: 'event', title: 'Carol today', starts_at: at(60), tz } });
        live.fail(true);
        try {
            const brief = await t.ctx.brief.buildBrief(carol.subject, { now, tz });
            assert.ok(brief.sections.some((s) => s.id === 'later-today'));
            assert.ok(!brief.sections.some((s) => s.id === 'yesterday'), 'no fake Rundown section');
        } finally {
            live.fail(false);
        }
    });

    await check('the daily job builds for subjects active in the last 30 days', async () => {
        const six = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate(), 6, 0, 0));
        const r = await t.ctx.brief.runOnce({ now: six.getTime(), force: true });
        assert.ok(r.subjects >= 2, `active subjects: ${r.subjects}`);
        assert.ok(r.built >= 2);
        const n = await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_briefs');
        assert.ok(n >= 2);
        // The same run again does not add a second brief for the same day.
        const before = Number(n);
        await t.ctx.brief.runOnce({ now: six.getTime(), force: true });
        assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_briefs')), before);
    });

    await t.close();
    await live.close();
    done();
})();
