const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { db } = require('../utils/db');
const { logger } = require('../utils/logger');

module.exports = {
    category: 'Automation',
    data: new SlashCommandBuilder()
        .setName('autoresponder')
        .setDescription('Create automatic responses to keywords and triggers')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('create')
                .setDescription('Create a new auto-responder')
                .addStringOption(option =>
                    option.setName('trigger')
                        .setDescription('The word/phrase to trigger on')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('response')
                        .setDescription('The response to send')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('match_type')
                        .setDescription('How to match the trigger (default: contains)')
                        .addChoices(
                            { name: 'Contains - Anywhere in message', value: 'contains' },
                            { name: 'Exact Match - Full message must match', value: 'exact' },
                            { name: 'Starts With - Message starts with trigger', value: 'starts_with' },
                            { name: 'Ends With - Message ends with trigger', value: 'ends_with' },
                            { name: 'Wildcard - Use * as wildcard', value: 'wildcard' }
                        ))
                .addBooleanOption(option =>
                    option.setName('case_sensitive')
                        .setDescription('Case sensitive matching (default: false)'))
                .addBooleanOption(option =>
                    option.setName('delete_trigger')
                        .setDescription('Delete the trigger message (default: false)')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all auto-responders'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Delete an auto-responder')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('The ID of the auto-responder to delete')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('toggle')
                .setDescription('Enable or disable an auto-responder')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('The ID of the auto-responder')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('edit')
                .setDescription('Edit an auto-responder')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('The ID to edit')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('field')
                        .setDescription('Field to edit')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Trigger Text', value: 'trigger' },
                            { name: 'Response Text', value: 'response' },
                            { name: 'Match Type', value: 'match_type' },
                            { name: 'Cooldown (seconds)', value: 'cooldown' }
                        ))
                .addStringOption(option =>
                    option.setName('value')
                        .setDescription('New value')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('restrict')
                .setDescription('Restrict auto-responder to specific channels/roles')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('The ID to restrict')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('type')
                        .setDescription('Restriction type')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Allow Channels', value: 'allow_channels' },
                            { name: 'Block Channels', value: 'block_channels' },
                            { name: 'Allow Roles', value: 'allow_roles' },
                            { name: 'Block Roles', value: 'block_roles' }
                        ))
                .addStringOption(option =>
                    option.setName('ids')
                        .setDescription('Comma-separated IDs (or "clear" to remove restrictions)')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('stats')
                .setDescription('View auto-responder statistics')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('Specific auto-responder ID (optional)'))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (subcommand) {
                case 'create':
                    await handleCreate(interaction);
                    break;
                case 'list':
                    await handleList(interaction);
                    break;
                case 'delete':
                    await handleDelete(interaction);
                    break;
                case 'toggle':
                    await handleToggle(interaction);
                    break;
                case 'edit':
                    await handleEdit(interaction);
                    break;
                case 'restrict':
                    await handleRestrict(interaction);
                    break;
                case 'stats':
                    await handleStats(interaction);
                    break;
                default:
                    await interaction.reply({ content: 'Unknown subcommand', ephemeral: true });
            }
        } catch (error) {
            logger.error(`[AutoResponder] Error in subcommand ${subcommand}:`, error);
            const errorMsg = { content: `An error occurred: ${error.message}`, ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(errorMsg);
            } else {
                await interaction.reply(errorMsg);
            }
        }
    },
};

async function handleCreate(interaction) {
    const trigger = interaction.options.getString('trigger');
    const response = interaction.options.getString('response');
    const matchType = interaction.options.getString('match_type') || 'contains';
    const caseSensitive = interaction.options.getBoolean('case_sensitive') || false;
    const deleteTrigger = interaction.options.getBoolean('delete_trigger') || false;

    if (trigger.length > 500) {
        return interaction.reply({ content: '❌ Trigger text is too long (max 500 characters)', ephemeral: true });
    }

    if (response.length > 2000) {
        return interaction.reply({ content: '❌ Response text is too long (max 2000 characters)', ephemeral: true });
    }

    // Check limit (max 50 autoresponders per guild)
    const [existing] = await db.execute(
        'SELECT COUNT(*) as count FROM autoresponders WHERE guild_id = ?',
        [interaction.guild.id]
    );

    if (existing[0].count >= 50) {
        return interaction.reply({ content: '❌ Maximum of 50 auto-responders per server reached!', ephemeral: true });
    }

    const [result] = await db.execute(
        `INSERT INTO autoresponders
        (guild_id, trigger_text, response_text, match_type, case_sensitive, delete_trigger, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [interaction.guild.id, trigger, response, matchType, caseSensitive, deleteTrigger, interaction.user.id]
    );

    const embed = new EmbedBuilder()
        .setTitle('✅ Auto-Responder Created')
        .setColor('#57F287')
        .addFields(
            { name: 'ID', value: `${result.insertId}`, inline: true },
            { name: 'Trigger', value: `\`${trigger}\``, inline: true },
            { name: 'Match Type', value: matchType, inline: true },
            { name: 'Response', value: response.length > 100 ? response.substring(0, 100) + '...' : response },
            { name: 'Options', value: `Case Sensitive: ${caseSensitive}\nDelete Trigger: ${deleteTrigger}` }
        )
        .setFooter({ text: `Use /autoresponder edit ${result.insertId} to modify settings` });

    await interaction.reply({ embeds: [embed] });
}

