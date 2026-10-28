'use strict';
/**
 * The public crawl artifacts: /robots.txt, /sitemap.xml, /llms.txt, /llms-full.txt and the home page's JSON-LD.
 * Each is served with the right status and content type, lists public pages only, and takes lastmod from STATUS.json.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const STATUS_UPDATED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'STATUS.json'), 'utf8')).updated;
const PRIVATE = ['/auth/', '/api/', '/me', '/brief', '/schedule', '/internal'];

(async () => {
    const t = await boot();
    try {
        await check('robots.txt: text/plain, private paths disallowed, public pages crawlable, sitemap named', async () => {
            const r = await t.get('/robots.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            for (const d of ['/auth/', '/api/', '/me', '/brief', '/schedule', '/internal']) assert.ok(r.text.includes(`Disallow: ${d}`), `missing Disallow: ${d}`);
            for (const d of ['/developers']) assert.ok(!r.text.includes(`Disallow: ${d}`), `${d} must stay crawlable`);
            assert.ok(r.text.includes('Sitemap: https://openvibe.today/sitemap.xml'), 'sitemap not named');
            assert.ok(/^User-agent: \*$/m.test(r.text));
        });

        await check('sitemap.xml: application/xml, real entries, lastmod from STATUS.json, nothing private', async () => {
            const r = await t.get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^application\/xml/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            for (const p of ['/', '/developers']) assert.ok(r.text.includes(`<loc>https://openvibe.today${p}</loc>`), `no ${p} entry`);
            const lastmods = [...r.text.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
            assert.ok(lastmods.length > 0);
            assert.ok(lastmods.every((d) => d === STATUS_UPDATED), `lastmod must come from STATUS.json (${STATUS_UPDATED}), got ${[...new Set(lastmods)].join(', ')}`);
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://openvibe.today${p}`), `private path in sitemap: ${p}`);
        });

        await check('llms.txt: text/plain, real links, nothing private', async () => {
            const r = await t.get('/llms.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.ok(r.text.startsWith('# OpenVibe.Today'));
            assert.ok(r.text.includes('(https://openvibe.today/developers)'));
            assert.ok(r.text.includes('https://openvibe.today/sitemap.xml'));
            assert.ok(r.text.includes('(https://openvibe.today/llms-full.txt)'));
            for (const p of ['/auth/', '/me', '/brief']) assert.ok(!r.text.includes(`https://openvibe.today${p}`), `private path in llms.txt: ${p}`);
        });

        await check('llms-full.txt: every page the sitemap lists', async () => {
            const r = await t.get('/llms-full.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.ok(r.text.startsWith('# OpenVibe.Today'));
            const sitemap = await t.get('/sitemap.xml');
            const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
            for (const loc of locs) assert.ok(r.text.includes(loc), `llms-full.txt is missing ${loc}`);
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://openvibe.today${p}`));
        });

        await check('home page: WebSite, WebApplication and WebPage JSON-LD', async () => {
            const r = await t.get('/');
            const blocks = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
            const types = blocks.map((b) => b['@type']);
            assert.ok(types.includes('WebSite'), types.join(','));
            assert.ok(types.includes('WebApplication'), types.join(','));
            assert.ok(types.includes('WebPage'), types.join(','));
            assert.strictEqual(blocks.find((b) => b['@type'] === 'WebSite').url, 'https://openvibe.today');
            assert.strictEqual(blocks.find((b) => b['@type'] === 'WebPage').url, 'https://openvibe.today/');
        });
    } finally {
        await t.close();
    }
    done();
})();
