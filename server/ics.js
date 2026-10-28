'use strict';

/**
 * RFC 5545 calendars. Correct line endings (CRLF), TEXT escaping and folding at 75 octets without splitting a
 * UTF-8 sequence; every VEVENT carries a stable UID, SEQUENCE, STATUS and LAST-MODIFIED, and times are UTC.
 */
const { wire } = require('./events/store');

const CRLF = '\r\n';

function escapeText(value) {
    return String(value == null ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold one content line at 75 octets per line, never splitting a UTF-8 code point. */
function foldLine(line, limit = 75) {
    const s = String(line);
    if (Buffer.byteLength(s, 'utf8') <= limit) return s;
    const out = [];
    let current = '';
    let bytes = 0;
    for (const ch of s) {
        const n = Buffer.byteLength(ch, 'utf8');
        if (bytes + n > limit) {
            out.push(current);
            current = ` ${ch}`;
            bytes = 1 + n;
        } else {
            current += ch;
            bytes += n;
        }
    }
    out.push(current);
    return out.join(CRLF);
}

function stamp(value) {
    const d = value instanceof Date ? value : new Date(value);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function vevent(row, { now = Date.now(), baseUrl = 'https://openvibe.today' } = {}) {
    const e = row.id ? row : wire(row);
    const starts = new Date(e.starts_at);
    const ends = e.ends_at ? new Date(e.ends_at) : new Date(starts.getTime() + 60 * 60_000);
    const status = e.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED';
    const url = e.url || `${String(baseUrl).replace(/\/+$/, '')}/e/${e.id}`;
    const lines = [
        'BEGIN:VEVENT',
        `UID:${e.id}@openvibe.today`,
        `DTSTAMP:${stamp(now)}`,
        `DTSTART:${stamp(starts)}`,
        `DTEND:${stamp(ends)}`,
        `SUMMARY:${escapeText(e.title)}`,
        `DESCRIPTION:${escapeText(e.description || '')}`,
        `URL:${url}`,
        `SEQUENCE:${Number(e.seq) || 0}`,
        `STATUS:${status}`,
        `LAST-MODIFIED:${stamp(e.updated_at || now)}`,
        'END:VEVENT',
    ];
    return lines.map((l) => foldLine(l)).join(CRLF);
}

function calendar({ name, events, now = Date.now(), baseUrl = 'https://openvibe.today' }) {
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//OpenVibe//Today//EN',
        'CALSCALE:GREGORIAN',
        `X-WR-CALNAME:${escapeText(name)}`,
        ...events.map((e) => vevent(e, { now, baseUrl })),
        'END:VCALENDAR',
    ];
    return `${lines.join(CRLF)}${CRLF}`;
}

module.exports = { calendar, vevent, escapeText, foldLine, stamp, CRLF };
