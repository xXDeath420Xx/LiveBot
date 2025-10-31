"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const music_panel_1 = __importDefault(require("../core/music-panel"));
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
module.exports = {
    data: new discord_js_1.SlashCommandBuilder()
        .setName('musicpanel')
        .setDescription('Manages the music control panel.')
        .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand => subcommand
        .setName('create')
        .setDescription('Creates the music control panel in the current channel.'))
        .addSubcommand(subcommand => subcommand
        .setName('delete')
        .setDescription('Deletes the music control panel from the server.')),
    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        if (subcommand === 'create') {
            const channelId = interaction.channel.id;
            try {
                const [existingPanel] = await db_1.default.execute('SELECT * FROM music_panels WHERE guild_id = ?', [guildId]);
                if (existingPanel.length > 0) {
                    await interaction.reply({
                        content: 'A music panel already exists in this server. Please use `/musicpanel delete` first.',
                        ephemeral: true
                    });
                    return;
                }
                await interaction.deferReply({ ephemeral: true });
                const client = interaction.client;
                const queue = client.player.nodes.get(guildId);
                const panel = new music_panel_1.default(client, queue);
                const message = await panel.createPanel(interaction.channel);
                await db_1.default.execute('INSERT INTO music_panels (guild_id, channel_id, message_id) VALUES (?, ?, ?)', [guildId, channelId, message.id]);
                client.musicPanelManager.set(guildId, panel);
                await interaction.editReply({ content: 'Music panel created successfully!' });
            }
            catch (error) {
                logger_1.default.error('[Music Panel Create Error]', error);
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: 'An error occurred while creating the music panel.' });
                }
                else {
                    await interaction.reply({
                        content: 'An error occurred while creating the music panel.',
                        ephemeral: true
                    });
                }
            }
        }
        else if (subcommand === 'delete') {
            try {
                await interaction.deferReply({ ephemeral: true });
                const [existingPanel] = await db_1.default.execute('SELECT * FROM music_panels WHERE guild_id = ?', [guildId]);
                if (existingPanel.length === 0) {
                    await interaction.editReply({ content: 'No music panel found to delete.' });
                    return;
                }
                const panelConfig = existingPanel[0];
                try {
                    const channel = await interaction.client.channels.fetch(panelConfig.channel_id);
                    const message = await channel.messages.fetch(panelConfig.message_id);
                    await message.delete();
                }
                catch (e) {
                    logger_1.default.warn(`[Music Panel Delete] Could not delete panel message for guild ${guildId}: ${e.message}`);
                }
                await db_1.default.execute('DELETE FROM music_panels WHERE guild_id = ?', [guildId]);
                const client = interaction.client;
                client.musicPanelManager.delete(guildId);
                await interaction.editReply({ content: 'Music panel deleted successfully.' });
            }
            catch (error) {
                logger_1.default.error('[Music Panel Delete Error]', error);
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: 'An error occurred while deleting the music panel.' });
                }
                else {
                    await interaction.reply({
                        content: 'An error occurred while deleting the music panel.',
                        ephemeral: true
                    });
                }
            }
        }
    },
    category: 'music'
};
