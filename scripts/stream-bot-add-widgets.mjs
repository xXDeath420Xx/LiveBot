#!/usr/bin/env node
/*
 * One-off: add the stream widgets to a profile's Overlays list, ready to add to OBS (it does not touch OBS). An overlay of
 * the same kind and name that is already there is left alone, so running it twice adds nothing.
 *
 *   node scripts/stream-bot-add-widgets.mjs --profile 2 [--apply]
 *
 * Prints each overlay's id, kind and browser-source path with the key left out (the dashboard's Overlays page shows the
 * full address; CertiFried Studio adds it to OBS from there).
 */
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { createOverlayStore } from '../core/stream-bot/overlays/store.js';
import { overlayType, LIMITS } from '../core/stream-bot/overlays/config.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const PROFILE = Number(arg('profile'));
const APPLY = process.argv.includes('--apply');

// What the owner asked for (2026-11-20). Bar colour and accent follow the Galaxy alerts' purple; the rest are defaults.
const PURPLE = '#9146ff';
const WANTED = [
    { type: 'chat', name: 'Chat (Twitch, Kick, YouTube)', config: { platforms: ['twitch', 'kick', 'youtube'] } },
    { type: 'events', name: 'Recent events', config: { types: ['follow', 'sub', 'resub', 'gift_sub', 'cheer', 'raid', 'tip', 'bits.used', 'membership', 'watch_streak', 'charity', 'kicks.gifted'] } },
    { type: 'goal', name: 'Follower goal', config: { title: 'Follower goal', metric: 'followers', target: 100, barColor: PURPLE } },
    { type: 'goal', name: 'Sub goal', config: { title: 'Sub goal', metric: 'subs', target: 25, barColor: PURPLE } },
    { type: 'goal', name: 'Bits goal', config: { title: 'Bits goal', metric: 'bits', target: 5000, barColor: PURPLE } },
    { type: 'goal', name: 'Tip goal', config: { title: 'Tip goal', metric: 'tips', target: 100, barColor: PURPLE } },
    { type: 'train', name: 'Hype train and sub train', config: { barColor: PURPLE } },
    { type: 'tipjar', name: 'Tip jar', config: {} },
    { type: 'credits', name: 'End credits', config: {} },
    { type: 'emotewall', name: 'Emote wall', config: {} },
    { type: 'poll', name: 'Polls and predictions', config: { barColor: PURPLE } },
    { type: 'labels', name: 'Stream labels', config: {} },
    { type: 'viewers', name: 'Viewer count', config: {} },
    // Studio 0.2.14: heart rate from the owner's watch (Bluetooth through Studio, Pulsoid as the fallback)
    { type: 'heartrate', name: 'Heart rate', config: {} },
];

async function main() {
    if (!PROFILE) throw new Error('usage: --profile <id> [--apply]');
    const ostore = createOverlayStore({ db: pool, encryption });
    const have = await ostore.list(PROFILE);
    const missing = WANTED.filter((w) => !have.some((o) => o.type === w.type && o.name === w.name));
    if (have.length + missing.length > LIMITS.overlays) throw new Error(`that would make ${have.length + missing.length} overlays; the most is ${LIMITS.overlays}`);
    for (const w of WANTED) {
        const found = have.find((o) => o.type === w.type && o.name === w.name);
        if (found) { console.log(`${found.id}\t${w.type}\t${w.name}\talready there\t/stream/bot/overlay/${w.type}/<key>\t${overlayType(w.type).sourceName}`); continue; }
        if (!APPLY) { console.log(`-\t${w.type}\t${w.name}\twould be added`); continue; }
        const { overlay } = await ostore.create(PROFILE, { type: w.type, name: w.name, config: w.config });
        console.log(`${overlay.id}\t${w.type}\t${w.name}\tadded\t/stream/bot/overlay/${w.type}/<key>\t${overlayType(w.type).sourceName}`);
    }
    if (!APPLY) console.log('\n(dry run: add --apply to add them)');
}

main().then(() => pool.end()).catch((err) => { console.error(err.message); pool.end().finally(() => process.exit(1)); });
