/*
 * /ban — one command, two outcomes, decided by who ran it.
 *
 * An admin bans. A mod kicks and files a request. That split is the whole point:
 * a mod needs to be able to end an incident at 3am without waiting for anybody,
 * but a ban is permanent and belongs to the people who own the server. A kick
 * ends the incident and is undone by a new invite; nothing is lost by waiting.
 *
 * A reason is mandatory in both paths. "Reason: None" in an audit log is the
 * thing that makes a decision impossible to review six months later.
 *
 * Who is which (core/ban-requests.js, H-657): Ban Members or an approver role bans; Kick Members or a
 * requester role files a request. The roles and the request channel are set on the Moderation page.
 * The command is shown to members with Kick Members by default (server admins can change that under
 * Server Settings > Integrations).
 */
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
         ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { logFeatureEvent, userLabel } from '../../core/feature-log.js';
import { expand as expandModReason } from '../../core/moderation-aliases.js';
import { protectedRoleFor, sendModerationDm, getModerationSettings, logInfraction } from '../../core/moderation-manager.js';
import { readBanRequestConfig, banRequestRole } from '../../core/ban-requests.js';

const data = new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member — mods kick and send a request to the admins instead.')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .setDMPermission(false)
    .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why — required, and it is kept').setRequired(true).setMaxLength(900))
    .addIntegerOption((o) => o.setName('delete_days')
        .setDescription('Delete their last N days of messages (0-7)').setMinValue(0).setMaxValue(7));

async function config(guildId) {
    const cfg = await readBanRequestConfig(guildId);
    return { ...cfg, channel: cfg.channelId, approvers: cfg.approverRoleIds };
}

