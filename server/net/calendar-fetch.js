'use strict';
/**
 * Reading a calendar a person chose (plan L48 R3). The address is theirs, so it is read through the one rule for
 * connecting to an address someone else chose (openvibe-shared/egress): https only, a public host only, a timeout
 * and a body cap. A name that resolves to a private range or to a link-local address is refused before a byte is
 * sent, and the check runs again at connect time (the safe lookup), so a name that answers 127.0.0.1 a moment
 * later is refused too.
 *
 * A redirect is followed, because some calendars answer 301 to their real address, but only after the same check:
 * a redirect can never land on a private address. At most three hops.
 *
 * The answer must be a calendar: text/calendar or text/plain, at most 2 MB, within 10 seconds.
 *
 *   fetchCalendar(url, { timeoutMs, maxBytes }) → { status, headers, body, type }
 *   assertReachable(url)                      → the URL, once it may be read
 *   checkUrl(url)                             → the URL, once its shape is allowed
 */
const https = require('https');
const net = require('net');
const egress = require('openvibe-shared/egress');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_PORTS = ['443', '8443'];
const ALLOWED_TYPES = ['text/calendar', 'text/plain'];
const MAX_REDIRECTS = 3;

class GuardedError extends Error {
    constructor(message, code = 'today.calendar.refused') {
        super(message);
        this.name = 'GuardedError';
        this.code = code;
    }
}

/** The URL, once its shape is allowed: https, no credentials in it, a public host, a known port. */
function checkUrl(url, { ports = ALLOWED_PORTS, isAllowed = egress.isPublicAddress } = {}) {
    let u;
    try { u = url instanceof URL ? url : new URL(String(url)); } catch { throw new GuardedError('that is not an address'); }
    if (u.protocol !== 'https:') throw new GuardedError('use an https address');
    if (u.username || u.password) throw new GuardedError('an address with a password in it is not allowed');
    const port = u.port || '443';
    if (!ports.includes(port)) throw new GuardedError('port ' + port + ' is not allowed');
    const host = egress.normalizeHost(u.hostname);
    if (egress.isInternalName(host)) throw new GuardedError(host + ' is not a public host name');
    // Node does not look up an address that is already an address, so it is checked here.
    if (net.isIP(host) && !isAllowed(host)) throw new GuardedError(host + ' is not a public address');
    return u;
}

/**
 * The URL, once it may be read: the shape is allowed, and every address the name resolves to is public. A name
 * that answers a private address is refused here, before the connection.
 */
async function assertReachable(url, { lookup, isAllowed = egress.isPublicAddress, ports } = {}) {
    const u = checkUrl(url, { ports, isAllowed });
    const look = egress.createSafeLookup({ lookup, isAllowed });
    await new Promise((resolve, reject) => {
        look(u.hostname, { all: true }, (err) => {
            if (!err) return resolve();
            return reject(err && err.code === 'EGRESS_DENIED' ? new GuardedError(err.message) : err);
        });
    });
    return u;
}

/** One request, through the egress guard. The body is read up to maxBytes; a bigger answer is refused. */
function requestOnce(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, lookup, isAllowed, headers = {} } = {}) {
    const u = url instanceof URL ? url : new URL(String(url));
    const safeLookup = egress.createSafeLookup({ lookup, isAllowed });
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (err, value) => { if (done) return; done = true; if (err) reject(err); else resolve(value); };
        const req = https.request({
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method: 'GET',
            servername: u.hostname,
            lookup: safeLookup,
            headers: {
                accept: 'text/calendar, text/plain;q=0.9',
                'user-agent': 'OpenVibe.Today (+https://openvibe.today)',
                ...headers,
            },
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                    req.destroy(new GuardedError('the answer is bigger than ' + maxBytes + ' bytes', 'today.calendar.too_large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => finish(null, { status: res.statusCode || 0, headers: res.headers || {}, body: Buffer.concat(chunks) }));
            res.on('error', (err) => finish(err));
        });
        req.setTimeout(timeoutMs, () => req.destroy(new GuardedError('the address did not answer within ' + timeoutMs + ' ms', 'today.calendar.timeout')));
        req.on('error', (err) => finish(err && err.code === 'EGRESS_DENIED' ? new GuardedError(err.message) : err));
        req.end();
    });
}

/** The calendar at that address. */
async function fetchCalendar(url, opts = {}) {
    const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    const send = opts.request || requestOnce;
    let current = String(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertReachable(current, opts);
        const res = await send(current, { ...opts, maxBytes });
        const status = res.status;
        if (status >= 300 && status < 400 && res.headers.location) {
            let next;
            try { next = new URL(String(res.headers.location), current).toString(); } catch {
                throw new GuardedError('the address answers a redirect to nowhere', 'today.calendar.bad_redirect');
            }
            current = next;                 // the next round checks the new address the same way
            continue;
        }
        if (status < 200 || status >= 300) throw new GuardedError('the address answered ' + status, 'today.calendar.http_error');
        if (res.body.length > maxBytes) throw new GuardedError('the answer is bigger than ' + maxBytes + ' bytes', 'today.calendar.too_large');
        const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!ALLOWED_TYPES.includes(type)) {
            throw new GuardedError('that address did not answer a calendar (it said ' + (type || 'nothing') + ')', 'today.calendar.not_a_calendar');
        }
        return { status, headers: res.headers, body: res.body.toString('utf8'), type };
    }
    throw new GuardedError('the address redirects too many times', 'today.calendar.too_many_redirects');
}

module.exports = {
    fetchCalendar, assertReachable, checkUrl, requestOnce, GuardedError,
    DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES, ALLOWED_PORTS, ALLOWED_TYPES, MAX_REDIRECTS,
};
