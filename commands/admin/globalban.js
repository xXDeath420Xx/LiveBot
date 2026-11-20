import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { isProtectedFromBanCommands } from '../../utils/owner-protection.js';
import { themeColor } from '../../core/guild-theme.js';
import configCache from '../../utils/configCache.js';
import pool from '../../utils/db.js';
import { normaliseMode, normaliseThreshold, DEFAULT_THRESHOLD } from '../../core/global-ban-confidence.js';
import { logFeatureEvent, userLabel } from '../../core/feature-log.js';
import { isSuperAdmin } from '../../utils/constants.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('globalban')
        .setDescription('Global ban database — report, lookup, vote, appeal, and view stats')

        // report — requires ModerateMembers
        .addSubcommand(sub =>
            sub.setName('report')
                .setDescription('Report a user to the global ban database')
                .addUserOption(opt => opt.setName('user').setDescription('User to report').setRequired(true))
                .addStringOption(opt => opt.setName('category').setDescription('Category of offense').setRequired(true)
                    .addChoices(
                        { name: 'Phishing', value: 'phishing' },
                        { name: 'Scam', value: 'scam' },
                        { name: 'Spam', value: 'spam' },
                        { name: 'Raid', value: 'raid' },
                        { name: 'Harassment', value: 'harassment' },
                        { name: 'Self-Bot', value: 'selfbot' },
                        { name: 'Mass DM', value: 'mass_dm' },
                        { name: 'Impersonation', value: 'impersonation' },
                        { name: 'Other', value: 'other' }
                    ))
                .addStringOption(opt => opt.setName('severity').setDescription('Severity level').setRequired(true)
                    .addChoices(
                        { name: 'Critical — Confirmed phishing/scam', value: 'critical' },
                        { name: 'High — Raid organizer, repeat offender', value: 'high' },
                        { name: 'Medium — Spam, nuisance', value: 'medium' },
                        { name: 'Low — Single incident', value: 'low' }
                    ))
                .addStringOption(opt => opt.setName('evidence').setDescription('Evidence (URLs, screenshots, descriptions)').setRequired(true))
                .addStringOption(opt => opt.setName('reason').setDescription('Reason for the report').setRequired(true)))

        // lookup — requires ModerateMembers
        .addSubcommand(sub =>
            sub.setName('lookup')
                .setDescription('Look up a user\'s global ban record')
                .addUserOption(opt => opt.setName('user').setDescription('User to look up').setRequired(true)))

        // vote — requires ModerateMembers
        .addSubcommand(sub =>
            sub.setName('vote')
                .setDescription('Vote on a pending global ban report')
                .addIntegerOption(opt => opt.setName('report_id').setDescription('Report ID to vote on').setRequired(true))
                .addStringOption(opt => opt.setName('decision').setDescription('Your vote').setRequired(true)
                    .addChoices({ name: 'Approve', value: 'approve' }, { name: 'Deny', value: 'deny' }))
                .addStringOption(opt => opt.setName('reason').setDescription('Reason for your vote')))

        // appeal — available to everyone
        .addSubcommand(sub =>
            sub.setName('appeal')
                .setDescription('Submit an appeal for your global ban')
                .addStringOption(opt => opt.setName('reason').setDescription('Why should your ban be lifted?').setRequired(true))
                .addStringOption(opt => opt.setName('evidence').setDescription('Supporting evidence for your appeal')))

        // appeals — requires ModerateMembers
        .addSubcommand(sub =>
            sub.setName('appeals')
                .setDescription('Review appeals: approve for this server (the CertiFried team decides for all)')
                .addIntegerOption(opt => opt.setName('appeal_id').setDescription('Appeal ID to review'))
                .addStringOption(opt => opt.setName('decision').setDescription('Decision on the appeal')
                    .addChoices({ name: 'Approve', value: 'approve' }, { name: 'Deny', value: 'deny' }))
                .addStringOption(opt => opt.setName('response').setDescription('Response message to the appellant')))

        // stats — requires ModerateMembers
        .addSubcommand(sub =>
            sub.setName('stats')
                .setDescription('Network size, recent additions and what it did in this server'))

        // check — requires ModerateMembers; privacy-safe (no reporting servers or moderators)
        .addSubcommand(sub =>
            sub.setName('check')
                .setDescription('Network confidence (0-100) for a user and what this server would do')
                .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true)))

        // mode — requires Manage Server
        .addSubcommand(sub =>
            sub.setName('mode')
                .setDescription('Protect (act above a confidence), Alert only, or Feed only (never act)')
                .addStringOption(opt => opt.setName('mode').setDescription('What this server does with network hits').setRequired(true)
                    .addChoices(
                        { name: 'Protect: act at or above the threshold, alert below', value: 'protect' },
                        { name: 'Alert only: never act, always alert', value: 'alert' },
                        { name: 'Feed only: contribute bans, never act or alert', value: 'feed' }
                    ))
                .addIntegerOption(opt => opt.setName('threshold').setDescription(`Confidence needed to act in Protect mode (default ${DEFAULT_THRESHOLD})`)
                    .setMinValue(0).setMaxValue(100))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const manager = interaction.client.globalBanManager;

        if (!manager) {
            return interaction.reply({ content: 'Global ban system is not available.', ephemeral: true });
        }

        try {
            switch (subcommand) {
                case 'report':
                    return await handleReport(interaction, manager);
                case 'lookup':
                    return await handleLookup(interaction, manager);
                case 'vote':
                    return await handleVote(interaction, manager);
                case 'appeal':
                    return await handleAppeal(interaction, manager);
                case 'appeals':
                    return await handleAppeals(interaction, manager);
                case 'stats':
                    return await handleStats(interaction, manager);
                case 'check':
                    return await handleCheck(interaction, manager);
                case 'mode':
                    return await handleMode(interaction);
            }
        } catch (error) {
            logger.error('[GlobalBan Command] Error:', { error: error.message, subcommand, stack: error.stack });
            const reply = { content: `Error: ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    }
};

async function handleReport(interaction, manager) {
    // Permission check
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: 'You need the Moderate Members permission to report users.', ephemeral: true });
    }

    const user = interaction.options.getUser('user');
    const category = interaction.options.getString('category');
    const severity = interaction.options.getString('severity');
    const evidence = interaction.options.getString('evidence');
    const reason = interaction.options.getString('reason');

    // Can't report yourself or bots
    if (user.id === interaction.user.id) {
        return interaction.reply({ content: 'You cannot report yourself.', ephemeral: true });
    }
    if (user.bot) {
        return interaction.reply({ content: 'You cannot report bots.', ephemeral: true });
    }
    if (isProtectedFromBanCommands(user.id)) {
        logger.warn('[GlobalBan Report] Blocked report against protected bot owner', {
            guildId: interaction.guild.id,
            actor: interaction.user.id,
            target: user.id
        });
        return interaction.reply({ content: 'This user is the bot owner / developer and cannot be reported through this bot.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const result = await manager.reportUser(
        interaction.user.id,
        interaction.guild.id,
        user.id,
        category,
        severity,
        evidence,
        reason
    );

    if (!result.success) {
        return interaction.editReply(result.message);
    }

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle('Global Ban Report Submitted')
        .addFields(
            { name: 'Report ID', value: `#${result.reportId}`, inline: true },
            { name: 'Target', value: `${user.tag} (${user.id})`, inline: true },
            { name: 'Category', value: category, inline: true },
            { name: 'Severity', value: severity.toUpperCase(), inline: true },
            { name: 'Status', value: 'Pending votes (need 3 approvals from 2+ guilds)', inline: false }
        )
        .setFooter({ text: 'Other moderators can vote with /globalban vote' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

async function handleLookup(interaction, manager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: 'You need the Moderate Members permission to look up records.', ephemeral: true });
    }

    const user = interaction.options.getUser('user');
    await interaction.deferReply({ ephemeral: true });

    const record = await manager.getUserRecord(user.id);
    if (!record) {
        return interaction.editReply('Failed to fetch user record.');
    }

    const activeEntry = record.entries.find(e => e.active);

    const embed = new EmbedBuilder()
        .setColor(activeEntry ? 0xE74C3C : 0x2ECC71)
        .setTitle(`Global Ban Record: ${user.tag}`)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
            { name: 'Status', value: activeEntry ? `ACTIVE — ${activeEntry.severity.toUpperCase()} (${activeEntry.category})` : 'No active ban', inline: false },
            { name: 'Total Entries', value: `${record.entries.length}`, inline: true },
            { name: 'Reports Filed', value: `${record.reports.length}`, inline: true },
            { name: 'Appeals', value: `${record.appeals.length}`, inline: true }
        );

    if (activeEntry) {
        if (activeEntry.reason) {
            embed.addFields({ name: 'Reason', value: activeEntry.reason.substring(0, 1024) });
        }
        embed.addFields(
            { name: 'Source', value: activeEntry.source.replace('_', ' '), inline: true },
            { name: 'Created', value: `<t:${Math.floor(new Date(activeEntry.created_at).getTime() / 1000)}:R>`, inline: true },
            { name: 'Verified', value: activeEntry.verified ? 'Yes' : 'No', inline: true }
        );
        if (activeEntry.expires_at) {
            embed.addFields({ name: 'Expires', value: `<t:${Math.floor(new Date(activeEntry.expires_at).getTime() / 1000)}:R>`, inline: true });
        }
    }

    if (record.aggregateData.length > 0) {
        const aggText = record.aggregateData.map(a => `**${a.action_type}:** ${a.total} actions across ${a.guild_count} guilds`).join('\n');
        embed.addFields({ name: 'Cross-Guild Moderation History', value: aggText });
    }

    if (record.reports.length > 0) {
        const reportsText = record.reports.slice(0, 5).map(r => {
            const ts = Math.floor(new Date(r.created_at).getTime() / 1000);
            return `#${r.id} — ${r.category} (${r.severity}) — ${r.status} — <t:${ts}:R>`;
        }).join('\n');
        embed.addFields({ name: 'Recent Reports', value: reportsText });
    }

    embed.setFooter({ text: `User ID: ${user.id}` }).setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

async function handleVote(interaction, manager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: 'You need the Moderate Members permission to vote.', ephemeral: true });
    }

    const reportId = interaction.options.getInteger('report_id');
    const decision = interaction.options.getString('decision');
    const reason = interaction.options.getString('reason');

    await interaction.deferReply({ ephemeral: true });

    const result = await manager.voteOnReport(
        reportId,
        interaction.user.id,
        interaction.guild.id,
        decision,
        reason
    );

    if (!result.success) {
        return interaction.editReply(result.message);
    }

    const color = result.promoted ? 0x2ECC71 : result.denied ? 0xE74C3C : 0x3498DB;
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('Vote Recorded')
        .setDescription(result.message)
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

