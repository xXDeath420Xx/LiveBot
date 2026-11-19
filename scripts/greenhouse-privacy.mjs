#!/usr/bin/env node
// Greenhouse Tycoon privacy requests from Twitch or Kick players, who cannot use the Discord /privacy command
// (phase 5, register H-631). Same code as /privacy (services/cfx/privacy): the save the sign-in is on, every
// sign-in linked to it, and the old CertiFried Tycoon rows while those tables exist.
//
//   node scripts/greenhouse-privacy.mjs export <platform> <user id> --out <file.json>
//   node scripts/greenhouse-privacy.mjs delete <platform> <user id> --yes
//
// platform: twitch, kick, discord or twitch_opaque (the panel's U... id). Export writes the file with mode 0600;
// send it to the person and delete your copy. Discord members should use /privacy themselves.
import fs from 'node:fs';
import pool from '../utils/db.js';
import { createPersonPrivacy, PERSON_PLATFORMS } from '../services/cfx/privacy/index.js';
import { redactRow } from '../core/privacy-tables.js';

const [action, platform, userId, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const option = (name) => { const i = rest.indexOf(name); return i === -1 ? null : rest[i + 1] || null; };
const say = (line) => process.stdout.write(`${line}\n`);

async function main() {
    if (!['export', 'delete'].includes(action) || !PERSON_PLATFORMS.includes(platform) || !userId) {
        say('usage: greenhouse-privacy.mjs export <platform> <user id> --out <file.json>');
        say('       greenhouse-privacy.mjs delete <platform> <user id> --yes');
        say(`platform: ${PERSON_PLATFORMS.join(', ')}`);
        return 2;
    }
    const privacy = createPersonPrivacy({ db: pool });
    const key = { platform, platformUserId: userId };
    if (action === 'export') {
        const out = option('--out');
        if (!out) { say('--out <file.json> is required'); return 2; }
        const r = await privacy.exportFor(key);
        const tables = Object.fromEntries(Object.entries(r.tables).map(([t, s]) => [t, { total: s.total, truncated: s.total > s.rows.length, rows: s.rows.map(redactRow) }]));
        const payload = {
            generated_at: new Date().toISOString(),
            about: 'Greenhouse Tycoon data for one sign-in and the save it is on (tables starting with gh_), and the old '
                + 'CertiFried Tycoon game while it is kept (tables starting with cfx_). Credentials are shown as [redacted].',
            sign_in: key, greenhouse_account_id: r.accountId, greenhouse_sign_ins: r.signIns, old_game_players: r.oldGamePlayers, tables
        };
        fs.writeFileSync(out, JSON.stringify(payload, null, 1), { mode: 0o600 });
        const rows = Object.values(tables).reduce((s, x) => s + x.rows.length, 0);
        say(`wrote ${out}: ${rows} row(s) from ${Object.keys(tables).length} table(s)`);
        return 0;
    }
    if (!flag('--yes')) { say('delete removes the whole save and every sign-in linked to it. Add --yes to go ahead.'); return 2; }
    const r = await privacy.deleteFor(key);
    const n = (m) => Object.values(m).reduce((s, x) => s + x, 0);
    say(`deleted ${n(r.deleted)} row(s), anonymised ${n(r.anonymised)} (save ${r.accountId ?? 'none'}, old game players ${r.oldGamePlayers})`);
    for (const [t, c] of Object.entries(r.deleted)) say(`  ${t}: ${c}`);
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => { process.stderr.write(`failed: ${err.message}\n`); process.exit(1); });
