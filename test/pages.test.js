'use strict';
/**
 * Server-rendered pages: the public schedule, a channel, one event with Event JSON-LD, the signed-in agenda, brief,
 * the plain schedule form (POST → /e/:id), developers, 404, cache headers and content-hashed assets.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { assetVersion } = require('../server/render/layout');

// One JSON-LD script per page: every node lives in the page's @graph.
function scripts(html) {
    return [...String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}
function jsonLd(html) {
    return scripts(html).flatMap((x) => (Array.isArray(x['@graph']) ? x['@graph'] : [x]));
}

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const at = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const created = await t.get('/api/v1/events', { as: alice, json: { kind: 'stream', title: 'Public stream', description: 'A description', starts_at: at, ends_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(), tz: 'Europe/Berlin' } });
    assert.strictEqual(created.status, 201);
    const event = created.json();

    await check('home: semantic, no-JavaScript navigation, the upcoming event, public cache with Vary: Cookie', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
        assert.strictEqual(r.headers.get('vary'), 'Cookie');
        for (const marker of ['id="td-home"', 'id="td-upcoming"', 'id="main"', '<noscript><nav', '<footer id="ov-footer"', 'Public stream']) assert.ok(r.text.includes(marker), marker);
        assert.strictEqual(scripts(r.text).length, 1, 'the page carries exactly one JSON-LD script');
        const types = jsonLd(r.text).map((x) => x['@type']);
        assert.ok(types.includes('WebSite'), types.join(','));
        assert.ok(types.includes('WebApplication'), types.join(','));
        // The day's list is dated, so each row is an Event node describing the event it links to.
        const events = jsonLd(r.text).filter((x) => x['@type'] === 'Event');
        assert.strictEqual(events.length, 1, 'one Event for the one event on the page');
        assert.strictEqual(events[0].name, 'Public stream');
        assert.strictEqual(events[0].startDate, event.starts_at);
        assert.strictEqual(events[0].url, `https://openvibe.today/e/${event.id}`);
        assert.strictEqual(events[0].organizer.name, '@alice');
        assert.ok(r.text.includes(`href="/e/${event.id}"`), "the Event's url is the row's link");
        // A page with nothing dated says so by having no Event node.
        const developers = jsonLd((await t.get('/developers')).text);
        assert.ok(!developers.some((x) => x['@type'] === 'Event'));
    });

    await check('a page drawn for a signed-in person is private, no-store', async () => {
        const r = await t.get('/', { as: alice });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.strictEqual(r.headers.get('vary'), 'Cookie');
    });

    await check('a channel page lists its public events and links the ICS feed', async () => {
        const r = await t.get('/@alice');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
        assert.ok(r.text.includes('id="td-channel"'));
        assert.ok(r.text.includes('Public stream'));
        assert.ok(r.text.includes('/ics/@alice.ics'));
        assert.strictEqual((await t.get('/@..bad')).status, 404);
    });

    await check('one event page carries schema.org Event JSON-LD', async () => {
        const r = await t.get(`/e/${event.id}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
        const ev = jsonLd(r.text).find((x) => x['@type'] === 'Event');
        assert.ok(ev, 'Event JSON-LD missing');
        assert.strictEqual(ev.name, 'Public stream');
        assert.strictEqual(ev.startDate, event.starts_at);
        assert.strictEqual(ev.endDate, event.ends_at);
        assert.strictEqual(ev.eventStatus, 'https://schema.org/EventScheduled');
        assert.strictEqual(ev.eventAttendanceMode, 'https://schema.org/OnlineEventAttendanceMode');
        assert.strictEqual(ev.location['@type'], 'VirtualLocation');
        assert.strictEqual(ev.location.url, 'https://openvibe.live/@alice');
        assert.ok(ev.organizer);
        assert.strictEqual((await t.get('/e/tev_DOESNOTEXIST0000000')).status, 404);
    });

    await check('a cancelled event answers with EventCancelled, and a followers-only event is private', async () => {
        const hidden = await t.get('/api/v1/events', { as: alice, json: { kind: 'event', title: 'Hidden', starts_at: at, tz: 'UTC', visibility: 'followers' } });
        const hid = hidden.json();
        assert.strictEqual((await t.get(`/e/${hid.id}`)).status, 404);
        assert.strictEqual((await t.get(`/e/${hid.id}`, { as: bob })).status, 404);
        assert.strictEqual((await t.get(`/e/${hid.id}`, { as: alice })).status, 200);
        const cancelled = await t.get(`/api/v1/events/${event.id}`, { as: alice, method: 'DELETE' });
        assert.strictEqual(cancelled.status, 200);
        const r = await t.get(`/e/${event.id}`);
        const ev = jsonLd(r.text).find((x) => x['@type'] === 'Event');
        assert.strictEqual(ev.eventStatus, 'https://schema.org/EventCancelled');
    });

    await check('/me is 401 signed out and shows the agenda, reminders and feed URL signed in', async () => {
        assert.strictEqual((await t.get('/me')).status, 401);
        const agendaItem = await t.get('/api/v1/events', { as: alice, json: { kind: 'stream', title: 'Agenda item', starts_at: new Date(Date.now() + 4 * 60 * 60_000).toISOString(), tz: 'Europe/Berlin' } });
        assert.strictEqual(agendaItem.status, 201);
        const r = await t.get('/me', { as: alice });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        assert.ok(r.text.includes('id="td-me"'));
        assert.ok(r.text.includes('Agenda item'));
        assert.match(r.text, /\/ics\/[A-Za-z0-9_-]{43}\.ics/);
        assert.ok(r.text.includes('action="/me/feed/rotate"'));
        const rotated = await t.get('/me/feed/rotate', { as: alice, method: 'POST', origin: 'https://openvibe.today' });
        assert.strictEqual(rotated.status, 303);
        assert.strictEqual(rotated.headers.get('location'), '/me');
        const cross = await t.get('/me/feed/rotate', { as: alice, method: 'POST', origin: 'https://evil.example' });
        assert.strictEqual(cross.status, 403);
    });

    await check('/brief is 401 signed out and renders sections signed in', async () => {
        assert.strictEqual((await t.get('/brief')).status, 401);
        // "Later today" needs an event still ahead on this UTC day. The /me check's event sits 4 h ahead, which is
        // tomorrow after 20:00 UTC, so this check makes its own: halfway to midnight (at most 4 h, at least 1 min). In
        // the day's last two minutes it waits for midnight first.
        let left = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1) - Date.now();
        if (left < 120_000) { await new Promise((ok) => setTimeout(ok, left + 1000)); left = 86_400_000; }
        const startsAt = new Date(Date.now() + Math.min(4 * 60 * 60_000, Math.max(60_000, Math.floor(left / 2)))).toISOString();
        const later = await t.get('/api/v1/events', { as: alice, json: { kind: 'stream', title: 'Brief item', starts_at: startsAt, tz: 'UTC' } });
        assert.strictEqual(later.status, 201);
        const r = await t.get('/brief', { as: alice });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('id="td-brief"'));
        assert.ok(r.text.includes('Later today'), 'the brief has a "Later today" section');
        assert.ok(r.text.includes('Brief item'), 'with the event still ahead today');
    });

    await check('/schedule: signed out 401; the plain form POSTs and redirects to /e/:id', async () => {
        assert.strictEqual((await t.get('/schedule')).status, 401);
        const form = await t.get('/schedule', { as: alice });
        assert.strictEqual(form.status, 200);
        assert.ok(form.text.includes('id="td-schedule-form"'));
        assert.ok(form.text.includes('method="post" action="/schedule"'));
        const local = new Date(Date.now() + 3 * 60 * 60_000).toISOString().slice(0, 16);
        const r = await t.get('/schedule', { as: alice, form: { kind: 'stream', title: 'From the form', starts_at: local, tz: 'Europe/Berlin', description: 'Form text', visibility: 'public' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        assert.match(r.headers.get('location'), /^\/e\/tev_/);
        const page = await t.get(r.headers.get('location'));
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('From the form'));
        const cross = await t.get('/schedule', { as: alice, origin: 'https://evil.example', form: { kind: 'event', title: 'Cross', starts_at: local, tz: 'UTC' } });
        assert.strictEqual(cross.status, 403);
        const bad = await t.get('/schedule', { as: alice, form: { kind: 'event', title: '', starts_at: local, tz: 'UTC' } });
        assert.strictEqual(bad.status, 400);
        assert.ok(bad.text.includes('id="td-schedule-form"'));
    });

    await check('/developers and the 404 page', async () => {
        const dev = await t.get('/developers');
        assert.strictEqual(dev.status, 200);
        assert.strictEqual(dev.headers.get('cache-control'), 'public, max-age=60');
        assert.ok(dev.text.includes('id="td-developers"'));
        assert.ok(dev.text.includes('/api/v1/events'));
        const nf = await t.get('/no/such/page');
        assert.strictEqual(nf.status, 404);
        assert.match(nf.headers.get('content-type'), /^text\/html/);
        assert.ok(nf.text.includes('Not on the calendar'));
    });

    await check('assets are content-hashed and served with the shared cache policy', async () => {
        const v = assetVersion('css/today.css');
        const hashed = await t.get(`/css/today.css?v=${v}`);
        assert.strictEqual(hashed.status, 200);
        assert.strictEqual(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        const wrong = await t.get('/css/today.css?v=deadbeefdeadbeef');
        assert.strictEqual(wrong.status, 200);
        assert.strictEqual(wrong.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
        const js = await t.get('/js/today.js');
        assert.strictEqual(js.status, 200);
        assert.match(js.headers.get('content-type'), /javascript/);
    });

    await t.close();
    done();
})();
