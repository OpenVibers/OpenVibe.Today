'use strict';
/**
 * RFC 5545: CRLF, 75-octet folding with multibyte text, TEXT escaping, UID/SEQUENCE/STATUS, a cancelled event as
 * CANCELLED for 7 days then gone, a private token feed that rotation invalidates at once, and a channel's public
 * calendar.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const CRLF = '\r\n';
function unfold(text) {
    return String(text).replace(/\r\n[ \t]/g, '');
}
function lines(text) { return String(text).split(CRLF); }

(async () => {
    let clock = Date.now();
    const t = await boot({ now: () => clock });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const starts = () => new Date(clock + 24 * 60 * 60_000).toISOString();

    let eventId = null;
    await check('channel calendar: CRLF, folding ≤ 75 octets, escaping, UID/SEQUENCE/STATUS', async () => {
        const title = `A, B; C\\D — ${'é'.repeat(80)}`;
        const description = `line one\nline two, with; punctuation\\`;
        const r = await t.get('/api/v1/events', { as: alice, json: { kind: 'stream', title, description, starts_at: starts(), tz: 'Europe/Berlin' } });
        assert.strictEqual(r.status, 201, r.text);
        eventId = r.json().id;
        const ics = await t.get('/ics/@alice.ics');
        assert.strictEqual(ics.status, 200);
        assert.strictEqual(ics.headers.get('content-type'), 'text/calendar; charset=utf-8');
        assert.strictEqual(ics.headers.get('cache-control'), 'public, max-age=300');
        assert.ok(!/[^\r]\n/.test(ics.text), 'every line ends CRLF');
        assert.ok(ics.text.endsWith(CRLF));
        for (const line of lines(ics.text)) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `folded line ${Buffer.byteLength(line, 'utf8')} octets: ${line.slice(0, 20)}`);
        const body = unfold(ics.text);
        for (const line of ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenVibe//Today//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:OpenVibe.Today — @alice']) assert.ok(body.includes(line), line);
        assert.ok(body.includes(`UID:${eventId}@openvibe.today`));
        assert.match(body, /DTSTAMP:\d{8}T\d{6}Z/);
        assert.match(body, /DTSTART:\d{8}T\d{6}Z/);
        assert.match(body, /DTEND:\d{8}T\d{6}Z/);
        assert.ok(body.includes('SEQUENCE:0'));
        assert.ok(body.includes('STATUS:CONFIRMED'));
        assert.match(body, /LAST-MODIFIED:\d{8}T\d{6}Z/);
        // TEXT escaping: comma, semicolon, backslash and the newline, with the multibyte title intact.
        assert.ok(body.includes('SUMMARY:A\\, B\\; C\\\\D — ' + 'é'.repeat(80)), 'the title is escaped and intact');
        assert.ok(body.includes('DESCRIPTION:line one\\nline two\\, with\\; punctuation\\\\'), 'the description is escaped');
        // No end given: DTEND is one hour after DTSTART.
        const dtstart = /DTSTART:(\d{8}T\d{6}Z)/.exec(body)[1];
        const dtend = /DTEND:(\d{8}T\d{6}Z)/.exec(body)[1];
        const parse = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
        assert.strictEqual(parse(dtend) - parse(dtstart), 60 * 60_000);
    });

    await check('a patch raises SEQUENCE in every feed', async () => {
        const r = await t.get(`/api/v1/events/${eventId}`, { as: alice, method: 'PATCH', json: { title: 'Changed' } });
        assert.strictEqual(r.status, 200);
        const ics = await t.get('/ics/@alice.ics');
        assert.ok(unfold(ics.text).includes('SEQUENCE:1'));
        assert.strictEqual((await t.get(`/api/v1/events/${eventId}`, { as: alice, method: 'PATCH', json: { title: 'Changed again' } })).json().seq, 2);
    });

    await check('a cancelled event is STATUS:CANCELLED for 7 days, then dropped', async () => {
        const r = await t.get(`/api/v1/events/${eventId}`, { as: alice, method: 'DELETE' });
        assert.strictEqual(r.status, 200);
        let ics = await t.get('/ics/@alice.ics');
        assert.ok(unfold(ics.text).includes('STATUS:CANCELLED'), 'still in the feed to remove it');
        assert.ok(unfold(ics.text).includes('SEQUENCE:3'));
        clock += 8 * 24 * 60 * 60_000;
        ics = await t.get('/ics/@alice.ics');
        assert.ok(!unfold(ics.text).includes(eventId), 'dropped after 7 days');
        assert.ok(!unfold(ics.text).includes('STATUS:CANCELLED'));
    });

    await check('the private token feed is the owner\'s, and rotation makes the old URL 404 at once', async () => {
        clock = Date.now();
        const created = await t.get('/api/v1/events', { as: alice, json: { kind: 'stream', title: 'Private agenda item', starts_at: starts(), tz: 'UTC' } });
        assert.strictEqual(created.status, 201);
        const f = await t.get('/api/v1/me/feed', { as: alice });
        assert.strictEqual(f.status, 200, f.text);
        const path = new URL(f.json().url).pathname;
        const ics = await t.get(path);
        assert.strictEqual(ics.status, 200);
        assert.strictEqual(ics.headers.get('cache-control'), 'private, max-age=300');
        assert.ok(unfold(ics.text).includes('Private agenda item'));
        const rotated = await t.get('/api/v1/me/feed/rotate', { as: alice, method: 'POST' });
        assert.strictEqual(rotated.status, 200);
        assert.notStrictEqual(rotated.json().url, f.json().url);
        assert.strictEqual((await t.get(path)).status, 404, 'the old URL is gone');
        const fresh = await t.get(new URL(rotated.json().url).pathname);
        assert.strictEqual(fresh.status, 200);
        assert.ok(unfold(fresh.text).includes('Private agenda item'));
        // Someone else's token feed is not this person's.
        const bf = await t.get('/api/v1/me/feed', { as: bob });
        assert.notStrictEqual(new URL(bf.json().url).pathname, new URL(rotated.json().url).pathname);
    });

    await check('the private feed includes followed channels once Today has read the person\'s follows', async () => {
        const carol = t.network.addUser('carol');
        t.network.setFollow(alice, carol.subject);
        t.ctx.follows.clear(alice.subject);   // a follow made after the 60 s cache was read
        const current = await t.get('/api/v1/me/feed', { as: alice });
        const path = new URL(current.json().url).pathname;
        const made = await t.get('/api/v1/events', { as: carol, json: { kind: 'stream', title: 'Followed channel stream', starts_at: starts(), tz: 'UTC' } });
        assert.strictEqual(made.status, 201);
        const ics = await t.get(path);
        assert.strictEqual(ics.status, 200);
        assert.ok(unfold(ics.text).includes('Followed channel stream'));
    });

    await check('the channel feed carries public events only', async () => {
        const hidden = await t.get('/api/v1/events', { as: alice, json: { kind: 'event', title: 'Followers only', starts_at: starts(), tz: 'UTC', visibility: 'followers' } });
        assert.strictEqual(hidden.status, 201);
        const ics = await t.get('/ics/@alice.ics');
        assert.ok(unfold(ics.text).includes('Private agenda item'), 'the public one is there');
        assert.ok(!unfold(ics.text).includes('Followers only'), 'the followers-only one is not');
        assert.strictEqual((await t.get('/ics/@nobody.ics')).status, 200);
        assert.strictEqual((await t.get('/ics/@..bad.ics')).status, 404);
        assert.strictEqual((await t.get('/ics/no-such-token.ics')).status, 404);
    });

    await t.close();
    done();
})();
