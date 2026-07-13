// Phase F + G — verify_config schema, gate channel posts, reaction role panels,
// mass-verify existing members. Stop PM2 before running.
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GUILD_ID, createPool, connectClient, getGuild, log, ROLES_EXISTING, CHANNELS_EXISTING } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'pac-state.json'), 'utf8'));

const EMBED_COLOR = 0x5865F2;

const RULES_TEXT = [
    '**1.** Be cool, kind, and respectful to one another.',
    '**2.** Keep your Discord profile appropriate.',
    '**3.** Do not spam.',
    '**4.** Do not @mention or direct message the staff. See Mods below in the channel for exceptions.',
    '**5.** No self-promotion or advertisements in general channels.',
    '**6.** No personal information that could be considered Doxxing.',
    '**7.** No hate speech or harmful language.',
    '**8.** No political or religious topics.',
    '**9.** No piracy, sexual, NSFW, or otherwise suspicious content in general channels.',
    '**10.** Rules are subject to common sense.',
].join('\n');

async function ensureVerifyConfigTable(pool) {
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS verify_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            verified_role_id VARCHAR(20) NOT NULL,
            unverified_role_id VARCHAR(20) NULL,
            gate_channel_id VARCHAR(20) NULL,
            gate_message_id VARCHAR(20) NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log('F', 'verify_config table ready');
}

async function phaseF(ctx) {
    log('F', 'Starting gate channel setup');
    await ensureVerifyConfigTable(ctx.pool);

    const gateId = state.channels.welcomeAndRules;
    const gate = await ctx.guild.channels.fetch(gateId);

    // Point Community "Rules channel" at the new gate so we can delete the legacy #pac-rules.
    try {
        await ctx.guild.setRulesChannel(gate, 'Pac migration: relocate rules channel to #welcome-and-rules');
        log('F', `setRulesChannel(${gateId}) OK`);
    } catch (e) {
        log('F', `setRulesChannel failed: ${e.message}`);
    }

    // Delete legacy #pac-rules now that the Community flag has moved.
    const oldRules = ctx.guild.channels.cache.get(CHANNELS_EXISTING.pacRules);
    if (oldRules) {
        await oldRules.delete('Pac migration: merged into #welcome-and-rules').catch(e => log('F', `  delete legacy rules failed: ${e.message}`));
    }

    // Post the combined welcome + rules + verify gate message.
    // Delete any prior messages from the bot in that channel first (idempotent re-runs).
    try {
        const recent = await gate.messages.fetch({ limit: 50 });
        const mine = recent.filter(m => m.author.id === ctx.client.user.id);
        for (const m of mine.values()) await m.delete().catch(() => {});
        log('F', `cleared ${mine.size} existing bot messages in gate channel`);
    } catch (e) { log('F', `message cleanup warning: ${e.message}`); }

    const welcomeEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Welcome to The Pac! 🐺')
        .setDescription([
            "Hey, welcome to **The Pac!** Take a second to read through the rules below.",
            "",
            "When you're ready, click the **✅ I accept the rules** button at the bottom and you'll be dropped straight into the server.",
        ].join('\n'));

    const rulesEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('📜 Server Rules')
        .setDescription(RULES_TEXT)
        .setFooter({ text: 'Breaking any of these may result in warnings, mutes, or removal from the server.' });

    const verifyRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('verify_accept')
            .setLabel('I accept the rules')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
    );

    const sent = await gate.send({ embeds: [welcomeEmbed, rulesEmbed], components: [verifyRow] });
    log('F', `gate message posted: ${sent.id}`);

    await ctx.pool.execute(
        `INSERT INTO verify_config (guild_id, verified_role_id, unverified_role_id, gate_channel_id, gate_message_id, enabled)
         VALUES (?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE verified_role_id=VALUES(verified_role_id), unverified_role_id=VALUES(unverified_role_id),
                                 gate_channel_id=VALUES(gate_channel_id), gate_message_id=VALUES(gate_message_id), enabled=1`,
        [GUILD_ID, ROLES_EXISTING.Verified, ROLES_EXISTING.unverified, gateId, sent.id]
    );
    log('F', 'verify_config row written');

    // Configure welcome_settings (greeting-manager consumes this on guildMemberAdd).
    await ctx.pool.execute(
        `INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled)
         VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), message=VALUES(message)`,
        [
            GUILD_ID,
            gateId,
            "🐺 Hey {mention}! Welcome to **{server}** — you're member #{memberCount}. Read the rules above and hit **I accept the rules** to unlock the rest of the server.",
        ],
    );
    log('F', 'welcome_settings row written');

    // Mass-grant Verified to all current (non-bot) members so no existing member gets locked out.
    log('F', 'fetching all members for bulk verify…');
    const members = await ctx.guild.members.fetch();
    const verified = ctx.guild.roles.cache.get(ROLES_EXISTING.Verified);
    const unverified = ctx.guild.roles.cache.get(ROLES_EXISTING.unverified);
    let granted = 0, stripped = 0, skipped = 0;
    for (const m of members.values()) {
        if (m.user.bot) { skipped++; continue; }
        if (!m.roles.cache.has(verified.id)) {
            try { await m.roles.add(verified, 'Bulk verify: grandfathering existing members'); granted++; }
            catch (e) { log('F', `  failed to add Verified to ${m.user.tag}: ${e.message}`); }
        }
        if (unverified && m.roles.cache.has(unverified.id)) {
            try { await m.roles.remove(unverified, 'Bulk verify cleanup'); stripped++; }
            catch (e) { log('F', `  failed to strip unverified from ${m.user.tag}: ${e.message}`); }
        }
    }
    log('F', `bulk verify complete: granted=${granted}, stripped-unverified=${stripped}, skipped-bots=${skipped}`);
}

