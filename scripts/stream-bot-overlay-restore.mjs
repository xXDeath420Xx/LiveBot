#!/usr/bin/env node
/*
 * Put an overlay's settings back from a backup written by scripts/stream-bot-galaxy-alerts.mjs
 * (/home/death/certifried-data/overlay-backups/profile<P>-overlay<O>-<time>.json).
 *
 *   node scripts/stream-bot-overlay-restore.mjs <backup.json> [--apply]
 *
 * Without --apply it only says what it would restore. Open overlay pages pick the settings up when they reconnect (a
 * CertiFried restart, or Save on the overlay's page in the dashboard).
 */
import fs from 'node:fs';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { createOverlayStore } from '../core/stream-bot/overlays/store.js';
import { withDefaults } from '../core/stream-bot/overlays/config.js';

async function main() {
    const file = process.argv[2];
    if (!file || !fs.existsSync(file)) throw new Error('usage: stream-bot-overlay-restore.mjs <backup.json> [--apply]');
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ostore = createOverlayStore({ db: pool, encryption });
    const o = await ostore.get(Number(b.profileId), Number(b.overlayId));
    if (!o || o.type !== b.type) throw new Error('that overlay no longer exists, or is another kind now');
    console.log(`overlay ${b.overlayId} (${o.name}) of profile ${b.profileId}: settings from ${b.savedAt}`);
    if (!process.argv.includes('--apply')) { console.log('(dry run: add --apply to restore)'); return; }
    await ostore.update(Number(b.profileId), Number(b.overlayId), { config: withDefaults(b.type, b.config) });
    console.log('restored');
}

main().then(() => pool.end()).catch((err) => { console.error(err.message); pool.end().finally(() => process.exit(1)); });
