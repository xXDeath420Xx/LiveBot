import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('utilities')
        .setDescription('Administrative utilities and maintenance commands')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommandGroup(group =>
            group
                .setName('cleanup')
                .setDescription('Cleanup and maintenance utilities')
                .addSubcommand(sub =>
                    sub
                        .setName('stream-spam')
                        .setDescription('Remove duplicate stream notifications from a channel')
                        .addChannelOption(option =>
                            option.setName('channel')
                                .setDescription('The channel to clean up (defaults to current channel)')
                        )
                        .addIntegerOption(option =>
                            option.setName('limit')
                                .setDescription('Number of messages to check (default: 100)')
                                .setMinValue(10)
                                .setMaxValue(100)
                        )
                )
        )
        .addSubcommandGroup(group =>
            group
                .setName('bugs')
                .setDescription('Manage bug reports')
                .addSubcommand(sub =>
                    sub
                        .setName('list')
                        .setDescription('List bug reports')
                        .addStringOption(option =>
                            option.setName('status')
                                .setDescription('Filter by status')
                                .addChoices(
                                    { name: 'Open', value: 'open' },
                                    { name: 'Investigating', value: 'investigating' },
                                    { name: 'Fixed', value: 'fixed' },
                                    { name: 'Closed', value: 'closed' },
                                    { name: "Won't Fix", value: 'wont_fix' }
                                ))
                        .addStringOption(option =>
                            option.setName('priority')
                                .setDescription('Filter by priority')
                                .addChoices(
                                    { name: 'Low', value: 'low' },
                                    { name: 'Medium', value: 'medium' },
                                    { name: 'High', value: 'high' },
                                    { name: 'Critical', value: 'critical' }
                                ))
                        .addIntegerOption(option =>
                            option.setName('limit')
                                .setDescription('Number of results (default: 10)')
                                .setMinValue(1)
                                .setMaxValue(25))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('view')
                        .setDescription('View a specific bug report')
                        .addIntegerOption(option =>
                            option.setName('id').setDescription('Bug report ID').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('update-status')
                        .setDescription('Update bug status')
                        .addIntegerOption(option =>
                            option.setName('id').setDescription('Bug report ID').setRequired(true))
                        .addStringOption(option =>
                            option.setName('status')
                                .setDescription('New status')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Open', value: 'open' },
                                    { name: 'Investigating', value: 'investigating' },
                                    { name: 'Fixed', value: 'fixed' },
                                    { name: 'Closed', value: 'closed' },
                                    { name: "Won't Fix", value: 'wont_fix' }
                                ))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('update-priority')
                        .setDescription('Update bug priority')
                        .addIntegerOption(option =>
                            option.setName('id').setDescription('Bug report ID').setRequired(true))
                        .addStringOption(option =>
                            option.setName('priority')
                                .setDescription('New priority')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Low', value: 'low' },
                                    { name: 'Medium', value: 'medium' },
                                    { name: 'High', value: 'high' },
                                    { name: 'Critical', value: 'critical' }
                                ))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('add-note')
                        .setDescription('Add admin notes to a bug')
                        .addIntegerOption(option =>
                            option.setName('id').setDescription('Bug report ID').setRequired(true))
                        .addStringOption(option =>
                            option.setName('note')
                                .setDescription('Admin notes')
                                .setRequired(true)
                                .setMaxLength(1000))
                )
                .addSubcommand(sub =>
                    sub.setName('stats').setDescription('View bug report statistics')
                )
        )
        .addSubcommandGroup(group =>
            group
                .setName('bots')
                .setDescription('Manage custom bot instances')
                .addSubcommand(sub =>
                    sub.setName('reload').setDescription('Reload all custom bots from database')
                )
                .addSubcommand(sub =>
                    sub.setName('list').setDescription('List custom bots status')
                )
                .addSubcommand(sub =>
                    sub
                        .setName('reload-one')
                        .setDescription('Reload specific bot')
                        .addStringOption(option =>
                            option.setName('bot-id').setDescription('Bot ID to reload').setRequired(true))
                )
        ),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (group) {
                case 'cleanup':
                    return await this.handleCleanup(interaction, subcommand);
                case 'bugs':
                    return await this.handleBugs(interaction, subcommand);
                case 'bots':
                    return await this.handleBots(interaction, subcommand);
            }
        } catch (error) {
            logger.error('[Utilities Command Error]', error);
            const method = interaction.deferred ? 'editReply' : 'reply';
            return interaction[method]({
                content: '❌ An error occurred while processing your request.',
                ephemeral: true
            });
        }
    },

    // ==================== CLEANUP GROUP ====================
    async handleCleanup(interaction, subcommand) {
        if (subcommand === 'stream-spam') {
            await interaction.deferReply({ ephemeral: true });

            const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
            const limit = interaction.options.getInteger('limit') || 100;

            try {
                logger.info(`[Cleanup Spam] Starting cleanup in channel ${targetChannel.id}`);

                const messages = await targetChannel.messages.fetch({ limit });
                logger.info(`[Cleanup Spam] Fetched ${messages.size} messages`);

                const [dbAnnouncements] = await pool.execute(
                    'SELECT message_id FROM live_announcements WHERE channel_id = ?',
                    [targetChannel.id]
                );

                const validMessageIds = new Set(dbAnnouncements.map(a => a.message_id));
                logger.info(`[Cleanup Spam] Found ${validMessageIds.size} valid announcements in database`);

                const seenStreamers = new Map();
                let deletedCount = 0;
                const errors = [];

                for (const [messageId, message] of messages) {
                    if (!message.author.bot) continue;

                    const hasStreamEmbed = message.embeds.some(e =>
                        e.description?.toLowerCase().includes('is now live') ||
                        e.title?.toLowerCase().includes('is now live') ||
                        e.author?.name?.toLowerCase().includes('is now live')
                    );

                    if (!hasStreamEmbed) continue;

                    let streamerKey = null;
                    for (const embed of message.embeds) {
                        if (embed.url) {
                            streamerKey = embed.url;
                            break;
                        }
                        if (embed.author?.name) {
                            streamerKey = embed.author.name;
                        }
                    }

                    const isDuplicate = streamerKey && seenStreamers.has(streamerKey);
                    const notInDatabase = !validMessageIds.has(messageId);

                    if (isDuplicate || notInDatabase) {
                        logger.info(`[Cleanup Spam] Deleting message ${messageId} (duplicate: ${isDuplicate}, not in DB: ${notInDatabase})`);
                        try {
                            await message.delete();
                            deletedCount++;
                            await new Promise(resolve => setTimeout(resolve, 500));
                        } catch (error) {
                            errors.push(`Failed to delete message ${messageId}: ${error.message}`);
                            logger.error(`[Cleanup Spam] Failed to delete message ${messageId}:`, error);
                        }
                    } else if (streamerKey) {
                        seenStreamers.set(streamerKey, messageId);
                    }
                }

                let response = `✅ Cleanup complete!\n\n**Deleted:** ${deletedCount} spam messages\n**Valid announcements:** ${validMessageIds.size}`;

                if (errors.length > 0) {
                    response += `\n\n**Errors:** ${errors.length}\n${errors.slice(0, 3).join('\n')}`;
                    if (errors.length > 3) {
                        response += `\n...and ${errors.length - 3} more`;
                    }
                }

                await interaction.editReply(response);

            } catch (error) {
                logger.error('[Cleanup Spam] Error:', error);
                await interaction.editReply(`❌ Error during cleanup: ${error.message}`);
            }
        }
    },

    // ==================== BUGS GROUP ====================
    async handleBugs(interaction, subcommand) {
        try {
            switch (subcommand) {
                case 'list':
                    return await this.bugsList(interaction);
                case 'view':
                    return await this.bugsView(interaction);
                case 'update-status':
                    return await this.bugsUpdateStatus(interaction);
                case 'update-priority':
                    return await this.bugsUpdatePriority(interaction);
                case 'add-note':
                    return await this.bugsAddNote(interaction);
                case 'stats':
                    return await this.bugsStats(interaction);
            }
        } catch (error) {
            logger.error('[Bugs Error]', error);
            const method = interaction.replied || interaction.deferred ? 'editReply' : 'reply';
            return interaction[method]({
                content: 'An error occurred while processing your request.',
                ephemeral: true
            });
        }
    },

    async bugsList(interaction) {
        const status = interaction.options.getString('status');
        const priority = interaction.options.getString('priority');
        const limit = interaction.options.getInteger('limit') || 10;

        let query = 'SELECT * FROM bug_reports WHERE 1=1';
        const params = [];

        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }

        if (priority) {
            query += ' AND priority = ?';
            params.push(priority);
        }

        query += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const [bugs] = await pool.execute(query, params);

        if (bugs.length === 0) {
            await interaction.reply({ content: 'No bug reports found matching your criteria.', ephemeral: true });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#FF6B6B')
            .setTitle('Bug Reports')
            .setDescription(`Found ${bugs.length} bug report(s)`);

        for (const bug of bugs.slice(0, 10)) {
            const preview = bug.title.length > 50 ? bug.title.substring(0, 50) + '...' : bug.title;
            const statusEmoji = this.getStatusEmoji(bug.status);
            const priorityEmoji = this.getPriorityEmoji(bug.priority);

            embed.addFields({
                name: `#${bug.id} - ${preview}`,
                value: `${statusEmoji} ${bug.status} | ${priorityEmoji} ${bug.priority}\nReported by: ${bug.username} | ${new Date(bug.created_at).toLocaleDateString()}`,
                inline: false
            });
        }

        embed.setFooter({ text: 'Use /utilities bugs view <id> to see full details' });
        await interaction.reply({ embeds: [embed] });
    },

    async bugsView(interaction) {
        const bugId = interaction.options.getInteger('id', true);

        const [bugs] = await pool.execute('SELECT * FROM bug_reports WHERE id = ?', [bugId]);
        const bug = bugs[0];

        if (!bug) {
            await interaction.reply({ content: 'Bug report not found.', ephemeral: true });
            return;
        }

        const statusColor = this.getStatusColor(bug.status);
        const statusEmoji = this.getStatusEmoji(bug.status);
        const priorityEmoji = this.getPriorityEmoji(bug.priority);

        const embed = new EmbedBuilder()
            .setColor(statusColor)
            .setTitle(`${statusEmoji} Bug Report #${bugId}`)
            .setDescription(`**${bug.title}**`)
            .addFields(
                { name: 'Reported By', value: `${bug.username} (<@${bug.user_id}>)`, inline: true },
                { name: 'Server', value: bug.guild_id === 'DM' ? 'Direct Message' : `<@${bug.guild_id}>`, inline: true },
                { name: 'Date Reported', value: new Date(bug.created_at).toLocaleString(), inline: true },
                { name: 'Status', value: `${statusEmoji} ${bug.status}`, inline: true },
                { name: 'Priority', value: `${priorityEmoji} ${bug.priority}`, inline: true },
                { name: 'Last Updated', value: new Date(bug.updated_at).toLocaleString(), inline: true },
                { name: '📝 What were they trying to do?', value: bug.trying_to_do || 'N/A', inline: false },
                { name: '❌ What happened instead?', value: bug.what_happened || 'N/A', inline: false }
            );

        if (bug.steps_to_reproduce) {
            embed.addFields({ name: '🔄 Steps to Reproduce', value: bug.steps_to_reproduce, inline: false });
        }

        if (bug.admin_notes) {
            embed.addFields({ name: '📋 Admin Notes', value: bug.admin_notes, inline: false });
        }

        if (bug.screenshot_urls) {
            try {
                const screenshots = JSON.parse(bug.screenshot_urls);
                if (screenshots.length > 0) {
                    embed.addFields({
                        name: '📸 Screenshots',
                        value: screenshots.map((url, i) => `[Screenshot ${i + 1}](${url})`).join('\n'),
                        inline: false
                    });
                    embed.setImage(screenshots[0]);
                }
            } catch (e) {}
        }

        embed.setFooter({ text: `Bug ID: ${bugId}` });
        embed.setTimestamp(new Date(bug.created_at));

        await interaction.reply({ embeds: [embed] });
    },

    async bugsUpdateStatus(interaction) {
        const bugId = interaction.options.getInteger('id', true);
        const newStatus = interaction.options.getString('status', true);

        const [bugs] = await pool.execute('SELECT * FROM bug_reports WHERE id = ?', [bugId]);

        if (bugs.length === 0) {
            await interaction.reply({ content: 'Bug report not found.', ephemeral: true });
            return;
        }

        const oldStatus = bugs[0].status;

        await pool.execute('UPDATE bug_reports SET status = ? WHERE id = ?', [newStatus, bugId]);

        if (oldStatus === 'open' && newStatus !== 'open') {
            await pool.execute('UPDATE bug_stats SET open_reports = open_reports - 1 WHERE id = 1');
        } else if (oldStatus !== 'open' && newStatus === 'open') {
            await pool.execute('UPDATE bug_stats SET open_reports = open_reports + 1 WHERE id = 1');
        }

        if (oldStatus !== 'fixed' && newStatus === 'fixed') {
            await pool.execute('UPDATE bug_stats SET fixed_reports = fixed_reports + 1 WHERE id = 1');
        } else if (oldStatus === 'fixed' && newStatus !== 'fixed') {
            await pool.execute('UPDATE bug_stats SET fixed_reports = fixed_reports - 1 WHERE id = 1');
        }

        logger.info(`[Utilities Bugs] Bug #${bugId} status updated from ${oldStatus} to ${newStatus}`);

        await interaction.reply({ content: `✅ Bug #${bugId} status updated from **${oldStatus}** to **${newStatus}**`, ephemeral: true });
    },

    async bugsUpdatePriority(interaction) {
        const bugId = interaction.options.getInteger('id', true);
        const newPriority = interaction.options.getString('priority', true);

        const [bugs] = await pool.execute('SELECT * FROM bug_reports WHERE id = ?', [bugId]);

        if (bugs.length === 0) {
            await interaction.reply({ content: 'Bug report not found.', ephemeral: true });
            return;
        }

        const oldPriority = bugs[0].priority;

        await pool.execute('UPDATE bug_reports SET priority = ? WHERE id = ?', [newPriority, bugId]);

        logger.info(`[Utilities Bugs] Bug #${bugId} priority updated from ${oldPriority} to ${newPriority}`);

        await interaction.reply({ content: `✅ Bug #${bugId} priority updated from **${oldPriority}** to **${newPriority}**`, ephemeral: true });
    },

    async bugsAddNote(interaction) {
        const bugId = interaction.options.getInteger('id', true);
        const note = interaction.options.getString('note', true);

        const [bugs] = await pool.execute('SELECT admin_notes FROM bug_reports WHERE id = ?', [bugId]);

        if (bugs.length === 0) {
            await interaction.reply({ content: 'Bug report not found.', ephemeral: true });
            return;
        }

        const existingNotes = bugs[0].admin_notes || '';
        const timestamp = new Date().toLocaleString();
        const newNote = `[${timestamp}] ${interaction.user.tag}: ${note}`;
        const updatedNotes = existingNotes ? `${existingNotes}\n\n${newNote}` : newNote;

        await pool.execute('UPDATE bug_reports SET admin_notes = ? WHERE id = ?', [updatedNotes, bugId]);

        logger.info(`[Utilities Bugs] Admin note added to bug #${bugId}`);

        await interaction.reply({ content: `✅ Note added to bug #${bugId}`, ephemeral: true });
    },

    async bugsStats(interaction) {
        const [stats] = await pool.execute('SELECT * FROM bug_stats WHERE id = 1');
        const [allBugs] = await pool.execute('SELECT status, priority, COUNT(*) as count FROM bug_reports GROUP BY status, priority');

        const bugStats = stats[0] || { total_reports: 0, open_reports: 0, fixed_reports: 0 };

        const embed = new EmbedBuilder()
            .setColor('#4ECDC4')
            .setTitle('📊 Bug Report Statistics')
            .addFields(
                { name: 'Total Reports', value: `${bugStats.total_reports}`, inline: true },
                { name: 'Open Reports', value: `${bugStats.open_reports}`, inline: true },
                { name: 'Fixed Reports', value: `${bugStats.fixed_reports}`, inline: true }
            );

        const statusCounts = {};
        const priorityCounts = {};

        for (const bug of allBugs) {
            statusCounts[bug.status] = (statusCounts[bug.status] || 0) + bug.count;
            priorityCounts[bug.priority] = (priorityCounts[bug.priority] || 0) + bug.count;
        }

        if (Object.keys(statusCounts).length > 0) {
            const statusBreakdown = Object.entries(statusCounts)
                .map(([status, count]) => `${this.getStatusEmoji(status)} ${status}: ${count}`)
                .join('\n');
            embed.addFields({ name: 'By Status', value: statusBreakdown, inline: true });
        }

        if (Object.keys(priorityCounts).length > 0) {
            const priorityBreakdown = Object.entries(priorityCounts)
                .map(([priority, count]) => `${this.getPriorityEmoji(priority)} ${priority}: ${count}`)
                .join('\n');
            embed.addFields({ name: 'By Priority', value: priorityBreakdown, inline: true });
        }

        embed.setTimestamp();
        await interaction.reply({ embeds: [embed] });
    },

    // ==================== BOTS GROUP ====================
    async handleBots(interaction, subcommand) {
        await interaction.deferReply({ ephemeral: true });

        const botId = interaction.options.getString('bot-id');

        try {
            if (subcommand === 'list') {
                await this.botsList(interaction);
            } else if (subcommand === 'reload') {
                await this.botsReloadAll(interaction);
            } else if (subcommand === 'reload-one') {
                await this.botsReloadOne(interaction, botId);
            }
        } catch (error) {
            logger.error('[Utilities Bots] Error:', error);
            await interaction.editReply({ content: `❌ Error: ${error.message}`, ephemeral: true });
        }
    },

    async botsList(interaction) {
        if (!global.botManager) {
            return await interaction.editReply('❌ Bot manager not available!');
        }

        const [dbBots] = await pool.execute('SELECT bot_id, bot_name, enabled, approved FROM custom_bots ORDER BY bot_name');

        const loadedBots = Array.from(global.botManager.clients.entries())
            .filter(([id]) => id !== 'default')
            .map(([id, client]) => ({
                id,
                name: client.botName || client.user?.tag || 'Unknown',
                status: client.isReady() ? '🟢 Online' : '🔴 Offline',
                guilds: client.assignedGuilds?.length || 0
            }));

        const embed = new EmbedBuilder()
            .setTitle('🤖 Custom Bots Status')
            .setColor(0x5865F2)
            .setTimestamp();

        const dbList = dbBots.map(bot => {
            const loaded = loadedBots.find(l => l.id === bot.bot_id);
            const status = loaded ? loaded.status : '⚫ Not Loaded';
            const guilds = loaded ? ` (${loaded.guilds} guilds)` : '';
            const enabled = bot.enabled ? '✅' : '❌';
            const approved = bot.approved ? '✅' : '⚠️';
            return `${status} **${bot.bot_name}**\n└ ID: \`${bot.bot_id}\`\n└ Enabled: ${enabled} | Approved: ${approved}${guilds}`;
        }).join('\n\n');

        embed.setDescription(dbList || 'No custom bots found in database');
        embed.setFooter({ text: `${loadedBots.length}/${dbBots.filter(b => b.enabled).length} custom bots loaded` });

        await interaction.editReply({ embeds: [embed] });
    },

    async botsReloadAll(interaction) {
        if (!global.botManager) {
            return await interaction.editReply('❌ Bot manager not available!');
        }

        const statusEmbed = new EmbedBuilder()
            .setTitle('🔄 Reloading Custom Bots...')
            .setColor(0xFFA500)
            .setDescription('Loading custom bots from database...')
            .setTimestamp();

        await interaction.editReply({ embeds: [statusEmbed] });

        const currentBots = Array.from(global.botManager.clients.keys()).filter(id => id !== 'default');

        for (const botId of currentBots) {
            try {
                const client = global.botManager.clients.get(botId);
                if (client) {
                    logger.info(`[Utilities Bots] Destroying bot ${botId}...`);
                    await client.destroy();
                    global.botManager.clients.delete(botId);
                }
            } catch (error) {
                logger.error(`[Utilities Bots] Error destroying bot ${botId}:`, error);
            }
        }

        const [customBots] = await pool.execute('SELECT * FROM custom_bots WHERE enabled = 1');

        const results = { total: customBots.length, loaded: 0, failed: 0, errors: [] };

        for (const botConfig of customBots) {
            try {
                const [mappings] = await pool.execute('SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?', [botConfig.bot_id]);
                const guildIds = mappings.map(m => m.guild_id);

                if (guildIds.length === 0) {
                    logger.warn(`[Utilities Bots] Bot ${botConfig.bot_name} has no assigned guilds, skipping`);
                    continue;
                }

                const tokenObj = JSON.parse(botConfig.bot_token);

                await global.botManager.addCustomBot({
                    bot_id: botConfig.bot_id,
                    bot_name: botConfig.bot_name,
                    bot_token: tokenObj,
                    guild_ids: guildIds
                });

                results.loaded++;
                logger.info(`[Utilities Bots] Successfully loaded ${botConfig.bot_name}`);

            } catch (error) {
                results.failed++;
                results.errors.push(`${botConfig.bot_name}: ${error.message}`);
                logger.error(`[Utilities Bots] Failed to load ${botConfig.bot_name}:`, error);
            }
        }

        const resultEmbed = new EmbedBuilder()
            .setTitle('✅ Custom Bots Reload Complete')
            .setColor(results.failed === 0 ? 0x00FF00 : 0xFFA500)
            .addFields(
                { name: 'Total Bots', value: results.total.toString(), inline: true },
                { name: 'Loaded', value: results.loaded.toString(), inline: true },
                { name: 'Failed', value: results.failed.toString(), inline: true }
            )
            .setTimestamp();

        if (results.errors.length > 0) {
            resultEmbed.addFields({
                name: '❌ Errors',
                value: results.errors.slice(0, 5).join('\n') + (results.errors.length > 5 ? `\n...and ${results.errors.length - 5} more` : '')
            });
        }

        await interaction.editReply({ embeds: [resultEmbed] });
    },

    async botsReloadOne(interaction, botId) {
        if (!global.botManager) {
            return await interaction.editReply('❌ Bot manager not available!');
        }

        const [bots] = await pool.execute('SELECT * FROM custom_bots WHERE bot_id = ? AND enabled = 1', [botId]);

        if (bots.length === 0) {
            return await interaction.editReply(`❌ Bot with ID ${botId} not found or not enabled!`);
        }

        const botConfig = bots[0];

        const existingClient = global.botManager.clients.get(botId);
        if (existingClient) {
            await existingClient.destroy();
            global.botManager.clients.delete(botId);
            logger.info(`[Utilities Bots] Destroyed existing connection for ${botConfig.bot_name}`);
        }

        const [mappings] = await pool.execute('SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?', [botId]);
        const guildIds = mappings.map(m => m.guild_id);

        if (guildIds.length === 0) {
            return await interaction.editReply(`❌ Bot ${botConfig.bot_name} has no assigned guilds!`);
        }

        const tokenObj = JSON.parse(botConfig.bot_token);

        await global.botManager.addCustomBot({
            bot_id: botConfig.bot_id,
            bot_name: botConfig.bot_name,
            bot_token: tokenObj,
            guild_ids: guildIds
        });

        const embed = new EmbedBuilder()
            .setTitle('✅ Bot Reloaded Successfully')
            .setColor(0x00FF00)
            .setDescription(`**${botConfig.bot_name}** (${botId})`)
            .addFields(
                { name: 'Assigned Guilds', value: guildIds.length.toString(), inline: true },
                { name: 'Status', value: '🟢 Online', inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    },

    // Helper functions
    getStatusColor(status) {
        const colors = {
            open: '#FF6B6B',
            investigating: '#FFD93D',
            fixed: '#6BCF7F',
            closed: '#95A5A6',
            wont_fix: '#7F8C8D'
        };
        return colors[status] || '#95A5A6';
    },

    getStatusEmoji(status) {
        const emojis = {
            open: '🔴',
            investigating: '🟡',
            fixed: '✅',
            closed: '⚫',
            wont_fix: '🚫'
        };
        return emojis[status] || '❓';
    },

    getPriorityEmoji(priority) {
        const emojis = {
            low: '🟢',
            medium: '🟡',
            high: '🟠',
            critical: '🔴'
        };
        return emojis[priority] || '⚪';
    }
};
