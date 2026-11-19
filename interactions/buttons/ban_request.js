/*
 * Approve or refuse a mod's ban request.
 *
 * The buttons are only half the guard: the customId carries the request id, so
 * anyone who can click has to also hold an approver role, checked here rather
 * than trusted from the message. The row is updated by id, and a request that
 * has already been decided is never decided twice — two admins tapping at the
 * same moment must not produce two bans and two log lines.
 *
 * Approving goes through the same moderation path as /ban and /admin mod ban (core/moderation-manager.js):
 * a member holding a protected role (Moderation page) is refused, the ban DM uses the page's wording and
 * on/off switch, and the ban is recorded with logInfraction (infraction row, mod-log, server log,
 * escalation, shared ban list). Someone who already left (usually kicked when the request was filed)
 * gets no DM, but the ban is still recorded.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { logFeatureEvent, userLabel } from '../../core/feature-log.js';
import { protectedRoleFor, sendModerationDm, logInfraction } from '../../core/moderation-manager.js';
import { readBanRequestConfig, mayDecideBanRequest } from '../../core/ban-requests.js';

async function decide(interaction, approve) {
    const id = Number(interaction.customId.split(':')[1]);
    if (!Number.isFinite(id)) return;

    const may = mayDecideBanRequest(interaction.member, await readBanRequestConfig(interaction.guild.id));
    if (!may) {
        return interaction.reply({ content: "This one's for the admins to decide.", ephemeral: true });
    }

    // Approving: the same checks /ban makes, before the request is claimed so a refusal leaves it pending.
    let member = null;
    if (approve) {
        const guild = interaction.guild;
        const [[pending]] = await pool.execute(
            'SELECT target_id FROM ban_requests WHERE id = ? AND guild_id = ?', [id, guild.id]);
        if (pending) {
            if (pending.target_id === guild.ownerId) {
                return interaction.reply({ content: "That's the server owner.", ephemeral: true });
            }
            member = await guild.members.fetch(pending.target_id).catch(() => null);
            const shielded = await protectedRoleFor(guild, member);
            if (shielded) {
                return interaction.reply({
                    content: `They have the protected role "${shielded.name}", so they can't be banned with bot commands. The request stays open.`,
                    ephemeral: true,
                });
            }
            if (member) {
                if (member.roles.highest.position >= interaction.member.roles.highest.position && guild.ownerId !== interaction.user.id) {
                    return interaction.reply({ content: "They're the same rank as you or higher. The request stays open.", ephemeral: true });
                }
                const me = await guild.members.fetchMe().catch(() => null);
                if (me && member.roles.highest.position >= me.roles.highest.position) {
                    return interaction.reply({ content: "I can't ban them: their role sits above mine. The request stays open.", ephemeral: true });
                }
            }
        }
    }

    // Claim it atomically — whoever's UPDATE changes a row owns the decision.
    const [res] = await pool.execute(
        `UPDATE ban_requests SET status = ?, decided_by = ?, decided_at = NOW()
          WHERE id = ? AND guild_id = ? AND status = 'pending'`,
        [approve ? 'approved' : 'denied', interaction.user.id, id, interaction.guild.id]);
    if (res.affectedRows === 0) {
        const [[cur]] = await pool.execute('SELECT status, decided_by FROM ban_requests WHERE id = ?', [id]);
        return interaction.reply({
            content: cur ? `Request #${id} was already ${cur.status} by <@${cur.decided_by}>.` : `Request #${id} is gone.`,
            ephemeral: true,
        });
    }

    const [[req]] = await pool.execute('SELECT * FROM ban_requests WHERE id = ?', [id]);
    await interaction.deferUpdate();

    let outcome;
    let bannedUser = null;
    if (approve) {
        bannedUser = member?.user
            ?? await interaction.client.users.fetch(req.target_id).catch(() => null)
            ?? { id: req.target_id, tag: req.target_tag, username: req.target_tag };
        // Before the ban, while the bot still shares the server with them. Someone who already left
        // (kicked when the request was filed) is not messaged.
        if (member) {
            await sendModerationDm(interaction.guild, bannedUser, 'ban',
                { reason: req.reason, permanent: true, moderator: interaction.user });
        }
        try {
            await interaction.guild.bans.create(req.target_id, {
                reason: `Ban request #${id} approved by ${interaction.user.tag}: ${req.reason}`,
            });
            outcome = `**Banned** by ${interaction.user}.`;
        } catch (err) {
            logger.error(`[BanRequest] ban failed for #${id}: ${err.message}`, { guildId: interaction.guild.id });
            // Put it back: a failed ban is still pending, not approved.
            await pool.execute(
                `UPDATE ban_requests SET status='pending', decided_by=NULL, decided_at=NULL WHERE id=?`, [id]);
            return interaction.followUp({ content: `Couldn't ban them: ${err.message}`, ephemeral: true });
        }
    } else {
        outcome = req.kicked
            ? `**Not banned** — ${interaction.user} left it at the kick. They can rejoin with a new invite.`
            : `**Refused** by ${interaction.user}.`;
    }

    const old = interaction.message.embeds[0];
    const embed = EmbedBuilder.from(old)
        .setColor(approve ? 0xD64545 : 0x5B9E6A)
        .setFields(
            ...old.fields.filter((f) => f.name !== 'Right now'),
            { name: 'Outcome', value: outcome },
        );
    await interaction.message.edit({ content: '', embeds: [embed], components: [] });

    if (approve) {
        // Infraction row, mod-log, the moderation.ban server log, escalation and the shared ban list.
        await logInfraction(interaction, bannedUser, 'Ban', `Ban request #${id}: ${req.reason || 'No reason given'}`);
    } else {
        // The request message just edited already shows the outcome, so not repeated in that channel.
        void logFeatureEvent(() => (interaction.guild), 'moderation.banRequestDenied', () => ({
            title: '✋ Ban Request Declined',
            fields: [
                ['Member', userLabel({ id: req.target_id, tag: req.target_tag })],
                ['Declined by', userLabel(interaction.user)],
                ['Requested by', userLabel(req.requested_by)],
                ['Request', `#${id}`],
                ['Kick', req.kicked ? 'Stands — they can rejoin with a new invite' : null],
                ['Reason', req.reason || 'No reason given', false],
            ],
            url: interaction.message.url,
            avoidChannelIds: [interaction.channelId],
        }));
    }

    logger.info(`[BanRequest] #${id} ${approve ? 'approved' : 'denied'} by ${interaction.user.tag}`,
        { guildId: interaction.guild.id, category: 'moderation' });

    // Tell the mod who asked — they acted on it and deserve to know how it landed.
    const asker = await interaction.client.users.fetch(req.requested_by).catch(() => null);
    await asker?.send(
        `Your ban request for **${req.target_tag}** in **${interaction.guild.name}** was ` +
        `${approve ? 'approved — they are banned' : 'not approved. The kick stands'}.`
    ).catch(() => {});
}

export const handleBanRequestApprove = (i) => decide(i, true);
export const handleBanRequestDeny = (i) => decide(i, false);
