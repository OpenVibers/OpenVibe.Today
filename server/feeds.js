'use strict';

/** A person's private calendar feed token (32 random bytes, base64url) and its rotation. */
const crypto = require('crypto');

function newFeedToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function createFeeds({ s }) {
    const db = s.db;

    async function getOrCreate(subject) {
        const existing = await db.maybe('SELECT token FROM today_feeds WHERE subject = $1', [subject]);
        if (existing) return existing.token;
        for (let i = 0; i < 3; i++) {
            const token = newFeedToken();
            const row = await db.maybe(
                `INSERT INTO today_feeds (subject, token, created_at) VALUES ($1, $2, $3::timestamptz)
                 ON CONFLICT (subject) DO NOTHING
                 RETURNING token`,
                [subject, token, new Date(s.now()).toISOString()],
            );
            if (row) return row.token;
            const again = await db.maybe('SELECT token FROM today_feeds WHERE subject = $1', [subject]);
            if (again) return again.token;
        }
        throw new Error('could not create a feed token');
    }

    async function rotate(subject) {
        for (let i = 0; i < 3; i++) {
            const token = newFeedToken();
            const row = await db.maybe(
                `INSERT INTO today_feeds (subject, token, created_at) VALUES ($1, $2, $3::timestamptz)
                 ON CONFLICT (subject) DO UPDATE SET token = EXCLUDED.token, created_at = EXCLUDED.created_at
                 RETURNING token`,
                [subject, token, new Date(s.now()).toISOString()],
            );
            if (row) return row.token;
        }
        throw new Error('could not rotate the feed token');
    }

    async function findByToken(token) {
        return await db.maybe('SELECT subject, token, created_at FROM today_feeds WHERE token = $1', [token]);
    }

    function url(config, token) {
        return `${String(config.baseUrl).replace(/\/+$/, '')}/ics/${token}.ics`;
    }

    return { getOrCreate, rotate, findByToken, url, newFeedToken };
}

module.exports = { createFeeds, newFeedToken };
