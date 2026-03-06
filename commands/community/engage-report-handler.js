import {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    ChannelType
} from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const scamTypeNames = {
    'fake_seeds': 'Fake Seeds/Clones',
    'payment_scam': 'Payment Scam',
    'bad_vendor': 'Bad Seed Bank/Vendor',
    'trade_scam': 'Trade Scam',
    'impersonation': 'Identity Theft/Impersonation',
    'phishing': 'Phishing/Malicious Links',
    'other': 'Other'
};

// ── Internal helpers ──

async function alertStaff(guild, reportId, reporter, reportedUser, scamType, description, evidence, lossAmount) {
    try {
        const [logConfig] = await pool.execute(
            `SELECT channel_id FROM logging_config WHERE guild_id = ? AND event_type = 'moderation' AND enabled = 1`,
            [guild.id]
        );

        if (logConfig.length === 0) return;

        const channel = await guild.channels.fetch(logConfig[0].channel_id).catch(() => null);
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle(`New Scam Report #${reportId}`)
            .setDescription('A new scam report has been submitted and requires review.')
            .addFields(
                { name: 'Reporter', value: `${reporter.tag} (<@${reporter.id}>)`, inline: true },
                { name: 'Reported User', value: `${reportedUser.tag} (<@${reportedUser.id}>)`, inline: true },
                { name: 'Scam Type', value: scamTypeNames[scamType], inline: true },
                { name: 'Description', value: description.substring(0, 1024), inline: false }
            )
            .setThumbnail(reportedUser.displayAvatarURL())
            .setTimestamp();

        if (evidence) {
            embed.addFields({ name: 'Evidence', value: evidence.substring(0, 1024), inline: false });
        }

        if (lossAmount) {
            embed.addFields({ name: 'Reported Loss', value: lossAmount, inline: true });
        }

        embed.setFooter({ text: 'Use /engage report review to review pending reports' });

        await channel.send({ embeds: [embed] });
    } catch (error) {
        logger.error('[Report] Failed to alert staff:', { error: error.message });
    }
}

async function alertStaffVendor(guild, reportId, reporter, vendorName, website, description, evidence) {
    try {
        const [logConfig] = await pool.execute(
            `SELECT channel_id FROM logging_config WHERE guild_id = ? AND event_type = 'moderation' AND enabled = 1`,
            [guild.id]
        );

        if (logConfig.length === 0) return;

        const channel = await guild.channels.fetch(logConfig[0].channel_id).catch(() => null);
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle(`New Vendor Report #${reportId}`)
            .setDescription('A bad vendor/seed bank has been reported.')
            .addFields(
                { name: 'Reporter', value: `${reporter.tag} (<@${reporter.id}>)`, inline: true },
                { name: 'Vendor Name', value: vendorName, inline: true },
                { name: 'Website', value: website || 'Not provided', inline: true },
                { name: 'Description', value: description.substring(0, 1024), inline: false }
            )
            .setTimestamp();

        if (evidence) {
            embed.addFields({ name: 'Evidence', value: evidence.substring(0, 1024), inline: false });
        }

        embed.setFooter({ text: 'Use /engage report review to review pending reports' });

        await channel.send({ embeds: [embed] });
    } catch (error) {
        logger.error('[Report] Failed to alert staff about vendor:', { error: error.message });
    }
}

async function confirmReport(interaction, report) {
    if (report.report_type === 'user') {
        await pool.execute(
            `INSERT INTO scammer_watchlist (guild_id, entry_type, discord_id, name, reason, reported_by, report_id)
            VALUES (?, 'user', ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE reason = VALUES(reason), updated_at = NOW()`,
            [
                report.guild_id,
                report.reported_user_id,
                report.reported_user_tag,
                report.description.substring(0, 500),
                report.reporter_id,
                report.id
            ]
        );
    } else {
        await pool.execute(
            `INSERT INTO scammer_watchlist (guild_id, entry_type, name, website, reason, reported_by, report_id)
            VALUES (?, 'vendor', ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE reason = VALUES(reason), updated_at = NOW()`,
            [
                report.guild_id,
                report.reported_vendor_name,
                report.reported_vendor_website,
                report.description.substring(0, 500),
                report.reporter_id,
                report.id
            ]
        );
    }

    await pool.execute(
        `UPDATE scam_reports SET status = 'confirmed', resolved_by = ?, resolved_at = NOW() WHERE id = ?`,
        [interaction.user.id, report.id]
    );

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('Report Confirmed')
        .setDescription(`Report #${report.id} has been confirmed and the ${report.report_type === 'user' ? 'user' : 'vendor'} has been added to the watchlist.`)
        .setTimestamp();

    await interaction.update({ embeds: [embed], components: [] });

    logger.info('[Report] Report confirmed and added to watchlist', {
        reportId: report.id,
        staffId: interaction.user.id,
        guildId: report.guild_id
    });
}

