#!/usr/bin/env node
/**
 * Fix the chicken-and-egg in the Lair mini-games area:
 *   - #🎮-arcade (where the Join button lives) must be visible to the
 *     baseline access role (1496410189920735354) so members can actually
 *     find and click the button.
 *   - All other mini-games channels stay gated to the Mini-Games role.
 *   - Category visibility opens to the baseline role so members see the
 *     arcade tab; deeper channel overrides hide the rest.
 */
import fs from 'node:fs';
import { REST, Routes, PermissionFlagsBits, ChannelType } from 'discord.js';

const GUILD_ID        = '1216126780767731722';
const BASELINE_ROLE   = '1496410189920735354'; // member role that should see arcade + category
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

const TOKEN = fs.readFileSync('/tmp/lair-bot-token.txt', 'utf8').trim();
const rest = new REST({ version: '10' }).setToken(TOKEN);

const VIEW   = PermissionFlagsBits.ViewChannel;
const SEND   = PermissionFlagsBits.SendMessages;
const READ   = PermissionFlagsBits.ReadMessageHistory;
const REACT  = PermissionFlagsBits.AddReactions;
const EMBED  = PermissionFlagsBits.EmbedLinks;
const ATTACH = PermissionFlagsBits.AttachFiles;
const EXT    = PermissionFlagsBits.UseExternalEmojis;
const APP    = PermissionFlagsBits.UseApplicationCommands;

// Full interactive access for role-holders
const ROLE_ALLOW = String(VIEW | SEND | READ | REACT | EMBED | ATTACH | EXT | APP);
// View-only for arcade (members can see + read but their interactions go through the button)
const BASELINE_ALLOW_VIEW_ARCADE = String(VIEW | READ | APP); // can click the button (UseApplicationCommands is Discord's umbrella for interactions)

async function fetchEveryoneId() {
    const roles = await rest.get(Routes.guildRoles(GUILD_ID));
    return roles.find(r => r.name === '@everyone').id;
}

async function main() {
    const everyoneId = await fetchEveryoneId();

    // Category: visible to BASELINE + MINI_GAMES, hidden from @everyone
    console.log('[1] Category perms — visible to baseline + mini-games, hidden from @everyone…');
    await rest.patch(Routes.channel(CATEGORY_ID), {
        body: {
            permission_overwrites: [
                { id: everyoneId,      type: 0, deny: String(VIEW), allow: '0' },
                { id: BASELINE_ROLE,   type: 0, allow: String(VIEW | READ), deny: '0' },
                { id: MINI_GAMES_ROLE, type: 0, allow: ROLE_ALLOW, deny: '0' },
            ],
        },
        reason: 'Fix: arcade visible to baseline so join button is reachable',
    });

    // Arcade channel: view-only for baseline (they can read + click the button),
    // full interactive for Mini-Games role-holders.
    console.log('[2] #🎮-arcade — baseline VIEW, mini-games FULL…');
    await rest.patch(Routes.channel(CH_ARCADE), {
        body: {
            permission_overwrites: [
                { id: everyoneId,      type: 0, deny: String(VIEW | SEND), allow: '0' },
                { id: BASELINE_ROLE,   type: 0, allow: BASELINE_ALLOW_VIEW_ARCADE, deny: String(SEND) },
                { id: MINI_GAMES_ROLE, type: 0, allow: ROLE_ALLOW, deny: '0' },
            ],
        },
        reason: 'Fix: arcade visible to baseline so join button can be clicked',
    });

    // All other mini-games channels: hidden from baseline, visible to Mini-Games role only
    for (const id of CH_OTHER) {
        console.log(`[3] Channel ${id} — hidden from baseline, full for mini-games…`);
        await rest.patch(Routes.channel(id), {
            body: {
                permission_overwrites: [
                    { id: everyoneId,      type: 0, deny: String(VIEW), allow: '0' },
                    { id: BASELINE_ROLE,   type: 0, deny: String(VIEW), allow: '0' },
                    { id: MINI_GAMES_ROLE, type: 0, allow: ROLE_ALLOW, deny: '0' },
                ],
            },
            reason: 'Fix: keep non-arcade channels gated to Mini-Games role',
        });
    }

    console.log('\n✅ Permissions fixed.');
    console.log('   - Baseline role (' + BASELINE_ROLE + ') sees the category + #🎮-arcade (view/read + can click Join button)');
    console.log('   - Only Mini-Games role-holders see + interact in the other channels');
    console.log('   - Baseline users cannot send messages in #🎮-arcade until they join (prevents noise)');
}

main().catch(e => {
    console.error('FAILED:', e.message);
    if (e.rawError) console.error(JSON.stringify(e.rawError, null, 2));
    process.exit(1);
});
