'use strict';

/**
 * What a public source says, read as an event. Every function here is pure: it takes what a source returned and gives
 * back the row Today wants, with the source's own id on it. Nothing is fetched and nothing is written here, so each
 * reading can be tried on its own.
 *
 * Only public facts are read. A stream's title, channel name and start are public (they are on the public Live page);
 * a plan's title and time are public (they are on the public Fun page); a person's identity is not, so an imported
 * plan is owned by the network rather than by the person who wrote it. A source may return private fields next to the
 * public ones; nothing here copies anything but the named public fields.
 *
 * OpenVibe.Live has no schedule store of its own: the schedule card in Live's studio writes to Today through this
 * service's own API (plan 2026-10-28 §4.2), so an upcoming stream is already a today_events row and must not be
 * imported back from Live. The live list below is only the streams that are on now.
 */
const { isZone } = require('./holidays');

const LIVE_HOME = 'https://openvibe.live';
const FUN_HOME = 'https://openvibe.fun';
const EVENTS_HOME = 'https://openvibe.events';

const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A source time as an instant. Live writes SQLite's ov_now() as `YYYY-MM-DD HH:MM:SS` in UTC with no zone, which
 * JavaScript would otherwise read in the server's local zone; an ISO time with an offset is read as it is.
 */
function parseSourceTime(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number' && Number.isFinite(value)) {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    let iso = s;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s)) iso = s.replace(' ', 'T') + 'Z';
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s)) iso = s + 'Z';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
}

function plain(value, max) {
    return String(value == null ? '' : value).trim().slice(0, max);
}

