import 'dotenv/config';
import pool from '../utils/db.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const CHANNELS = [
    { label: '729650115844898817 (ICBN Laser)',     guildId: '729650115844898817',   channelId: '1528196433239478343' },
    { label: '814321716872347648 (Kabbot)',         guildId: '814321716872347648',   channelId: '1466965996224118807' },
    { label: '1554057640504721409 (Hive Guardian)', guildId: '1554057640504721409',  channelId: '1554068634396131488' },
];

for (const ch of CHANNELS) {
    console.log(`\n=== ${ch.label}  channel=${ch.channelId} ===`);
    try {
        const bot = await resolveBotForGuild(ch.guildId);
        const raw = await bot.rest(`/channels/${ch.channelId}/messages?limit=100`);
        const msgs = raw.slice().reverse();
        const nums = msgs.filter(m => /^\d+$/.test((m.content || '').trim()));
        if (!nums.length) { console.log('  (no numeric messages in last 100)'); continue; }

        const last = nums[nums.length - 1];
        let streak = 1;
        for (let i = nums.length - 2; i >= 0; i--) {
            if (nums[i].author.id === last.author.id) streak++;
            else break;
        }
        console.log(`  bot: ${bot.botName} (${bot.botId})`);
        console.log(`  ${nums.length} numeric msgs in window (head = ${nums[0].content}, tail = ${last.content})`);
        console.log(`  trailing streak: ${streak}× by @${last.author.username} (${last.author.id})`);
        if (streak >= 2) {
            const firstInStreak = nums[nums.length - streak];
            console.log(`    streak range: ${firstInStreak.content} → ${last.content}`);
            const preIdx = nums.length - streak - 1;
            if (preIdx >= 0) {
                const pre = nums[preIdx];
                console.log(`    pre-grief: ${pre.content} by @${pre.author.username} (${pre.author.id})`);
                console.log(`    => rollback to: current_count = ${pre.content}, last_user_id = ${pre.author.id}`);
            } else {
                console.log('    pre-grief post older than our window');
            }
        } else {
            console.log('    (clean — no trailing single-user streak)');
        }

        // Longest streak anywhere in window.
        let maxStreak = 1, maxUser = null, maxEnd = null, cur = 1, curUser = nums[0].author.id;
        for (let i = 1; i < nums.length; i++) {
            if (nums[i].author.id === curUser) cur++;
            else {
                if (cur > maxStreak) { maxStreak = cur; maxUser = nums[i-1].author.username; maxEnd = nums[i-1].content; }
                cur = 1; curUser = nums[i].author.id;
            }
        }
        if (cur > maxStreak) { maxStreak = cur; maxUser = nums[nums.length-1].author.username; maxEnd = nums[nums.length-1].content; }
        console.log(`  longest streak anywhere in window: ${maxStreak}× (@${maxUser}, ending at ${maxEnd})`);
    } catch (err) {
        console.log(`  ERROR: ${err.message}`);
    }
}

await pool.end();
