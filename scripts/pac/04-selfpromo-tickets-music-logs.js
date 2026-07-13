// Phases J, K, L, M — self-promo gate, tickets panel, music panel, logging routing.
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GUILD_ID, createPool, connectClient, getGuild, log, ROLES_EXISTING } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'pac-state.json'), 'utf8'));

async function phaseJ(ctx) {
    log('J', 'Configuring self-promo');
    await ctx.pool.execute(`
        INSERT INTO self_promo_config
            (guild_id, enabled, channel_id, allowed_platforms, auto_subscribe, delete_invalid, dm_on_track, dm_on_already_tracked, announcement_channel_id, same_channel)
        VALUES (?, 1, ?, ?, 0, 1, 1, 0, ?, 0)
        ON DUPLICATE KEY UPDATE
            enabled = 1,
            channel_id = VALUES(channel_id),
            allowed_platforms = VALUES(allowed_platforms),
            delete_invalid = 1,
            announcement_channel_id = VALUES(announcement_channel_id)
    `, [GUILD_ID, state.channels.selfPromo, JSON.stringify(['twitch', 'kick', 'youtube', 'tiktok', 'trovo', 'facebook']), state.channels.liveStreams]);
    log('J', `self-promo enabled. Allowed only in <#${state.channels.selfPromo}>`);
}

