#!/usr/bin/env node
'use strict';

/**
 * Run one import pass now (the boot job runs every TODAY_IMPORTS_INTERVAL_MS). Useful after a deploy, or for an
 * operator checking a source:
 *
 *   node scripts/import-now.js [live,fun,holidays,events]
 *
 * It refuses under NODE_ENV=production unless the process is already configured with DATABASE_URL; it uses the same
 * loader as the service. The output is counts only.
 */
const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createImports, SOURCES } = require('../server/imports');

(async () => {
    const config = load(process.env);
    if (config.drill) throw new Error('refusing to import under TODAY_DRILL');
    const store = await openStore(config);
    try {
        const imports = createImports({ config, s: store, now: store.now });
        const asked = process.argv.slice(2).flatMap((x) => x.split(',')).filter(Boolean);
        const sources = asked.length ? asked : SOURCES;
        const out = await imports.runOnce({ sources });
        for (const [source, result] of Object.entries(out.sources || {})) {
            console.log(`[import] ${source}: ${result.ok ? 'ok' : 'failed'} imported=${result.imported || 0} retired=${result.retired || 0}${result.error ? ` error=${result.error}` : ''}`);
        }
        process.exitCode = Object.values(out.sources || {}).every((r) => r.ok) ? 0 : 1;
    } finally {
        await store.close();
    }
})().catch((err) => { console.error(`[import] ${err && err.message ? err.message : err}`); process.exitCode = 1; });
