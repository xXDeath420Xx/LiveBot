"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const dotenv_1 = __importDefault(require("dotenv"));
const user_streamer_linker_1 = require("../core/user-streamer-linker");
dotenv_1.default.config();
const data = new discord_js_1.SlashCommandBuilder()
    .setName('superadmin')
    .setDescription('Bot Owner Only Commands.')
    .setDefaultMemberPermissions(0)
    .addSubcommand(subcommand => subcommand
    .setName('global-reinit')
    .setDescription('Restarts the entire bot application (Bot Owner Only).'))
    .addSubcommand(subcommand => subcommand
    .setName('audit-users')
    .setDescription('Audit all Discord users across all guilds and link them to streamers.'))
    .addSubcommand(subcommand => subcommand
    .setName('search-streamer')
    .setDescription('Search for a specific streamer username across all guilds.')
    .addStringOption(option => option.setName('username')
    .setDescription('The streamer username to search for')
    .setRequired(true))
    .addStringOption(option => option.setName('platform')
    .setDescription('The platform (optional)')
    .setRequired(false)
    .addChoices({ name: 'Twitch', value: 'twitch' }, { name: 'Kick', value: 'kick' }, { name: 'YouTube', value: 'youtube' }, { name: 'TikTok', value: 'tiktok' }, { name: 'Trovo', value: 'trovo' }, { name: 'Facebook', value: 'facebook' }, { name: 'Instagram', value: 'instagram' })))
    .addSubcommand(subcommand => subcommand
    .setName('view-links')
    .setDescription('View all Discord-to-Streamer links.')
    .addUserOption(option => option.setName('user')
    .setDescription('The Discord user to check (optional)')
    .setRequired(false)));
