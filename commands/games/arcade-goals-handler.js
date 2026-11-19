import { EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { getSettings, updateSettings } from '../../core/bgames-settings.js';
import * as goals from '../../core/community-goals-manager.js';
import { GOAL_TYPES, progressBar } from '../../core/community-goal-logic.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

function isAdmin(member) {
    return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

async function denyAdmin(interaction) {
    return interaction.reply({ content: '❌ You need **Manage Server** to manage community goals.', ...EPHEMERAL });
}

async function enabledOrReply(interaction) {
    const s = await getSettings('communitygoals', interaction.guildId);
    if (s.enabled) return s;
    const msg = '❌ Community goals are turned off in this server.';
    if (interaction.deferred) await interaction.editReply({ content: msg });
    else await interaction.reply({ content: msg, ...EPHEMERAL });
    return null;
}

export async function handleCreate(interaction) {
    if (!isAdmin(interaction.member)) return denyAdmin(interaction);
    await interaction.deferReply(EPHEMERAL);
    const s = await enabledOrReply(interaction);
    if (!s) return;
    const o = interaction.options;
    const channel = o.getChannel('channel')
        || (s.announce_channel_id ? interaction.guild.channels.cache.get(s.announce_channel_id) : null)
        || interaction.channel;
    const role = o.getRole('role');
    if (role && (!role.editable || role.managed)) {
        return interaction.editReply({ content: `❌ I can't give ${role} — it is above my highest role, managed by an integration, or I lack **Manage Roles**.` });
    }
    if (role && (role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageGuild))) {
        return interaction.editReply({ content: '❌ For safety, a goal reward role cannot have Administrator or Manage Server.' });
    }
    try {
        const res = await goals.createGoal({
            guild: interaction.guild,
            createdBy: interaction.user.id,
            title: o.getString('title'),
            description: o.getString('description'),
            type: o.getString('type'),
            target: o.getInteger('target'),
            days: o.getInteger('days'),
            channel,
            reward: { coins: o.getInteger('coins') || 0, xp: o.getInteger('xp') || 0, role_id: role?.id || null },
        });
        if (!res.ok) return interaction.editReply({ content: `❌ ${res.error}` });
        return interaction.editReply({
            content: `✅ Goal #${res.goal.id} is live${res.goal.message_id ? ` in ${channel}` : ''}. Progress updates every few minutes.`,
        });
    } catch (err) {
        logger.error('[CommunityGoals] /create failed', { guildId: interaction.guildId, error: err.message, stack: err.stack });
        return interaction.editReply({ content: '❌ Something went wrong creating the goal.' });
    }
}

export async function handleList(interaction) {
    await interaction.deferReply();
    if (!(await enabledOrReply(interaction))) return;
    try {
        const rows = await goals.listGoals(interaction.guildId, { includeFinished: true });
        if (!rows.length) return interaction.editReply({ content: 'No community goals yet. Staff can set one with `/arcade goals create`.' });
        const icon = { active: '🟢', completed: '✅', failed: '⏰', cancelled: '🚫' };
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('🎯 Community goals')
            .setDescription(rows.slice(0, 15).map(g => {
                const def = GOAL_TYPES[g.goal_type] || GOAL_TYPES.custom;
                const deadline = g.status === 'active' && g.ends_ms ? ` · ends <t:${Math.floor(Number(g.ends_ms) / 1000)}:R>` : '';
                return `${icon[g.status] || '•'} **#${g.id} ${g.title || def.label}** — ${def.emoji} `
                    + `${Number(g.current_value).toLocaleString()}/${Number(g.target_value).toLocaleString()} ${def.unit}${deadline}\n`
                    + `${progressBar(g.current_value, g.target_value, 12)}`;
            }).join('\n\n').slice(0, 4000))
            .setTimestamp();
        return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        logger.error('[CommunityGoals] /list failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not load goals.' });
    }
}

