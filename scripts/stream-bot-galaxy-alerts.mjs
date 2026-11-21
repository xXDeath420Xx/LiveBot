#!/usr/bin/env node
/*
 * One-off: give a profile's alert box the owner's Streamlabs "Galaxy Alert Box" look on every alert
 * (C:\Users\crawf\Documents\CertiFried\streamlabs-alertbox-galaxy-2026-11-20.md), keeping the previous settings in a backup file.
 *
 *   node scripts/stream-bot-galaxy-alerts.mjs --profile 2 --overlay 2 [--apply]
 *
 * Without --apply it prints what would change. The Galaxy files are CertiFried's own copies (overlay media and the sound
 * library, byte-identical to the Streamlabs library files, checked by SHA-256 on 2026-11-20), found by name; nothing is
 * fetched. Streamlabs settings matched: text over the image at 50 % size, 8 s, text after 1 s, volume 50 %, fade in and out,
 * the same wording. Events Streamlabs showed with its default image (power-ups, watch streaks, charity and the rest) get the
 * nearest Galaxy file. Alerts that are switched off stay off; general settings (font, size, colours, gap) are kept.
 * The backup goes to /home/death/certifried-data/overlay-backups/; scripts/stream-bot-overlay-restore.mjs puts it back.
 */
import fs from 'node:fs';
import path from 'node:path';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { createOverlayStore } from '../core/stream-bot/overlays/store.js';
import { validateConfig, ALERT_KEYS } from '../core/stream-bot/overlays/config.js';
import { createStore } from '../core/stream-bot/store.js';
import { createSoundLibrary } from '../core/stream-bot/sounds.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const PROFILE = Number(arg('profile'));
const OVERLAY = Number(arg('overlay'));
const BACKUP_DIR = '/home/death/certifried-data/overlay-backups';

// The Galaxy files by their sha256 (the Streamlabs library files, downloaded once on 2026-11-20 and compared).
const SHA = {
    follower: 'dbfb6db20146aa874dc31c15396c4d9b616407cc9cefe48dd1b4b71813c2eca2',
    subscriber: '27095daaee3cb9d408db39576fd26130c1bff025b2c3051d895eaf2b40e7c04b',
    raid: '787c2a7975091439ced9422a9418cbf9ddc13cd74c38b6c414099981d1e97f7f',
    donation: '917f4d8775f8367ea219e19b448a3629488148114ff6599953af4681b51c985b',
    cheer: '86f98abbd5542ec81158a2bc51653c27e54a0c43b79013af1a959aca9da7989c',
    sfx: '93737e4bdca7d88c10d5270dc1b49cd3accb0a4727452d958674e7c7fde82263',
};
// Which Galaxy file each alert uses, and the wording for alerts the Streamlabs box did not have (theirs is kept otherwise).
const PLAN = {
    follow: ['follower'], sub: ['subscriber'], resub: ['subscriber'], gift_sub: ['subscriber'], cheer: ['cheer'], raid: ['raid'],
    redemption: ['follower'], powerup: ['cheer'], tip: ['donation'], hype_train: ['raid'],
    watch_streak: ['follower', '{user.name} is on a {amount}-stream watch streak!'],
    charity: ['donation', '{user.name} donated {amount} {currency}!'],
    kick_follow: ['follower'], kick_sub: ['subscriber'], kick_gift: ['subscriber'],
    kicks: ['cheer', '{user.name} sent {amount} Kicks!'],
    yt_subscriber: ['follower', '{user.name} just subscribed!'],
    yt_superchat: ['donation', '{user.name} donated {amount} {currency}!'],
    yt_sticker: ['donation', '{user.name} donated {amount} {currency}!'],
    yt_member: ['subscriber', '{user.name} just became a member!'],
    yt_milestone: ['subscriber', '{user.name} has been a member for {months} months!'],
    yt_gift: ['subscriber', '{user.name} gifted {count} memberships!'],
};
const GALAXY = { layout: 'over', animation: 'fade', mediaScale: 50, volume: 50, durationMs: 8000, textDelayMs: 1000, detail: '' };
const BITS_TIERS = [100, 1000, 5000, 10000];   // Streamlabs: default_1 (the alert itself), _100, _1000, _5000, _10000

async function main() {
    if (!PROFILE || !OVERLAY) throw new Error('usage: --profile <id> --overlay <id> [--apply]');
    const ostore = createOverlayStore({ db: pool, encryption });
    const o = await ostore.get(PROFILE, OVERLAY);
    if (!o || o.type !== 'alerts') throw new Error('that alert box does not exist for that profile');
    const [[raw]] = await pool.query('SELECT config FROM stream_bot_overlays WHERE id = ? AND profile_id = ?', [OVERLAY, PROFILE]);
    const media = await ostore.listMedia(PROFILE);
    const sounds = await createSoundLibrary({ store: createStore({ db: pool, encryption }) }).list(PROFILE);
    const byMediaSha = new Map(media.map((m) => [m.sha256, m]));
    const ids = {};
    for (const k of ['follower', 'subscriber', 'raid', 'donation', 'cheer']) {
        const m = byMediaSha.get(SHA[k]);
        if (!m || m.kind !== 'video') throw new Error(`the Galaxy ${k} video is not in this profile's media`);
        ids[k] = m.id;
    }
    const sfx = sounds.find((s) => s.sha256 === SHA.sfx)?.id || null;
    if (!sfx) throw new Error('the Galaxy sound is not in this profile\'s sound library');

    const cfg = JSON.parse(JSON.stringify(o.config));
    const changes = [];
    for (const key of ALERT_KEYS) {
        const [file, wording] = PLAN[key];
        const a = cfg.alerts[key];
        const before = JSON.stringify(a);
        Object.assign(a, GALAXY, { media: ids[file], sound: sfx });
        const stored = JSON.parse(raw.config || '{}').alerts?.[key];
        if (wording && !stored) a.message = wording;   // a new alert kind: Galaxy wording; an existing one keeps the owner's
        if (key === 'cheer') a.variations = BITS_TIERS.map((min) => ({ min, message: '', detail: '', media: ids.cheer, sound: sfx, layout: '', animation: '', durationMs: '' }));
        if (JSON.stringify(a) !== before) changes.push(`${key}: ${file}${a.enabled ? '' : ' (stays off)'} · "${a.message}"`);
    }
    const v = validateConfig('alerts', cfg, { mediaIds: new Set(media.map((m) => m.id)), soundIds: new Set(sounds.map((s) => s.id)) });
    if (!v.ok) throw new Error(`the new settings do not validate: ${v.errors.join(' ')}`);
    console.log(changes.join('\n'));
    if (!APPLY) { console.log('\n(dry run: add --apply to save)'); return; }
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o750 });
    const file = path.join(BACKUP_DIR, `profile${PROFILE}-overlay${OVERLAY}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ profileId: PROFILE, overlayId: OVERLAY, name: o.name, type: o.type, savedAt: new Date().toISOString(), config: JSON.parse(raw.config || '{}') }, null, 2), { mode: 0o640 });
    await ostore.update(PROFILE, OVERLAY, { config: v.value });
    console.log(`\nsaved; previous settings in ${file}`);
}

main().then(() => pool.end()).catch((err) => { console.error(err.message); pool.end().finally(() => process.exit(1)); });
