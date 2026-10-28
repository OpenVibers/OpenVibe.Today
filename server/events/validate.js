'use strict';

/** Validation for what a person may schedule. Pure: no clock of its own, no database. */

const KINDS = ['stream', 'event'];
const VISIBILITIES = ['public', 'followers'];
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 1000;
const EARLIEST_MS = 5 * 60_000;
const LATEST_MS = 366 * 24 * 60 * 60_000;
const MAX_LENGTH_MS = 24 * 60 * 60_000;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const PLAIN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;

function bad(field, message) { return { ok: false, status: 400, code: 'today.invalid', field, message }; }

/** An ISO time (a plain local form is read as UTC, so a form and the API agree). */
function parseTime(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const s = value.trim();
    if (!ISO_RE.test(s) && !PLAIN_RE.test(s)) return null;
    const d = new Date(PLAIN_RE.test(s) ? `${s}Z` : s);
    return Number.isNaN(d.getTime()) ? null : d;
}

function isIanaZone(tz) {
    if (typeof tz !== 'string' || !tz.trim() || tz.length > 80) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function validateTitle(v) {
    if (typeof v !== 'string') return bad('title', 'title is required and must be 1-120 characters');
    const s = v.trim();
    if (s.length < 1 || s.length > TITLE_MAX) return bad('title', 'title must be 1-120 characters');
    return { ok: true, value: s };
}
function validateDescription(v, { optional = false } = {}) {
    if (v == null || v === '') return { ok: true, value: null };
    if (typeof v !== 'string') return bad('description', 'description must be text of at most 1000 characters');
    if (v.length > DESCRIPTION_MAX) return bad('description', 'description must be at most 1000 characters');
    return { ok: true, value: v };
}
function validateVisibility(v) {
    if (v == null) return { ok: true, value: 'public' };
    if (typeof v !== 'string' || !VISIBILITIES.includes(v)) return bad('visibility', 'visibility must be public or followers');
    return { ok: true, value: v };
}
function validateStarts(v, now) {
    const d = parseTime(v);
    if (!d) return bad('starts_at', 'starts_at must be an ISO time');
    if (d.getTime() < now - EARLIEST_MS) return bad('starts_at', 'starts_at must not be earlier than 5 minutes ago');
    if (d.getTime() > now + LATEST_MS) return bad('starts_at', 'starts_at must not be later than 366 days ahead');
    return { ok: true, value: d };
}
function validateEnds(v, start) {
    if (v == null || v === '') return { ok: true, value: null };
    const d = parseTime(v);
    if (!d) return bad('ends_at', 'ends_at must be an ISO time');
    if (d.getTime() <= start.getTime()) return bad('ends_at', 'ends_at must be after starts_at');
    if (d.getTime() - start.getTime() > MAX_LENGTH_MS) return bad('ends_at', 'ends_at must be within 24 hours of starts_at');
    return { ok: true, value: d };
}
function validateTz(v) {
    if (!isIanaZone(v)) return bad('tz', 'tz must be a valid IANA time zone');
    return { ok: true, value: String(v).trim() };
}

/** POST body → the fields to write, or a today.invalid refusal. */
function validateCreate(body, { now = Date.now(), username = null } = {}) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (!KINDS.includes(b.kind)) return bad('kind', 'kind must be stream or event');
    const t = validateTitle(b.title); if (!t.ok) return t;
    const d = validateDescription(b.description); if (!d.ok) return d;
    const s = validateStarts(b.starts_at, now); if (!s.ok) return s;
    const e = validateEnds(b.ends_at, s.value); if (!e.ok) return e;
    const z = validateTz(b.tz); if (!z.ok) return z;
    const v = validateVisibility(b.visibility); if (!v.ok) return v;

    let channel = null;
    let url = null;
    if (b.kind === 'stream') {
        if (typeof username !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(username)) {
            return bad('channel', 'a stream needs the username on your OpenVibe account');
        }
        channel = username;
        url = `https://openvibe.live/@${encodeURIComponent(username)}`;
    }
    return {
        ok: true,
        fields: {
            kind: b.kind, channel, url,
            title: t.value, description: d.value,
            starts_at: s.value.toISOString(), ends_at: e.value ? e.value.toISOString() : null,
            tz: z.value, visibility: v.value,
        },
    };
}

function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

/** PATCH body → the merged fields to write, or a today.invalid refusal. */
function validatePatch(body, row, { now = Date.now() } = {}) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const fields = ['title', 'description', 'starts_at', 'ends_at', 'tz', 'visibility'];
    if (!fields.some((f) => has(b, f))) return bad('body', `nothing to update; send one of ${fields.join(', ')}`);

    let title = row.title;
    if (has(b, 'title')) { const t = validateTitle(b.title); if (!t.ok) return t; title = t.value; }
    let description = row.description;
    if (has(b, 'description')) { const d = validateDescription(b.description); if (!d.ok) return d; description = d.value; }
    let starts = new Date(row.starts_at);
    if (has(b, 'starts_at')) { const s = validateStarts(b.starts_at, now); if (!s.ok) return s; starts = s.value; }
    let ends = row.ends_at ? new Date(row.ends_at) : null;
    if (has(b, 'ends_at')) { const e = validateEnds(b.ends_at, starts); if (!e.ok) return e; ends = e.value; }
    else if (ends) { const e = validateEnds(ends.toISOString(), starts); if (!e.ok) return e; ends = e.value; }
    let tz = row.tz;
    if (has(b, 'tz')) { const z = validateTz(b.tz); if (!z.ok) return z; tz = z.value; }
    let visibility = row.visibility;
    if (has(b, 'visibility')) { const v = validateVisibility(b.visibility); if (!v.ok) return v; visibility = v.value; }

    return {
        ok: true,
        fields: {
            title, description,
            starts_at: starts.toISOString(), ends_at: ends ? ends.toISOString() : null,
            tz, visibility,
        },
    };
}

module.exports = {
    KINDS, VISIBILITIES, TITLE_MAX, DESCRIPTION_MAX, EARLIEST_MS, LATEST_MS, MAX_LENGTH_MS,
    parseTime, isIanaZone, validateCreate, validatePatch, bad,
};
