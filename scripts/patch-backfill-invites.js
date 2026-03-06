#!/usr/bin/env node
/**
 * Patch backfilled join log embeds with invite data from invite_tracker_logs.
 * Finds the 4 embeds that have matching invite data and adds Invited By / Invite Code fields.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '844406178799943730';
const BOT_ID = '1438897897289552054';
const LOG_CHANNEL_ID = '844406664744271882';

// Users with invite data (from invite_tracker_logs cross-reference)
const updates = [
    { userId: '448388755192283136', inviterId: '842881525434679336', code: 'PQYZat9N' },  // mansonite_isag
    { userId: '532067451131658250', inviterId: '842881525434679336', code: 'nSfsmXbZ' },  // 1taymo_
    { userId: '1448558533120622622', inviterId: '842881525434679336', code: 'YEdutd9t' }, // tjsmoke420
    { userId: '811636730225885237', inviterId: '842881525434679336', code: 'aKEF6Yf4' },  // dethslayr
];

async function getBotToken() {
    let [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]
    );
    if (bots.length === 0) {
        [bots] = await pool.execute(
            'SELECT bot_token FROM custom_bots WHERE client_id = ?', [BOT_ID]
        );
    }
    if (bots.length === 0) throw new Error(`Bot ${BOT_ID} not found`);
    return encryption.decrypt(JSON.parse(bots[0].bot_token));
}

async function main() {
    const token = await getBotToken();
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
    });
    await client.login(token);
    console.log(`Logged in as ${client.user.tag}`);

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();
    const channel = await guild.channels.fetch(LOG_CHANNEL_ID);

    // Fetch recent messages to find backfilled embeds
    const messages = await channel.messages.fetch({ limit: 100 });
    console.log(`Fetched ${messages.size} messages from #${channel.name}`);

    const updateUserIds = new Set(updates.map(u => u.userId));
    let edited = 0;

    for (const [msgId, msg] of messages) {
        if (msg.author.id !== client.user.id) continue;
        if (msg.embeds.length === 0) continue;

        const embed = msg.embeds[0];
        if (embed.title !== '👋 Member Joined') continue;
        if (!embed.footer?.text?.includes('Backfilled')) continue;

        // Extract user ID from the "User" field: "username (123456789)"
        const userField = embed.fields?.find(f => f.name === 'User');
        if (!userField) continue;

        const idMatch = userField.value.match(/\((\d+)\)/);
        if (!idMatch) continue;
        const embedUserId = idMatch[1];

        if (!updateUserIds.has(embedUserId)) continue;

        const update = updates.find(u => u.userId === embedUserId);
        const inviterMember = guild.members.cache.get(update.inviterId);
        const inviterTag = inviterMember ? inviterMember.user.tag : update.inviterId;

        // Rebuild embed with invite info
        const newEmbed = EmbedBuilder.from(embed)
            .addFields(
                { name: 'Invited By', value: `<@${update.inviterId}> (${inviterTag})`, inline: true },
                { name: 'Invite Code', value: `\`${update.code}\``, inline: true }
            );

        await msg.edit({ embeds: [newEmbed] });
        const member = guild.members.cache.get(embedUserId);
        console.log(`  Edited: ${member?.user?.tag || embedUserId} — invited by ${inviterTag} via ${update.code}`);
        edited++;
    }

    console.log(`\nDone! Edited ${edited} of ${updates.length} embeds.`);

    client.destroy();
    await pool.end();
}

main().catch(err => {
    console.error('Failed:', err);
    process.exit(1);
});