async function phaseK(ctx) {
    log('K', 'Configuring tickets');

    // Legacy ticket_config row (some handlers still read this as a fallback).
    await ctx.pool.execute(`
        INSERT INTO ticket_config (guild_id, panel_channel_id, ticket_category_id, support_role_id, log_channel_id, auto_close_hours, use_threads)
        VALUES (?, ?, ?, ?, ?, 72, 0)
        ON DUPLICATE KEY UPDATE
            panel_channel_id = VALUES(panel_channel_id),
            ticket_category_id = VALUES(ticket_category_id),
            support_role_id = VALUES(support_role_id),
            log_channel_id = VALUES(log_channel_id)
    `, [GUILD_ID, state.channels.ticketsPanel, state.channels.ticketCategory, ROLES_EXISTING.Beta, state.channels.modLog]);

    // Newer per-panel row (ticket_panels) — primary authoritative config.
    const [existing] = await ctx.pool.execute(
        'SELECT panel_id, panel_message_id FROM ticket_panels WHERE guild_id = ? AND panel_channel_id = ?',
        [GUILD_ID, state.channels.ticketsPanel]
    );
    let panelId;
    if (existing.length) {
        panelId = existing[0].panel_id;
        await ctx.pool.execute(`
            UPDATE ticket_panels SET embed_title = ?, embed_description = ?, button_text = ?, button_emoji = ?,
                                     ticket_category_id = ?, support_role_id = ?, log_channel_id = ?, alert_channel_id = ?, is_active = 1
            WHERE panel_id = ?
        `, ['Support Tickets', 'Click below to open a support ticket. A staff member will be with you shortly.', 'Open a ticket', '🎫',
            state.channels.ticketCategory, ROLES_EXISTING.Beta, state.channels.modLog, state.channels.modLog, panelId]);
    } else {
        const [ins] = await ctx.pool.execute(`
            INSERT INTO ticket_panels (guild_id, panel_name, panel_channel_id, embed_title, embed_description, embed_color,
                                       button_text, button_emoji, ticket_category_id, support_role_id, ticket_name_format,
                                       save_transcripts, log_channel_id, alert_channel_id, is_active)
            VALUES (?, 'Support', ?, 'Support Tickets', ?, '#5865F2', 'Open a ticket', '🎫', ?, ?, 'ticket-{user}', 1, ?, ?, 1)
        `, [GUILD_ID, state.channels.ticketsPanel,
            'Click below to open a support ticket. A staff member will be with you shortly.',
            state.channels.ticketCategory, ROLES_EXISTING.Beta, state.channels.modLog, state.channels.modLog]);
        panelId = ins.insertId;
    }
    log('K', `ticket_panels row ready (panel_id=${panelId})`);

    // Post the panel message (idempotent — delete prior bot posts first).
    const panelCh = await ctx.guild.channels.fetch(state.channels.ticketsPanel);
    try {
        const recent = await panelCh.messages.fetch({ limit: 50 });
        const mine = recent.filter(m => m.author.id === ctx.client.user.id);
        for (const m of mine.values()) await m.delete().catch(() => {});
    } catch (_) {}

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎫 Support Tickets')
        .setDescription(['Need help from staff?', '', 'Click **Open a ticket** below and a private channel will be created for you and the mod team.'].join('\n'));
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticket_create_panel_${panelId}`).setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary)
    );
    const sent = await panelCh.send({ embeds: [embed], components: [row] });
    await ctx.pool.execute('UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?', [sent.id, panelId]);
    log('K', `ticket panel posted (msg=${sent.id})`);
}

async function phaseL(ctx) {
    log('L', 'Configuring music panel');

    await ctx.pool.execute(`
        INSERT INTO music_config (guild_id, is_enabled, enabled, request_channel_id, default_volume, vote_skip_enabled, vote_skip_percentage)
        VALUES (?, 1, 1, ?, 80, 1, 50)
        ON DUPLICATE KEY UPDATE
            is_enabled = 1, enabled = 1, request_channel_id = VALUES(request_channel_id)
    `, [GUILD_ID, state.channels.music]);

    // Post placeholder music panel message so music_panels row exists. The running bot's
    // music manager will take over the persistent embed updates on next restart.
    const ch = await ctx.guild.channels.fetch(state.channels.music);
    try {
        const recent = await ch.messages.fetch({ limit: 50 });
        const mine = recent.filter(m => m.author.id === ctx.client.user.id);
        for (const m of mine.values()) await m.delete().catch(() => {});
    } catch (_) {}
    const embed = new EmbedBuilder()
        .setColor(0x1ABC9C)
        .setTitle('🎵 Music')
        .setDescription([
            'Queue controls live here once someone starts playback.',
            '',
            'Use `/play <song or URL>` to start. The panel will update as tracks play.',
        ].join('\n'));
    const sent = await ch.send({ embeds: [embed] });
    await ctx.pool.execute(`
        INSERT INTO music_panels (guild_id, channel_id, message_id) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), message_id = VALUES(message_id)
    `, [GUILD_ID, state.channels.music, sent.id]);
    log('L', `music panel row written, placeholder posted (msg=${sent.id})`);
}

async function phaseM(ctx) {
    log('M', 'Configuring logging routing');

    // Events we want ON — everything else stays off.
    const enabledEvents = [
        'memberJoin', 'memberLeave', 'memberUpdate',
        'messageDelete', 'messageUpdate',
        'voiceUpdate',
        'channelCreate', 'channelDelete', 'channelUpdate',
        'roleCreate', 'roleDelete', 'roleUpdate',
        'banAdd', 'banRemove',
    ];

    await ctx.pool.execute(`
        INSERT INTO logging_config (guild_id, log_channel_id, enabled, enabled_events)
        VALUES (?, ?, 1, ?)
        ON DUPLICATE KEY UPDATE
            log_channel_id = VALUES(log_channel_id),
            enabled = 1,
            enabled_events = VALUES(enabled_events)
    `, [GUILD_ID, state.channels.modLog, JSON.stringify(enabledEvents)]);

    // Per-event routing to the dedicated log channels.
    const routes = [
        ['memberJoin',    state.channels.memberLog,  '#43B581'],
        ['memberLeave',   state.channels.memberLog,  '#E67E22'],
        ['memberUpdate',  state.channels.memberLog,  '#3498DB'],
        ['messageDelete', state.channels.messageLog, '#E74C3C'],
        ['messageUpdate', state.channels.messageLog, '#F1C40F'],
        ['voiceUpdate',   state.channels.voiceLog,   '#9B59B6'],
        ['channelCreate', state.channels.channelLog, '#43B581'],
        ['channelDelete', state.channels.channelLog, '#E74C3C'],
        ['channelUpdate', state.channels.channelLog, '#3498DB'],
        ['roleCreate',    state.channels.roleLog,    '#43B581'],
        ['roleDelete',    state.channels.roleLog,    '#E74C3C'],
        ['roleUpdate',    state.channels.roleLog,    '#3498DB'],
        ['banAdd',        state.channels.modLog,     '#E74C3C'],
        ['banRemove',     state.channels.modLog,     '#43B581'],
    ];
    await ctx.pool.execute('DELETE FROM log_event_config WHERE guild_id = ?', [GUILD_ID]);
    for (const [evt, ch, color] of routes) {
        await ctx.pool.execute(
            `INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id, embed_color) VALUES (?, ?, 1, ?, ?)`,
            [GUILD_ID, evt, ch, color]
        );
    }
    log('M', `logging routes written (${routes.length} events)`);
}

async function main() {
    const client = await connectClient();
    const pool = createPool();
    const guild = await getGuild(client);
    const ctx = { client, pool, guild };
    log('main', `logged in as ${client.user.tag}`);
    const phases = process.argv.slice(2).length ? process.argv.slice(2) : ['J', 'K', 'L', 'M'];
    const handlers = { J: phaseJ, K: phaseK, L: phaseL, M: phaseM };
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
