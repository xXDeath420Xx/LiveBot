/*
 * `/lockdown` — the raid lockdown (core/raid-lockdown.js): an emergency mode in which every new join
 * is kicked, banned, timed out, quarantined or only logged until a set time; the auto-trigger that
 * starts one on a join spike; same-name join floods; and Discord's own invite / DM pause.
 *
 * Its own top-level command rather than `/protection raid lockdown …`: /protection's registration
 * payload is already ~7,560 of Discord's 8,000 characters. `/protection raid` keeps the join-rate +
 * new-account detection settings; this is everything that blocks joins.
 *
 * The dashboard (Advanced Protection → Raid Lockdown) does all of this as well, with a typed
 * "LOCKDOWN" confirmation and the full history; start / stop here ask for a button press.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { liveConfigAccess } from '../../core/protection-exempt.js';
import {
    getActive, getRaidConfig, saveSettings, extendLockdown, syncIncidents, readIncidents, history,
} from '../../core/raid-lockdown.js';
import {
    ACTION_LABEL, LIMITS, lockdownSettings, parseLength, summarise, normaliseAction,
} from '../../core/raid-lockdown-logic.js';
import { formatDuration } from '../../core/protection-exempt-logic.js';
import { rememberLockdownRequest, lockdownRefusal } from '../../interactions/buttons/raid_lockdown.js';

const EPHEMERAL = { flags: 64 };
const ACTION_CHOICES = [
    { name: 'Kick every join', value: 'kick' },
    { name: 'Ban every join', value: 'ban' },
    { name: 'Time out every join', value: 'timeout' },
    { name: 'Quarantine every join (quarantine role)', value: 'quarantine' },
    { name: 'Log only', value: 'log' },
];
const ts = (d) => Math.floor(new Date(d).getTime() / 1000);
const dash = (guildId) => `${(process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '')}/manage/${guildId}?page=advanced-protection#raid-lockdown`;
const onOff = (v) => (v ? 'On' : 'Off');

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('lockdown')
        .setDescription('Raid lockdown: block every new join, auto-trigger, same-name floods, invite/DM pause')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand(s => s.setName('start').setDescription('Block every new join until a set time (asks to confirm)')
            .addStringOption(o => o.setName('action').setDescription('What happens to each join (default: your setting)').addChoices(...ACTION_CHOICES))
            .addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 2h, 1d (default: your setting; up to 7d)').setMaxLength(20))
            .addStringOption(o => o.setName('reason').setDescription('Shown in the log and the summary').setMaxLength(200))
            .addBooleanOption(o => o.setName('pause_invites').setDescription('Also pause Discord invites for the lockdown'))
            .addBooleanOption(o => o.setName('lock_channels').setDescription('Also lock the channels picked on the dashboard')))
        .addSubcommand(s => s.setName('stop').setDescription('End the lockdown now (asks to confirm)'))
        .addSubcommand(s => s.setName('extend').setDescription('Make the running lockdown longer')
            .addStringOption(o => o.setName('by').setDescription('How much longer, e.g. 30m or 2h').setRequired(true).setMaxLength(20)))
        .addSubcommand(s => s.setName('status').setDescription('Lockdown, auto-trigger, same-name and invite/DM pause state'))
        .addSubcommand(s => s.setName('history').setDescription('Recent lockdowns: when, why, how many joins blocked'))
        .addSubcommand(s => s.setName('autotrigger').setDescription('Start a lockdown automatically on a join spike')
            .addBooleanOption(o => o.setName('enabled').setDescription('On or off'))
            .addIntegerOption(o => o.setName('joins').setDescription('Joins that set it off (3-100, default 20)').setMinValue(LIMITS.autoJoins[0]).setMaxValue(LIMITS.autoJoins[1]))
            .addIntegerOption(o => o.setName('seconds').setDescription('Inside this many seconds (5-300, default 10)').setMinValue(LIMITS.autoWindowSeconds[0]).setMaxValue(LIMITS.autoWindowSeconds[1]))
            .addIntegerOption(o => o.setName('minutes').setDescription('Lockdown length in minutes (1-1440, default 60)').setMinValue(LIMITS.autoDurationMinutes[0]).setMaxValue(LIMITS.autoDurationMinutes[1]))
            .addStringOption(o => o.setName('action').setDescription('What happens to each join').addChoices(...ACTION_CHOICES))
            .addBooleanOption(o => o.setName('pause_invites').setDescription('Also pause Discord invites while it runs (default on)'))
            .addBooleanOption(o => o.setName('lock_channels').setDescription('Also lock the channels picked on the dashboard')))
        .addSubcommand(s => s.setName('samename').setDescription('Act on floods of joins sharing a name')
            .addBooleanOption(o => o.setName('enabled').setDescription('On or off'))
            .addIntegerOption(o => o.setName('count').setDescription('Same-name joins that make a flood (3-50, default 5)').setMinValue(LIMITS.sameNameCount[0]).setMaxValue(LIMITS.sameNameCount[1]))
            .addIntegerOption(o => o.setName('seconds').setDescription('Inside this many seconds (30-600, default 300)').setMinValue(LIMITS.sameNameWindowSeconds[0]).setMaxValue(LIMITS.sameNameWindowSeconds[1]))
            .addStringOption(o => o.setName('action').setDescription('What happens to the group (default: ban)').addChoices(...ACTION_CHOICES)))
        .addSubcommand(s => s.setName('dms').setDescription("Pause DMs from members who aren't friends, until you switch it off")
            .addBooleanOption(o => o.setName('enabled').setDescription('On: keep DMs paused, renewed daily. Off: lift the pause now').setRequired(true)))
        .addSubcommand(s => s.setName('invites').setDescription('Pause Discord invites (nobody can join by invite), until you switch it off')
            .addBooleanOption(o => o.setName('enabled').setDescription('On: keep invites paused, renewed daily. Off: lift the pause now').setRequired(true)))
        .addSubcommand(s => s.setName('settings').setDescription('Defaults for a manual lockdown')
            .addStringOption(o => o.setName('action').setDescription('Default action').addChoices(...ACTION_CHOICES))
            .addStringOption(o => o.setName('duration').setDescription('Default length, e.g. 1h').setMaxLength(20))
            .addBooleanOption(o => o.setName('dm_joiners').setDescription('DM kicked joiners when to come back (default on)'))
            .addBooleanOption(o => o.setName('pause_invites').setDescription('Pause Discord invites by default'))
            .addBooleanOption(o => o.setName('lock_channels').setDescription('Lock the dashboard-picked channels by default'))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub !== 'status' && sub !== 'history') {
                const access = await liveConfigAccess(interaction.guild, interaction.user.id);
                if (!access.ok) {
                    return interaction.reply({ content: 'You need Manage Server, Administrator or a bot-manager role in this server.', ...EPHEMERAL });
                }
            }
            switch (sub) {
                case 'start': return await start(interaction);
                case 'stop': return await stop(interaction);
                case 'extend': return await extend(interaction);
                case 'status': return await status(interaction);
                case 'history': return await showHistory(interaction);
                case 'autotrigger': return await autotrigger(interaction);
                case 'samename': return await samename(interaction);
                case 'dms': return await incidents(interaction, 'dms');
                case 'invites': return await incidents(interaction, 'invites');
                case 'settings': return await settings(interaction);
            }
        } catch (err) {
            logger.error(`[/lockdown ${sub}] ${err.message}`, { stack: err.stack });
            const reply = { content: `Error: ${err.message}`, ...EPHEMERAL };
            return interaction.deferred || interaction.replied ? interaction.editReply(reply) : interaction.reply(reply);
        }
    },
};

function confirmRow(token, label) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rlock_go:${token}`).setLabel(label).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`rlock_no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
}

async function start(interaction) {
    const guild = interaction.guild;
    const s = lockdownSettings(await getRaidConfig(guild.id));
    const running = await getActive(guild.id);
    if (running) {
        return interaction.reply({ content: `A lockdown is already running until <t:${ts(running.ends_at)}:F>. Use \`/lockdown extend\` or \`/lockdown stop\`.`, ...EPHEMERAL });
    }
    const action = normaliseAction(interaction.options.getString('action'), s.lockdownAction);
    const lenText = interaction.options.getString('duration');
    const len = lenText ? parseLength(lenText) : { ok: true, ms: s.lockdownDurationMinutes * 60_000 };
    if (!len.ok) return interaction.reply({ content: len.error, ...EPHEMERAL });
    const refusal = await lockdownRefusal(guild, interaction.user.id, action);
    if (refusal) return interaction.reply({ content: refusal, ...EPHEMERAL });

    const pauseInvites = interaction.options.getBoolean('pause_invites') ?? s.lockdownPauseInvites;
    const lockChannels = interaction.options.getBoolean('lock_channels') ?? s.lockdownLockChannels;
    const reason = interaction.options.getString('reason');
    const token = rememberLockdownRequest({
        kind: 'start', guildId: guild.id, actorId: interaction.user.id, action, durationMs: len.ms, reason, pauseInvites, lockChannels,
    });
    const end = Math.floor((Date.now() + len.ms) / 1000);
    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xE67E22).setTitle('Start a server lockdown?')
            .setDescription(`Until <t:${end}:F> (${formatDuration(len.ms)}), **every new member** will be: **${ACTION_LABEL[action]}**.\n`
                + 'Members already in the server are not touched. Allowlisted users, bot managers and bots are exempt.')
            .addFields(
                { name: 'Pause Discord invites', value: onOff(pauseInvites), inline: true },
                { name: 'Lock channels', value: lockChannels ? (s.lockdownChannelIds.length ? `${s.lockdownChannelIds.length} channel(s)` : 'On, but none picked on the dashboard') : 'Off', inline: true },
                ...(reason ? [{ name: 'Reason', value: reason }] : []))],
        components: [confirmRow(token, 'Start lockdown')],
        ...EPHEMERAL,
    });
}

async function stop(interaction) {
    const running = await getActive(interaction.guild.id);
    if (!running) return interaction.reply({ content: 'No lockdown is running.', ...EPHEMERAL });
    const token = rememberLockdownRequest({ kind: 'stop', guildId: interaction.guild.id, actorId: interaction.user.id });
    const sum = summarise(running);
    return interaction.reply({
        content: `End lockdown #${running.id} now? It was due to end <t:${ts(running.ends_at)}:R>; ${sum.blocked} join(s) blocked so far.`,
        components: [confirmRow(token, 'End lockdown')],
        ...EPHEMERAL,
    });
}

async function extend(interaction) {
    const running = await getActive(interaction.guild.id);
    if (!running) return interaction.reply({ content: 'No lockdown is running.', ...EPHEMERAL });
    const len = parseLength(interaction.options.getString('by'));
    if (!len.ok) return interaction.reply({ content: len.error, ...EPHEMERAL });
    const out = await extendLockdown(interaction.guild, new Date(running.ends_at).getTime() + len.ms, interaction.user);
    if (!out.ok) return interaction.reply({ content: out.error, ...EPHEMERAL });
    return interaction.reply({ content: `Lockdown #${running.id} now ends <t:${ts(out.row.ends_at)}:F> (<t:${ts(out.row.ends_at)}:R>).`, ...EPHEMERAL });
}

async function status(interaction) {
    const guild = interaction.guild;
    const s = lockdownSettings(await getRaidConfig(guild.id));
    const running = await getActive(guild.id);
    const inc = await readIncidents(guild, { fetch: true }).catch(() => ({}));
    const pauseText = (d) => (d && new Date(d).getTime() > Date.now() ? `Paused until <t:${ts(d)}:R>` : 'Allowed');
    const embed = new EmbedBuilder()
        .setColor(running ? 0xC0392B : 0x3498DB)
        .setTitle(running ? `🚨 Lockdown #${running.id} is ON` : 'Lockdown is off')
        .addFields(
            ...(running ? [
                { name: 'Action', value: ACTION_LABEL[running.action], inline: true },
                { name: 'Ends', value: `<t:${ts(running.ends_at)}:R>`, inline: true },
                { name: 'Joins blocked', value: String(summarise(running).blocked), inline: true },
                { name: 'Started by', value: running.trigger_kind === 'auto' ? `Auto-trigger (${running.trigger_detail || 'join spike'})` : `<@${running.started_by}>`, inline: false },
            ] : []),
            { name: 'Auto-trigger', value: s.autoEnabled ? `On: ${s.autoJoins} joins in ${s.autoWindowSeconds}s → ${ACTION_LABEL[s.autoAction]} for ${s.autoDurationMinutes} min` : 'Off', inline: false },
            { name: 'Same-name floods', value: s.sameNameEnabled ? `On: ${s.sameNameCount} same-name joins in ${s.sameNameWindowSeconds}s → ${ACTION_LABEL[s.sameNameAction]}` : 'Off', inline: false },
            { name: 'DMs', value: `${pauseText(inc.dms)}${s.keepDmsDisabled ? ' (kept off)' : ''}`, inline: true },
            { name: 'Invites', value: `${pauseText(inc.invites)}${s.keepInvitesDisabled ? ' (kept paused)' : ''}`, inline: true },
            ...(inc.raidDetectedAt ? [{ name: 'Discord detected a raid', value: `<t:${ts(inc.raidDetectedAt)}:R>`, inline: true }] : []),
            { name: 'Manual default', value: `${ACTION_LABEL[s.lockdownAction]} for ${formatDuration(s.lockdownDurationMinutes * 60_000)}`, inline: false },
        )
        .setFooter({ text: 'Everything here is also on the dashboard: Advanced Protection → Raid Lockdown' });
    return interaction.reply({ embeds: [embed], content: dash(guild.id), ...EPHEMERAL });
}

async function showHistory(interaction) {
    const rows = await history(interaction.guild.id, 10);
    if (!rows.length) return interaction.reply({ content: 'No lockdowns yet.', ...EPHEMERAL });
    const lines = rows.map(r => {
        const sum = summarise(r);
        const who = r.trigger_kind === 'auto' ? 'auto' : r.started_by ? `<@${r.started_by}>` : 'manual';
        const end = r.status === 'active' ? `running, ends <t:${ts(r.ends_at)}:R>` : `ended <t:${ts(r.ended_at || r.ends_at)}:R> (${r.end_reason || 'ended'})`;
        return `**#${r.id}** <t:${ts(r.started_at)}:f> · ${ACTION_LABEL[r.action] || r.action} · by ${who} · ${end}\n└ ${sum.blocked} blocked, ${sum.held} exempt/paused, ${sum.failed} failed${r.trigger_detail ? ` · ${r.trigger_detail}` : ''}`;
    });
    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x3498DB).setTitle('Lockdown history').setDescription(lines.join('\n\n').slice(0, 4000))],
        ...EPHEMERAL,
    });
}

async function autotrigger(interaction) {
    const o = interaction.options;
    const patch = {};
    if (o.getBoolean('enabled') !== null) patch.auto_lockdown_enabled = o.getBoolean('enabled') ? 1 : 0;
    if (o.getInteger('joins') !== null) patch.auto_lockdown_joins = o.getInteger('joins');
    if (o.getInteger('seconds') !== null) patch.auto_lockdown_window_seconds = o.getInteger('seconds');
    if (o.getInteger('minutes') !== null) patch.auto_lockdown_duration_minutes = o.getInteger('minutes');
    if (o.getString('action') !== null) patch.auto_lockdown_action = o.getString('action');
    if (o.getBoolean('pause_invites') !== null) patch.auto_lockdown_pause_invites = o.getBoolean('pause_invites') ? 1 : 0;
    if (o.getBoolean('lock_channels') !== null) patch.auto_lockdown_lock_channels = o.getBoolean('lock_channels') ? 1 : 0;
    if (patch.auto_lockdown_action) {
        const refusal = await lockdownRefusal(interaction.guild, interaction.user.id, patch.auto_lockdown_action);
        if (refusal) return interaction.reply({ content: refusal, ...EPHEMERAL });
    }
    const s = lockdownSettings(Object.keys(patch).length ? await saveSettings(interaction.guild.id, patch) : await getRaidConfig(interaction.guild.id));
    return interaction.reply({
        content: `Auto-trigger is **${onOff(s.autoEnabled)}**: ${s.autoJoins} joins in ${s.autoWindowSeconds}s starts a ${s.autoDurationMinutes}-minute lockdown `
            + `(${ACTION_LABEL[s.autoAction]}; invites ${s.autoPauseInvites ? 'paused' : 'left alone'}; channels ${s.autoLockChannels ? 'locked' : 'left alone'}).`,
        ...EPHEMERAL,
    });
}

async function samename(interaction) {
    const o = interaction.options;
    const patch = {};
    if (o.getBoolean('enabled') !== null) patch.same_name_enabled = o.getBoolean('enabled') ? 1 : 0;
    if (o.getInteger('count') !== null) patch.same_name_count = o.getInteger('count');
    if (o.getInteger('seconds') !== null) patch.same_name_window_seconds = o.getInteger('seconds');
    if (o.getString('action') !== null) patch.same_name_action = o.getString('action');
    if (patch.same_name_action) {
        const refusal = await lockdownRefusal(interaction.guild, interaction.user.id, patch.same_name_action);
        if (refusal) return interaction.reply({ content: refusal, ...EPHEMERAL });
    }
    const s = lockdownSettings(Object.keys(patch).length ? await saveSettings(interaction.guild.id, patch) : await getRaidConfig(interaction.guild.id));
    return interaction.reply({
        content: `Same-name floods: **${onOff(s.sameNameEnabled)}** — ${s.sameNameCount} or more joins whose names match within ${s.sameNameWindowSeconds}s → **${ACTION_LABEL[s.sameNameAction]}** for the whole group.`,
        ...EPHEMERAL,
    });
}

// The server's one DM / invite pause control (H-660). Off lifts a running pause now, whoever set it.
async function incidents(interaction, kind) {
    const enabled = interaction.options.getBoolean('enabled');
    await interaction.deferReply(EPHEMERAL);
    await saveSettings(interaction.guild.id, { [kind === 'dms' ? 'keep_dms_disabled' : 'keep_invites_disabled']: enabled ? 1 : 0 });
    const out = await syncIncidents(interaction.guild, { why: `/lockdown ${kind} by ${interaction.user.username}`, lift: { [kind]: !enabled } });
    const until = out.state?.[kind];
    const what = kind === 'dms' ? 'DMs between members who are not friends' : 'Invites';
    if (out.error) return interaction.editReply(`Saved, but Discord refused the change: ${out.error}`);
    return interaction.editReply(enabled
        ? `${what} are now paused until <t:${Math.floor(until / 1000)}:R>, and the bot renews it before it runs out (Discord allows 24 hours at a time).`
        : (until
            ? `${what} switch is off, but the running lockdown keeps them paused until <t:${Math.floor(until / 1000)}:R>. \`/lockdown stop\` ends it.`
            : `${what} are allowed again.`));
}

async function settings(interaction) {
    const o = interaction.options;
    const patch = {};
    if (o.getString('action') !== null) patch.lockdown_action = o.getString('action');
    if (o.getString('duration') !== null) {
        const len = parseLength(o.getString('duration'));
        if (!len.ok) return interaction.reply({ content: len.error, ...EPHEMERAL });
        patch.lockdown_duration_minutes = Math.round(len.ms / 60_000);
    }
    if (o.getBoolean('dm_joiners') !== null) patch.lockdown_dm = o.getBoolean('dm_joiners') ? 1 : 0;
    if (o.getBoolean('pause_invites') !== null) patch.lockdown_pause_invites = o.getBoolean('pause_invites') ? 1 : 0;
    if (o.getBoolean('lock_channels') !== null) patch.lockdown_lock_channels = o.getBoolean('lock_channels') ? 1 : 0;
    const s = lockdownSettings(Object.keys(patch).length ? await saveSettings(interaction.guild.id, patch) : await getRaidConfig(interaction.guild.id));
    return interaction.reply({
        content: `Manual lockdown default: **${ACTION_LABEL[s.lockdownAction]}** for ${formatDuration(s.lockdownDurationMinutes * 60_000)}; `
            + `DM kicked joiners ${onOff(s.lockdownDm)}; pause invites ${onOff(s.lockdownPauseInvites)}; lock channels ${onOff(s.lockdownLockChannels)}`
            + ` (${s.lockdownChannelIds.length} picked — choose them on the dashboard).`,
        ...EPHEMERAL,
    });
}
