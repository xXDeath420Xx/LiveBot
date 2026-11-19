// Roll back the ICBN counting channel to 143 and delete the 12 cheated
// posts (144 → 155) by user 485694366644699137. Idempotent: skips already-
// deleted messages, prints every action.
import 'dotenv/config';
import pool from '../utils/db.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD = '729650115844898817';
const CHANNEL = '1528196433239478343';
const GRIEFER = '485694366644699137';
const GRIEF_RANGE_START = 144, GRIEF_RANGE_END = 155;
const ROLLBACK_TO = 143;
const CLEAN_LAST_USER = '802459557816303626'; // @gggreal

// Step 1: DB rollback.
const [[before]] = await pool.execute(
    'SELECT current_count, last_user_id, allow_same_user FROM counting_channels WHERE channel_id = ?',
    [CHANNEL]);
console.log('Before:', before);

if (Number(before.current_count) === ROLLBACK_TO && String(before.last_user_id) === CLEAN_LAST_USER) {
    console.log('[skip] already at rollback target');
} else {
    await pool.execute(
        `UPDATE counting_channels
            SET current_count = ?,
                last_user_id  = ?
          WHERE guild_id = ? AND channel_id = ?`,
        [ROLLBACK_TO, CLEAN_LAST_USER, GUILD, CHANNEL]);
    const [[after]] = await pool.execute(
        'SELECT current_count, last_user_id FROM counting_channels WHERE channel_id = ?',
        [CHANNEL]);
    console.log('After:',  after);
}

// Step 2: delete the 12 cheated messages.
const bot = await resolveBotForGuild(GUILD);
console.log(`\nUsing bot ${bot.botName} (${bot.botId}) to clean up griefed messages…`);

// Fetch up to 100 recent messages, find the targets.
const raw = await bot.rest(`/channels/${CHANNEL}/messages?limit=100`);
const targets = raw.filter(m => {
    if (m.author.id !== GRIEFER) return false;
    const txt = (m.content || '').trim();
    if (!/^\d+$/.test(txt)) return false;
    const n = Number(txt);
    return n >= GRIEF_RANGE_START && n <= GRIEF_RANGE_END;
});
console.log(`Found ${targets.length} griefed messages to delete.`);

// Bulk delete (requires messages < 14 days old; falls back to per-message).
const young = [], old = [];
const CUTOFF = Date.now() - 14 * 24 * 3600_000;
for (const m of targets) {
    const createdAt = Number((BigInt(m.id) >> 22n)) + 1420070400000;
    (createdAt > CUTOFF ? young : old).push(m.id);
}
if (young.length >= 2) {
    await bot.rest(`/channels/${CHANNEL}/messages/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ messages: young }),
    });
    console.log(`Bulk-deleted ${young.length} messages (<14d old).`);
} else if (young.length === 1) {
    old.push(young[0]);
}
for (const id of old) {
    try {
        await bot.rest(`/channels/${CHANNEL}/messages/${id}`, { method: 'DELETE' });
        console.log(`Deleted ${id} (single).`);
    } catch (e) { console.log(`skip ${id}: ${e.message}`); }
}

console.log('\nDone.');
await pool.end();
