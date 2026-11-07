'use strict';
// Agent streams on Today (S7): only public live agent streams, followed first, never mixed with people's streams,
// the counted fold after three, the next 24 hours of schedules, and the digest card of the person's own agents.
const assert = require('assert');
const { createAgents, sortAgents } = require('../server/agents');
const views = require('../server/views');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n   ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n    ')); }
}

const A = {
    id: 'ags_01JAB2C3D4E5F6G7H8J9K0MNA1', owner: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1', channel: 'ann',
    title: 'Followed agent', state: 'live', visibility: 'public', viewers: 2,
    task: { source: 'codes', ref: 'tsk_1', title: 'Fix the login page' }, current_step: { title: 'Run the tests', status: 'started' },
    started_at: '2026-11-07T01:00:00Z', page_url: 'https://openvibe.live/@ann/agents/ags_01JAB2C3D4E5F6G7H8J9K0MNA1',
};
const B = { ...A, id: 'ags_01JAB2C3D4E5F6G7H8J9K0MNB2', owner: 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2', channel: 'bob', title: 'Watched agent', viewers: 40, started_at: '2026-11-07T00:00:00Z' };
const C = { ...A, id: 'ags_01JAB2C3D4E5F6G7H8J9K0MNC3', owner: 'usr_01JAB2C3D4E5F6G7H8J9K0MNC3', channel: 'cat', title: 'A small agent', viewers: 1, started_at: '2026-11-07T02:00:00Z' };
const D = { ...A, id: 'ags_01JAB2C3D4E5F6G7H8J9K0MND4', title: 'A private agent', visibility: 'private' };
const E = { ...A, id: 'ags_01JAB2C3D4E5F6G7H8J9K0MNE5', title: 'An ended agent', state: 'ended' };

check('only public live streams, followed first and then the most watched', () => {
    const out = sortAgents([B, C, A, D, E], [A.owner]);
    assert.deepStrictEqual(out.map((a) => a.title), ['Followed agent', 'Watched agent', 'A small agent']);
});

check('the Agents live block is its own section, with a counted fold after three', () => {
    const html = views.home({
        now: Date.now(),
        agents: { agents: [A, B, C, { ...D, title: 'Fourth', visibility: 'public', viewers: 0 }, { ...E, title: 'Fifth', state: 'live', viewers: 0 }] },
        schedules: { schedules: [] },
        digest: { reports: [] },
    });
    assert.match(html, /id="td-agents"/);
    assert.match(html, /Agents live/);
    assert.match(html, /More \(2\)/);
    assert.match(html, /Followed agent/);
    assert.match(html, /AI agent/);
    // The calendar's own rows never carry an agent: the block is added beside them, not mixed into them.
    assert.ok(!/<li class="td-ev[^"]*">[^]*?Followed agent/.test(html), 'an agent is not an event row');
});

check('a schedule in the next 24 hours shows with its time; the digest is the person\'s own', () => {
    const html = views.home({
        now: Date.now(),
        agents: { agents: [] },
        schedules: { schedules: [{ id: 'scd_01JAB2C3D4E5F6G7H8J9K0MNPS', title: 'Nightly update', channel: 'ann', starts_at: new Date(Date.now() + 3600_000).toISOString(), state: 'scheduled', waits_for_go: false, page_url: 'https://openvibe.live/@ann/agents' }] },
        digest: { reports: [{ id: 'rps_01JAB2C3D4E5F6G7H8J9K0MNPS', task: { title: 'My agent fixed the login page' }, outcome: 'done' }] },
    });
    assert.match(html, /Scheduled · next 24 hours/);
    assert.match(html, /Nightly update/);
    assert.match(html, /Your agents this week/);
    assert.match(html, /My agent fixed the login page/);
});

check('createAgents filters to 24 hours and followed first, and a Live failure is an empty block', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (String(url).includes('/api/streams/agent?live=1')) return { ok: true, json: async () => ({ agents: [B, A, D] }) };
        if (String(url).includes('/schedules?public=1')) {
            return { ok: true, json: async () => ({ schedules: [
                { id: 'scd_1', title: 'Soon', state: 'scheduled', starts_at: new Date(Date.now() + 3600_000).toISOString() },
                { id: 'scd_2', title: 'Later', state: 'scheduled', starts_at: new Date(Date.now() + 25 * 3600_000).toISOString() },
            ] }) };
        }
        throw new Error('unexpected ' + url);
    };
    const agents = createAgents({
        config: { imports: { live: { url: 'https://live.test' } }, live: { timeoutMs: 1000, internalUrl: 'https://live.test' }, report: { url: 'https://report.test', timeoutMs: 1000 } },
        follows: { forSubject: async () => ({ follows: [A.owner], unavailable: false }) },
        fetchImpl, log: { warn() {} },
    });
    const live = await agents.live({ subject: A.owner, token: 'person-token' });
    assert.deepStrictEqual(live.agents.map((a) => a.title), ['Followed agent', 'Watched agent']);
    assert.strictEqual(live.agents.length, 2, 'the private one is not on Today');
    const scheduled = await agents.schedules();
    assert.deepStrictEqual(scheduled.schedules.map((s) => s.title), ['Soon'], 'only the next 24 hours');

    const down = createAgents({
        config: { imports: { live: { url: 'https://live.test' } }, live: { timeoutMs: 100, internalUrl: 'https://live.test' }, report: { url: 'https://report.test', timeoutMs: 100 } },
        follows: { forSubject: async () => ({ follows: [], unavailable: true }) },
        fetchImpl: async () => { throw new Error('down'); }, log: { warn() {} },
    });
    assert.deepStrictEqual(await down.live(), { agents: [], unavailable: true, follows_unavailable: false });
});

check('the phone layout keeps the cards one column and the tap targets 44 px', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const css = fs.readFileSync(path.join(__dirname, '../public/css/today.css'), 'utf8');
    assert.match(css, /@media \(max-width: 640px\)[\s\S]*td-agents \{ grid-template-columns: 1fr/);
    assert.match(css, /min-height: 44px/);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll Today S7 checks passed');
process.exit(failures ? 1 : 0);