async function investigateReport(interaction, report) {
    await pool.execute(
        `UPDATE scam_reports SET status = 'investigating', resolved_by = ? WHERE id = ?`,
        [interaction.user.id, report.id]
    );

    const embed = new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle('Report Under Investigation')
        .setDescription(`Report #${report.id} has been marked as under investigation.`)
        .setTimestamp();

    await interaction.update({ embeds: [embed], components: [] });

    logger.info('[Report] Report marked as investigating', {
        reportId: report.id,
        staffId: interaction.user.id
    });
}

async function dismissReport(interaction, report) {
    await pool.execute(
        `UPDATE scam_reports SET status = 'dismissed', resolved_by = ?, resolved_at = NOW() WHERE id = ?`,
        [interaction.user.id, report.id]
    );

    const embed = new EmbedBuilder()
        .setColor('#95A5A6')
        .setTitle('Report Dismissed')
        .setDescription(`Report #${report.id} has been dismissed.`)
        .setTimestamp();

    await interaction.update({ embeds: [embed], components: [] });

    logger.info('[Report] Report dismissed', {
        reportId: report.id,
        staffId: interaction.user.id
    });
}

async function showReportForReview(interaction, report, totalPending) {
    const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle(`Report #${report.id} - Pending Review`)
        .setDescription(`**${totalPending} pending report(s) total**`)
        .addFields(
            { name: 'Reporter', value: `<@${report.reporter_id}>`, inline: true },
            { name: 'Type', value: report.report_type === 'user' ? 'User Report' : 'Vendor Report', inline: true },
            { name: 'Scam Type', value: scamTypeNames[report.scam_type] || report.scam_type, inline: true }
        )
        .setTimestamp(new Date(report.created_at));

    if (report.report_type === 'user') {
        embed.addFields(
            { name: 'Reported User', value: `${report.reported_user_tag} (<@${report.reported_user_id}>)`, inline: false }
        );
    } else {
        embed.addFields(
            { name: 'Vendor Name', value: report.reported_vendor_name, inline: true },
            { name: 'Website', value: report.reported_vendor_website || 'Not provided', inline: true }
        );
    }

    embed.addFields(
        { name: 'Description', value: report.description.substring(0, 1024), inline: false }
    );

    if (report.evidence_urls) {
        embed.addFields({ name: 'Evidence', value: report.evidence_urls.substring(0, 1024), inline: false });
    }

    if (report.loss_amount) {
        embed.addFields({ name: 'Reported Loss', value: report.loss_amount, inline: true });
    }

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`report_confirm_${report.id}`)
                .setLabel('Confirm & Add to Watchlist')
                .setStyle(ButtonStyle.Danger)
                .setEmoji(''),
            new ButtonBuilder()
                .setCustomId(`report_investigate_${report.id}`)
                .setLabel('Mark as Investigating')
                .setStyle(ButtonStyle.Primary)
                .setEmoji(''),
            new ButtonBuilder()
                .setCustomId(`report_dismiss_${report.id}`)
                .setLabel('Dismiss Report')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('')
        );

    const response = await interaction.editReply({
        embeds: [embed],
        components: [row]
    });

    const collector = response.createMessageComponentCollector({ time: 300000 });

    collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) {
            return i.reply({ content: 'Only the staff member who initiated the review can use these buttons.', ephemeral: true });
        }

        if (i.customId.startsWith('report_confirm_')) {
            await confirmReport(i, report);
            collector.stop();
        } else if (i.customId.startsWith('report_investigate_')) {
            await investigateReport(i, report);
            collector.stop();
        } else if (i.customId.startsWith('report_dismiss_')) {
            await dismissReport(i, report);
            collector.stop();
        }
    });

    collector.on('end', async () => {
        try {
            const disabledRow = new ActionRowBuilder()
                .addComponents(
                    row.components.map(c => ButtonBuilder.from(c).setDisabled(true))
                );
            await interaction.editReply({ components: [disabledRow] }).catch(() => {});
        } catch (e) {
            // Silently ignore
        }
    });
}

