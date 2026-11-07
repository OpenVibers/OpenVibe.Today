'use strict';
// The menu's network card for OpenVibe.Today (frame.menu-card@1): GET /.well-known/openvibe-menu.json serves
// today's next public events within seven days — "Today", "Tomorrow" or "Next 7 days" — each with its own day,
// time and channel or place. The array validates against frame.menu-cards@1, never carries a cancelled, done,
// private or out-of-window event, is CORS * and cached for five minutes. With nothing upcoming the card stays
// empty: the schedule is honest.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { createMenuCard, cardFrom, dayLabel, timeLabel, placeOf, upcomingRows, CARD_TTL_S } = require('../server/menu-card');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const event = (over = {}) => ({
    id: 'ev1', title: 'A real stream', channel: 'nova', starts_at: '2026-11-07T14:00:00Z',
    tz: 'UTC', status: 'scheduled', kind: 'stream', visibility: 'public', url: null, ...over,
});

// ── The card: shape, words, window and contract ─────────────────────────
const card = cardFrom([
    event({ id: 'past', starts_at: '2026-11-07T09:00:00Z' }),
    event({ id: 'done', status: 'done' }),
    event({ id: 'gone', status: 'cancelled' }),
    event({ id: 'ev2', title: '<b>Later</b>\nshow', channel: null, url: 'https://openvibe.live/@kitchen', starts_at: '2026-11-07T18:30:00Z' }),
    event({ id: 'ev1', title: 'A real stream', starts_at: '2026-11-07T14:00:00Z' }),
    event({ id: 'ev3', title: 'Tomorrow workshop', starts_at: '2026-11-08T10:00:00Z' }),
    event({ id: 'ev4', title: 'Tuesday meetup', starts_at: '2026-11-10T09:00:00Z' }),
    event({ id: 'too-far', title: 'Next week', starts_at: '2026-11-15T12:01:00Z' }),
    event({ id: 'private', title: 'Followers only', visibility: 'followers' }),
    event({ id: 'blank', title: '  ' }),
], NOW);
const checked = contracts.validate('frame.menu-cards@1', [card]);

// ── Holidays only when nothing else is on this week (11-07) ──
(async () => {
    const asked = [];
    const store = (rows) => ({ listPublic: async (q) => { asked.push(q); return rows(q); } });
    const holiday = event({ id: 'h1', title: 'Veterans Day', kind: 'holiday', starts_at: '2026-11-11T00:00:00Z' });
    const quiet = await upcomingRows(store((q) => (q.kinds ? [holiday] : [])), NOW);
    assert.deepStrictEqual(quiet.map((r) => r.id), ['h1'], 'a quiet week shows its holidays');
    assert.deepStrictEqual(cardFrom(quiet, NOW).items[0].meta, 'Wed 11 Nov · Holiday', 'a holiday reads as a day, not 00:00');
    assert.deepStrictEqual(asked.map((q) => [q.exceptKinds || null, q.kinds || null]), [[['holiday'], null], [null, ['holiday']]]);
    asked.length = 0;
    const busy = await upcomingRows(store((q) => (q.kinds ? [holiday] : [event()])), NOW);
    assert.deepStrictEqual(busy.map((r) => r.id), ['ev1'], 'a real event comes first, and holidays are not asked for');
    assert.strictEqual(asked.length, 1);
    // A stream already live is not upcoming: the week is still quiet, and its holidays show, each name once.
    asked.length = 0;
    const liveNow = event({ id: 'live', status: 'live', starts_at: '2026-11-07T11:00:00Z' });
    const twice = event({ id: 'h2', title: 'Veterans Day', kind: 'holiday', starts_at: '2026-11-11T05:00:00Z' });
    const quietButLive = await upcomingRows(store((q) => (q.kinds ? [holiday, twice] : [liveNow])), NOW);
    assert.deepStrictEqual(quietButLive.map((r) => r.id), ['live', 'h1'], 'holidays come in, each name once');
    assert.deepStrictEqual(cardFrom(quietButLive, NOW).items.map((i) => i.title), ['Veterans Day'], 'and the card shows the holiday');
    // A holiday stored at local midnight reads as its own day: Paris's 11 Nov starts 23:00 UTC on the 10th.
    const paris = event({ id: 'h3', title: 'Armistice Day', kind: 'holiday', tz: 'Europe/Paris', starts_at: '2026-11-10T23:00:00Z' });
    assert.strictEqual(cardFrom([paris], NOW).items[0].meta, 'Wed 11 Nov · Holiday');
})().catch((e) => { console.error(e); process.exit(1); });
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
    { title: 'Tomorrow workshop', meta: 'Tomorrow · 10:00 UTC · @nova', url: 'https://openvibe.today/e/ev3' },
    { title: 'Tuesday meetup', meta: 'Tue 10 Nov · 09:00 UTC · @nova', url: 'https://openvibe.today/e/ev4' },
]);
assert.deepStrictEqual(card.more, { label: 'Full schedule', url: 'https://openvibe.today/' });
assert.ok(card.title.length <= 60);
for (const it of card.items) assert.ok(it.title.length <= 80 && (!it.meta || it.meta.length <= 120) && it.url.startsWith('https://openvibe.today/e/'));

