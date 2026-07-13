#!/usr/bin/env node
/**
 * One-off: Set up the "🎮 Mini-Games" area in Mama Bear's Lair
 * (guild 1216126780767731722) served by the CertiFried Bear custom bot.
 *
 * Creates:
 *   - Gated role: "Mini-Games" (amber, not hoisted, not mentionable)
 *   - Category: "🎮 MINI-GAMES" — hidden from @everyone, visible to role
 *   - 7 channels inside the category — one per mini-game area
 *   - A self-serve role-request message in #🎮-arcade (pin it manually after)
 *
 * Idempotent: re-runs detect existing role/category/channels by name and
 * skip creation. Permission overwrites are always applied.
 *
 * Usage:
 *   node scripts/setup-lair-minigames.mjs
 * Requires /tmp/lair-bot-token.txt (decrypted token) to be present.
 */
import fs from 'node:fs';
import {
    REST, Routes,
    PermissionFlagsBits, ChannelType,
} from 'discord.js';

const GUILD_ID = '1216126780767731722';
const TOKEN_FILE = '/tmp/lair-bot-token.txt';
const ROLE_NAME = 'Mini-Games';
const CATEGORY_NAME = '🎮 MINI-GAMES';

const CHANNELS = [
    { name: '🐾-owo-main',     topic: '/owo hunt · /owo zoo · /owo catalog · /owo daily · /owo leaderboard — the main hunting grounds.' },
    { name: '⚔-owo-battles',   topic: '/owo team · /owo equip · /owo battle · /owo2 forge — team-building + combat.' },
    { name: '🎰-daily-luck',   topic: '/luck once-per-day rolls · /owo daily claims · /owo balance.' },
    { name: '🎮-arcade',       topic: '/arcade trivia · hangman · counting · CFX · LFG · music quiz. General mini-game chat.' },
    { name: '🎵-music-quiz',   topic: 'Music-quiz rounds. Use /arcade musicquiz to start a round.' },
    { name: '🧭-pokemon',      topic: '/pokemon commands. Catch em all.' },
    { name: '🗡-rpg-adventure',topic: '/rpg — classic RPG character + quests + party loot.' },
];

