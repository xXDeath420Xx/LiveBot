// One-off: import BearOrso's KumaBot Defender export (TwitchAccount, Feb-Aug 2023) into kbd_banlist.
// Only entries banned as "Bot" are imported; the test entry and the two personal "Troll" bans are not.
// Idempotent: INSERT IGNORE on (platform, platform_user_id, list_type); every row tagged source='kbd_2023'.
// Usage: node scripts/import-kbd-2023.mjs <path-to-kbd-2023-banlist.json>
import fs from 'fs';
import pool from '../utils/db.js';
import { invalidateCache } from '../services/certifried-bot/defender/banlist.js';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/import-kbd-2023.mjs <json>'); process.exit(1); }
const all = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = all.filter(r => r.reason === 'Bot' && /^\d{1,20}$/.test(String(r.id)) && r.name);
console.log(`input ${all.length}, importing ${rows.length} "Bot" entries, skipping ${all.length - rows.length}`);

let inserted = 0;
for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000).map(r => [
        'twitch', String(r.id), String(r.name).toLowerCase().slice(0, 255),
        'KBD 2023 list: bot account', 'kbd_2023', 'ban',
    ]);
    const [res] = await pool.query(
        'INSERT IGNORE INTO kbd_banlist (platform, platform_user_id, username, reason, source, list_type) VALUES ?', [batch]);
    inserted += res.affectedRows;
}
invalidateCache();
const [[c]] = await pool.query("SELECT COUNT(*) n FROM kbd_banlist WHERE platform = 'twitch' AND source = 'kbd_2023'");
console.log(`inserted ${inserted}; kbd_banlist twitch/kbd_2023 rows now ${c.n}`);
process.exit(0);