// The title follows the first event's day; later within the week is "Next 7 days".
const tomorrow = cardFrom([
    event({ id: 'ev3', title: 'Tomorrow workshop', starts_at: '2026-11-08T10:00:00Z' }),
    event({ id: 'ev4', title: 'Tuesday meetup', starts_at: '2026-11-10T09:00:00Z' }),
], NOW);
assert.strictEqual(tomorrow.title, 'Tomorrow');
assert.deepStrictEqual(tomorrow.items.map((i) => i.title), ['Tomorrow workshop', 'Tuesday meetup']);
assert.ok(contracts.validate('frame.menu-cards@1', [tomorrow]).valid);
const later = cardFrom([event({ id: 'ev4', title: 'Tuesday meetup', starts_at: '2026-11-10T09:00:00Z' })], NOW);
assert.strictEqual(later.title, 'Next 7 days');
assert.deepStrictEqual(later.items.map((i) => i.title), ['Tuesday meetup']);

// No entries at all (or none the card may show, or none inside the week): an empty items array, still a valid
// card, and Network skips it. Nothing stale is ever put there to fill the card.
for (const rows of [
    [event({ starts_at: '2026-11-07T09:00:00Z' })],
    [event({ id: 'far', starts_at: '2026-11-15T12:01:00Z' })],
    [event({ visibility: 'followers' }), event({ title: '  ' })],
    null,
]) {
    const empty = cardFrom(rows, NOW);
    assert.deepStrictEqual(empty.items, []);
    assert.strictEqual(empty.title, 'Today');
    assert.ok(contracts.validate('frame.menu-cards@1', [empty]).valid);
}

// At most six entries, in start order.
const many = Array.from({ length: 9 }, (_, i) => event({ id: `ev${i}`, title: `Event ${i}`, starts_at: new Date(NOW + (i + 1) * 6 * 60 * 60_000).toISOString() }));
const six = cardFrom(many, NOW);
assert.strictEqual(six.items.length, 6);
assert.deepStrictEqual(six.items.map((i) => i.title), ['Event 0', 'Event 1', 'Event 2', 'Event 3', 'Event 4', 'Event 5']);

// Days, hours and places are plain words in the event's own zone.
assert.strictEqual(dayLabel('2026-11-07T14:00:00Z', NOW), '');
assert.strictEqual(dayLabel('2026-11-08T10:00:00Z', NOW), 'Tomorrow');
assert.strictEqual(dayLabel('2026-11-10T09:00:00Z', NOW), 'Tue 10 Nov');
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

    console.log('menu card: 7-day window, day labels, empty schedule, plain text, 5 min cache, CORS and last-good card');
})().catch((err) => { console.error(err); process.exit(1); });
