#!/usr/bin/env node
/**
 * Add a "🎮 Mini-Games" button to Panel 124 ("Gaming Opt-ins") in channel
 * 1496410189920735354 of Lair so members self-assign the Mini-Games role
 * alongside the existing Twitch Streamer / Palia Community buttons.
 *
 * Also UNDO the separate Join button I posted in #🎮-arcade — that was
 * redundant with the real self-react channel — and revert the two-tier
 * perms: the Mini-Games category gates back to @everyone denied + role
 * allowed (no baseline exception), since users no longer need to see
 * #🎮-arcade before joining.
 */
import fs from 'node:fs';
import {
    REST, Routes, PermissionFlagsBits, ChannelType,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import 'dotenv/config';
import mysql from 'mysql2/promise';

const GUILD_ID        = '1216126780767731722';
const MINI_GAMES_ROLE = '1496826488119627856';
const CATEGORY_ID     = '1496826489398755450';
const CH_ARCADE       = '1496826493840527440';
const CH_OTHER = [
    '1496826490837270548', // 🐾-owo-main
    '1496826491965669400', // ⚔-owo-battles
    '1496826492661923923', // 🎰-daily-luck
    '1496826496659099658', // 🧭-pokemon
    '1496826497892221008', // 🗡-rpg-adventure
];

const SELF_REACT_CHANNEL = '1496410189920735354';
const GAMING_PANEL_ID    = 124;
const GAMING_PANEL_MSG   = '1496432758468378656';

const rest = new REST({ version: '10' }).setToken(fs.readFileSync('/tmp/lair-bot-token.txt', 'utf8').trim());

const styleMap = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };

async function main() {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });

    // 1. Upsert the Mini-Games mapping into Panel 124
    console.log('[1] Adding Mini-Games row to reaction_role_mappings panel_id=' + GAMING_PANEL_ID + '…');
    const [existing] = await db.execute(
        'SELECT id FROM reaction_role_mappings WHERE panel_id = ? AND role_id = ?',
        [GAMING_PANEL_ID, MINI_GAMES_ROLE]
    );
    if (existing.length) {
        console.log('      ↳ already present (id ' + existing[0].id + ') — skipping insert.');
    } else {
        await db.execute(
            `INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id)
             VALUES (?, ?, ?, ?, ?)`,
            [GAMING_PANEL_ID, '🎮', 'Mini-Games', 'primary', MINI_GAMES_ROLE]
        );
        console.log('      ↳ inserted.');
    }

    // 2. Rebuild the buttons on the panel-124 Discord message
    const [mappings] = await db.execute(
        'SELECT emoji_id, label, button_style, role_id FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id',
        [GAMING_PANEL_ID]
    );
    console.log('[2] Rebuilding Panel 124 message with ' + mappings.length + ' buttons…');
    const rows = [];
    let row = new ActionRowBuilder();
    let count = 0;
    for (const m of mappings) {
        if (count >= 5) { rows.push(row); row = new ActionRowBuilder(); count = 0; }
        const btn = new ButtonBuilder()
            .setCustomId(`rr_${m.role_id}`)
            .setLabel(m.label)
            .setStyle(styleMap[m.button_style] || ButtonStyle.Primary);
        if (m.emoji_id) btn.setEmoji(m.emoji_id);
        row.addComponents(btn);
        count++;
    }
    if (count > 0) rows.push(row);
    await rest.patch(Routes.channelMessage(SELF_REACT_CHANNEL, GAMING_PANEL_MSG), {
        body: { components: rows.map(r => r.toJSON()) },
    });
    console.log('      ↳ message ' + GAMING_PANEL_MSG + ' updated.');

    // 3. Revert arcade/category perms to the simple Mini-Games-only gate
    const allRoles = await rest.get(Routes.guildRoles(GUILD_ID));
    const everyoneId = allRoles.find(r => r.name === '@everyone').id;
    const VIEW = PermissionFlagsBits.ViewChannel;
    const SEND = PermissionFlagsBits.SendMessages;
    const READ = PermissionFlagsBits.ReadMessageHistory;
    const REACT = PermissionFlagsBits.AddReactions;
    const EMBED = PermissionFlagsBits.EmbedLinks;
    const ATT = PermissionFlagsBits.AttachFiles;
    const EXT = PermissionFlagsBits.UseExternalEmojis;
    const APP = PermissionFlagsBits.UseApplicationCommands;
    const ROLE_ALLOW = String(VIEW | SEND | READ | REACT | EMBED | ATT | EXT | APP);
    const basicOverwrites = [
        { id: everyoneId, type: 0, deny: String(VIEW), allow: '0' },
        { id: MINI_GAMES_ROLE, type: 0, allow: ROLE_ALLOW, deny: '0' },
    ];

    console.log('[3] Reverting perms — Mini-Games-only on category + all 6 channels…');
    await rest.patch(Routes.channel(CATEGORY_ID), {
        body: { permission_overwrites: basicOverwrites },
        reason: 'Revert: join flow now uses existing self-react panel',
    });
    for (const id of [CH_ARCADE, ...CH_OTHER]) {
        await rest.patch(Routes.channel(id), {
            body: { permission_overwrites: basicOverwrites },
            reason: 'Revert: Mini-Games-only gate (baseline access no longer needed in arcade)',
        });
    }

    // 4. Remove the redundant welcome embed w/ button from #🎮-arcade
    console.log('[4] Removing redundant welcome embed from #🎮-arcade…');
    const msgs = await rest.get(Routes.channelMessages(CH_ARCADE) + '?limit=50').catch(() => []);
    for (const m of msgs) {
        const isMine = m.embeds?.some(e => String(e.title || '').includes('Welcome to Mini-Games'));
        if (isMine) {
            try {
                await rest.delete(Routes.channelMessage(CH_ARCADE, m.id));
                console.log('      ↳ removed ' + m.id);
            } catch (e) { console.log('      ↳ could not delete ' + m.id + ': ' + e.message); }
        }
    }

    await db.end();
    console.log('\n✅ Done.');
    console.log('   - Mini-Games now a 3rd button on Panel 124 ("Gaming Opt-ins") in <#' + SELF_REACT_CHANNEL + '>');
    console.log('   - Members click 🎮 Mini-Games to self-assign the role');
    console.log('   - Category + all 6 channels gated to Mini-Games role only (clean, no baseline exceptions)');
    console.log('   - Redundant arcade welcome embed removed');
}

main().catch(e => {
    console.error('FAILED:', e.message);
    if (e.rawError) console.error(JSON.stringify(e.rawError, null, 2));
    process.exit(1);
});