async function handleAppeal(interaction, manager) {
    const reason = interaction.options.getString('reason');
    const evidence = interaction.options.getString('evidence');

    await interaction.deferReply({ ephemeral: true });

    const result = await manager.submitAppeal(interaction.user.id, reason, evidence);

    if (!result.success) {
        return interaction.editReply(result.message);
    }

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle('Appeal Submitted')
        .setDescription(`Your appeal (#${result.appealId}) has been submitted. The CertiFried team decides for every server; a server's moderators can accept it for their own server.`)
        .addFields(
            { name: 'Reason', value: reason.substring(0, 1024) }
        )
        .setFooter({ text: 'You will be notified when a decision is made.' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

// H-802: a CertiFried super-admin decides for every server; a server's moderators approve for their server only.
async function handleAppeals(interaction, manager) {
    const team = isSuperAdmin(interaction.user.id);
    if (!team && !interaction.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: 'You need the Moderate Members permission to review appeals.', ephemeral: true });
    }

    const appealId = interaction.options.getInteger('appeal_id');
    const decision = interaction.options.getString('decision');
    const response = interaction.options.getString('response');

    await interaction.deferReply({ ephemeral: true });

    // If reviewing a specific appeal
    if (appealId && decision) {
        const approved = decision === 'approve';
        const result = await manager.reviewAppeal(
            interaction.user.id,
            appealId,
            approved,
            response || (approved ? 'Appeal approved.' : 'Appeal denied.'),
            { guild: interaction.guild }
        );

        if (!result.success) {
            return interaction.editReply(result.message);
        }

        const local = result.scope === 'server';
        const embed = new EmbedBuilder()
            .setColor(approved ? 0x2ECC71 : 0xE74C3C)
            .setTitle(`Appeal #${appealId} ${local ? 'approved for this server' : approved ? 'approved for every server' : 'denied for every server'}`)
            .setDescription(local
                ? `CertiFried no longer acts on the shared ban for <@${result.userId}> in this server${result.unbanned ? ', and their global-ban ban here was lifted' : ''}. Every other protection (raids, scam links, name filters and the rest) still applies to them. The shared ban stays for every other server, and the CertiFried team still reviews the appeal. Undo it on the dashboard: Protection Settings, "Accepted global ban appeals".`
                : approved
                    ? `The shared ban for <@${result.userId}> has been lifted in every server.`
                    : `The appeal has been denied. The shared ban stays in every server.`
            )
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }

    // List pending appeals. The team sees every appeal; a server sees only appeals from people tied to it
    // (a network signal from this server, a member, or banned here): appeal texts are not shared network-wide.
    const [pending] = await (await import('../../utils/db.js')).default.execute(
        `SELECT a.*, e.user_id as banned_user_id, e.severity, e.category,
                EXISTS(SELECT 1 FROM global_ban_action_log l WHERE l.user_id = a.user_id AND l.guild_id = ?) AS here
         FROM global_ban_appeals a
         JOIN global_ban_entries e ON a.global_ban_entry_id = e.id
         WHERE a.status IN ('pending', 'under_review')
         ORDER BY a.created_at ASC LIMIT ${team ? 10 : 200}`,
        [String(interaction.guildId || '')]
    );
    let appeals = pending;
    if (!team) {
        const bans = await interaction.guild?.bans?.fetch().catch(() => null);
        appeals = pending.filter(a => Number(a.here) || interaction.guild?.members?.cache?.has(String(a.user_id)) || bans?.has?.(String(a.user_id))).slice(0, 10);
    }

    if (appeals.length === 0) {
        return interaction.editReply(team ? 'No pending appeals.' : 'No pending appeals from people connected to this server.');
    }

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle('Pending Appeals')
        .setDescription(appeals.map(a => {
            const ts = Math.floor(new Date(a.created_at).getTime() / 1000);
            return `**#${a.id}** — <@${a.user_id}> (${a.severity}/${a.category})\n` +
                   `Reason: ${a.reason.substring(0, 100)}${a.reason.length > 100 ? '...' : ''}\n` +
                   `Submitted: <t:${ts}:R>`;
        }).join('\n\n'))
        .setFooter({ text: team
            ? 'Your decision applies to every server: /globalban appeals <id> <approve|deny> [response]'
            : 'Approve applies to this server only: /globalban appeals <id> approve [response]. The CertiFried team decides for every server.' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

async function handleStats(interaction, manager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: 'You need the Moderate Members permission to view stats.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const [stats, net] = await Promise.all([manager.getStats(), manager.getNetworkStats(interaction.guild.id)]);
    if (!stats) {
        return interaction.editReply('Failed to fetch statistics.');
    }

    const severityText = stats.bySeverity.length > 0
        ? stats.bySeverity.map(s => `${s.severity.toUpperCase()}: ${s.count}`).join(' | ')
        : 'None';

    const categoryText = stats.byCategory.length > 0
        ? stats.byCategory.map(c => `${c.category}: ${c.count}`).join(' | ')
        : 'None';

    const recentText = stats.recentActions.length > 0
        ? stats.recentActions.map(a => `${a.action}: ${a.count}`).join(' | ')
        : 'None';

    const modeText = Object.entries(net.enabledByMode).map(([m, n]) => `${m}: ${n}`).join(' | ') || 'None';
    const additions = net.recent.slice(0, 5).map(e => {
        const ts = Math.floor(new Date(e.created_at).getTime() / 1000);
        return `<@${e.user_id}> ${e.severity} (${e.category}), confidence ${e.confidence} <t:${ts}:R>`;
    }).join('\n') || 'None';
    const settings = await manager.getSettings(interaction.guild.id);
    const here = settings
        ? `${settings.enabled ? 'On' : 'Off'} · ${normaliseMode(settings.mode)}${normaliseMode(settings.mode) === 'protect' ? ` at ${normaliseThreshold(settings.confidence_threshold)}` : ''}`
            + ` · ${settings.auto_aggregate_opt_in ? 'contributing' : 'not contributing'}`
        : 'Not set up (contributing by default)';

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle('Global Ban Network')
        .addFields(
            { name: 'Listed Users', value: `${stats.activeEntries} (${net.automaticEntries} automatic)`, inline: true },
            { name: 'Users With Signals (90d)', value: `${net.trackedUsers}`, inline: true },
            { name: 'Contributing Servers (90d)', value: `${net.contributingServers}`, inline: true },
            { name: 'Participating Servers', value: `${stats.enabledGuilds} (${modeText})`, inline: true },
            { name: 'Added This Week', value: `${net.addedThisWeek} entries, ${net.signalsThisWeek} signals`, inline: true },
            { name: 'Pending', value: `${stats.pendingReports} reports, ${stats.pendingAppeals} appeals`, inline: true },
            { name: 'By Severity', value: severityText, inline: false },
            { name: 'Top Categories', value: categoryText, inline: false },
            { name: 'Recent Additions', value: additions.slice(0, 1024), inline: false },
            { name: 'This Server', value: `${here}\nLast 30 days: ${net.mine?.actions30d ?? 0} removed, ${net.mine?.alerts30d ?? 0} alerts; ${net.mine?.contributed90d ?? 0} bans contributed (90d)`, inline: false },
            { name: 'Network Actions (24h)', value: recentText, inline: false }
        )
        .setFooter({ text: 'Change this server\'s mode with /globalban mode or on the dashboard Global Ban page' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

async function handleCheck(interaction, manager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: 'You need the Moderate Members permission to check users.', ephemeral: true });
    }

    const user = interaction.options.getUser('user');
    await interaction.deferReply({ ephemeral: true });

    const c = await manager.getNetworkCheck(user.id, interaction.guild.id);
    const color = c.confidence >= 75 ? 0xE74C3C : c.confidence >= 40 ? 0xE67E22 : 0x2ECC71;
    const ts = (d) => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>` : 'never');
    const what = { ban: 'Ban', kick: 'Kick', alert: 'Alert only', none: 'Nothing' };

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`Network Check: ${user.tag}`)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
            { name: 'Confidence', value: `**${c.confidence}/100**`, inline: true },
            { name: 'Listed', value: c.listed ? `Yes — ${String(c.severity).toUpperCase()} (${c.category})` : 'No', inline: true },
            { name: 'Independent Servers', value: `${c.independentServers}`, inline: true },
            { name: 'Reported By', value: c.reportedBy.join(', ') || 'Nobody', inline: false },
            { name: 'Reasons', value: c.reasons.join(', ') || '—', inline: true },
            { name: 'First / Last Seen', value: `${ts(c.firstSeen)} / ${ts(c.lastSeen)}`, inline: true },
            { name: 'Pending Reports', value: `${c.pendingReports}`, inline: true }
        )
        .setFooter({ text: `User ID: ${user.id} · reporting servers and moderators are never shown` })
        .setTimestamp();

    if (c.ownSignal) embed.addFields({ name: 'This Server', value: 'This server has reported them too.', inline: false });
    if (c.decision) {
        embed.addFields({
            name: 'If They Join Here',
            value: `${what[c.decision.action] || c.decision.action} — ${c.decision.mode} mode${c.decision.mode === 'protect' ? ` (threshold ${c.decision.threshold})` : ''}: ${c.decision.why}`.slice(0, 1024),
            inline: false
        });
    }

    await interaction.editReply({ embeds: [embed] });
}

async function handleMode(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the Manage Server permission to change the global ban mode.', ephemeral: true });
    }
    const guildId = interaction.guild.id;
    const mode = normaliseMode(interaction.options.getString('mode'));
    const raw = interaction.options.getInteger('threshold');
    const threshold = raw === null ? null : normaliseThreshold(raw);

    await pool.execute('INSERT IGNORE INTO global_ban_config (guild_id) VALUES (?)', [guildId]);
    if (threshold === null) {
        await pool.execute('UPDATE global_ban_config SET mode = ? WHERE guild_id = ?', [mode, guildId]);
    } else {
        await pool.execute('UPDATE global_ban_config SET mode = ?, confidence_threshold = ? WHERE guild_id = ?', [mode, threshold, guildId]);
    }
    configCache.invalidate('global_ban_config', guildId);
    configCache.invalidate('global_ban_config_any', guildId);

    const [[row]] = await pool.execute('SELECT enabled, confidence_threshold FROM global_ban_config WHERE guild_id = ?', [guildId]);
    const t = normaliseThreshold(row?.confidence_threshold);
    const text = {
        protect: `**Protect** — members at or above confidence **${t}** get this server's action for their severity; below it, an alert.`,
        alert: '**Alert only** — nobody is removed; every network hit is posted to the alert channel.',
        feed: '**Feed only** — this server keeps contributing its bans to the network but never acts or alerts.',
    }[mode];

    void logFeatureEvent(() => (interaction.guild), 'moderation.globalBanSettings', () => ({
        title: '🌐 Global Ban Mode Changed',
        fields: [['Mode', mode], ['Threshold', mode === 'protect' ? String(t) : null], ['By', userLabel(interaction.user)]],
    }));
    logger.info('[GlobalBan] Mode changed', { guildId, mode, threshold: t, by: interaction.user.username });

    await interaction.reply({
        content: `${text}${row?.enabled ? '' : '\n\nGlobal ban protection is currently **off** here — turn it on with `/protection globalban enable` or the dashboard.'}`,
        ephemeral: true
    });
}
