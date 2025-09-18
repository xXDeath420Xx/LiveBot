import { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder, MessageFlags, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import db from '../utils/db';
import * as apiChecks from '../utils/api_checks';

// Define interfaces for data structures
interface TwitchTeamMember {
    user_id: string;
    user_login: string;
    // Add other properties if apiChecks.getTwitchTeamMembers returns more
}

interface StreamerDBEntry {
    streamer_id: number;
    platform: string;
    platform_user_id: string;
    username: string;
}

export default {
    data: new SlashCommandBuilder()
        .setName('addteam')
        .setDescription('Adds all members of a Twitch Team to the announcement list for a channel.')
        .addStringOption(option =>
            option.setName('team')
                .setDescription('The name of the Twitch Team (e.g., the "reeferrealm" in twitch.tv/team/reeferrealm).')
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('The channel where the team members will be announced.')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ ephemeral: true });

        const teamName = interaction.options.getString('team', true).toLowerCase();
        const channel = interaction.options.getChannel('channel', true) as TextChannel; // Cast to TextChannel as per addChannelTypes
        const guildId = interaction.guild!.id; // guild is guaranteed to exist in a guild command

        const added: string[] = [];
        const updated: string[] = [];
        const failed: string[] = [];

        try {
            // Step 1: Fetch the list of team members from the Twitch API
            const teamMembers: TwitchTeamMember[] | null = await apiChecks.getTwitchTeamMembers(teamName);

            if (!teamMembers) {
                return interaction.editReply({ content: `❌ Could not find a Twitch Team named \`${teamName}\`. Please check the name and try again.` });
            }
            
            if (teamMembers.length === 0) {
                return interaction.editReply({ content: `ℹ️ The Twitch Team \`${teamName}\` does not have any members.` });
            }

            // Step 2: Loop through each member and add them to the database
            for (const member of teamMembers) {
                try {
                    // Add or update the streamer in the main `streamers` table
                    await db.execute(
                        `INSERT INTO streamers (platform, platform_user_id, username) VALUES ('twitch', ?, ?)
                         ON DUPLICATE KEY UPDATE username = VALUES(username)`,
                        [member.user_id, member.user_login]
                    );

                    // Get the internal streamer_id for the subscription
                    const [[streamer]]: [[StreamerDBEntry], any] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', ['twitch', member.user_id]);

                    // Add or update the subscription for this specific guild and channel
                    const [subResult]: any = await db.execute(
                        `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE streamer_id = VALUES(streamer_id)`,
                        [guildId, streamer.streamer_id, channel.id]
                    );

                    // Check if it was a new addition or an update
                    if (subResult.affectedRows > 1) { // affectedRows > 1 typically means an update occurred
                        updated.push(member.user_login);
                    } else {
                        added.push(member.user_login);
                    }

                } catch (dbError: any) {
                    console.error(`Error processing team member ${member.user_login}:`, dbError);
                    failed.push(`${member.user_login} (DB Error)`);
                }
            }

            // Step 3: Send a summary report
            const embed = new EmbedBuilder()
                .setTitle(`Twitch Team Import Report for "${teamName}"`)
                .setDescription(`All members have been added/updated for announcements in ${channel}.`)
                .setColor('#5865F2')
                .addFields(
                    { name: `✅ Added (${added.length})`, value: added.length > 0 ? added.join(', ').substring(0, 1020) : 'None' },
                    { name: `🔄 Updated/Already Existed (${updated.length})`, value: updated.length > 0 ? updated.join(', ').substring(0, 1020) : 'None' },
                    { name: `❌ Failed (${failed.length})`, value: failed.length > 0 ? failed.join(', ') : 'None' }
                )
                .setTimestamp();
            
            await interaction.editReply({ embeds: [embed] });

        } catch (error: any) {
            console.error('AddTeam Command Error:', error);
            await interaction.editReply({ content: 'A critical error occurred while executing the command.' });
        }
    },
};