async function phaseG(ctx) {
    log('G', 'Starting reaction role panels in #roles');
    const rolesCh = await ctx.guild.channels.fetch(CHANNELS_EXISTING.roles);

    // Idempotency: delete any existing panels in this channel authored by the bot
    try {
        const recent = await rolesCh.messages.fetch({ limit: 50 });
        const mine = recent.filter(m => m.author.id === ctx.client.user.id);
        for (const m of mine.values()) await m.delete().catch(() => {});
        // Remove any DB rows for this channel
        await ctx.pool.execute('DELETE FROM reaction_role_panels WHERE guild_id = ? AND channel_id = ?', [GUILD_ID, CHANNELS_EXISTING.roles]);
        log('G', `cleared ${mine.size} existing bot panels`);
    } catch (e) { log('G', `cleanup warning: ${e.message}`); }

    // Panel 1: Color roles (select menu)
    const colorEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('🎨 Color Roles')
        .setDescription('Pick the color you want next to your name. You can only wear one at a time.');
    const colorSelect = new StringSelectMenuBuilder()
        .setCustomId('rr_select_colors')
        .setPlaceholder('Choose a color…')
        .setMinValues(0)
        .setMaxValues(1)
        .addOptions(
            { label: 'Purple', value: ROLES_EXISTING.Purple, emoji: '🟣' },
            { label: 'Orange', value: ROLES_EXISTING.Orange, emoji: '🟠' },
            { label: 'Green',  value: ROLES_EXISTING.Green,  emoji: '🟢' },
            { label: 'Red',    value: ROLES_EXISTING.Red,    emoji: '🔴' },
            { label: 'Yellow', value: ROLES_EXISTING.Yellow, emoji: '🟡' },
            { label: 'Blue',   value: ROLES_EXISTING.Blue,   emoji: '🔵' },
        );
    const colorMsg = await rolesCh.send({ embeds: [colorEmbed], components: [new ActionRowBuilder().addComponents(colorSelect)] });
    const [colorPanelRes] = await ctx.pool.execute(
        `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
         VALUES (?, ?, ?, 'Color Roles', 'Pick one color', '#5865F2', 'select_menu', 'unique')`,
        [GUILD_ID, CHANNELS_EXISTING.roles, colorMsg.id]
    );
    const colorPanelId = colorPanelRes.insertId;
    for (const [roleId, emoji] of [[ROLES_EXISTING.Purple, '🟣'], [ROLES_EXISTING.Orange, '🟠'], [ROLES_EXISTING.Green, '🟢'], [ROLES_EXISTING.Red, '🔴'], [ROLES_EXISTING.Yellow, '🟡'], [ROLES_EXISTING.Blue, '🔵']]) {
        await ctx.pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [colorPanelId, roleId, emoji]);
    }
    log('G', `color panel posted (panel_id=${colorPanelId}, msg=${colorMsg.id})`);

    // Panel 2: Game roles (select menu, multi-select)
    const gameEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('🎮 Game Roles')
        .setDescription('Pick the games you want access to. You can pick as many as you want.');
    const gameSelect = new StringSelectMenuBuilder()
        .setCustomId('rr_select_games')
        .setPlaceholder('Choose one or more games…')
        .setMinValues(0)
        .setMaxValues(6)
        .addOptions(
            { label: 'Arc Raiders',       value: state.roles.ArcRaiders,      emoji: '🎯' },
            { label: 'Call of Duty',      value: state.roles.CallOfDuty,      emoji: '🔫' },
            { label: 'Horror Games',      value: state.roles.HorrorGames,     emoji: '👻' },
            { label: 'Marvel',            value: state.roles.Marvel,          emoji: '🦸' },
            { label: 'World of Warcraft', value: state.roles.WorldOfWarcraft, emoji: '⚔️' },
            { label: 'Fortnite',          value: state.roles.Fortnite,        emoji: '🏗️' },
        );
    const gameMsg = await rolesCh.send({ embeds: [gameEmbed], components: [new ActionRowBuilder().addComponents(gameSelect)] });
    const [gamePanelRes] = await ctx.pool.execute(
        `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
         VALUES (?, ?, ?, 'Game Roles', 'Pick your games', '#5865F2', 'select_menu', 'multiple')`,
        [GUILD_ID, CHANNELS_EXISTING.roles, gameMsg.id]
    );
    const gamePanelId = gamePanelRes.insertId;
    for (const [roleId, emoji] of [
        [state.roles.ArcRaiders, '🎯'], [state.roles.CallOfDuty, '🔫'], [state.roles.HorrorGames, '👻'],
        [state.roles.Marvel, '🦸'], [state.roles.WorldOfWarcraft, '⚔️'], [state.roles.Fortnite, '🏗️'],
    ]) {
        await ctx.pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [gamePanelId, roleId, emoji]);
    }
    log('G', `game panel posted (panel_id=${gamePanelId}, msg=${gameMsg.id})`);

    // Panel 3: Notification roles (buttons — simpler for 1-click toggles)
    const notifEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('🔔 Notifications & Extras')
        .setDescription([
            'Toggle optional access:',
            '',
            '**📢 Announcements** — get pinged for important server news',
            '**🎵 Music** — unlocks the #music channel so you can queue songs',
        ].join('\n'));
    const notifRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rr_${state.roles.Announcements}`).setLabel('Announcements').setEmoji('📢').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`rr_${state.roles.Music}`).setLabel('Music').setEmoji('🎵').setStyle(ButtonStyle.Secondary),
    );
    const notifMsg = await rolesCh.send({ embeds: [notifEmbed], components: [notifRow] });
    const [notifPanelRes] = await ctx.pool.execute(
        `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
         VALUES (?, ?, ?, 'Notifications', 'Toggle opt-in roles', '#5865F2', 'button', 'multiple')`,
        [GUILD_ID, CHANNELS_EXISTING.roles, notifMsg.id]
    );
    const notifPanelId = notifPanelRes.insertId;
    for (const [roleId, emoji] of [[state.roles.Announcements, '📢'], [state.roles.Music, '🎵']]) {
        await ctx.pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id) VALUES (?, ?, ?)', [notifPanelId, roleId, emoji]);
    }
    log('G', `notification panel posted (panel_id=${notifPanelId}, msg=${notifMsg.id})`);
}

async function main() {
    const client = await connectClient();
    const pool = createPool();
    const guild = await getGuild(client);
    const ctx = { client, pool, guild };

    log('main', `logged in as ${client.user.tag}`);
    const phases = process.argv.slice(2).length ? process.argv.slice(2) : ['F', 'G'];
    const handlers = { F: phaseF, G: phaseG };
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
