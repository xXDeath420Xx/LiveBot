// Phases H + I — leveling configuration, role-reward mapping, monthly-reset opt-in,
// stream signup embed+button post, migrate existing subs.
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GUILD_ID, createPool, connectClient, getGuild, log } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'pac-state.json'), 'utf8'));

const LEVEL_UP_CHANNEL_ID = '1439845927031672994'; // #pac-levels
const SHOUTOUT_ELIGIBLE_ROLE = state.roles.ShoutoutEligible;

async function ensureLevelConfigSchema(pool) {
    const [cols] = await pool.execute(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'level_config'
    `);
    const have = new Set(cols.map(r => r.COLUMN_NAME));
    if (!have.has('monthly_reset_enabled')) {
        await pool.execute('ALTER TABLE level_config ADD COLUMN monthly_reset_enabled TINYINT(1) NOT NULL DEFAULT 0');
        log('H', 'added level_config.monthly_reset_enabled');
    }
    if (!have.has('enabled')) {
        await pool.execute('ALTER TABLE level_config ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 0');
        log('H', 'added level_config.enabled');
    }
}

async function ensureStreamSignupConfigTable(pool) {
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS stream_signup_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            stream_signup_channel_id VARCHAR(20) NULL,
            stream_announcement_channel_id VARCHAR(20) NOT NULL,
            stream_signup_message_id VARCHAR(20) NULL,
            level_gate INT NOT NULL DEFAULT 3,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log('I', 'stream_signup_config table ready');
}

async function phaseH(ctx) {
    log('H', 'Starting leveling setup');
    await ensureLevelConfigSchema(ctx.pool);

    // Ensure level_config row exists and opt-in monthly reset.
    await ctx.pool.execute(`
        INSERT INTO level_config (guild_id, xp_per_message, xp_cooldown_seconds, xp_per_voice_minute,
                                  voice_xp_enabled, level_up_message, level_up_channel_id, enabled, monthly_reset_enabled)
        VALUES (?, 15, 60, 5, 1, 'Congrats {user}! You reached **Level {level}**!', ?, 1, 1)
        ON DUPLICATE KEY UPDATE
            level_up_channel_id = VALUES(level_up_channel_id),
            enabled = 1,
            monthly_reset_enabled = 1
    `, [GUILD_ID, LEVEL_UP_CHANNEL_ID]);
    log('H', `level_config upserted (level-up channel=${LEVEL_UP_CHANNEL_ID})`);

    // Role reward: level 3 -> Shoutout Eligible
    await ctx.pool.execute(`
        INSERT INTO level_role_rewards (guild_id, level, role_id) VALUES (?, 3, ?)
        ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)
    `, [GUILD_ID, SHOUTOUT_ELIGIBLE_ROLE]);
    log('H', `role_reward: level 3 -> ${SHOUTOUT_ELIGIBLE_ROLE}`);
}

async function phaseI(ctx) {
    log('I', 'Starting stream signup + migration');
    await ensureStreamSignupConfigTable(ctx.pool);

    const announceChannel = state.channels.liveStreams;
    const signupChannelId = state.channels.streamSignup;

    // Keep existing wolf-live-pointing subscription as-is (user wants wolf-live reserved for Wolf).
    // Do NOT migrate — wolf-live remains Wolf's personal channel.

    // Configure stream_signup_config.
    await ctx.pool.execute(`
        INSERT INTO stream_signup_config (guild_id, stream_signup_channel_id, stream_announcement_channel_id, level_gate)
        VALUES (?, ?, ?, 3)
        ON DUPLICATE KEY UPDATE
            stream_signup_channel_id = VALUES(stream_signup_channel_id),
            stream_announcement_channel_id = VALUES(stream_announcement_channel_id),
            level_gate = VALUES(level_gate)
    `, [GUILD_ID, signupChannelId, announceChannel]);
    log('I', `stream_signup_config upserted: signup=${signupChannelId}, announce=${announceChannel}`);

    // Post the signup embed in #stream-signup (clear prior bot posts first)
    const ch = await ctx.guild.channels.fetch(signupChannelId);
    try {
        const recent = await ch.messages.fetch({ limit: 50 });
        const mine = recent.filter(m => m.author.id === ctx.client.user.id);
        for (const m of mine.values()) await m.delete().catch(() => {});
    } catch (_) {}

    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('📡 Auto-Shoutout Signup')
        .setDescription([
            "Want the bot to automatically announce your live streams in <#" + announceChannel + ">?",
            "",
            "**Requirements:**",
            "• Reach **level 3** in the server (you'll get the **Shoutout Eligible** role automatically)",
            "• Click the button below and enter your platform + username",
            "",
            "**Supported platforms:** Twitch, Kick, YouTube, TikTok, Trovo, Facebook.",
            "",
            "At the start of each month the server XP resets — if you're below level 3 after the reset, your auto-shoutouts will pause until you earn level 3 again.",
        ].join('\n'));

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('stream_signup_add').setLabel('Add my stream').setEmoji('📡').setStyle(ButtonStyle.Primary)
    );
    const sent = await ch.send({ embeds: [embed], components: [row] });
    await ctx.pool.execute(
        'UPDATE stream_signup_config SET stream_signup_message_id = ? WHERE guild_id = ?',
        [sent.id, GUILD_ID]
    );
    log('I', `signup embed posted (msg=${sent.id})`);
}

async function main() {
    const client = await connectClient();
    const pool = createPool();
    const guild = await getGuild(client);
    const ctx = { client, pool, guild };

    log('main', `logged in as ${client.user.tag}`);
    const phases = process.argv.slice(2).length ? process.argv.slice(2) : ['H', 'I'];
    const handlers = { H: phaseH, I: phaseI };
    try {
        for (const p of phases) {
            const fn = handlers[p.toUpperCase()];
            if (!fn) { log('main', `unknown phase: ${p}`); continue; }
            await fn(ctx);
        }
    } finally {
        try { await client.destroy(); } catch (_) {}
        try { await pool.end(); } catch (_) {}
    }
}

main().catch(err => { console.error('FATAL', err?.stack || err); process.exit(1); });