// ── Exported handlers ──

export async function handleScammerReport(interaction) {
    const reportedUser = interaction.options.getUser('user');
    const scamType = interaction.options.getString('type');

    if (reportedUser.id === interaction.user.id) {
        return interaction.reply({ content: 'You cannot report yourself.', ephemeral: true });
    }

    if (reportedUser.bot) {
        return interaction.reply({ content: 'You cannot report bots.', ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId(`scam_report_modal_${reportedUser.id}`)
        .setTitle('Scam Report Details');

    const descriptionInput = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Describe what happened')
        .setPlaceholder('Provide details about the scam or suspicious behavior...')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(2000);

    const evidenceInput = new TextInputBuilder()
        .setCustomId('evidence')
        .setLabel('Evidence Links (Optional)')
        .setPlaceholder('Paste links to screenshots, messages, or other evidence (one per line)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000);

    const lossAmountInput = new TextInputBuilder()
        .setCustomId('loss_amount')
        .setLabel('Amount Lost (if applicable)')
        .setPlaceholder('e.g., $50, 10 seeds')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(100);

    modal.addComponents(
        new ActionRowBuilder().addComponents(descriptionInput),
        new ActionRowBuilder().addComponents(evidenceInput),
        new ActionRowBuilder().addComponents(lossAmountInput)
    );

    await interaction.showModal(modal);

    const filter = (i) => i.customId === `scam_report_modal_${reportedUser.id}` && i.user.id === interaction.user.id;

    try {
        const modalSubmit = await interaction.awaitModalSubmit({ filter, time: 300000 });
        await modalSubmit.deferReply({ ephemeral: true });

        const description = modalSubmit.fields.getTextInputValue('description');
        const evidence = modalSubmit.fields.getTextInputValue('evidence') || null;
        const lossAmount = modalSubmit.fields.getTextInputValue('loss_amount') || null;

        const [result] = await pool.execute(
            `INSERT INTO scam_reports
            (guild_id, reporter_id, reported_user_id, reported_user_tag, report_type, scam_type, description, evidence_urls, loss_amount, status)
            VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, 'pending')`,
            [
                interaction.guild.id,
                interaction.user.id,
                reportedUser.id,
                reportedUser.tag,
                scamType,
                description,
                evidence,
                lossAmount
            ]
        );

        const reportId = result.insertId;

        // Also create a global ban report for super-admin review
        try {
            const globalBanManager = interaction.client.globalBanManager;
            if (globalBanManager) {
                const scamToGBCategory = {
                    fake_seeds: 'scam', payment_scam: 'scam', bad_vendor: 'scam', trade_scam: 'scam',
                    impersonation: 'impersonation', phishing: 'phishing', other: 'other'
                };
                const gbCategory = scamToGBCategory[scamType] || 'other';
                const gbEvidence = evidence ? evidence.split('\n').filter(e => e.trim()) : [];
                await globalBanManager.reportUser(
                    interaction.user.id,
                    interaction.guild.id,
                    reportedUser.id,
                    gbCategory,
                    'medium',
                    gbEvidence,
                    description || `Scam report: ${scamTypeNames[scamType]}`
                );
            }
        } catch (gbError) {
            logger.warn('[Report] Failed to create global ban report (best-effort)', { error: gbError.message, reportedUserId: reportedUser.id });
        }

        const confirmEmbed = new EmbedBuilder()
            .setColor('#FF6B6B')
            .setTitle(`Report #${reportId} Submitted`)
            .setDescription('Thank you for helping keep our community safe!')
            .addFields(
                { name: 'Reported User', value: `${reportedUser.tag} (${reportedUser.id})`, inline: true },
                { name: 'Type', value: scamTypeNames[scamType], inline: true },
                { name: 'Status', value: 'Pending Review', inline: true }
            )
            .setFooter({ text: 'Staff will review this report shortly' })
            .setTimestamp();

        await modalSubmit.editReply({ embeds: [confirmEmbed] });

        await alertStaff(interaction.guild, reportId, interaction.user, reportedUser, scamType, description, evidence, lossAmount);

        const [previousReports] = await pool.execute(
            'SELECT COUNT(*) as count FROM scam_reports WHERE reported_user_id = ? AND guild_id = ? AND status != "dismissed"',
            [reportedUser.id, interaction.guild.id]
        );

        if (previousReports[0].count > 1) {
            await modalSubmit.followUp({
                content: `This user has been reported ${previousReports[0].count} time(s) previously. Staff have been notified.`,
                ephemeral: true
            });
        }

        logger.info('[Report] Scam report submitted', {
            reportId,
            reporterId: interaction.user.id,
            reportedUserId: reportedUser.id,
            scamType,
            guildId: interaction.guild.id
        });

    } catch (modalError) {
        if (modalError.code === 'InteractionCollectorError') {
            logger.warn('[Report] Modal submission timeout', { userId: interaction.user.id });
        } else {
            throw modalError;
        }
    }
}

export async function handleVendorReport(interaction) {
    const vendorName = interaction.options.getString('name');
    const website = interaction.options.getString('website') || null;

    const modal = new ModalBuilder()
        .setCustomId(`vendor_report_modal_${Date.now()}`)
        .setTitle('Vendor Report Details');

    const descriptionInput = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Describe the issue with this vendor')
        .setPlaceholder('What happened? Bad genetics, never shipped, fake products?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(2000);

    const evidenceInput = new TextInputBuilder()
        .setCustomId('evidence')
        .setLabel('Evidence Links (Optional)')
        .setPlaceholder('Links to screenshots, reviews, forum posts, etc.')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000);

    modal.addComponents(
        new ActionRowBuilder().addComponents(descriptionInput),
        new ActionRowBuilder().addComponents(evidenceInput)
    );

    await interaction.showModal(modal);

    const filter = (i) => i.customId.startsWith('vendor_report_modal_') && i.user.id === interaction.user.id;

    try {
        const modalSubmit = await interaction.awaitModalSubmit({ filter, time: 300000 });
        await modalSubmit.deferReply({ ephemeral: true });

        const description = modalSubmit.fields.getTextInputValue('description');
        const evidence = modalSubmit.fields.getTextInputValue('evidence') || null;

        const [result] = await pool.execute(
            `INSERT INTO scam_reports
            (guild_id, reporter_id, reported_vendor_name, reported_vendor_website, report_type, scam_type, description, evidence_urls, status)
            VALUES (?, ?, ?, ?, 'vendor', 'bad_vendor', ?, ?, 'pending')`,
            [
                interaction.guild.id,
                interaction.user.id,
                vendorName,
                website,
                description,
                evidence
            ]
        );

        const reportId = result.insertId;

        const confirmEmbed = new EmbedBuilder()
            .setColor('#FF6B6B')
            .setTitle(`Vendor Report #${reportId} Submitted`)
            .setDescription('Thank you for warning others about this vendor!')
            .addFields(
                { name: 'Vendor Name', value: vendorName, inline: true },
                { name: 'Website', value: website || 'Not provided', inline: true },
                { name: 'Status', value: 'Pending Review', inline: true }
            )
            .setFooter({ text: 'Staff will review and may add to watchlist' })
            .setTimestamp();

        await modalSubmit.editReply({ embeds: [confirmEmbed] });

        await alertStaffVendor(interaction.guild, reportId, interaction.user, vendorName, website, description, evidence);

        logger.info('[Report] Vendor report submitted', {
            reportId,
            reporterId: interaction.user.id,
            vendorName,
            guildId: interaction.guild.id
        });

    } catch (modalError) {
        if (modalError.code === 'InteractionCollectorError') {
            logger.warn('[Report] Vendor modal timeout', { userId: interaction.user.id });
        } else {
            throw modalError;
        }
    }
}

export async function handleListReports(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({
            content: 'This command is only available to staff members.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const [watchlist] = await pool.execute(
        `SELECT * FROM scammer_watchlist WHERE guild_id = ? ORDER BY created_at DESC LIMIT 25`,
        [interaction.guild.id]
    );

    if (watchlist.length === 0) {
        return interaction.editReply({
            content: 'No entries in the scammer watchlist yet.',
            ephemeral: true
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('Scammer Watchlist')
        .setDescription('Known scammers and bad vendors in this community')
        .setTimestamp();

    let userList = '';
    let vendorList = '';

    for (const entry of watchlist) {
        if (entry.entry_type === 'user') {
            userList += `**${entry.name}** (${entry.discord_id || 'Unknown ID'})\n${entry.reason}\n\n`;
        } else {
            vendorList += `**${entry.name}**${entry.website ? ` - ${entry.website}` : ''}\n${entry.reason}\n\n`;
        }
    }

    if (userList) {
        embed.addFields({ name: 'Known Scammer Users', value: userList.substring(0, 1024) || 'None', inline: false });
    }
    if (vendorList) {
        embed.addFields({ name: 'Bad Vendors/Seed Banks', value: vendorList.substring(0, 1024) || 'None', inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
}

export async function handleCheck(interaction) {
    const user = interaction.options.getUser('user');
    const vendorName = interaction.options.getString('vendor');

    if (!user && !vendorName) {
        return interaction.reply({
            content: 'Please provide either a user or vendor name to check.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const embeds = [];

    if (user) {
        const [userEntry] = await pool.execute(
            `SELECT * FROM scammer_watchlist WHERE discord_id = ? AND entry_type = 'user'`,
            [user.id]
        );

        const [reports] = await pool.execute(
            `SELECT COUNT(*) as count, MAX(status) as latest_status FROM scam_reports
            WHERE reported_user_id = ? AND status != 'dismissed'`,
            [user.id]
        );

        if (userEntry.length > 0) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('KNOWN SCAMMER')
                .setDescription(`${user.tag} is on the scammer watchlist!`)
                .addFields(
                    { name: 'Reason', value: userEntry[0].reason, inline: false },
                    { name: 'Added', value: `<t:${Math.floor(new Date(userEntry[0].created_at).getTime() / 1000)}:R>`, inline: true }
                )
                .setThumbnail(user.displayAvatarURL())
                .setTimestamp();
            embeds.push(embed);
        } else if (reports[0].count > 0) {
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('User Has Reports')
                .setDescription(`${user.tag} has ${reports[0].count} report(s) filed against them.`)
                .setThumbnail(user.displayAvatarURL())
                .setTimestamp();
            embeds.push(embed);
        } else {
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('User Clear')
                .setDescription(`${user.tag} has no reports or watchlist entries.`)
                .setThumbnail(user.displayAvatarURL())
                .setTimestamp();
            embeds.push(embed);
        }
    }

    if (vendorName) {
        const [vendorEntry] = await pool.execute(
            `SELECT * FROM scammer_watchlist WHERE LOWER(name) LIKE LOWER(?) AND entry_type = 'vendor'`,
            [`%${vendorName}%`]
        );

        const [reports] = await pool.execute(
            `SELECT COUNT(*) as count FROM scam_reports
            WHERE LOWER(reported_vendor_name) LIKE LOWER(?) AND status != 'dismissed'`,
            [`%${vendorName}%`]
        );

        if (vendorEntry.length > 0) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('KNOWN BAD VENDOR')
                .setDescription(`"${vendorEntry[0].name}" is on the vendor watchlist!`)
                .addFields(
                    { name: 'Reason', value: vendorEntry[0].reason, inline: false },
                    { name: 'Website', value: vendorEntry[0].website || 'Unknown', inline: true },
                    { name: 'Added', value: `<t:${Math.floor(new Date(vendorEntry[0].created_at).getTime() / 1000)}:R>`, inline: true }
                )
                .setTimestamp();
            embeds.push(embed);
        } else if (reports[0].count > 0) {
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('Vendor Has Reports')
                .setDescription(`Vendors matching "${vendorName}" have ${reports[0].count} report(s).`)
                .setTimestamp();
            embeds.push(embed);
        } else {
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('Vendor Clear')
                .setDescription(`No reports or watchlist entries found for "${vendorName}".`)
                .setFooter({ text: 'This does not guarantee the vendor is trustworthy - always do your research!' })
                .setTimestamp();
            embeds.push(embed);
        }
    }

    await interaction.editReply({ embeds });
}

export async function handleReview(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({
            content: 'This command is only available to staff members.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const [pendingReports] = await pool.execute(
        `SELECT * FROM scam_reports WHERE guild_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 10`,
        [interaction.guild.id]
    );

    if (pendingReports.length === 0) {
        return interaction.editReply({
            content: 'No pending reports to review!',
            ephemeral: true
        });
    }

    await showReportForReview(interaction, pendingReports[0], pendingReports.length);
}

export async function handleBugReport(interaction) {
    const modal = new ModalBuilder()
        .setCustomId('bug_report_modal')
        .setTitle('Bug Report');

    const titleInput = new TextInputBuilder()
        .setCustomId('bug_title')
        .setLabel('Bug Title')
        .setPlaceholder('Brief summary of the bug')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

    const descriptionInput = new TextInputBuilder()
        .setCustomId('bug_description')
        .setLabel('What happened?')
        .setPlaceholder('Describe what you were trying to do and what went wrong')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

    const stepsInput = new TextInputBuilder()
        .setCustomId('steps_to_reproduce')
        .setLabel('Steps to Reproduce (Optional)')
        .setPlaceholder('1. Do this\n2. Then do that\n3. Bug occurs')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000);

    modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(descriptionInput),
        new ActionRowBuilder().addComponents(stepsInput)
    );

    await interaction.showModal(modal);

    const filter = (i) => i.customId === 'bug_report_modal' && i.user.id === interaction.user.id;

    try {
        const modalSubmit = await interaction.awaitModalSubmit({ filter, time: 300000 });
        await modalSubmit.deferReply({ ephemeral: true });

        const title = modalSubmit.fields.getTextInputValue('bug_title');
        const description = modalSubmit.fields.getTextInputValue('bug_description');
        const steps = modalSubmit.fields.getTextInputValue('steps_to_reproduce') || null;

        const [result] = await pool.execute(
            `INSERT INTO bug_reports (user_id, guild_id, username, title, trying_to_do, what_happened, steps_to_reproduce, status, priority)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'medium')`,
            [
                interaction.user.id,
                interaction.guild?.id || 'DM',
                interaction.user.tag,
                title,
                description,
                description,
                steps
            ]
        );

        const bugId = result.insertId;

        // Post to bug reports forum if configured
        if (interaction.guild) {
            try {
                const [sugConfig] = await pool.execute(
                    'SELECT bug_report_channel_id FROM suggestion_config WHERE guild_id = ?',
                    [interaction.guild.id]
                );
                const bugChannelId = sugConfig[0]?.bug_report_channel_id;
                if (bugChannelId) {
                    const bugChannel = await interaction.guild.channels.fetch(bugChannelId).catch(() => null);
                    if (bugChannel) {
                        const bugEmbed = new EmbedBuilder()
                            .setColor('#E74C3C')
                            .setTitle(`Bug #${bugId}: ${title}`)
                            .setDescription(description)
                            .addFields(
                                { name: 'Reported By', value: `${interaction.user}`, inline: true },
                                { name: 'Status', value: 'Open', inline: true },
                                { name: 'Priority', value: 'Medium', inline: true }
                            )
                            .setFooter({ text: `Bug Report ID: ${bugId}` })
                            .setTimestamp();

                        if (steps) {
                            bugEmbed.addFields({ name: 'Steps to Reproduce', value: steps, inline: false });
                        }

                        if (bugChannel.type === ChannelType.GuildForum) {
                            const openTag = bugChannel.availableTags?.find(t => t.name === 'Open');
                            const mediumTag = bugChannel.availableTags?.find(t => t.name === 'Medium Priority');
                            const tags = [openTag?.id, mediumTag?.id].filter(Boolean);
                            const thread = await bugChannel.threads.create({
                                name: `Bug #${bugId}: ${title.substring(0, 90)}`,
                                message: { embeds: [bugEmbed] },
                                appliedTags: tags
                            });
                            await pool.execute(
                                'UPDATE bug_reports SET screenshot_urls = ? WHERE id = ?',
                                [JSON.stringify({ thread_id: thread.id, channel_id: bugChannelId }), bugId]
                            );
                        } else {
                            await bugChannel.send({ embeds: [bugEmbed] });
                        }
                    }
                }
            } catch (forumErr) {
                logger.error('[Report] Failed to post bug to forum:', { error: forumErr.message });
            }
        }

        const confirmEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle(`Bug Report #${bugId} Submitted`)
            .setDescription('Thank you for reporting this bug!')
            .addFields(
                { name: 'Title', value: title, inline: false },
                { name: 'Status', value: 'Open', inline: true }
            )
            .setTimestamp();

        await modalSubmit.editReply({ embeds: [confirmEmbed] });

        logger.info('[Report] Bug report submitted', {
            bugId,
            userId: interaction.user.id
        });

    } catch (modalError) {
        if (modalError.code !== 'InteractionCollectorError') {
            throw modalError;
        }
    }
}
