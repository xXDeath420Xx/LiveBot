#!/usr/bin/env node
/**
 * Backfill join logs for a guild.
 *
 * Fetches all guild members, filters by joinedAt date range
 * (from when bot was added to the first real join log),
 * and posts join embeds to the specified log channel.
 *
 * Usage:
 *   node scripts/backfill-join-logs.js              # Dry run (list only)
 *   node scripts/backfill-join-logs.js --post        # Post embeds to channel
 */

import dotenv from 'dotenv';
dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '844406178799943730';
const BOT_ID = '1438897897289552054';
const LOG_CHANNEL_ID = '844406664744271882';
const CUTOFF = new Date('2026-02-14T06:34:00Z');

async function getBotToken() {
    let [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );
    if (bots.length === 0) {
        [bots] = await pool.execute(
            'SELECT bot_token FROM custom_bots WHERE client_id = ?',
            [BOT_ID]
        );
    }
    if (bots.length === 0) throw new Error(`Bot ${BOT_ID} not found in custom_bots`);
    return encryption.decrypt(JSON.parse(bots[0].bot_token));
}

async function main() {
    const args = process.argv.slice(2);
    const shouldPost = args.includes('--post');

    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║  Backfill Join Logs                            ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log(`  Mode:    ${shouldPost ? '📨 POST TO CHANNEL' : '🔍 DRY RUN (list only)'}`);
    console.log(`  Guild:   ${GUILD_ID}`);
    console.log(`  Channel: ${LOG_CHANNEL_ID}`);
    console.log(`  Cutoff:  ${CUTOFF.toISOString()}\n`);

    // Connect to Discord
    console.log('1. Connecting to Discord...');
    const token = await getBotToken();
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
    });
    await client.login(token);
    console.log(`   Logged in as ${client.user.tag}`);

    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch();
    console.log(`   Fetched ${members.size} members from ${guild.name}\n`);

    // Find when the bot joined (our start date)
    const botMember = guild.members.cache.get(client.user.id);
    const botJoinedAt = botMember?.joinedAt;
    console.log(`2. Bot joined server: ${botJoinedAt ? botJoinedAt.toISOString() : 'unknown'}`);
    console.log(`   Looking for members who joined between bot join and ${CUTOFF.toISOString()}\n`);

    // Filter members who joined in the gap period
    const gapJoins = [];
    for (const [id, member] of members) {
        if (!member.joinedAt) continue;
        if (id === client.user.id) continue; // skip the bot itself

        const joinedAt = member.joinedAt;
        // If we know when bot joined, use that as start; otherwise include all before cutoff
        const afterBotJoin = botJoinedAt ? joinedAt >= botJoinedAt : true;
        const beforeCutoff = joinedAt < CUTOFF;

        if (afterBotJoin && beforeCutoff) {
            gapJoins.push({
                id: member.id,
                tag: member.user.tag,
                username: member.user.username,
                displayName: member.displayName,
                globalName: member.user.globalName,
                joinedAt: member.joinedAt,
                createdAt: member.user.createdAt,
                avatarURL: member.user.displayAvatarURL({ dynamic: true, size: 128 }),
            });
        }
    }

    // Sort chronologically
    gapJoins.sort((a, b) => a.joinedAt - b.joinedAt);

    console.log(`3. Found ${gapJoins.length} members who joined in the gap:\n`);

    if (gapJoins.length === 0) {
        console.log('   No members found in this date range.');
        client.destroy();
        await pool.end();
        return;
    }

    // Print them all
    console.log('   ┌────┬──────────────────────────────┬────────────────────────────┐');
    console.log('   │  # │ User                         │ Joined At                  │');
    console.log('   ├────┼──────────────────────────────┼────────────────────────────┤');
    for (let i = 0; i < gapJoins.length; i++) {
        const j = gapJoins[i];
        const num = String(i + 1).padStart(2);
        const name = j.tag.padEnd(28);
        const date = j.joinedAt.toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');
        console.log(`   │ ${num} │ ${name} │ ${date} │`);
    }
    console.log('   └────┴──────────────────────────────┴────────────────────────────┘\n');

    // Post embeds
    if (!shouldPost) {
        console.log('DRY RUN — no messages posted. Run with --post to send embeds.');
        client.destroy();
        await pool.end();
        return;
    }

    console.log('4. Posting join log embeds...');
    const channel = await guild.channels.fetch(LOG_CHANNEL_ID);
    if (!channel) {
        console.error('   Channel not found!');
        client.destroy();
        await pool.end();
        return;
    }

    let posted = 0;
    for (const j of gapJoins) {
        const embed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('👋 Member Joined')
            .setDescription(`<@${j.id}> joined the server`)
            .addFields(
                { name: 'User', value: `${j.tag} (${j.id})`, inline: true },
                { name: 'Account Created', value: `<t:${Math.floor(j.createdAt.getTime() / 1000)}:R>`, inline: true },
                { name: 'Joined At', value: `<t:${Math.floor(j.joinedAt.getTime() / 1000)}:f>`, inline: true }
            )
            .setThumbnail(j.avatarURL)
            .setTimestamp(j.joinedAt)
            .setFooter({ text: 'Backfilled join log' });

        await channel.send({ embeds: [embed] });
        posted++;
        console.log(`   ✅ ${posted}/${gapJoins.length} — ${j.tag} (joined ${j.joinedAt.toISOString()})`);

        // Small delay to avoid rate limits
        if (posted % 5 === 0) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    console.log(`\nDone! Posted ${posted} join log embeds to #${channel.name}.`);

    client.destroy();
    await pool.end();
}

main().catch(err => {
    console.error('Failed:', err);
    process.exit(1);
});
