'use strict';
/**
 * Development only: a few events in the local PGlite database, so the pages have something to show
 * (node scripts/seed-dev.js; refuses to run with NODE_ENV=production or a DATABASE_URL).
 */
const { load } = require('../server/config');
const { openDb } = require('../server/db');

(async () => {
    if (process.env.NODE_ENV === 'production' || process.env.DATABASE_URL) throw new Error('seed-dev is for the local development database only');
    const config = load(process.env);
    const db = await openDb(config, { log: { log() {}, warn() {}, error: console.error } });
    const now = Date.now();
    const h = (n) => new Date(now + n * 3600e3).toISOString();
    const rows = [
        ['tev_DEVSEED0000000000001', 'stream', 'goosely', 'Night owls: Seattle walk', 'A slow walk downtown, chat picks the turns.', h(-0.5), h(1.5), 'America/Los_Angeles', 'live'],
        ['tev_DEVSEED0000000000002', 'stream', 'carol', 'Robot build, part 2', 'Wiring the arm and the first test moves.', h(5), h(7), 'America/Los_Angeles', 'scheduled'],
        ['tev_DEVSEED0000000000003', 'stream', 'JapaneseOldGuy', 'Morning workshop', 'Blue cylinder, round two.', h(20), h(22), 'Asia/Tokyo', 'scheduled'],
        ['tev_DEVSEED0000000000004', 'event', 'kiwi', 'Speedrun Sunday: community race', 'Bring your best route.', h(50), h(53), 'Europe/London', 'scheduled'],
        ['tev_DEVSEED0000000000005', 'stream', 'carol', 'Q&A and parts haul', null, h(74), h(75.5), 'America/Los_Angeles', 'cancelled'],
    ];
    for (const r of rows) {
        await db.prepare(`INSERT INTO today_events (id, owner_subject, kind, channel, title, description, starts_at, ends_at, tz, status, visibility, url)
            VALUES (?, 'usr_01DEVSEED0000000000000000', ?, ?, ?, ?, ?, ?, ?, ?, 'public', ?) ON CONFLICT (id) DO UPDATE SET starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, status = EXCLUDED.status`)
            .run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[2] ? `https://openvibe.live/@${r[2]}` : null);
    }
    console.log(`seeded ${rows.length} events`);
    process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