const ROLE_MESSAGE = {
    title: '🎮 Welcome to Mini-Games',
    body:
        '**This area is opt-in** — you won\'t see the Mini-Games channels until you claim the <@&{ROLE_ID}> role.\n\n' +
        'Once you have the role you get access to:\n' +
        '• <#{CH_OWO}> — hunt, zoo, catalog, daily rewards\n' +
        '• <#{CH_BATTLE}> — build teams, equip weapons, fight\n' +
        '• <#{CH_LUCK}> — daily luck rolls + balance\n' +
        '• <#{CH_ARCADE}> — trivia, hangman, counting, CFX\n' +
        '• <#{CH_MUSIC}> — music-quiz rounds\n' +
        '• <#{CH_POKE}> — /pokemon\n' +
        '• <#{CH_RPG}> — /rpg adventures\n\n' +
        '**All rewards feed Lair\'s Economy + Leveling** — catches earn currency, battles build streaks, ' +
        'quests pay out crates / shards / coins.\n\n' +
        '*Ask a moderator to grant you the role (self-assignment via reaction coming soon).*',
};

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
    if (!fs.existsSync(TOKEN_FILE)) {
        console.error(`Token file ${TOKEN_FILE} missing. Run the token-extract step first.`);
        process.exit(1);
    }
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    const rest = new REST({ version: '10' }).setToken(token);

    console.log('[setup] Fetching guild state…');
    const [existingRoles, existingChannels] = await Promise.all([
        rest.get(Routes.guildRoles(GUILD_ID)),
        rest.get(Routes.guildChannels(GUILD_ID)),
    ]);

    // 1. Role
    let role = existingRoles.find(r => r.name === ROLE_NAME);
    if (!role) {
        console.log(`[setup] Creating role "${ROLE_NAME}"…`);
        role = await rest.post(Routes.guildRoles(GUILD_ID), {
            body: {
                name: ROLE_NAME,
                color: 0xF0A500,
                hoist: false,
                mentionable: false,
                permissions: '0',
                reason: 'Mini-games gated access role',
            },
            reason: 'Setup: mini-games area',
        });
        console.log(`[setup]   ↳ role id ${role.id}`);
    } else {
        console.log(`[setup] Role "${ROLE_NAME}" already exists (${role.id})`);
    }

    // 2. Category
    const everyoneId = existingRoles.find(r => r.name === '@everyone').id;
    const categoryOverwrites = [
        {
            id: everyoneId,
            type: 0, // role
            deny:  String(PermissionFlagsBits.ViewChannel),
            allow: '0',
        },
        {
            id: role.id,
            type: 0,
            allow: String(
                PermissionFlagsBits.ViewChannel |
                PermissionFlagsBits.SendMessages |
                PermissionFlagsBits.ReadMessageHistory |
                PermissionFlagsBits.AddReactions |
                PermissionFlagsBits.UseExternalEmojis |
                PermissionFlagsBits.EmbedLinks |
                PermissionFlagsBits.AttachFiles |
                PermissionFlagsBits.UseApplicationCommands
            ),
            deny: '0',
        },
    ];

    let category = existingChannels.find(c => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME);
    if (!category) {
        console.log(`[setup] Creating category "${CATEGORY_NAME}"…`);
        category = await rest.post(Routes.guildChannels(GUILD_ID), {
            body: {
                name: CATEGORY_NAME,
                type: ChannelType.GuildCategory,
                permission_overwrites: categoryOverwrites,
            },
            reason: 'Setup: mini-games category',
        });
        console.log(`[setup]   ↳ category id ${category.id}`);
    } else {
        console.log(`[setup] Category "${CATEGORY_NAME}" already exists (${category.id}) — refreshing overwrites`);
        await rest.patch(Routes.channel(category.id), {
            body: { permission_overwrites: categoryOverwrites },
            reason: 'Setup: refresh mini-games permissions',
        });
    }

    // 3. Channels
    const madeChannels = {};
    for (const def of CHANNELS) {
        let ch = existingChannels.find(c =>
            c.type === ChannelType.GuildText &&
            c.name === def.name &&
            c.parent_id === category.id
        );
        if (!ch) {
            console.log(`[setup] Creating channel "${def.name}"…`);
            ch = await rest.post(Routes.guildChannels(GUILD_ID), {
                body: {
                    name: def.name,
                    type: ChannelType.GuildText,
                    parent_id: category.id,
                    topic: def.topic,
                    // Explicit overwrites so channel inherits category access.
                    permission_overwrites: categoryOverwrites,
                },
                reason: 'Setup: mini-games channel',
            });
            console.log(`[setup]   ↳ #${def.name} id ${ch.id}`);
        } else {
            console.log(`[setup] #${def.name} already exists (${ch.id}) — updating topic`);
            await rest.patch(Routes.channel(ch.id), {
                body: { topic: def.topic, permission_overwrites: categoryOverwrites },
                reason: 'Setup: refresh channel topic/perms',
            });
        }
        madeChannels[def.name] = ch.id;
    }

    // 4. Post the welcome / role-request message in #🎮-arcade (only once)
    const arcadeId = madeChannels['🎮-arcade'];
    if (arcadeId) {
        let existingMsgs = [];
        try {
            existingMsgs = await rest.get(Routes.channelMessages(arcadeId) + '?limit=50');
        } catch { /* channel may be brand-new, skip */ }
        const already = existingMsgs.some(m => m.author?.id && m.embeds?.some(e => e.title === ROLE_MESSAGE.title));
        if (!already) {
            const body = ROLE_MESSAGE.body
                .replace('{ROLE_ID}', role.id)
                .replace('{CH_OWO}',    madeChannels['🐾-owo-main']  || '0')
                .replace('{CH_BATTLE}', madeChannels['⚔-owo-battles'] || '0')
                .replace('{CH_LUCK}',   madeChannels['🎰-daily-luck'] || '0')
                .replace('{CH_ARCADE}', madeChannels['🎮-arcade']     || '0')
                .replace('{CH_MUSIC}',  madeChannels['🎵-music-quiz'] || '0')
                .replace('{CH_POKE}',   madeChannels['🧭-pokemon']    || '0')
                .replace('{CH_RPG}',    madeChannels['🗡-rpg-adventure'] || '0');
            console.log('[setup] Posting welcome embed in #🎮-arcade…');
            await rest.post(Routes.channelMessages(arcadeId), {
                body: {
                    embeds: [{
                        title: ROLE_MESSAGE.title,
                        description: body,
                        color: 0xF0A500,
                        footer: { text: 'Mama Bear\'s Lair · Mini-Games · opt-in access' },
                    }],
                    allowed_mentions: { parse: [] },
                },
            });
        } else {
            console.log('[setup] Welcome embed already posted — skip.');
        }
    }

    console.log('\n[setup] ✅ Done.');
    console.log(`         Role:     ${ROLE_NAME}  ${role.id}`);
    console.log(`         Category: ${CATEGORY_NAME}  ${category.id}`);
    console.log('         Channels:');
    for (const [name, id] of Object.entries(madeChannels)) {
        console.log(`           #${name} → ${id}`);
    }
    console.log('\n         Grant the role via: right-click a member → Roles → Mini-Games,');
    console.log('         or set up a reaction-role in #🎮-arcade for self-serve.');
}

main().catch(e => {
    console.error('[setup] FAILED:', e.message);
    if (e.rawError) console.error(JSON.stringify(e.rawError, null, 2));
    process.exit(1);
});
