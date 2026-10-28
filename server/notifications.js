'use strict';

/**
 * Network notifications for a due reminder. A reminder row stores the person's usr_ subject; Network's push route
 * wants its numeric user id, resolved in batches through POST /internal/identity/resolve-batch and cached. Both calls
 * use this service's own client-credentials token for audience openvibe.network (identity.subject.resolve and
 * network.notifications.push).
 */
const { serviceAuth } = require('openvibe-contracts');

function createNotifier({ config, s, fetchImpl = globalThis.fetch, log = console }) {
    const cache = new Map();   // subject -> { at, expires, userId }
    const ttl = config.notifications.resolveCacheMs;
    const canSend = Boolean(config.oauth.clientSecret);
    const identityTokens = canSend ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'identity.subject.resolve', fetchImpl,
    }) : null;
    const pushTokens = canSend ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'network.notifications.push', fetchImpl,
    }) : null;

    async function resolveUserIds(subjects) {
        const out = new Map();
        const missing = [];
        for (const subject of subjects) {
            const hit = cache.get(subject);
            if (hit && (ttl === 0 || hit.expires > s.now())) { out.set(subject, hit.userId); } else missing.push(subject);
        }
        const unique = [...new Set(missing)].filter((x) => typeof x === 'string' && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(x));
        for (let i = 0; i < unique.length; i += 500) {
            const batch = unique.slice(i, i + 500);
            const res = await fetchImpl(`${config.networkInternalUrl}/internal/identity/resolve-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await identityTokens.authHeaders()) },
                body: JSON.stringify({ subject_ids: batch }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`identity resolve-batch ${res.status}`);
            const body = await res.json().catch(() => null);
            const results = (body && body.results) || {};
            for (const subject of batch) {
                const user = results[subject];
                const userId = user && Number.isFinite(Number(user.network_user_id)) ? Number(user.network_user_id) : null;
                cache.set(subject, { at: s.now(), expires: s.now() + ttl, userId });
                out.set(subject, userId);
            }
        }
        return out;
    }

    function titleFor(event, now) {
        if (event.status === 'live') return `${event.title} is live now`;
        const minutes = Math.max(0, Math.round((new Date(event.starts_at).getTime() - now) / 60_000));
        return `${event.title} starts in ${minutes} min`;
    }

    async function sendReminder({ subject, event, now = s.now() }) {
        if (!canSend) throw new Error('TODAY_OAUTH_CLIENT_SECRET is not set: Today cannot send a notification');
        const ids = await resolveUserIds([subject]);
        const userId = ids.get(subject);
        if (!userId) {
            log.warn(`[OpenVibe.Today] reminder for ${subject}: Network has no user id for that subject`);
            return { ok: false, reason: 'no_user' };
        }
        const title = titleFor(event, now);
        const body = {
            user_id: userId,
            type: 'TODAY_REMINDER',
            category: event.kind === 'stream' ? 'stream' : 'system',
            priority: 'normal',
            icon: '⏰',
            title,
            service: 'today',
            url: `${String(config.baseUrl).replace(/\/+$/, '')}/e/${event.id}`,
        };
        const res = await fetchImpl(`${config.networkInternalUrl}/internal/notifications/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await pushTokens.authHeaders()) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`notification push ${res.status}`);
        return { ok: true, user_id: userId, title };
    }

    function clear(subject = null) { if (subject) cache.delete(subject); else cache.clear(); }

    return { sendReminder, resolveUserIds, clear, titleFor, canSend };
}

module.exports = { createNotifier };