async function execute(interaction) {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: 'Server only.', ephemeral: true });

    const cfg = await config(guild.id);
    const me = interaction.member;
    const role = banRequestRole(me, cfg);
    const isApprover = role === 'approver';
    if (!role) {
        return interaction.reply({ content: 'You need Ban Members to ban, or Kick Members (or a ban-request role from the Moderation page) to ask for a ban.', ephemeral: true });
    }

    const target = interaction.options.getUser('member');
    let reason = interaction.options.getString('reason').trim();
    // Expand a stored alias (e.g. 'gh' → 'guideline hopper (repeat offender)') before
    // persisting the audit-log reason. If the input is not an alias, this is a no-op.
    // See core/moderation-aliases.js and /modreason.
    try {
        const exp = await expandModReason(interaction.guildId, reason);
        if (exp.aliasMatched) reason = exp.reason;
    } catch { /* alias lookup is best-effort — never block a ban over a DB blip */ }
    const days = interaction.options.getInteger('delete_days') ?? 0;
    const member = await guild.members.fetch(target.id).catch(() => null);

    if (target.id === interaction.user.id) return interaction.reply({ content: "You can't ban yourself.", ephemeral: true });
    if (target.id === guild.ownerId) return interaction.reply({ content: "That's the server owner.", ephemeral: true });
    // Protected roles (dashboard Moderation page) cannot be actioned by bot moderation commands.
    const protectedRole = await protectedRoleFor(guild, member || target);
    if (protectedRole) {
        return interaction.reply({ content: `They have the protected role "${protectedRole.name}", so they can't be banned or kicked with bot commands.`, ephemeral: true });
    }
    if (member) {
        if (member.roles.highest.position >= me.roles.highest.position && guild.ownerId !== me.id) {
            return interaction.reply({ content: "They're the same rank as you or higher.", ephemeral: true });
        }
        const bot = await guild.members.fetchMe();
        if (member.roles.highest.position >= bot.roles.highest.position) {
            return interaction.reply({ content: "I can't action them — their role sits above mine.", ephemeral: true });
        }
    }

    await interaction.deferReply({ ephemeral: true });

    // ── admin path: ban outright ──────────────────────────────────────────
    if (isApprover) {
        // Before the ban, while the bot still shares the server with them (Moderation page wording).
        await sendModerationDm(guild, target, 'ban', { reason, permanent: true, moderator: interaction.user });
        try {
            await guild.bans.create(target.id, {
                reason: `${reason} — by ${interaction.user.tag}`,
                deleteMessageSeconds: days * 86400,
            });
        } catch (err) {
            logger.error(`[Ban] direct ban failed: ${err.message}`, { guildId: guild.id });
            return interaction.editReply(`Couldn't ban them: ${err.message}`);
        }
        // Recorded like every other bot ban: infraction row (so /infractions and escalation see it),
        // mod-log, the moderation.ban server log and the shared ban list.
        await logInfraction(interaction, target, 'Ban', reason);
        await pool.execute(
            `INSERT INTO ban_requests (guild_id,target_id,target_tag,requested_by,reason,kicked,status,decided_by,decided_at)
             VALUES (?,?,?,?,?,0,'approved',?,NOW())`,
            [guild.id, target.id, target.tag, interaction.user.id, reason, interaction.user.id]);
        return interaction.editReply(`**${target.tag}** is banned. Reason recorded.`);
    }

    // ── mod path: kick now, ask after ─────────────────────────────────────
    let kicked = false;
    if (member) {
        try {
            // The kick DM can be switched off on the Moderation page; this one keeps its own wording.
            if ((await getModerationSettings(guild.id)).dmOn.kick) await member.send(
                `You've been removed from **${guild.name}**.\n\n**Reason:** ${reason}\n\n` +
                `This is a kick, not a ban — the admins are reviewing it. If it's overturned you can rejoin with a new invite.`
            ).catch(() => {});
            await member.kick(`Ban requested by ${interaction.user.tag}: ${reason}`);
            kicked = true;
            void logFeatureEvent(() => (guild), 'moderation.kick', () => ({
                title: '👢 Member Kicked',
                fields: [
                    ['Member', userLabel(target)],
                    ['Moderator', userLabel(interaction.user)],
                    ['Via', '/ban — kicked while a ban request goes to the admins'],
                    ['Reason', reason, false],
                ],
                avoidChannelIds: [cfg.channel],
            }));
        } catch (err) {
            logger.error(`[Ban] kick failed: ${err.message}`, { guildId: guild.id });
        }
    }

    const [res] = await pool.execute(
        `INSERT INTO ban_requests (guild_id,target_id,target_tag,requested_by,reason,kicked,channel_id)
         VALUES (?,?,?,?,?,?,?)`,
        [guild.id, target.id, target.tag, interaction.user.id, reason, kicked ? 1 : 0, cfg.channel]);
    const id = res.insertId;

    const embed = new EmbedBuilder()
        .setTitle('Ban request')
        .setColor(0xE8A33D)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
            { name: 'Member', value: `${target} \`${target.tag}\`\n\`${target.id}\``, inline: true },
            { name: 'Requested by', value: `${interaction.user}`, inline: true },
            { name: 'Reason', value: reason },
            { name: 'Right now', value: kicked
                ? 'They have been **kicked**, so they are out of the server already. They can come back with a new invite unless you ban.'
                : "They **weren't in the server**, so nothing has happened yet." },
        )
        .setFooter({ text: `Request #${id}` })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`banreq_approve:${id}`).setLabel('Ban them').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`banreq_deny:${id}`).setLabel('No — leave it at the kick').setStyle(ButtonStyle.Secondary),
    );

    const channel = cfg.channel ? await guild.channels.fetch(cfg.channel).catch(() => null) : null;
    if (!channel) {
        // Nobody was pinged, so the server log is the only place staff will see this request.
        void logFeatureEvent(() => (guild), 'moderation.banRequest', () => ({
            title: '📨 Ban Requested',
            fields: [
                ['Member', userLabel(target)],
                ['Requested by', userLabel(interaction.user)],
                ['Request', `#${id}`],
                ['Right now', kicked ? 'Kicked — waiting on the admins' : 'Not in the server — nothing done yet'],
                ['Request channel', 'Not set or unreachable — no admin was pinged'],
                ['Reason', reason, false],
            ],
        }));
        return interaction.editReply(
            `${kicked ? `**${target.tag}** was kicked` : 'Nothing was done'}, but there's no ban-request channel set, ` +
            `so no admin has been told. Request #${id} is stored. An admin can set the channel on the dashboard Moderation page, under Ban requests.`);
    }
    // Ping the approvers by role: a request nobody sees is a request nobody answers.
    const mention = cfg.approvers.map((r) => `<@&${r}>`).join(' ');
    const msg = await channel.send({ content: mention || undefined, embeds: [embed], components: [row] });
    void logFeatureEvent(() => (guild), 'moderation.banRequest', () => ({
        title: '📨 Ban Requested',
        fields: [
            ['Member', userLabel(target)],
            ['Requested by', userLabel(interaction.user)],
            ['Request', `#${id}`],
            ['Right now', kicked ? 'Kicked — waiting on the admins' : 'Not in the server — nothing done yet'],
            ['Reason', reason, false],
        ],
        url: msg.url,
        avoidChannelIds: [cfg.channel],
    }));
    await pool.execute('UPDATE ban_requests SET message_id = ? WHERE id = ?', [msg.id, id]);

    return interaction.editReply(
        `${kicked ? `**${target.tag}** has been kicked` : `**${target.tag}** wasn't in the server`} ` +
        `and request **#${id}** is with the admins.`);
}

export { data, execute };
export default { category: 'admin', guildScoped: true, data, execute };