async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'global-reinit') {
        const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
        if (!BOT_OWNER_ID || interaction.user.id !== BOT_OWNER_ID) {
            await interaction.reply({
                content: 'You do not have permission to use this command.',
                ephemeral: true
            });
            return;
        }
        const embed = new discord_js_1.EmbedBuilder()
            .setTitle('⚠️ Global Bot Reinitialization Confirmation')
            .setDescription('This action will restart the entire bot application, causing a brief downtime for all guilds.\n\n'
            + '**This will:**\n'
            + '- Restart the bot process (via PM2).\n'
            + '- Temporarily disconnect the bot from all Discord guilds.\n'
            + '- Clear any in-memory caches.\n\n'
            + 'This action cannot be undone once confirmed. Only proceed if you understand the implications.')
            .setColor(0xFFCC00)
            .setFooter({ text: 'Please confirm you want to proceed.' });
        const confirmButton = new discord_js_1.ButtonBuilder()
            .setCustomId('confirm_global_reinit')
            .setLabel('I understand, restart the bot globally')
            .setStyle(discord_js_1.ButtonStyle.Danger);
        const cancelButton = new discord_js_1.ButtonBuilder()
            .setCustomId('cancel_global_reinit')
            .setLabel('Cancel')
            .setStyle(discord_js_1.ButtonStyle.Secondary);
        const row = new discord_js_1.ActionRowBuilder()
            .addComponents(confirmButton, cancelButton);
        await interaction.reply({
            embeds: [embed],
            components: [row],
            ephemeral: true
        });
    }
    else if (subcommand === 'audit-users') {
        const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
        if (!BOT_OWNER_ID || interaction.user.id !== BOT_OWNER_ID) {
            await interaction.reply({
                content: 'You do not have permission to use this command.',
                ephemeral: true
            });
            return;
        }
        await interaction.deferReply({ ephemeral: true });
        const linker = new user_streamer_linker_1.UserStreamerLinker(interaction.client);
        const results = await linker.runFullAudit();
        const embed = new discord_js_1.EmbedBuilder()
            .setTitle('📊 User Audit Complete')
            .setColor(0x00FF00)
            .addFields({ name: 'Guilds Scanned', value: results.totalGuilds.toString(), inline: true }, { name: 'Members Scanned', value: results.totalMembers.toString(), inline: true }, { name: 'Streamers Checked', value: results.totalStreamers.toString(), inline: true }, { name: '✅ Exact Matches', value: results.exactMatches.length.toString(), inline: true }, { name: '🔍 Fuzzy Matches', value: results.fuzzyMatches.length.toString(), inline: true }, { name: '🔗 New Links Created', value: results.newLinks.toString(), inline: true }, { name: '♻️ Existing Links', value: results.existingLinks.toString(), inline: true }, { name: '❌ Errors', value: results.errors.length.toString(), inline: true })
            .setTimestamp();
        // Show some exact matches
        if (results.exactMatches.length > 0) {
            const matchList = results.exactMatches.slice(0, 10).map(m => `• ${m.discordUsername} → **${m.streamerUsername}** (${m.platform}) in ${m.guildName}`).join('\n');
            embed.addFields({ name: 'Sample Exact Matches', value: matchList || 'None' });
        }
        // Show some fuzzy matches
        if (results.fuzzyMatches.length > 0) {
            const fuzzyList = results.fuzzyMatches.slice(0, 5).map(m => `• ${m.discordUsername} ≈ **${m.streamerUsername}** (${m.platform})`).join('\n');
            embed.addFields({ name: 'Sample Fuzzy Matches (Not Auto-Linked)', value: fuzzyList || 'None' });
        }
        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'search-streamer') {
        const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
        if (!BOT_OWNER_ID || interaction.user.id !== BOT_OWNER_ID) {
            await interaction.reply({
                content: 'You do not have permission to use this command.',
                ephemeral: true
            });
            return;
        }
        const username = interaction.options.getString('username', true);
        const platform = interaction.options.getString('platform');
        await interaction.deferReply({ ephemeral: true });
        const linker = new user_streamer_linker_1.UserStreamerLinker(interaction.client);
        const matches = await linker.searchForStreamer(username, platform || undefined);
        const embed = new discord_js_1.EmbedBuilder()
            .setTitle(`🔍 Search Results for "${username}"`)
            .setColor(0x3498DB)
            .addFields({ name: 'Matches Found', value: matches.length.toString(), inline: true }, { name: 'Platform Filter', value: platform || 'All Platforms', inline: true })
            .setTimestamp();
        if (matches.length > 0) {
            const matchList = matches.map(m => `• **${m.discordUsername}** (${m.discordUserId})\n` +
                `  → ${m.streamerUsername} (${m.platform}) in ${m.guildName}`).join('\n\n');
            embed.setDescription(matchList);
        }
        else {
            embed.setDescription('No matches found. Either the streamer doesn\'t exist, or no Discord users match the username.');
        }
        await interaction.editReply({ embeds: [embed] });
    }
    else if (subcommand === 'view-links') {
        const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
        if (!BOT_OWNER_ID || interaction.user.id !== BOT_OWNER_ID) {
            await interaction.reply({
                content: 'You do not have permission to use this command.',
                ephemeral: true
            });
            return;
        }
        const user = interaction.options.getUser('user');
        await interaction.deferReply({ ephemeral: true });
        const linker = new user_streamer_linker_1.UserStreamerLinker(interaction.client);
        if (user) {
            // Show links for specific user
            const links = await linker.getLinkedStreamers(user.id);
            const embed = new discord_js_1.EmbedBuilder()
                .setTitle(`🔗 Streamer Links for ${user.username}`)
                .setColor(0x9B59B6)
                .setTimestamp();
            if (links.length > 0) {
                const linkList = links.map(l => `• **${l.streamer_username}** (${l.platform})\n` +
                    `  ${l.verified ? '✅ Verified' : '⏳ Pending'} - Linked ${new Date(l.linked_at).toLocaleDateString()}`).join('\n\n');
                embed.setDescription(linkList);
                embed.addFields({ name: 'Total Links', value: links.length.toString() });
            }
            else {
                embed.setDescription('No streamer links found for this user.');
            }
            await interaction.editReply({ embeds: [embed] });
        }
        else {
            // Show all links
            const [allLinks] = await require('../utils/db').default.query(`SELECT sdl.*, s.username as streamer_username, s.platform
                 FROM streamer_discord_links sdl
                 JOIN streamers s ON sdl.streamer_id = s.streamer_id
                 ORDER BY sdl.linked_at DESC
                 LIMIT 50`);
            const embed = new discord_js_1.EmbedBuilder()
                .setTitle('🔗 All Discord-Streamer Links')
                .setColor(0x9B59B6)
                .addFields({ name: 'Total Links', value: allLinks.length.toString() })
                .setTimestamp();
            if (allLinks.length > 0) {
                const linkList = allLinks.slice(0, 20).map((l) => `• <@${l.discord_user_id}> → **${l.streamer_username}** (${l.platform}) ${l.verified ? '✅' : '⏳'}`).join('\n');
                embed.setDescription(linkList);
            }
            else {
                embed.setDescription('No links found. Run `/superadmin audit-users` first.');
            }
            await interaction.editReply({ embeds: [embed] });
        }
    }
}
// Export using CommonJS pattern
module.exports = {
    data,
    execute,
    category: 'Super Admin'
};
