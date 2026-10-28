'use strict';
/**
 * Sign-in with PKCE S256 (client id today, cookies today_at/today_rt/today_oauth), the session-token rules (a FedCM
 * assertion or an app token is not a session), the open-redirect guard, truthful readiness, loopback metrics, pages
 * without JavaScript, and cross-site sign-out.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');
const { sanitizeNext } = require('../server/auth/sso');

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');

    await check('login redirects to Network with state and an S256 code challenge', async () => {
        const r = await t.get('/auth/login?next=/brief');
        assert.strictEqual(r.status, 302);
        const loc = new URL(r.headers.get('location'));
        assert.strictEqual(loc.origin + loc.pathname, `${t.network.url}/oauth/authorize`);
        assert.strictEqual(loc.searchParams.get('client_id'), 'today');
        assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
        assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
        assert.match(loc.searchParams.get('state'), /^[0-9a-f]{32}$/);
        assert.match(r.headers.get('set-cookie'), /today_oauth=.*Path=\/auth.*HttpOnly/i);
    });

    await check('callback exchanges the code with the matching verifier and sets httpOnly session cookies', async () => {
        const login = await t.get('/auth/login?next=/brief');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = login.headers.get('set-cookie').split(';')[0];
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const r = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie });
        assert.strictEqual(r.status, 302, r.text);
        assert.strictEqual(r.headers.get('location'), '/brief');
        const set = r.headers.get('set-cookie');
        assert.match(set, /today_at=[^;]+;.*HttpOnly/i);
        assert.match(set, /today_rt=[^;]+;.*HttpOnly/i);
        const at = set.match(/today_at=([^;]+)/)[1];
        const me = await t.get('/auth/me', { cookie: `today_at=${at}` });
        assert.strictEqual(me.json().user.username, 'kim');
        assert.ok(!me.text.includes(at), '/auth/me never returns the token');
    });

    await check('a wrong state, a verifier that does not match, or no flow cookie is refused', async () => {
        const login = await t.get('/auth/login');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = login.headers.get('set-cookie').split(';')[0];
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const bad = await t.get(`/auth/callback?code=${code}&state=${'0'.repeat(32)}`, { cookie: flowCookie });
        assert.strictEqual(bad.status, 400);
        const other = t.network.issueCode(user, crypto.createHash('sha256').update('another-verifier').digest('base64url'));
        const mismatch = await t.get(`/auth/callback?code=${other}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie });
        assert.strictEqual(mismatch.status, 400);
        const noCookie = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`);
        assert.strictEqual(noCookie.status, 400);
    });

    await check('next= only accepts same-site paths', async () => {
        const r = await t.get('/auth/login?next=//evil.example/x');
        const flow = decodeURIComponent(r.headers.get('set-cookie').match(/today_oauth=([^;]+)/)[1]);
        assert.strictEqual(JSON.parse(flow).next, '/');
        const config = { baseUrl: 'https://openvibe.today' };
        assert.strictEqual(sanitizeNext('/me?tab=1', config), '/me?tab=1');
        assert.strictEqual(sanitizeNext('https://openvibe.today/e/x?y=1', config), '/e/x?y=1');
        for (const v of ['//evil.com', '/\\evil.com', 'https://evil.com/x', '/\t/evil.com', 'javascript:alert(1)', 'https://openvibe.today.evil.com/x']) assert.strictEqual(sanitizeNext(v, config), '/', v);
    });

    await check('readiness is truthful: db required; JWKS, the OAuth client and Valkey optional', async () => {
        const r = await t.get('/api/ready');
        const b = r.json();
        assert.strictEqual(r.status, 200);
        assert.strictEqual(b.checks.db.status, 'ok');
        assert.strictEqual(b.checks.db.required, true);
        assert.strictEqual(b.checks.network_jwks.status, 'ok');
        assert.strictEqual(b.checks.network_jwks.required, false);
        assert.strictEqual(b.checks.oauth_client.status, 'ok');
        assert.strictEqual(b.checks.oauth_client.required, false);
        assert.ok('valkey' in b.checks);
    });

    await check('/release.json and /metrics (loopback only)', async () => {
        const rel = await t.get('/release.json');
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.json().service, 'today');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json()).errors, []);
        const m = await t.get('/metrics');
        assert.strictEqual(m.status, 200);
        assert.match(m.text, /http_requests_total|release_info/);
        const proxied = await t.get('/metrics', { headers: { 'x-forwarded-for': '203.0.113.9' } });
        assert.notStrictEqual(proxied.status, 200, 'a proxied request is not loopback');
    });

    await check('public pages are complete without JavaScript', async () => {
        for (const p of ['/', '/developers']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, p);
            assert.match(r.text, /<noscript><nav/);
            assert.match(r.text, /<footer id="ov-footer"/);
            assert.match(r.text, /<main id="main"/);
        }
    });

    await check('the API answers /ping and unknown routes are problem+json 404', async () => {
        const ping = await t.get('/api/v1/ping');
        assert.strictEqual(ping.status, 200);
        assert.deepStrictEqual(ping.json(), { ok: true, service: 'today' });
        const gone = await t.get('/api/v1/nope');
        assert.strictEqual(gone.status, 404);
        assert.match(gone.headers.get('content-type'), /application\/problem\+json/);
        assert.strictEqual(gone.json().code, 'route.not_found');
    });

    await check('a FedCM assertion and an app token are not sessions', async () => {
        const now = Math.floor(Date.now() / 1000);
        const fedcm = t.network.signJwt({ iss: t.network.issuer(), sub: user.id, id: user.id, subject_id: user.subject, username: user.username, display_name: user.username, nonce: null, typ: 'fedcm', jti: 'x', aud: 'https://tenant.openvibe.host', iat: now, exp: now + 300 });
        assert.strictEqual((await t.get('/auth/me', { cookie: `today_at=${fedcm}` })).status, 401);
        const page = await t.get('/', { cookie: `today_at=${fedcm}` });
        assert.ok(!page.text.includes('Signed in as <strong>kim'));
        const app = t.network.signJwt({ iss: t.network.issuer(), sub: 'app:app_01JABCDEFGHJKMNPQRSTVWXYZ0', actor_type: 'app', aud: ['openvibe.network'], cap: ['x.y.z'], subject_id: user.subject, iat: now, exp: now + 300 });
        assert.strictEqual((await t.get('/auth/me', { cookie: `today_at=${app}` })).status, 401);
    });

    await check('/auth/me: a guest is signed out (200 { user: null }); a failing session cookie is 401', async () => {
        const guest = await t.get('/auth/me');
        assert.strictEqual(guest.status, 200);
        assert.deepStrictEqual(JSON.parse(guest.text), { user: null });
        assert.strictEqual(guest.headers.get('cache-control'), 'private, no-store');
        assert.strictEqual((await t.get('/auth/me', { cookie: 'today_at=garbage' })).status, 401);
        assert.strictEqual((await t.get('/auth/me', { cookie: 'today_rt=stale' })).status, 401);
        assert.strictEqual((await t.get('/auth/me', { as: user })).status, 200);
    });

    await check('another site cannot sign a person out; this site can', async () => {
        const cross = await t.get('/auth/logout', { as: user, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(cross.status, 200);
        assert.ok(!/today_at=;|today_at=deleted/i.test(String(cross.headers.get('set-cookie') || '')));
        assert.match(cross.text, /method="post"/);
        const crossPost = await t.get('/auth/logout', { as: user, method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(crossPost.status, 403);
        const same = await t.get('/auth/logout?next=/brief', { as: user, headers: { 'sec-fetch-site': 'same-origin' } });
        assert.strictEqual(same.status, 303);
        assert.strictEqual(same.headers.get('location'), '/brief');
        assert.match(String(same.headers.get('set-cookie') || ''), /today_at=;/);
    });

    await t.close();
    done();
})();
