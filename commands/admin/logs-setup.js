/**
 * /manage logs-setup — one-shot setup for the Logging system (register H-656).
 *
 * Creates private log channels under a 'CF Logs' category and routes every Logging-page category to one of
 * them, the same way the Logging page does: logging_config (master switch, ticked categories, default
 * channel) plus a log_event_config row per CATEGORY (core/log-manager.js resolveLogTarget reads both).
 * The plan itself is core/logs-setup-plan.js.
 *
 * `preview` changes nothing. `apply` creates what is missing, reuses channels it finds by name, makes them
 * private (only staff and the bot can see them) and writes the routing. Safe to re-run.
 */
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { LOGS_CATEGORY_NAME, FALLBACK_CHANNEL, logsSetupPlan, planLoggingConfig } from '../../core/logs-setup-plan.js';

const data = new SlashCommandBuilder()
    .setName('logs-setup')
    .setDescription('Create private log channels and route every log category to them.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('preview').setDescription('Show what apply would do, without changing anything.'))
    .addSubcommand(sub => sub.setName('apply').setDescription('Create the missing channels and write the routing. Safe to re-run.'));

// Roles that moderate (and so read logs). Administrators see every channel anyway.
const STAFF_PERMS = [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageMessages];
const BOT_ALLOW = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory];
const STAFF_ALLOW = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
const MAX_STAFF_ROLES = 20;

/** Hidden from @everyone; the bot and the server's moderator roles can read. */
function privateOverwrites(guild) {
    const staff = guild.roles.cache
        .filter(r => r.id !== guild.id && !r.managed && !r.permissions.has(PermissionFlagsBits.Administrator)
            && STAFF_PERMS.some(p => r.permissions.has(p)))
        .sort((a, b) => b.position - a.position)
        .first(MAX_STAFF_ROLES);
    return [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.members.me.id, allow: BOT_ALLOW },
        ...staff.map(r => ({ id: r.id, allow: STAFF_ALLOW })),
    ];
}

const findCategory = (guild) => guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === LOGS_CATEGORY_NAME);
const findText = (guild, name) => guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === name);
const everyoneCanSee = (guild, ch) => ch.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false;

/** Hide a reused channel or category that @everyone can see, keeping its other overwrites. */
async function makePrivate(guild, ch) {
    if (!everyoneCanSee(guild, ch)) return false;
    await ch.permissionOverwrites.edit(guild.id, { ViewChannel: false }, { reason: 'logs-setup: log channels are private' });
    await ch.permissionOverwrites.edit(guild.members.me.id,
        { ViewChannel: true, SendMessages: true, EmbedLinks: true, AttachFiles: true, ReadMessageHistory: true },
        { reason: 'logs-setup: the bot posts the logs' });
    return true;
}

async function readLoggingConfig(guildId) {
    const [rows] = await pool.execute('SELECT log_channel_id, enabled, enabled_events FROM logging_config WHERE guild_id = ?', [guildId]);
    return rows[0] || null;
}

function configLines(cfg, plan) {
    const lines = [];
    if (cfg.setEvents) lines.push('Logging is switched on with every category ticked.');
    else lines.push('Your ticked categories on the Logging page stay as they are.');
    if (cfg.switchOn) lines.push('Logging was switched off; apply switches it on.');
    if (cfg.setDefaultChannel) lines.push(`#${FALLBACK_CHANNEL} becomes the default log channel.`);
    if (cfg.off.length) lines.push(`${cfg.off.length} of ${plan.reduce((n, g) => n + g.categories.length, 0)} categories are unticked on the Logging page, so they stay off: ${cfg.off.slice(0, 8).join(', ')}${cfg.off.length > 8 ? ', ...' : ''}.`);
    return lines.join('\n');
}

async function previewReply(interaction) {
    const guild = interaction.guild;
    const plan = logsSetupPlan();
    const cfg = planLoggingConfig(await readLoggingConfig(guild.id), plan.flatMap(g => g.categories));
    const lines = plan.map(({ name, categories }) => {
        const ch = findText(guild, name);
        const state = !ch ? '`new `' : everyoneCanSee(guild, ch) ? '`hide`' : '`keep`';
        return `${state} **#${name}**: ${categories.length} ${categories.length === 1 ? 'category' : 'categories'}`;
    });
    const willCreate = plan.filter(g => !findText(guild, g.name)).length;
    const embed = new EmbedBuilder()
        .setTitle('Logs setup preview')
        .setDescription(`Category **${LOGS_CATEGORY_NAME}**: ${findCategory(guild) ? '`keep`' : '`new `'}\n\n${lines.join('\n')}\n\n${configLines(cfg, plan)}`)
        .addFields(
            { name: 'Channels to create', value: String(willCreate), inline: true },
            { name: 'Channels to reuse', value: String(plan.length - willCreate), inline: true },
            { name: 'Categories routed', value: String(plan.reduce((n, g) => n + g.categories.length, 0)), inline: true },
        )
        .setFooter({ text: 'The channels are private: only moderator roles, admins and the bot can see them. Run /manage logs-setup apply to do this.' });
    return interaction.editReply({ embeds: [embed] });
}

