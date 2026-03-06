/**
 * Analyze audit results to find likely false positives
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ch1 = JSON.parse(readFileSync(join(__dirname, '..', 'audit-results-899865437267963924.json'), 'utf8'));
const ch2 = JSON.parse(readFileSync(join(__dirname, '..', 'audit-results-1142508311594410086.json'), 'utf8'));
const all = [...ch1.messages, ...ch2.messages];

// Known server/channel IDs that are NOT user IDs
const KNOWN_NON_USER_IDS = new Set([
    '889550752123613194',  // server ID
    '899865437267963924',  // channel 1
    '1142508311594410086', // channel 2
]);

const falsePositives = new Map(); // id -> { reasons, msg }

for (const msg of all) {
    for (const id of msg.extractedIds) {
        const flags = [];

        // 1. Known server/channel ID
        if (KNOWN_NON_USER_IDS.has(id)) {
            flags.push('SERVER_OR_CHANNEL_ID');
        }

        // 2. ID appears inside a discord.com/channels/ URL (server/channel/message IDs)
        const urlPattern = new RegExp('discord\\.com/channels/[^\\s]*' + id);
        if (urlPattern.test(msg.content)) {
            flags.push('INSIDE_DISCORD_URL');
        }

        // 3. ID matches the message author (reporter posted their own ID)
        const authorId = msg.author.match(/\((\d+)\)/)?.[1];
        if (id === authorId) {
            flags.push('IS_MESSAGE_AUTHOR');
        }

        // 4. Duplicate ID in same message (e.g. <@ID> + "User ID: ID")
        // Not a false positive per se, just dedup

        if (flags.length > 0) {
            if (!falsePositives.has(id) || flags.some(f => f !== 'INSIDE_DISCORD_URL')) {
                falsePositives.set(id, {
                    flags,
                    author: msg.author,
                    content: msg.content.slice(0, 200)
                });
            }
        }
    }
}

console.log('=== Likely False Positives ===\n');
console.log(`Found ${falsePositives.size} suspicious entries out of ${all.length} messages\n`);

const toRemove = [];

for (const [id, info] of falsePositives) {
    console.log(`User ID: ${id}`);
    console.log(`  Flags: ${info.flags.join(', ')}`);
    console.log(`  Author: ${info.author}`);
    console.log(`  Content: ${info.content}`);
    console.log('');
    toRemove.push(id);
}

console.log('=== IDs to remove ===');
console.log(toRemove.join('\n'));
