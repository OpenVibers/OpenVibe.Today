'use strict';

/**
 * Account export and deletion → Today (ADR-033; openvibe-sdk/account-data). The rows a person owns are their
 * events, the reminders they set, their feed token's row, their briefs and their idempotency keys. Every subject
 * column stores the bare usr_ id.
 *
 * A feed token is a bearer capability for one calendar, so it is NOT exported: today_feeds exports only its
 * subject and created_at. On deletion the row goes, so the old URL is 404 at once.
 *
 * The order matters for the orphan cleanup in extraErase: the person's events are erased with their subject rows,
 * then reminders other people set on those events and still-pending outbox rows for those events go too.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    { table: 'today_events', subject: 'owner_subject', value: (usr) => usr, file: 'events.json', erase: 'delete' },
    { table: 'today_reminders', subject: 'subject', value: (usr) => usr, file: 'reminders.json', erase: 'delete' },
    // The token itself is never exported; it is a bearer capability for the person's calendar.
    { table: 'today_feeds', subject: 'subject', value: (usr) => usr, file: 'feeds.json', columns: ['subject', 'created_at'], erase: 'delete' },
    { table: 'today_briefs', subject: 'subject', value: (usr) => usr, file: 'briefs.json', erase: 'delete' },
    { table: 'today_idempotency', subject: 'subject', value: (usr) => usr, file: 'idempotency.json', erase: 'delete' },
    // The public Live username → Network subject map the import job uses to put a followed channel first. It is a
    // public channel fact, not a private one, so it is erased with the person and not exported.
    { table: 'today_channels', subject: 'subject', value: (usr) => usr, file: null, erase: 'delete' },
];

async function extraErase(t) {
    await t.exec('DELETE FROM today_reminders WHERE event_id NOT IN (SELECT id FROM today_events)');
    await t.exec("DELETE FROM today_outbox WHERE payload->>'event_id' NOT IN (SELECT id FROM today_events)");
}

function create({ db, log = console } = {}) {
    return createAccountData({
        db,
        service: 'today',
        tables: TABLES,
        note: 'A feed token is a bearer capability for one calendar and is not exported.',
        extraErase,
        log,
    });
}

module.exports = { create, TABLES, TOPICS, extraErase };
