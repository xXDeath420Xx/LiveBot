/*
 * /native-poll — create a Discord-native poll (as distinct from CertiFried's
 * own `/polls` system, which stores votes locally for mod review).
 *
 * Discord's native polls carry up to 10 answers, run for 1–168 hours, and
 * accept single or multi-select voting. Results are tallied by Discord
 * server-side and shown live inside the client; the bot has no state to
 * maintain after posting. End-of-poll ingest already lives in
 * `events/messagePollVoteAdd.js` style handlers if we want to analyse results
 * downstream (not required for the poll to function).
 */
import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    PollLayoutType,
} from 'discord.js';
import logger from '../../utils/logger.js';

export default {
    category: 'discord',
    data: new SlashCommandBuilder()
        .setName('native-poll')
        .setDescription('Create a Discord-native poll in this channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addStringOption(o => o.setName('question').setDescription('The poll question (max 300 chars)').setRequired(true).setMaxLength(300))
        .addStringOption(o => o.setName('option1').setDescription('Answer 1 (max 55 chars)').setRequired(true).setMaxLength(55))
        .addStringOption(o => o.setName('option2').setDescription('Answer 2 (max 55 chars)').setRequired(true).setMaxLength(55))
        .addStringOption(o => o.setName('option3').setDescription('Answer 3').setMaxLength(55))
        .addStringOption(o => o.setName('option4').setDescription('Answer 4').setMaxLength(55))
        .addStringOption(o => o.setName('option5').setDescription('Answer 5').setMaxLength(55))
        .addStringOption(o => o.setName('option6').setDescription('Answer 6').setMaxLength(55))
        .addStringOption(o => o.setName('option7').setDescription('Answer 7').setMaxLength(55))
        .addStringOption(o => o.setName('option8').setDescription('Answer 8').setMaxLength(55))
        .addStringOption(o => o.setName('option9').setDescription('Answer 9').setMaxLength(55))
        .addStringOption(o => o.setName('option10').setDescription('Answer 10').setMaxLength(55))
        .addIntegerOption(o => o.setName('hours').setDescription('How long the poll runs (1-168, default 24)').setMinValue(1).setMaxValue(168))
        .addBooleanOption(o => o.setName('multi_select').setDescription('Let voters pick more than one answer'))
        .addChannelOption(o => o.setName('channel').setDescription('Post the poll in a different channel')),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: 'Polls can only be created in a server channel.', flags: MessageFlags.Ephemeral });
        }

        const question = interaction.options.getString('question', true);
        const answers = [];
        for (let i = 1; i <= 10; i++) {
            const a = interaction.options.getString('option' + i);
            if (a && a.trim()) answers.push({ text: a.trim().slice(0, 55) });
        }
        if (answers.length < 2) {
            return interaction.reply({ content: 'A poll needs at least two answers.', flags: MessageFlags.Ephemeral });
        }

        const duration = interaction.options.getInteger('hours') ?? 24;
        const allowMultiselect = interaction.options.getBoolean('multi_select') ?? false;
        const target = interaction.options.getChannel('channel') ?? interaction.channel;

        if (!target?.isTextBased?.()) {
            return interaction.reply({ content: 'That channel can\'t receive polls.', flags: MessageFlags.Ephemeral });
        }

        // Permission preflight — the bot needs Send Messages in the target channel.
        const me = interaction.guild.members.me;
        const perms = target.permissionsFor?.(me);
        if (!perms?.has(PermissionFlagsBits.SendMessages)) {
            return interaction.reply({ content: `I can't post in ${target}. Check my channel permissions.`, flags: MessageFlags.Ephemeral });
        }

        try {
            const sent = await target.send({
                poll: {
                    question: { text: question.slice(0, 300) },
                    answers,
                    allowMultiselect,
                    duration,
                    layoutType: PollLayoutType.Default,
                },
            });
            logger.info('[native-poll] created', {
                guildId: interaction.guild.id, channelId: target.id, messageId: sent.id, by: interaction.user.id, answers: answers.length, hours: duration,
            });
            return interaction.reply({
                content: `Poll posted in ${target}. [Jump to it](https://discord.com/channels/${interaction.guild.id}/${target.id}/${sent.id})`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            logger.error('[native-poll] send failed', { err: err.message, guildId: interaction.guild.id });
            return interaction.reply({
                content: `I couldn't post that poll: ${err.message}`,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
