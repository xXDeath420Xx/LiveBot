// One-off: fetch a missed message via Discord HTTP API and replay it through
// the community-support tracker pipeline. No Discord.js client, no gateway
// connection — safe to run while PM2 bot is online.
import 'dotenv/config';
import encryption from '../utils/encryption.js';
import pool from '../utils/db.js';
import {
    getConfig, extractTwitchUsernames, checkAffiliateStatus,
    resolveTwitchUsername, recordEntry, findBestTwitchMatch
} from '../core/community-support-manager.js';

const GUILD_ID = '902393911958470717';
const CHANNEL_ID = '1318141825009319936';
const MESSAGE_ID = '1493172452677652541';
const BOT_ID = '1476040458680406214';

async function main() {
    const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!rows.length) throw new Error('bot not found');
    const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

    const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, {
        headers: { Authorization: `Bot ${token}` }
    });
    if (!res.ok) throw new Error(`Discord API ${res.status}: ${await res.text()}`);
    const message = await res.json();

    console.log(`Message author: ${message.author.username} (${message.author.id})`);
    console.log(`Content: ${message.content}`);

    if (message.author.bot) { console.log('Author is a bot, skipping'); return; }

    const config = await getConfig(GUILD_ID);
    if (!config) throw new Error('community support not enabled for guild');

    let entryType = null;
    if (CHANNEL_ID === config.raid_channel_id) entryType = 'raid';
    else if (CHANNEL_ID === config.support_channel_id) entryType = 'support';
    else throw new Error(`channel ${CHANNEL_ID} is not a tracked channel`);

    if (entryType === 'support' && /\braid(ed|ing)?\b/i.test(message.content)) {
        entryType = 'raid';
    }
    console.log(`Entry type: ${entryType}`);

    const targets = [];
    const mentionRegex = /<@!?(\d+)>/g;
    let match;
    while ((match = mentionRegex.exec(message.content)) !== null) {
        const mentionedId = match[1];
        if (mentionedId === message.author.id) continue;

        const resolved = await resolveTwitchUsername(GUILD_ID, mentionedId);
        if (resolved) {
            targets.push({ username: resolved.username, twitchId: resolved.twitchId, discordId: mentionedId });
            continue;
        }

        const memberRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${mentionedId}`, {
            headers: { Authorization: `Bot ${token}` }
        });
        if (!memberRes.ok) continue;
        const member = await memberRes.json();
        const nameSources = [member.user?.username, member.nick, member.user?.global_name].filter(Boolean);

        const bestMatch = await findBestTwitchMatch(nameSources, GUILD_ID, mentionedId);
        if (bestMatch) {
            targets.push({
                username: bestMatch.canonicalUsername,
                twitchId: bestMatch.twitchId,
                discordId: mentionedId,
                preResolved: true,
                isAffiliate: bestMatch.isAffiliate
            });
        } else {
            const cleaned = (member.user?.username || '').toLowerCase()
                .replace(/\.+$/, '')
                .replace(/[_.]?ttv$/i, '')
                .replace(/[^a-z0-9_]/g, '')
                .replace(/^_+|_+$/g, '');
            if (cleaned) targets.push({ username: cleaned, discordId: mentionedId, noTwitch: true });
        }
    }

    for (const { username: name, fromUrl } of extractTwitchUsernames(message.content)) {
        if (!targets.find(t => t.username.toLowerCase() === name.toLowerCase())) {
            targets.push({ username: name, fromUrl });
        }
    }

    if (targets.length === 0) {
        console.log('No targets found in message');
        return;
    }

    console.log(`Found ${targets.length} target(s): ${targets.map(t => t.username).join(', ')}`);

    let totalPoints = 0;
    for (const target of targets) {
        let isAffiliate = false;
        let twitchId = target.twitchId || null;
        let displayUsername = target.username;
        try {
            if (target.preResolved) {
                isAffiliate = target.isAffiliate;
            } else {
                const result = await checkAffiliateStatus(GUILD_ID, target.username);
                isAffiliate = result.isAffiliate;
                twitchId = result.twitchId || twitchId;
                displayUsername = result.canonicalUsername || target.username;
            }
        } catch (err) {
            console.warn(`Affiliate check failed for ${target.username}: ${err.message}`);
        }

        const points = await recordEntry(
            GUILD_ID, message.author.id, entryType, displayUsername,
            isAffiliate, message.id, CHANNEL_ID, config, twitchId
        );
        totalPoints += points;
        console.log(`  -> ${displayUsername} (${isAffiliate ? 'affiliate' : 'non-affiliate'}) +${points}pts`);
    }

    console.log(`Total points awarded: ${totalPoints}`);
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error('FAILED:', err); process.exit(1); });
