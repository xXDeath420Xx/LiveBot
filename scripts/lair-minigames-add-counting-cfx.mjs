#!/usr/bin/env node
/**
 * Finish the Lair mini-games routing:
 *   - Add #🔢-counting channel (wires to counting_channels)
 *   - Add #🌿-cfx-farm channel (CannaFarmX hangout — fits Lair's theme)
 *   - Both inside the existing MINI-GAMES category, gated to the Mini-Games role
 *   - Ensure counting_channels has a row pointing at the new channel
 */
import fs from 'node:fs';
import { REST, Routes, PermissionFlagsBits, ChannelType } from 'discord.js';
import 'dotenv/config';
import mysql from 'mysql2/promise';

const GUILD_ID        = '1216126780767731722';
const CATEGORY_ID     = '1496826489398755450';
const MINI_GAMES_ROLE = '1496826488119627856';

const NEW_CHANNELS = [
    { name: '🔢-counting',  topic: 'Counting game. Post only numbers — the bot keeps track. One miss resets the count.', slot: 'counting' },
    { name: '🌿-cfx-farm',  topic: 'CannaFarmX — /grow plant, /cfx commands. The farming-RPG system.', slot: 'cfx' },
];

const rest = new REST({ version: '10' }).setToken(fs.readFileSync('/tmp/lair-bot-token.txt', 'utf8').trim());

const VIEW   = PermissionFlagsBits.ViewChannel;
const SEND   = PermissionFlagsBits.SendMessages;
const READ   = PermissionFlagsBits.ReadMessageHistory;
const REACT  = PermissionFlagsBits.AddReactions;
const EMBED  = PermissionFlagsBits.EmbedLinks;
const ATT    = PermissionFlagsBits.AttachFiles;
const EXT    = PermissionFlagsBits.UseExternalEmojis;
const APP    = PermissionFlagsBits.UseApplicationCommands;
const ROLE_ALLOW = String(VIEW | SEND | READ | REACT | EMBED | ATT | EXT | APP);

async function main() {
    const guildRoles = await rest.get(Routes.guildRoles(GUILD_ID));
    const everyoneId = guildRoles.find(r => r.name === '@everyone').id;
    const basicOverwrites = [
        { id: everyoneId, type: 0, deny: String(VIEW), allow: '0' },
        { id: MINI_GAMES_ROLE, type: 0, allow: ROLE_ALLOW, deny: '0' },
    ];

    const existing = await rest.get(Routes.guildChannels(GUILD_ID));
    const made = {};

    for (const def of NEW_CHANNELS) {
        let ch = existing.find(c =>
            c.type === ChannelType.GuildText &&
            c.name === def.name &&
            c.parent_id === CATEGORY_ID
        );
        if (!ch) {
            console.log(`[+] Creating #${def.name}…`);
            ch = await rest.post(Routes.guildChannels(GUILD_ID), {
                body: {
                    name: def.name,
                    type: ChannelType.GuildText,
                    parent_id: CATEGORY_ID,
                    topic: def.topic,
                    permission_overwrites: basicOverwrites,
                },
                reason: 'Setup: additional mini-games channel',
            });
            console.log(`    ↳ ${ch.id}`);
        } else {
            console.log(`[=] #${def.name} already exists (${ch.id})`);
        }
        made[def.slot] = ch.id;
    }

    // Wire counting_channels to the new counting channel
    console.log('[*] Wiring counting_channels → ' + made.counting + '…');
    const db = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });
    await db.execute(
        `INSERT INTO counting_channels (guild_id, channel_id, current_count, highest_count, is_active)
         VALUES (?, ?, 0, 0, 1)
         ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), is_active = 1`,
        [GUILD_ID, made.counting]
    );
    await db.end();

    console.log('\n✅ Done.');
    console.log('   - #🔢-counting  → ' + made.counting + ' (counting_channels wired)');
    console.log('   - #🌿-cfx-farm  → ' + made.cfx + ' (CFX runs on invocation, category perms gate it)');
    console.log('   - Both role-gated to Mini-Games (' + MINI_GAMES_ROLE + ')');
}

main().catch(e => { console.error('FAILED:', e.message); if (e.rawError) console.error(JSON.stringify(e.rawError, null, 2)); process.exit(1); });
