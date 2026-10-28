'use strict';

/**
 * OpenVibe.Today's own PostgreSQL database (ADR-035): the schema is migrations/NNNN_*.sql, applied at boot.
 * Nothing written here is ever a secret except a feed token, which is a bearer capability for one calendar and
 * is treated as one (never logged).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh today)');
        const dir = config.db.pgliteDir || DEV_PGLITE;
        log.warn(`[OpenVibe.Today] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'today', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'today-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'today', registry, log });
}

/** The store every module takes: the db handle, a clock (epoch ms; tests inject one), ids and transactions. */
function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,
        iso: () => new Date(now()).toISOString(),
        newId: (prefix) => {
            if (prefix === 'event') return `evt_${require('openvibe-contracts').ids.ulid(now())}`;
            return `${prefix}_${require('openvibe-contracts').ids.ulid(now())}`;
        },
        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    };
}

async function openStore(config, { now, log } = {}) {
    return createStore(await openDb(config, { log }), { now });
}

/** A today_events id: tev_ + 20 Crockford base32 characters (100 bits from the OS random source). */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newEventId() {
    const bytes = crypto.randomBytes(13);
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5 && out.length < 20) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    while (out.length < 20) { out += BASE32[value & 31]; value >>>= 5; }
    return `tev_${out.slice(0, 20)}`;
}

module.exports = { openDb, openStore, createStore, newEventId, MIGRATIONS };
