const { SlashCommandBuilder, PermissionsBitField, StringSelectMenuBuilder, ActionRowBuilder, MessageFlags } = require('discord.js');

// This map will temporarily store the initial command data
const pendingInteractions = new Map();

// Define a constant for the timeout duration for better readability
const INTERACTION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

module.exports = {
    data: new SlashCommandBuilder()
        .setName('addstreamer')
        .setDescription('Adds a streamer to the notification list using an interactive form.')
        .addStringOption(option => 
            option.setName('username')
                .setDescription("The streamer's username or channel ID. Must be the same on all chosen platforms.")
                .setRequired(true))
        .addUserOption(option => 
            option.setName('user')
                .setDescription('Optional: Link a Discord user to receive the Live Role.')
                .setRequired(false))
        .addAttachmentOption(option => 
            option.setName('avatar')
                .setDescription("Optional: A custom avatar for this streamer's webhook announcements.")
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    async execute(interaction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const username = interaction.options.getString('username');
        const discordUser = interaction.options.getUser('user');
        const avatar = interaction.options.getAttachment('avatar');
        
        let avatarUrl = null;
        if (avatar) {
             if (!avatar.contentType?.startsWith('image/')) {
                return interaction.editReply({ content: 'The provided avatar must be an image file (PNG, JPG, GIF).' });
            }
            const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
            if (!tempUploadChannelId) {
                return interaction.editReply({ content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file." });
            }
            try {
                const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                if (!tempChannel) { // Channel not found or bot doesn't have access
                    throw new Error("Temporary upload channel not found. Check TEMP_UPLOAD_CHANNEL_ID and bot's permissions.");
                }
                if (!tempChannel.isTextBased()) { // Added check for text-based channel
                    throw new Error("Temporary upload channel is not a text channel. Check TEMP_UPLOAD_CHANNEL_ID in your .env file.");
                }
                const tempMessage = await tempChannel.send({ files: [{ attachment: avatar.url, name: avatar.name }] });
                avatarUrl = tempMessage.attachments.first().url;
                // IMPORTANT: Do NOT delete this message if you need a permanent CDN URL for the attachment.
                // Ensure any follow-up process that uses this URL is aware of its dependency on this message's existence.
            } catch (uploadError) {
                console.error('[Add Streamer Command] Error uploading temporary avatar to Discord:', uploadError);
                return interaction.editReply({ content: `Failed to upload custom avatar: ${uploadError.message || 'An unknown error occurred'}. Please check bot's permissions or TEMP_UPLOAD_CHANNEL_ID.` });
            }
        }

        const interactionId = interaction.id;
        pendingInteractions.set(interactionId, {
            username,
            discordUserId: discordUser?.id || null,
            avatarUrl,
            guildId: interaction.guild.id
        });

        // Set a timeout to clear the pending interaction data.
        // The follow-up interaction handler (for the select menu with customId 'addstreamer_platforms_${interactionId}')
        // must check if this data has expired and inform the user if it has, as the select menu itself can remain active longer.
        setTimeout(() => pendingInteractions.delete(interactionId), INTERACTION_TIMEOUT_MS);

        const platformSelect = new StringSelectMenuBuilder()
            .setCustomId(`addstreamer_platforms_${interactionId}`)
            .setPlaceholder('Select the platform(s) to add this streamer on')
            .setMinValues(1)
            .setMaxValues(5)
            .addOptions([
                { label: 'Twitch', value: 'twitch', emoji: '🟣' },
                { label: 'Kick', value: 'kick', emoji: '🟢' },
                { label: 'YouTube', value: 'youtube', emoji: '🔴' },
                { label: 'TikTok', value: 'tiktok', emoji: '⚫' },
                { label: 'Trovo', value: 'trovo', emoji: '🟢' },
            ]);

        const row = new ActionRowBuilder().addComponents(platformSelect);

        await interaction.editReply({
            content: `Adding streamer \`${username}\`. Please select the platforms below to continue.`,
            components: [row]
        });
    }
    // Removed 'pendingInteractions' from module.exports to improve encapsulation.
    // If other modules need to access this data (e.g., the select menu handler),
    // consider creating a dedicated state management module or passing necessary data
    // through the interaction handlers' state if Discord.js allows, or ensure the
    // select menu handler can import and access this Map internally.
};