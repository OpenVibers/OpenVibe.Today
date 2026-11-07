'use strict';
// The menu's network card for OpenVibe.Today (frame.menu-card@1): GET /.well-known/openvibe-menu.json serves
// "Today" — the next real public events left today, or tomorrow's with the title "Tomorrow". The array validates
// against frame.menu-cards@1, never carries a cancelled, done or private event, is CORS * and cached for five minutes.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { createMenuCard, cardFrom, timeLabel, placeOf, CARD_TTL_S } = require('../server/menu-card');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const event = (over = {}) => ({
    id: 'ev1', title: 'A real stream', channel: 'nova', starts_at: '2026-11-07T14:00:00Z',
    tz: 'UTC', status: 'scheduled', kind: 'stream', visibility: 'public', url: null, ...over,
});

// ── Today's card: shape, words and contract ─────────────────────────────
const card = cardFrom([
    event({ id: 'past', starts_at: '2026-11-07T09:00:00Z' }),
    event({ id: 'done', status: 'done' }),
    event({ id: 'gone', status: 'cancelled' }),
    event({ id: 'ev2', title: '<b>Later</b>\nshow', channel: null, url: 'https://openvibe.live/@kitchen', starts_at: '2026-11-07T18:30:00Z' }),
    event({ id: 'ev1', title: 'A real stream', starts_at: '2026-11-07T14:00:00Z' }),
], NOW);
const checked = contracts.validate('frame.menu-cards@1', [card]);
assert.ok(checked.valid, JSON.stringify(checked.errors));
assert.deepStrictEqual(Object.keys(card).sort(), ['id', 'items', 'kind', 'more', 'site', 'title', 'ttl_s', 'updated_at']);
assert.strictEqual(card.id, 'today');
assert.strictEqual(card.site, 'today');
assert.strictEqual(card.title, 'Today');
assert.strictEqual(card.kind, 'rows');
assert.strictEqual(card.ttl_s, CARD_TTL_S);
assert.deepStrictEqual(card.items, [
    { title: 'A real stream', meta: '14:00 UTC · @nova', url: 'https://openvibe.today/e/ev1' },
    { title: 'Later show', meta: '18:30 UTC · openvibe.live', url: 'https://openvibe.today/e/ev2' },
]);
assert.deepStrictEqual(card.more, { label: 'Full schedule', url: 'https://openvibe.today/' });
assert.ok(card.title.length <= 60);
for (const it of card.items) assert.ok(it.title.length <= 80 && (!it.meta || it.meta.length <= 120) && it.url.startsWith('https://openvibe.today/e/'));

// Nothing left today: tomorrow's events are shown and the card says "Tomorrow".
const tomorrow = cardFrom([
    event({ id: 'ev3', title: 'Tomorrow workshop', starts_at: '2026-11-08T10:00:00Z' }),
    event({ id: 'ev4', title: 'Tomorrow stream', starts_at: '2026-11-08T20:00:00Z' }),
], NOW);
assert.strictEqual(tomorrow.title, 'Tomorrow');
assert.deepStrictEqual(tomorrow.items.map((i) => i.title), ['Tomorrow workshop', 'Tomorrow stream']);
assert.ok(contracts.validate('frame.menu-cards@1', [tomorrow]).valid);

// No entries at all (or none the card may show): an empty items array, still a valid card, and Network skips it.
const empty = cardFrom([event({ starts_at: '2026-11-07T09:00:00Z' })], NOW);
assert.deepStrictEqual(empty.items, []);
assert.strictEqual(empty.title, 'Today');
assert.ok(contracts.validate('frame.menu-cards@1', [empty]).valid);
assert.deepStrictEqual(cardFrom(null, NOW).items, []);
assert.deepStrictEqual(cardFrom([event({ visibility: 'followers' }), event({ title: '  ' })], NOW).items, []);

// At most six entries, in start order.
const many = Array.from({ length: 9 }, (_, i) => event({ id: `ev${i}`, title: `Event ${i}`, starts_at: `2026-11-07T${String(13 + i).padStart(2, '0')}:00:00Z` }));
assert.strictEqual(cardFrom(many, NOW).items.length, 6);

// Hours are shown in the event's own zone, and a place is the channel, the link's host, or the site.
assert.strictEqual(timeLabel('2026-11-07T14:00:00Z', 'UTC'), '14:00 UTC');
assert.ok(timeLabel('2026-11-07T14:00:00Z', 'America/New_York').startsWith('09:00 '), 'the event\'s own zone is named');
assert.strictEqual(placeOf(event()), '@nova');
assert.strictEqual(placeOf(event({ channel: null, url: 'https://openvibe.live/@kitchen' })), 'openvibe.live');
assert.strictEqual(placeOf(event({ channel: null })), 'OpenVibe.Today');

// ── The five-minute cache and the route's headers ───────────────────────
(async () => {
    let t = NOW;
    let loads = 0;
    const menu = createMenuCard({ load: async () => { loads++; return [event()]; }, now: () => t });
    const first = await menu.card();
    assert.strictEqual(loads, 1);
    assert.strictEqual(await menu.card(), first);
    assert.strictEqual(loads, 1, 'a second request inside the ttl is served from the cache');
    t += CARD_TTL_S * 1000 + 1;
    await menu.card();
    assert.strictEqual(loads, 2, 'after the ttl the card is rebuilt');

    const headers = {};
    let body = null;
    const res = {
        set(k, v) { headers[k] = v; return this; },
        json(v) { body = v; return this; },
    };
    await menu.handler({}, res);
    assert.strictEqual(headers['Access-Control-Allow-Origin'], '*');
    assert.strictEqual(headers['Cross-Origin-Resource-Policy'], 'cross-origin');
    assert.strictEqual(headers['Cache-Control'], 'public, max-age=60');
    assert.ok(Array.isArray(body) && body.length === 1, 'the file is an array of cards');
    assert.ok(contracts.validate('frame.menu-cards@1', body).valid);

    // A failing database keeps the last good card rather than publishing an empty schedule.
    let fail = false;
    const flaky = createMenuCard({ load: async () => { if (fail) throw new Error('db down'); return [event()]; }, now: () => t });
    const good = await flaky.card();
    fail = true;
    t += CARD_TTL_S * 1000 + 1;
    assert.strictEqual(await flaky.card(), good);

    console.log('menu card: shape, contract, today/tomorrow, empty schedule, plain text, 5 min cache, CORS and last-good card');
})().catch((err) => { console.error(err); process.exit(1); });