async function applyWizard(interaction) {
    const guild = interaction.guild;
    const me = guild.members.me;
    const missing = [['Manage Channels', PermissionFlagsBits.ManageChannels], ['Manage Roles', PermissionFlagsBits.ManageRoles]]
        .filter(([, p]) => !me?.permissions?.has(p)).map(([n]) => n);
    if (missing.length) {
        return interaction.editReply(`I need the **${missing.join('** and **')}** permission${missing.length > 1 ? 's' : ''} to create private log channels.`);
    }

    const plan = logsSetupPlan();
    const overwrites = privateOverwrites(guild);
    let category = findCategory(guild);
    let hidden = 0;
    if (category) {
        if (await makePrivate(guild, category).catch(() => false)) hidden++;
    } else {
        category = await guild.channels.create({
            name: LOGS_CATEGORY_NAME, type: ChannelType.GuildCategory, permissionOverwrites: overwrites,
            reason: 'logs-setup: category for the log channels',
        });
    }

    const results = [];
    const channelOf = new Map();
    for (const { name } of plan) {
        try {
            let ch = findText(guild, name);
            let status = 'kept';
            if (ch) {
                if (ch.parentId !== category.id) await ch.setParent(category.id, { lockPermissions: false }).catch(() => {});
                if (await makePrivate(guild, ch)) { status = 'hidden'; hidden++; }
            } else {
                ch = await guild.channels.create({
                    name, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites,
                    reason: 'logs-setup: log channel',
                });
                status = 'created';
            }
            channelOf.set(name, ch.id);
            results.push({ name, status, channel: ch });
        } catch (err) {
            results.push({ name, status: 'failed', error: err.message });
        }
    }

    // logging_config first: without its row nothing is logged at all.
    const categories = plan.filter(g => channelOf.has(g.name)).flatMap(g => g.categories);
    const cfg = planLoggingConfig(await readLoggingConfig(guild.id), categories);
    const fallbackId = channelOf.get(FALLBACK_CHANNEL) || null;
    await pool.execute(
        `INSERT INTO logging_config (guild_id, log_channel_id, enabled, enabled_events, events_saved_at)
         VALUES (?, ?, 1, ?, NOW())
         ON DUPLICATE KEY UPDATE
             enabled = 1,
             log_channel_id = COALESCE(log_channel_id, VALUES(log_channel_id))
             ${cfg.setEvents ? ', enabled_events = VALUES(enabled_events), events_saved_at = NOW()' : ''}`,
        [String(guild.id), fallbackId, JSON.stringify(cfg.enabledEvents)]);

    // One row per category, as the Logging page writes them. An existing row keeps its on/off switch.
    let wrote = 0;
    for (const { name, categories: cats } of plan) {
        const channelId = channelOf.get(name);
        if (!channelId) continue;
        for (const eventType of cats) {
            try {
                await pool.execute(
                    `INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id)`,
                    [String(guild.id), eventType, cfg.enabledEvents.includes(eventType) ? 1 : 0, channelId]);
                wrote++;
            } catch (err) {
                logger.warn(`[logs-setup] routing write failed for ${eventType}: ${err.message}`);
            }
        }
    }

    const label = { created: 'new ', kept: 'kept', hidden: 'hid ' };
    const summary = results.map(r => (r.status === 'failed'
        ? `\`fail\` **#${r.name}**: ${r.error}`
        : `\`${label[r.status]}\` ${r.channel}`)).join('\n');
    const embed = new EmbedBuilder()
        .setTitle('Logs setup applied')
        .setDescription(`${summary}\n\n${configLines(cfg, plan)}`)
        .addFields(
            { name: 'Categories routed', value: `${wrote} / ${plan.reduce((n, g) => n + g.categories.length, 0)}`, inline: true },
            { name: 'Made private', value: String(hidden), inline: true },
            { name: 'Category', value: `**${LOGS_CATEGORY_NAME}**`, inline: true },
        )
        .setFooter({ text: 'Change channels, ticked categories and colours on Dashboard → Logging.' });
    return interaction.editReply({ embeds: [embed] });
}

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });
    try {
        if (sub === 'preview') return await previewReply(interaction);
        if (sub === 'apply') return await applyWizard(interaction);
        return interaction.editReply('Unknown subcommand.');
    } catch (err) {
        logger.error(`[logs-setup] failed: ${err.message}`, { stack: err.stack });
        return interaction.editReply(`Logs setup failed: ${err.message}`);
    }
}

export { data, execute };
export default { category: 'admin', data, execute };