/** Only an https page is a source link; anything else falls back to the service's home. */
function httpsUrl(value, fallback) {
    return typeof value === 'string' && /^https:\/\/[^\s"'<>]{1,300}$/.test(value) ? value : fallback;
}

function zoneOr(value, fallback = 'UTC') {
    return typeof value === 'string' && isZone(value) ? value : fallback;
}

/** The subject a channel is known by: the Network subject when the bus told us, the channel name otherwise. */
function ownerOf(subject, username) {
    if (typeof subject === 'string' && USER_SUBJECT.test(subject)) return subject;
    return 'chan:' + String(username || 'unknown').slice(0, 64);
}

/**
 * A stream that is on now. Live's public list says which streams are live; the row becomes an event that is live, so
 * the agenda and the public list can say "on now" without asking Live again.
 */
function liveStream(stream, { subject = null } = {}) {
    if (!stream || typeof stream !== 'object') return null;
    const id = stream.id == null ? null : String(stream.id);
    const channel = stream.channel && typeof stream.channel === 'object' ? stream.channel : {};
    const username = plain(channel.username || stream.username, 64);
    if (!id || !username) return null;
    const started = parseSourceTime(stream.started_at || stream.created_at);
    if (!started) return null;
    const title = plain(stream.title, 200) || (username + ' is live');
    const url = LIVE_HOME + '/@' + encodeURIComponent(username);
    return {
        source: 'live',
        source_id: 'stream:' + id,
        source_kind: 'on_now',
        kind: 'stream',
        title,
        description: 'Live now on OpenVibe.Live.',
        starts_at: started.toISOString(),
        ends_at: null,
        tz: 'UTC',
        url,
        source_url: url,
        owner_subject: ownerOf(subject, username),
        channel: username,
        status: 'live',
        visibility: 'public',
    };
}

/**
 * A group plan on OpenVibe.Fun. The plan's own timezone is kept, so a plan in Berlin starts at the hour the plan says
 * it starts, whatever the reader's own clock says. Fun's own Today body gives a plan two hours (server/today.js);
 * `closes_at` is when voting closed, not when the plan ends, so it is never used as ends_at.
 */
function funPlan(plan) {
    if (!plan || typeof plan !== 'object') return null;
    if (plan.visibility && plan.visibility !== 'public') return null;
    const slug = plain(plan.slug, 80);
    if (!slug) return null;
    const starts = parseSourceTime(plan.starts_at);
    if (!starts) return null;
    const where = [plain(plan.city, 120), plain(plan.place_name, 120)].filter(Boolean).join(', ');
    const url = FUN_HOME + '/plans/' + encodeURIComponent(slug);
    return {
        source: 'fun',
        source_id: 'plan:' + slug,
        source_kind: 'plan',
        kind: 'plan',
        title: plain(plan.title, 200) || 'A plan on OpenVibe.Fun',
        description: [plain(plan.summary, 500), where].filter(Boolean).join(' — ').slice(0, 1000) || null,
        starts_at: starts.toISOString(),
        ends_at: new Date(starts.getTime() + 2 * 60 * 60_000).toISOString(),
        tz: zoneOr(plan.timezone),
        url,
        source_url: url,
        owner_subject: 'sys:fun',
        channel: null,
        status: 'scheduled',
        visibility: 'public',
    };
}

/**
 * An IRL quest on OpenVibe.Fun. A quest has no clock of its own, so it enters the calendar at the moment it was
 * accepted and stays live while the streamer is running it. Completed or verified quests are history, not an
 * upcoming plan, and hidden/unlisted ones never appear in the public list.
 */
function funQuest(quest) {
    if (!quest || typeof quest !== 'object') return null;
    if (quest.visibility && quest.visibility !== 'public') return null;
    const slug = plain(quest.slug, 80);
    const status = String(quest.status || '').toLowerCase();
    if (!slug || !['accepted', 'live'].includes(status)) return null;
    const start = parseSourceTime(quest.accepted_at || quest.created_at);
    if (!start) return null;
    const where = [plain(quest.city, 120), plain(quest.place_name, 120)].filter(Boolean).join(', ');
    const url = FUN_HOME + '/q/' + encodeURIComponent(slug);
    return {
        source: 'fun',
        source_id: 'quest:' + slug,
        source_kind: status === 'live' ? 'on_now' : 'quest',
        kind: 'quest',
        title: plain(quest.title, 200) || 'A quest on OpenVibe.Fun',
        description: [plain(quest.brief, 500), where].filter(Boolean).join(' — ').slice(0, 1000) || null,
        starts_at: start.toISOString(),
        ends_at: null,
        tz: 'UTC',
        url,
        source_url: url,
        owner_subject: 'sys:fun',
        channel: plain(quest.streamer_username, 64) || null,
        status: status === 'live' ? 'live' : 'scheduled',
        visibility: 'public',
    };
}

/**
 * A public event from the network's event bus. Release notes, deploys, migrations, builds and heartbeats are not
 * events a person turns up to, so they are left out: only a public event with a title and a time is one.
 */
function networkEvent(event) {
    if (!event || typeof event !== 'object') return null;
    const type = String(event.event_type || '');
    if (!type || /release|deploy|migration|build|rollout|heartbeat|analytics|usage|telemetry/i.test(type)) return null;
    if (event.visibility && event.visibility !== 'public') return null;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const title = plain(payload.title, 200);
    const starts = parseSourceTime(payload.starts_at || payload.at || payload.when || event.occurred_at || event.timestamp);
    const id = typeof event.event_id === 'string' ? event.event_id : null;
    if (!title || !starts || !id) return null;
    const url = httpsUrl(payload.url, EVENTS_HOME);
    return {
        source: 'events',
        source_id: 'event:' + id,
        source_kind: 'network_event',
        kind: 'event',
        title,
        description: plain(payload.summary || payload.description, 1000) || null,
        starts_at: starts.toISOString(),
        ends_at: parseSourceTime(payload.ends_at) ? parseSourceTime(payload.ends_at).toISOString() : null,
        tz: zoneOr(payload.tz),
        url,
        source_url: url,
        owner_subject: 'sys:events',
        channel: null,
        status: 'scheduled',
        visibility: 'public',
    };
}

module.exports = {
    liveStream, funPlan, funQuest, networkEvent, ownerOf, parseSourceTime, httpsUrl, zoneOr,
    LIVE_HOME, FUN_HOME, EVENTS_HOME,
};
