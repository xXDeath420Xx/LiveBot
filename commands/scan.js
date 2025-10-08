const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('scan')
        .setDescription('Scans the server for other bots and lists their registered slash commands.'),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        try {
            // Fetch all members in the guild to identify the bots
            const members = await interaction.guild.members.fetch();
            const bots = members.filter(member => member.user.bot);

            if (bots.size === 0) {
                return interaction.editReply('I couldn\'t find any other bots in this server.');
            }

            // Fetch all slash commands registered in the guild
            const allCommands = await interaction.guild.commands.fetch();

            // Optional Debugging Line (safe to keep or remove)
            logger.info(`[Scan Command] Fetched a total of ${allCommands.size} application commands from the guild "${interaction.guild.name}".`);

            const botData = [];
            let commandCount = 0;

            // Map commands to each bot
            for (const [botId, botMember] of bots) {
                const botCommands = allCommands.filter(cmd => cmd.applicationId === botId);

                if (botCommands.size > 0) {
                    commandCount += botCommands.size;
                    botData.push({
                        name: botMember.user.username,
                        id: botId,
                        commands: botCommands.map(cmd => ({
                            name: cmd.name,
                            description: cmd.description,
                            options: cmd.options.map(opt => ({
                                name: opt.name,
                                type: opt.type,
                                description: opt.description,
                            })),
                        })),
                    });
                }
            }

            if (commandCount === 0) {
                return interaction.editReply('Found some bots, but none of them seem to have any slash commands registered in this server.');
            }

            const embed = new EmbedBuilder()
                .setTitle(`🤖 Bot Scan Report`)
                .setDescription(`Found **${botData.length}** bots with a total of **${commandCount}** slash commands in this server.`)
                .setColor('#0099ff')
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

            const jsonData = JSON.stringify(botData, null, 2);
            const buffer = Buffer.from(jsonData, 'utf-8');

            await interaction.followUp({
                content: 'Here is the full structured report:',
                files: [{
                    attachment: buffer,
                    name: 'bot_scan_report.json',
                }],
                ephemeral: true,
            });

        } catch (error) {
            logger.error('[Scan Command Error]', error);
            await interaction.editReply({ content: 'An error occurred while scanning for bots.' });
        }
    },
};