async function handleList(interaction) {
    const [responders] = await db.execute(
        'SELECT * FROM autoresponders WHERE guild_id = ? ORDER BY id ASC',
        [interaction.guild.id]
    );

    if (responders.length === 0) {
        return interaction.reply({ content: '📝 No auto-responders configured. Create one with `/autoresponder create`', ephemeral: true });
    }

    const pages = [];
    const perPage = 10;

    for (let i = 0; i < responders.length; i += perPage) {
        const chunk = responders.slice(i, i + perPage);

        const embed = new EmbedBuilder()
            .setTitle('🤖 Auto-Responders')
            .setColor('#5865F2')
            .setDescription(chunk.map(r => {
                const status = r.enabled ? '✅' : '❌';
                const trigger = r.trigger_text.length > 30 ? r.trigger_text.substring(0, 30) + '...' : r.trigger_text;
                return `${status} **ID ${r.id}** - \`${trigger}\` (${r.match_type}) | Used: ${r.use_count}x`;
            }).join('\n'))
            .setFooter({ text: `Page ${pages.length + 1} | ${responders.length} total | Use /autoresponder edit [id] to modify` });

        pages.push(embed);
    }

    await interaction.reply({ embeds: [pages[0]] });
}

async function handleDelete(interaction) {
    const id = interaction.options.getInteger('id');

    const [result] = await db.execute(
        'DELETE FROM autoresponders WHERE id = ? AND guild_id = ?',
        [id, interaction.guild.id]
    );

    if (result.affectedRows === 0) {
        return interaction.reply({ content: '❌ Auto-responder not found or already deleted.', ephemeral: true });
    }

    await interaction.reply(`✅ Auto-responder **#${id}** has been deleted.`);
}

async function handleToggle(interaction) {
    const id = interaction.options.getInteger('id');

    const [responders] = await db.execute(
        'SELECT enabled FROM autoresponders WHERE id = ? AND guild_id = ?',
        [id, interaction.guild.id]
    );

    if (responders.length === 0) {
        return interaction.reply({ content: '❌ Auto-responder not found.', ephemeral: true });
    }

    const newState = !responders[0].enabled;

    await db.execute(
        'UPDATE autoresponders SET enabled = ? WHERE id = ?',
        [newState, id]
    );

    await interaction.reply(`${newState ? '✅' : '⏸️'} Auto-responder **#${id}** is now **${newState ? 'enabled' : 'disabled'}**.`);
}

async function handleEdit(interaction) {
    const id = interaction.options.getInteger('id');
    const field = interaction.options.getString('field');
    const value = interaction.options.getString('value');

    // Validate field and value
    const fieldMap = {
        'trigger': { column: 'trigger_text', validate: (v) => v.length <= 500 },
        'response': { column: 'response_text', validate: (v) => v.length <= 2000 },
        'match_type': { column: 'match_type', validate: (v) => ['exact', 'contains', 'starts_with', 'ends_with', 'wildcard', 'regex'].includes(v) },
        'cooldown': { column: 'cooldown_seconds', validate: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 0 && parseInt(v) <= 3600 }
    };

    if (!fieldMap[field]) {
        return interaction.reply({ content: '❌ Invalid field!', ephemeral: true });
    }

    const { column, validate } = fieldMap[field];

    if (!validate(value)) {
        return interaction.reply({ content: `❌ Invalid value for ${field}!`, ephemeral: true });
    }

    const finalValue = field === 'cooldown' ? parseInt(value) : value;

    const [result] = await db.execute(
        `UPDATE autoresponders SET ${column} = ? WHERE id = ? AND guild_id = ?`,
        [finalValue, id, interaction.guild.id]
    );

    if (result.affectedRows === 0) {
        return interaction.reply({ content: '❌ Auto-responder not found.', ephemeral: true });
    }

    await interaction.reply(`✅ Updated **${field}** for auto-responder **#${id}** to: \`${value}\``);
}

