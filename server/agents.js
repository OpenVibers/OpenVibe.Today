'use strict';
/**
 * Agent streams on Today (Agent Streams S7, design 2026-11-06 §1 and §3).
 *
 *   - Agents live: the public agent streams that are live now, one card each, followed channels first and then the
 *     most watched. They are their own section, never mixed into people's streams or the calendar rows.
 *   - Scheduled: public agent streams that start in the next 24 hours (the design's window).
 *   - Your agents this week: the person's own session reports from OpenVibe.Report, private to them.
 *
 * The public reads never take a person's token: Live's agent list is public. The followed-first order uses Network's
 * follow graph with the person's own token (server/identity/follows.js), and a Network failure only loses the order,
 * never the block. A failure from Live answers empty and `unavailable: true`, so the page still renders.
 */
const DAY = 24 * 60 * 60_000;

/** Followed first, then the most watched, then the newest. Never a person's stream: only agent cards get here. */
function sortAgents(agents, followed = []) {
    const set = new Set(followed || []);
    return [...(Array.isArray(agents) ? agents : [])]
        .filter((a) => a && a.state === 'live' && a.visibility === 'public')
        .sort((a, b) => (set.has(b.owner) - set.has(a.owner))
            || (Number(b.viewers) || 0) - (Number(a.viewers) || 0)
            || Date.parse(b.started_at || 0) - Date.parse(a.started_at || 0));
}

function createAgents({ config, follows, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() }) {
    const liveBase = String((config.imports && config.imports.live && config.imports.live.url) || config.live.internalUrl || 'https://openvibe.live').replace(/\/+$/, '');
    const reportBase = String((config.report && config.report.url) || 'https://openvibe.report').replace(/\/+$/, '');
    const timeout = (config.live && config.live.timeoutMs) || 2500;
    const reportTimeout = (config.report && config.report.timeoutMs) || 2500;

    async function getJson(url, token, ms) {
        const res = await fetchImpl(url, {
            headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            signal: AbortSignal.timeout(ms),
        });
        if (!res.ok) throw new Error(`${url} ${res.status}`);
        return await res.json().catch(() => null);
    }

    /** The live public agent streams, followed first. */
    async function live({ subject = null, token = null } = {}) {
        let followed = [];
        let followsUnavailable = false;
        if (subject && token) {
            try {
                const r = await follows.forSubject(subject, token);
                followed = r.follows;
                followsUnavailable = r.unavailable;
            } catch { followsUnavailable = true; }
        }
        try {
            const data = await getJson(`${liveBase}/api/streams/agent?live=1`, null, timeout);
            if (!data || !Array.isArray(data.agents)) throw new Error('agents: no list');
            return { agents: sortAgents(data.agents, followed), unavailable: false, follows_unavailable: followsUnavailable };
        } catch (err) {
            log.warn(`[OpenVibe.Today] agents unavailable: ${(err && err.message) || err}`);
            return { agents: [], unavailable: true, follows_unavailable: followsUnavailable };
        }
    }

    /** The public agent schedules that start in the next 24 hours. */
    async function schedules() {
        try {
            const data = await getJson(`${liveBase}/api/streams/agent/schedules?public=1`, null, timeout);
            if (!data || !Array.isArray(data.schedules)) throw new Error('schedules: no list');
            const until = now() + DAY;
            return {
                schedules: data.schedules.filter((s) => s && s.state === 'scheduled' && Date.parse(s.starts_at) <= until && Date.parse(s.starts_at) >= now() - 60_000),
                unavailable: false,
            };
        } catch (err) {
            log.warn(`[OpenVibe.Today] agent schedules unavailable: ${(err && err.message) || err}`);
            return { schedules: [], unavailable: true };
        }
    }

    /** The person's own session reports of the last seven days (never anyone else's). */
    async function digest(token, { days = 7 } = {}) {
        if (!token) return { reports: [], unavailable: false };
        try {
            const data = await getJson(`${reportBase}/api/v1/me/session-reports?days=${Math.min(30, Math.max(1, Number(days) || 7))}`, token, reportTimeout);
            if (!data || !Array.isArray(data.reports)) throw new Error('reports: no list');
            return { reports: data.reports, unavailable: false };
        } catch (err) {
            log.warn(`[OpenVibe.Today] agent digest unavailable: ${(err && err.message) || err}`);
            return { reports: [], unavailable: true };
        }
    }

    return { live, schedules, digest };
}

module.exports = { createAgents, sortAgents, DAY };
