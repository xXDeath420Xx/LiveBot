/*
 * `/engage report-dm` — report a commission-spammer DM to CertiFried's network intel.
 *
 * Discord does not let bots see DMs between members. The only ToS-safe way to collect this evidence
 * is for the recipient to voluntarily share what they received, which is exactly what this command
 * is for. N reports from N distinct guilds within the configured window auto-promote the reported
 * user into the network blacklist (core/dm-spam-reports.js evaluateForBlacklist); the join-gate on
 * every CertiFried-covered guild reads that blacklist on every join (Wave 367).
 *
 * No ManageGuild gate: a spammer DMs ordinary members, not just staff, so ordinary members are the
 * only people who CAN report them. Per-user rate limiting lives on the DB uniqueness constraint
 * (reported_user_id, reporter_user_id, content_hash) — you can't flood with the same content twice.
 */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { createReport } from '../../core/dm-spam-reports.js';

const EPHEMERAL = { flags: 64 };

const data = new SlashCommandBuilder()
    .setName('report-dm')
    .setDescription('Report a user for sending commission-spam DMs to server members.')
    .setDMPermission(false)
    .addUserOption(opt =>
        opt.setName('user')
           .setDescription('The user who DM\'d you.')
           .setRequired(true))
    .addStringOption(opt =>
        opt.setName('content')
           .setDescription('Paste what they said (or a summary). Attach a screenshot in a follow-up if needed.')
           .setRequired(false)
           .setMaxLength(2000))
    .addStringOption(opt =>
        opt.setName('message-link')
           .setDescription('If they also posted it in a channel, link to that message.')
           .setRequired(false)
           .setMaxLength(300));

async function execute(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: 'Run this inside the server where you received the DM.', ...EPHEMERAL });
    }

    const reported = interaction.options.getUser('user');
    const content = interaction.options.getString('content') || '';
    const link = interaction.options.getString('message-link') || '';

    if (!content && !link) {
        return interaction.reply({
            content: 'Give me something to go on — either paste the DM content or supply a message link.',
            ...EPHEMERAL,
        });
    }

    const fullContent = [content, link ? `\n\nLinked message: ${link}` : ''].join('').trim();

    const res = await createReport({
        reporter: interaction.user,
        reported,
        guildId: interaction.guild.id,
        content: fullContent,
        attachments: null,
        client: interaction.client,
    });

    if (!res.ok) {
        const msg = {
            self_report: 'You can\'t report yourself.',
            bot_target: 'That account is a bot — bots can\'t DM users unprompted the way commission spammers do.',
            missing_fields: 'Missing information in the report.',
            db_error: 'Something went wrong recording the report. Please tell staff.',
        }[res.reason] || 'Could not file the report.';
        return interaction.reply({ content: msg, ...EPHEMERAL });
    }

    const embed = new EmbedBuilder()
        .setTitle('Report filed')
        .setDescription([
            `Report #${res.reportId} filed against <@${reported.id}>.`,
            '',
            res.blacklist?.tripped
                ? `**Threshold tripped.** This user is now on the network blacklist (${res.blacklist.distinctGuilds} guild(s), ${res.blacklist.reportIds?.length || 0} report(s)). Any CertiFried-covered server with network intel enabled will act on them automatically on next join.`
                : res.blacklist?.distinctGuilds
                    ? `Progress toward blacklist: **${res.blacklist.distinctGuilds} / ${res.blacklist.threshold}** distinct guilds in the last ${res.blacklist.windowHours}h.`
                    : 'Thanks — staff will review.',
        ].join('\n'))
        .setColor(res.blacklist?.tripped ? 0xC13E3E : 0x5865F2)
        .setFooter({ text: 'If a staff member marks this a false positive, it won\'t count toward the blacklist.' });

    return interaction.reply({ embeds: [embed], ...EPHEMERAL });
}

export { data, execute };
export default { category: 'admin', data, execute };
