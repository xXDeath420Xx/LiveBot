import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';

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
                .setDescription('List or review pending appeals')
                .addIntegerOption(opt => opt.setName('appeal_id').setDescription('Appeal ID to review'))
                .addStringOption(opt => opt.setName('decision').setDescription('Decision on the appeal')
                    .addChoices({ name: 'Approve', value: 'approve' }, { name: 'Deny', value: 'deny' }))
                .addStringOption(opt => opt.setName('response').setDescription('Response message to the appellant')))

        // stats — requires ModerateMembers
        .addSubcommand(sub =>
            sub.setName('stats')
                .setDescription('View global ban database statistics')),

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
        .setColor(0x3498DB)
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
        .setColor(0x3498DB)
        .setTitle('Appeal Submitted')
        .setDescription(`Your appeal (#${result.appealId}) has been submitted and will be reviewed by moderators.`)
        .addFields(
            { name: 'Reason', value: reason.substring(0, 1024) }
        )
        .setFooter({ text: 'You will be notified when a decision is made.' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

async function handleAppeals(interaction, manager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
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
            response || (approved ? 'Appeal approved.' : 'Appeal denied.')
        );

        if (!result.success) {
            return interaction.editReply(result.message);
        }

        const embed = new EmbedBuilder()
            .setColor(approved ? 0x2ECC71 : 0xE74C3C)
            .setTitle(`Appeal #${appealId} ${approved ? 'Approved' : 'Denied'}`)
            .setDescription(approved
                ? `The global ban for user <@${result.userId}> has been lifted.`
                : `The appeal has been denied. The global ban remains active.`
            )
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }

    // List pending appeals
    const [appeals] = await (await import('../../utils/db.js')).default.execute(
        `SELECT a.*, e.user_id as banned_user_id, e.severity, e.category
         FROM global_ban_appeals a
         JOIN global_ban_entries e ON a.global_ban_entry_id = e.id
         WHERE a.status IN ('pending', 'under_review')
         ORDER BY a.created_at ASC LIMIT 10`
    );

    if (appeals.length === 0) {
        return interaction.editReply('No pending appeals.');
    }

    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Pending Appeals')
        .setDescription(appeals.map(a => {
            const ts = Math.floor(new Date(a.created_at).getTime() / 1000);
            return `**#${a.id}** — <@${a.user_id}> (${a.severity}/${a.category})\n` +
                   `Reason: ${a.reason.substring(0, 100)}${a.reason.length > 100 ? '...' : ''}\n` +
                   `Submitted: <t:${ts}:R>`;
        }).join('\n\n'))
        .setFooter({ text: 'Use /globalban appeals <id> <approve|deny> [response] to review' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

async function handleStats(interaction, manager) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: 'You need the Moderate Members permission to view stats.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const stats = await manager.getStats();
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

    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Global Ban Database Statistics')
        .addFields(
            { name: 'Active Entries', value: `${stats.activeEntries}`, inline: true },
            { name: 'Pending Reports', value: `${stats.pendingReports}`, inline: true },
            { name: 'Pending Appeals', value: `${stats.pendingAppeals}`, inline: true },
            { name: 'Participating Guilds', value: `${stats.enabledGuilds}`, inline: true },
            { name: 'Cache Size', value: `${stats.cacheSize}`, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'By Severity', value: severityText, inline: false },
            { name: 'Top Categories', value: categoryText, inline: false },
            { name: 'Actions (24h)', value: recentText, inline: false }
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}
