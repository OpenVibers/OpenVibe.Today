'use strict';

/**
 * The follow graph from OpenVibe.Network, read with the person's own token (GET /api/v1/me/follows), cached 60 s
 * per subject. A followed channel's target_id is its owner's usr_ subject, which is what today_events.owner_subject
 * stores. A failure returns no follows and `unavailable: true`: the agenda still answers with the person's own and
 * reminded events.
 */
function createFollows({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const cache = new Map();      // subject -> { at, expires, follows, unavailable }
    const lastGood = new Map();   // subject -> the last successful follows, for a token feed with no Network token
    const ttl = config.follows.cacheMs;

    async function fetchFollows(token) {
        const res = await fetchImpl(`${config.networkUrl}/api/v1/me/follows?type=channel&limit=200`, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`follows ${res.status}`);
        const body = await res.json().catch(() => null);
        if (!body || !Array.isArray(body.items)) throw new Error('follows: no items');
        const targets = [];
        for (const item of body.items) {
            if (item && item.target_type === 'channel' && typeof item.target_id === 'string' && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(item.target_id)) targets.push(item.target_id);
        }
        return [...new Set(targets)];
    }

    async function forSubject(subject, token) {
        const hit = cache.get(subject);
        if (hit && ttl > 0 && hit.expires > now()) return { follows: hit.follows, unavailable: hit.unavailable };
        try {
            const follows = await fetchFollows(token);
            cache.set(subject, { at: now(), expires: now() + ttl, follows, unavailable: false });
            lastGood.set(subject, follows);
            return { follows, unavailable: false };
        } catch (err) {
            log.warn(`[OpenVibe.Today] follows unavailable for ${subject}: ${(err && err.message) || err}`);
            cache.set(subject, { at: now(), expires: now() + ttl, follows: [], unavailable: true });
            return { follows: [], unavailable: true };
        }
    }

    /** The last successful follows for a subject, even after the 60 s cache: a token feed has no person token. */
    function peek(subject) {
        return [...(lastGood.get(subject) || [])];
    }

    function clear(subject = null) {
        if (subject) { cache.delete(subject); lastGood.delete(subject); } else { cache.clear(); lastGood.clear(); }
    }

    return { forSubject, peek, clear, cache, lastGood };
}

module.exports = { createFollows };
