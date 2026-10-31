'use strict';
/**
 * The agenda: the caller's own events, the events they set a reminder on and the public or followers-only events of
 * the channels they follow. Follows come from Network with the person's token; when Network is down the agenda still
 * answers with own and reminded events and follows_unavailable: true.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const carol = t.network.addUser('carol');
    const at = (mins) => new Date(Date.now() + mins * 60_000).toISOString();
    const create = async (user, title, opts = {}) => {
        const r = await t.get('/api/v1/events', { as: user, json: { kind: opts.kind || 'stream', title, starts_at: opts.starts_at || at(60), tz: 'UTC', ...(opts.visibility ? { visibility: opts.visibility } : {}) } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json();
    };

    let own;
    let reminded;
    let followed;
    let followedPrivate;

    await check('own + reminded + followed channels\' events, and nothing else', async () => {
        own = await create(alice, 'My own stream', { starts_at: at(30) });
        reminded = await create(bob, 'Bob reminded', { starts_at: at(90) });
        followed = await create(carol, 'Carol public', { starts_at: at(120) });
        followedPrivate = await create(carol, 'Carol followers', { starts_at: at(150), visibility: 'followers' });
        const unfollowed = await create(bob, 'Bob not followed', { starts_at: at(180) });
        await t.get(`/api/v1/events/${reminded.id}/remind`, { as: alice, json: { minutes_before: 5 } });
        t.network.setFollow(alice, carol.subject);
        const r = await t.get('/api/v1/me/agenda?days=14', { as: alice });
        assert.strictEqual(r.status, 200, r.text);
        const b = r.json();
        assert.strictEqual(b.days, 14);
        assert.strictEqual(b.follows_unavailable, false);
        const ids = b.events.map((e) => e.id);
        assert.ok(ids.includes(own.id), 'own');
        assert.ok(ids.includes(reminded.id), 'reminded');
        assert.ok(ids.includes(followed.id), 'followed public');
        assert.ok(ids.includes(followedPrivate.id), 'followed followers-only');
        assert.ok(!ids.includes(unfollowed.id), 'not followed and not reminded');
        assert.strictEqual(b.events.find((e) => e.id === own.id).own, true);
        assert.strictEqual(b.events.find((e) => e.id === reminded.id).reminded, true);
        // Followed channels come first, then everything is soonest first. Carol's two events start after alice's
        // own one, so this also proves the agenda is not merely sorting by starts_at.
        const followedIds = new Set([followed.id, followedPrivate.id]);
        assert.ok(ids.slice(0, 2).every((id) => followedIds.has(id)), `followed first: ${ids.join(', ')}`);
        const rest = ids.slice(2);
        assert.deepStrictEqual(rest, [...rest].sort((x, y) => {
            const a = b.events.find((e) => e.id === x); const c = b.events.find((e) => e.id === y);
            return new Date(a.starts_at) - new Date(c.starts_at);
        }));
    });

    await check('an anonymous caller is 401 and days is validated', async () => {
        assert.strictEqual((await t.get('/api/v1/me/agenda')).status, 401);
        assert.strictEqual((await t.get('/api/v1/me/agenda?days=0', { as: alice })).status, 400);
        assert.strictEqual((await t.get('/api/v1/me/agenda?days=61', { as: alice })).status, 400);
        assert.strictEqual((await t.get('/api/v1/me/agenda?days=60', { as: alice })).status, 200);
    });

    await check('Network down: own and reminded events still answer, follows_unavailable true', async () => {
        const dave = t.network.addUser('dave');
        const mine = await create(dave, 'Dave own', { starts_at: at(45) });
        t.network.setFollow(dave, carol.subject);
        t.network.setDown(true);
        const r = await t.get('/api/v1/me/agenda', { as: dave });
        assert.strictEqual(r.status, 200, r.text);
        const b = r.json();
        assert.strictEqual(b.follows_unavailable, true);
        assert.deepStrictEqual(b.events.map((e) => e.id), [mine.id]);
        t.network.setDown(false);
    });

    await check('the reminders API lists upcoming reminders only', async () => {
        const r = await t.get('/api/v1/me/reminders', { as: alice });
        assert.strictEqual(r.status, 200);
        assert.ok(r.json().reminders.some((x) => x.event_id === reminded.id));
        const removed = await t.get(`/api/v1/events/${reminded.id}/remind`, { as: alice, method: 'DELETE' });
        assert.strictEqual(removed.status, 200);
        assert.strictEqual(removed.json().removed, true);
        const after = await t.get('/api/v1/me/reminders', { as: alice });
        assert.ok(!after.json().reminders.some((x) => x.event_id === reminded.id));
    });

    await t.close();
    done();
})();
