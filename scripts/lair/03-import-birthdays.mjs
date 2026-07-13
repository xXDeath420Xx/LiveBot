// Parse Birthday Bot messages → (name, month, day) → match to current guild members → user_birthdays.
import 'dotenv/config';
import fs from 'fs';
import mysql from 'mysql2/promise';

const GUILD = '1216126780767731722';
const DUMP = '/home/death/CertiFriedUtility/scripts/lair/birthday-bot.jsonl';
const RECON = '/home/death/CertiFriedUtility/scripts/lair/recon.json';

// 1. Parse birthday extractions
const byName = new Map(); // name → { month, day, confirmations: number }
const lines = fs.readFileSync(DUMP, 'utf8').trim().split('\n');
for (const line of lines) {
    const m = JSON.parse(line);
    for (const e of m.embeds || []) {
        const desc = (e.description || '');
        const mm = desc.match(/^Happy Birthday \*\*(.+?)\*\*!?/);
        if (!mm) continue;
        const rawName = mm[1];
        // Unescape markdown: `\_` → `_`
        const name = rawName.replace(/\\([_*])/g, '$1');
        const ts = new Date(m.timestamp);
        const month = ts.getUTCMonth() + 1;
        const day = ts.getUTCDate();
        // Each birthday's MM-DD should be stable across years. Use latest timestamp
        // so we favor the most recent posting (in case Birthday Bot posted on the
        // wrong date once — unlikely, but the latest is most authoritative).
        const prev = byName.get(name);
        if (!prev || ts > prev.ts) byName.set(name, { month, day, ts });
    }
}
console.log(`parsed ${byName.size} unique birthday names from ${lines.length} messages`);

// 2. Load guild member list
const recon = JSON.parse(fs.readFileSync(RECON, 'utf8'));
const members = recon.members;
console.log(`guild has ${members.length} members`);

// 3. Matching functions — try progressively looser matches
const norm = s => (s || '').toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')   // strip most emoji
    .replace(/[^\p{L}\p{N}]/gu, '')                             // keep letters+numbers only
    .trim();

function candidateKeysForMember(m) {
    return [m.user.username, m.user.global_name, m.nick].filter(Boolean).map(norm);
}

function findMatch(searchName) {
    const target = norm(searchName);
    if (!target) return null;
    // Pass 1: exact
    for (const m of members) if (candidateKeysForMember(m).includes(target)) return m;
    // Pass 2: prefix
    for (const m of members) {
        for (const k of candidateKeysForMember(m)) {
            if (k && (k.startsWith(target) || target.startsWith(k))) return m;
        }
    }
    // Pass 3: substring
    for (const m of members) {
        for (const k of candidateKeysForMember(m)) {
            if (k && k.length >= 4 && target.length >= 4 && (k.includes(target) || target.includes(k))) return m;
        }
    }
    return null;
}

// 4. Resolve all names
const resolved = [];
const unresolved = [];
for (const [name, { month, day }] of byName) {
    const m = findMatch(name);
    if (m) resolved.push({ name, userId: m.user.id, username: m.user.username, month, day });
    else unresolved.push({ name, month, day });
}
console.log(`\nresolved: ${resolved.length}`);
console.log(`unresolved: ${unresolved.length}`);

// 5. Import resolved → user_birthdays (upsert)
const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
let inserted = 0, updated = 0, noop = 0;
for (const r of resolved) {
    try {
        const [existing] = await pool.execute(
            'SELECT month, day FROM user_birthdays WHERE user_id = ? AND guild_id = ?',
            [r.userId, GUILD]
        );
        if (existing.length) {
            if (existing[0].month === r.month && existing[0].day === r.day) { noop++; continue; }
            await pool.execute(
                'UPDATE user_birthdays SET month = ?, day = ? WHERE user_id = ? AND guild_id = ?',
                [r.month, r.day, r.userId, GUILD]
            );
            updated++;
        } else {
            await pool.execute(
                'INSERT INTO user_birthdays (user_id, guild_id, month, day) VALUES (?, ?, ?, ?)',
                [r.userId, GUILD, r.month, r.day]
            );
            inserted++;
        }
    } catch (e) {
        console.log(`  ✗ ${r.name} (${r.userId}): ${e.message}`);
    }
}
await pool.end();

console.log(`\nDB result: inserted=${inserted}, updated=${updated}, no-op=${noop}`);
console.log(`\n--- RESOLVED ---`);
for (const r of resolved.sort((a, b) => a.month - b.month || a.day - b.day)) {
    console.log(`  ${String(r.month).padStart(2, '0')}/${String(r.day).padStart(2, '0')}  ${r.name.padEnd(32)}  →  ${r.username} (${r.userId})`);
}
console.log(`\n--- UNRESOLVED (need manual review) ---`);
for (const u of unresolved) {
    console.log(`  ${String(u.month).padStart(2, '0')}/${String(u.day).padStart(2, '0')}  ${u.name}`);
}

// Write the results to a JSON side-file for audit
fs.writeFileSync('/home/death/CertiFriedUtility/scripts/lair/birthdays-imported.json', JSON.stringify({ resolved, unresolved, summary: { inserted, updated, noop } }, null, 2));
