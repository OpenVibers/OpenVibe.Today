'use strict';

/**
 * Holidays and observances from Nager.Date (https://date.nager.at): an open dataset with a public API and no key,
 * one request per country and year. The answer is a list of
 * { date, localName, name, countryCode, types: ['Public'|'Bank'|...] }.
 *
 * A holiday is a local day, not an instant: it starts at local midnight in the country's own zone and lasts until
 * the next local midnight. The zone matters (a holiday in Berlin and one in New York start hours apart) and it moves
 * with daylight saving, so both midnights are worked out for the date rather than assumed.
 */

/** The IANA zone a country's holidays are read in. Countries not listed are read in UTC. */
const COUNTRY_ZONES = Object.freeze({
    AT: 'Europe/Vienna', AU: 'Australia/Sydney', BE: 'Europe/Brussels', BR: 'America/Sao_Paulo',
    CA: 'America/Toronto', CH: 'Europe/Zurich', CZ: 'Europe/Prague', DE: 'Europe/Berlin',
    DK: 'Europe/Copenhagen', ES: 'Europe/Madrid', FI: 'Europe/Helsinki', FR: 'Europe/Paris',
    GB: 'Europe/London', IE: 'Europe/Dublin', IN: 'Asia/Kolkata', IT: 'Europe/Rome',
    JP: 'Asia/Tokyo', MX: 'America/Mexico_City', NL: 'Europe/Amsterdam', NO: 'Europe/Oslo',
    NZ: 'Pacific/Auckland', PL: 'Europe/Warsaw', PT: 'Europe/Lisbon', SE: 'Europe/Stockholm',
    US: 'America/New_York',
});

/** The zone a country's holidays are read in. */
function zoneOf(country) {
    return COUNTRY_ZONES[String(country || '').toUpperCase()] || 'UTC';
}

/** True when the runtime knows this IANA zone. */
function isZone(zone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** The offset of a zone at an instant, in milliseconds (east of UTC is positive). */
function offsetAt(zone, ms) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms));
    const at = {};
    for (const p of parts) if (p.type !== 'literal') at[p.type] = p.value;
    const asUtc = Date.UTC(Number(at.year), Number(at.month) - 1, Number(at.day), Number(at.hour) % 24, Number(at.minute), Number(at.second));
    return asUtc - ms;
}

/**
 * The UTC instant of local midnight on a calendar date in a zone. Two passes: the first guess uses the offset at
 * UTC midnight, the second the offset at that guess, which is what settles the hours either side of a
 * daylight-saving change.
 */
function zonedMidnight(date, zone) {
    const [y, m, d] = String(date).split('-').map(Number);
    if (!y || !m || !d) return null;
    const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
    let guess = naive - offsetAt(zone, naive);
    guess = naive - offsetAt(zone, guess);
    const out = new Date(guess);
    return Number.isNaN(out.getTime()) ? null : out;
}

/** The local calendar date after the one given, as YYYY-MM-DD. */
function nextDate(date) {
    const [y, m, d] = String(date).split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The locale-independent key that keeps the same observance one row when its display name changes. */
function nameKey(name) {
    return String(name || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'holiday';
}

/**
 * The events a country and year hold, as import records. An observance is kept apart from a holiday:
 * both are on the calendar, but only one of them is a day off.
 */
function recordsFor(payload, { country, year, zone = zoneOf(country) } = {}) {
    const list = Array.isArray(payload) ? payload : [];
    const countryCode = String(country || '').toUpperCase();
    const api = 'https://date.nager.at/api/v3/PublicHolidays/' + year + '/' + countryCode;
    const out = [];
    for (const item of list) {
        if (!item || typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) continue;
        const start = zonedMidnight(item.date, zone);
        const end = zonedMidnight(nextDate(item.date), zone);
        if (!start || !end) continue;
        const types = Array.isArray(item.types) ? item.types.map((t) => String(t).toLowerCase()) : [String(item.type || '').toLowerCase()];
        const observance = types.includes('observance') && !types.includes('public');
        const name = String(item.localName || item.name || 'Holiday').trim().slice(0, 200) || 'Holiday';
        const cc = String(item.countryCode || countryCode).toUpperCase();
        out.push({
            source: 'holidays',
            source_id: 'holiday:' + cc + ':' + item.date + ':' + nameKey(name),
            source_kind: observance ? 'observance' : 'holiday',
            kind: observance ? 'observance' : 'holiday',
            title: name,
            description: (observance ? 'An observance in ' : 'A public holiday in ') + cc + ', from the Nager.Date open dataset.',
            starts_at: start.toISOString(),
            ends_at: end.toISOString(),
            tz: zone,
            url: api,
            source_url: api,
            owner_subject: 'sys:holidays',
            channel: null,
            status: 'scheduled',
            visibility: 'public',
        });
    }
    return out;
}

module.exports = { COUNTRY_ZONES, zoneOf, isZone, zonedMidnight, nextDate, recordsFor };