async function handleRestrict(interaction) {
    const id = interaction.options.getInteger('id');
    const type = interaction.options.getString('type');
    const idsInput = interaction.options.getString('ids');

    // Map type to column
    const columnMap = {
        'allow_channels': 'allowed_channels',
        'block_channels': 'blocked_channels',
        'allow_roles': 'allowed_roles',
        'block_roles': 'blocked_roles'
    };

    const column = columnMap[type];

    // Parse IDs
    let idsArray = null;
    if (idsInput.toLowerCase() !== 'clear') {
        idsArray = JSON.stringify(idsInput.split(',').map(id => id.trim()).filter(id => id.length > 0));
    }

    const [result] = await db.execute(
        `UPDATE autoresponders SET ${column} = ? WHERE id = ? AND guild_id = ?`,
        [idsArray, id, interaction.guild.id]
    );

    if (result.affectedRows === 0) {
        return interaction.reply({ content: '❌ Auto-responder not found.', ephemeral: true });
    }

    if (idsInput.toLowerCase() === 'clear') {
        await interaction.reply(`✅ Cleared **${type}** restrictions for auto-responder **#${id}**.`);
    } else {
        await interaction.reply(`✅ Updated **${type}** for auto-responder **#${id}**.`);
    }
}

async function handleStats(interaction) {
    const id = interaction.options.getInteger('id');

    if (id) {
        // Single autoresponder stats
        const [responders] = await db.execute(
            'SELECT * FROM autoresponders WHERE id = ? AND guild_id = ?',
            [id, interaction.guild.id]
        );

        if (responders.length === 0) {
            return interaction.reply({ content: '❌ Auto-responder not found.', ephemeral: true });
        }

        const r = responders[0];

        const embed = new EmbedBuilder()
            .setTitle(`📊 Auto-Responder #${r.id} Stats`)
            .setColor('#5865F2')
            .addFields(
                { name: 'Trigger', value: `\`${r.trigger_text}\``, inline: true },
                { name: 'Match Type', value: r.match_type, inline: true },
                { name: 'Status', value: r.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
                { name: 'Times Triggered', value: `${r.use_count}`, inline: true },
                { name: 'Last Triggered', value: r.last_triggered ? `<t:${Math.floor(new Date(r.last_triggered).getTime() / 1000)}:R>` : 'Never', inline: true },
                { name: 'Cooldown', value: r.cooldown_seconds > 0 ? `${r.cooldown_seconds}s` : 'None', inline: true },
                { name: 'Response', value: r.response_text.length > 200 ? r.response_text.substring(0, 200) + '...' : r.response_text }
            );

        await interaction.reply({ embeds: [embed] });
    } else {
        // Server-wide stats
        const [stats] = await db.execute(
            `SELECT
                COUNT(*) as total,
                SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_count,
                SUM(use_count) as total_triggers
            FROM autoresponders WHERE guild_id = ?`,
            [interaction.guild.id]
        );

        const [topUsed] = await db.execute(
            'SELECT id, trigger_text, use_count FROM autoresponders WHERE guild_id = ? ORDER BY use_count DESC LIMIT 5',
            [interaction.guild.id]
        );

        const embed = new EmbedBuilder()
            .setTitle('📊 Auto-Responder Statistics')
            .setColor('#5865F2')
            .addFields(
                { name: 'Total Auto-Responders', value: `${stats[0].total}`, inline: true },
                { name: 'Enabled', value: `${stats[0].enabled_count}`, inline: true },
                { name: 'Total Triggers', value: `${stats[0].total_triggers}`, inline: true }
            );

        if (topUsed.length > 0) {
            embed.addFields({
                name: 'Most Used',
                value: topUsed.map((r, i) => `${i + 1}. **#${r.id}** \`${r.trigger_text.substring(0, 30)}\` - ${r.use_count}x`).join('\n')
            });
        }

        await interaction.reply({ embeds: [embed] });
    }
}