export async function handleView(interaction) {
    await interaction.deferReply();
    if (!(await enabledOrReply(interaction))) return;
    try {
        const goal = await goals.getGoal(interaction.guildId, interaction.options.getInteger('goal'));
        if (!goal) return interaction.editReply({ content: '❌ No goal with that number here.' });
        return interaction.editReply({ embeds: [await goals.progressEmbed(goal, interaction.guild)], allowedMentions: { parse: [] } });
    } catch (err) {
        logger.error('[CommunityGoals] /view failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not load that goal.' });
    }
}

export async function handleAdd(interaction) {
    if (!isAdmin(interaction.member)) return denyAdmin(interaction);
    await interaction.deferReply(EPHEMERAL);
    try {
        const res = await goals.adjustCustom(
            interaction.guild,
            interaction.options.getInteger('goal'),
            interaction.options.getInteger('amount'),
            interaction.options.getBoolean('set') ? 'set' : 'add');
        if (!res.ok) return interaction.editReply({ content: `❌ ${res.error}` });
        const g = res.goal;
        return interaction.editReply({
            content: `✅ **${g.title}** is now at ${Number(g.current_value).toLocaleString()} / ${Number(g.target_value).toLocaleString()}`
                + (g.status === 'completed' ? ' — goal reached! 🎉' : '.'),
        });
    } catch (err) {
        logger.error('[CommunityGoals] /add failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not update the goal.' });
    }
}

export async function handleCancel(interaction) {
    if (!isAdmin(interaction.member)) return denyAdmin(interaction);
    await interaction.deferReply(EPHEMERAL);
    try {
        const g = await goals.cancelGoal(interaction.guild, interaction.options.getInteger('goal'));
        return interaction.editReply({ content: g ? `✅ Cancelled **${g.title}**.` : '❌ No active goal with that number.' });
    } catch (err) {
        logger.error('[CommunityGoals] /cancel failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not cancel the goal.' });
    }
}

export async function handleConfig(interaction) {
    if (!isAdmin(interaction.member)) return denyAdmin(interaction);
    await interaction.deferReply(EPHEMERAL);
    const o = interaction.options;
    const patch = {};
    const enabled = o.getBoolean('enabled');
    if (enabled !== null) patch.enabled = enabled;
    const ch = o.getChannel('announce-channel');
    if (ch) patch.announce_channel_id = ch.id;
    const role = o.getRole('ping-role');
    if (role) patch.ping_role_id = role.id;
    if (o.getBoolean('clear-ping-role')) patch.ping_role_id = '';
    const ms = o.getBoolean('milestones');
    if (ms !== null) patch.milestone_announcements = ms;
    try {
        const s = Object.keys(patch).length
            ? await updateSettings('communitygoals', interaction.guildId, patch, interaction.user.id)
            : await getSettings('communitygoals', interaction.guildId);
        return interaction.editReply({
            content: `⚙️ **Community goal settings${Object.keys(patch).length ? ' saved' : ''}**\n`
                + `Enabled: **${s.enabled ? 'yes' : 'no'}** · Default channel: ${s.announce_channel_id ? `<#${s.announce_channel_id}>` : '_where /create is run_'}`
                + ` · Ping: ${s.ping_role_id ? `<@&${s.ping_role_id}>` : 'none'} · Milestone posts: **${s.milestone_announcements ? 'on' : 'off'}**`,
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        logger.error('[CommunityGoals] /config failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not save the settings.' });
    }
}

/** Autocomplete for the `goal` option: this server's goals, active first. */
export async function autocompleteGoal(interaction) {
    const focused = String(interaction.options.getFocused() || '').toLowerCase();
    const sub = interaction.options.getSubcommand(false);
    const rows = await goals.listGoals(interaction.guildId, { includeFinished: sub === 'view' });
    const choices = rows
        .filter(g => sub !== 'add' || g.goal_type === 'custom')
        .filter(g => !focused || `${g.id} ${g.title}`.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(g => ({ name: `#${g.id} ${g.title || g.goal_type} (${g.status})`.slice(0, 100), value: Number(g.id) }));
    return interaction.respond(choices);
}
