#!/usr/bin/env node
/**
 * Finalize the Lair mini-games area:
 *   1. Delete the #🎵-music-quiz channel (not needed).
 *   2. Replace the welcome embed in #🎮-arcade with one that includes a
 *      "Join / Leave Mini-Games" button (customId: minigames_join:<roleId>).
 *   3. Write owo_config.allowed_channel_ids so /owo hunt + per-subcommand
 *      commands only fire in the intended channels.
 *
 * REST-only — safe to run while PM2 is up.
 */
import fs from 'node:fs';
import { REST, Routes, ButtonStyle, ComponentType } from 'discord.js';
import 'dotenv/config';
import mysql from 'mysql2/promise';

const GUILD_ID        = '1216126780767731722';
const ROLE_ID         = '1496826488119627856';
const CATEGORY_ID     = '1496826489398755450';
const CH_OWO_MAIN     = '1496826490837270548';
const CH_OWO_BATTLES  = '1496826491965669400';
const CH_DAILY_LUCK   = '1496826492661923923';
const CH_ARCADE       = '1496826493840527440';
const CH_MUSIC_QUIZ   = '1496826495509725264';
const CH_POKEMON      = '1496826496659099658';
const CH_RPG          = '1496826497892221008';

const TOKEN_FILE = '/tmp/lair-bot-token.txt';

async function main() {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    const rest = new REST({ version: '10' }).setToken(token);

    // 1. Delete music-quiz channel
    try {
        console.log('[1/3] Deleting #🎵-music-quiz…');
        await rest.delete(Routes.channel(CH_MUSIC_QUIZ), { reason: 'Music-quiz channel not needed' });
        console.log('      ↳ deleted.');
    } catch (e) {
        if (e.code === 10003) console.log('      ↳ already gone.');
        else throw e;
    }

    // 2. Delete old welcome embed(s) + post new one with button
    console.log('[2/3] Refreshing welcome embed in #🎮-arcade…');
    const existing = await rest.get(Routes.channelMessages(CH_ARCADE) + '?limit=50').catch(() => []);
    for (const m of existing) {
        if (m.embeds?.some(e => String(e.title || '').includes('Welcome to Mini-Games'))) {
            try {
                await rest.delete(Routes.channelMessage(CH_ARCADE, m.id));
                console.log('      ↳ removed stale embed ' + m.id);
            } catch { /* ignore */ }
        }
    }
    const welcomeBody =
        '**This area is opt-in** — click the button below to claim the <@&' + ROLE_ID + '> role and reveal these channels. ' +
        'Click again to leave.\n\n' +
        'Once you have the role you get access to:\n' +
        '• <#' + CH_OWO_MAIN    + '> — 🐾 OwO hunt, zoo, catalog, daily\n' +
        '• <#' + CH_OWO_BATTLES + '> — ⚔️ OwO teams, weapons, battles\n' +
        '• <#' + CH_DAILY_LUCK  + '> — 🎰 Daily luck roll + balance\n' +
        '• <#' + CH_ARCADE      + '> — 🎮 Arcade (trivia, hangman, counting, CFX, LFG)\n' +
        '• <#' + CH_POKEMON     + '> — 🧭 /pokemon\n' +
        '• <#' + CH_RPG         + '> — 🗡 /rpg adventures\n\n' +
        '**Rewards feed Lair\'s Economy + Leveling** — catches earn currency, battles build streaks, ' +
        'quests pay out crates / shards / coins.';

    const joinButton = {
        type: ComponentType.ActionRow,
        components: [{
            type: ComponentType.Button,
            custom_id: 'minigames_join:' + ROLE_ID,
            label: '🎮 Join / Leave Mini-Games',
            style: ButtonStyle.Primary,
        }],
    };

    await rest.post(Routes.channelMessages(CH_ARCADE), {
        body: {
            embeds: [{
                title: '🎮 Welcome to Mini-Games',
                description: welcomeBody,
                color: 0xF0A500,
                footer: { text: 'Mama Bear\'s Lair · Mini-Games · click the button to toggle access' },
            }],
            components: [joinButton],
            allowed_mentions: { parse: [] },
        },
    });
    console.log('      ↳ posted with Join button.');

    // 3. Write per-guild OwO config: channel routing + subcommand availability
    console.log('[3/3] Writing owo_config.allowed_channel_ids…');
    const allowed = [CH_OWO_MAIN, CH_OWO_BATTLES, CH_DAILY_LUCK, CH_ARCADE];
    const db = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });
    await db.execute(
        `INSERT INTO owo_config (guild_id, enabled, allowed_channel_ids) VALUES (?, 1, ?)
         ON DUPLICATE KEY UPDATE enabled = 1, allowed_channel_ids = VALUES(allowed_channel_ids)`,
        [GUILD_ID, JSON.stringify(allowed)]
    );
    console.log('      ↳ OwO enabled + /owo hunt gated to: ' + allowed.map(c => '<#' + c + '>').join(', '));
    await db.end();

    console.log('\n✅ Mini-games area finalized.');
    console.log('   - Music-quiz channel removed.');
    console.log('   - #🎮-arcade shows a Join button — members self-assign the role.');
    console.log('   - /owo hunt restricted to the mini-games channels.');
    console.log('   - Button clicks handled by the new `minigames_join` registry entry.');
    console.log('   - PM2 restart picks up the new handler on next reload.');
}

main().catch(e => {
    console.error('FAILED:', e.message);
    if (e.rawError) console.error(JSON.stringify(e.rawError, null, 2));
    process.exit(1);
});
