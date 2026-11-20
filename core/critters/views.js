/*
 * Discord views the module itself needs (the jobs and the boss buttons): the boss announcement, the boss button
 * handler, gate refusal text and the job messages. All wording is original to Critters.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { formatAcorns } from './constants.js';
import { hpBar } from './rules/misc-rules.js';
import { gate } from './config.js';
import { getBoss, fightBoss } from './boss.js';
import { isCritterError } from './db.js';
import logger from '../../utils/logger.js';

export const BOSS_BUTTON_PREFIX = 'guildboss_';
export const BOSS_BUTTONS = Object.freeze({ inspect: 'guildboss_inspect', leaderboard: 'guildboss_leaderboard', fight: 'guildboss_fight' });

const ts = (d, style = 'R') => `<t:${Math.floor(new Date(d).getTime() / 1000)}:${style}>`;

/** Member-facing text for a failed gate (rules/config-rules.js checkGates result). */
export function gateMessage(result, { isAdmin = false } = {}) {
    switch (result?.code) {
        case 'DISABLED':
            return isAdmin ? 'The critters game is switched off on this server. Turn it on with `/owo toggle enabled:true`.' : 'The critters game is not switched on in this server.';
        case 'FEATURE_OFF':
            return 'That part of the critters game is switched off on this server.';
        case 'CHANNEL':
            return `Critter commands work in ${result.allowedChannelIds.map(id => `<#${id}>`).join(', ')}${result.moreChannels ? ' and a few more' : ''}.`;
        case 'ROLE':
            return 'One of your roles keeps you out of the critters game on this server.';
        default:
            return 'You cannot use that here.';
    }
}

/** The boss announcement: { embeds, components } (for send, edit or interaction.update). */
export function bossMessage(boss, { now = new Date() } = {}) {
    const name = boss.species ? `${boss.species.emoji} ${boss.species.name}` : 'Mystery critter';
    const live = boss.status === 'active' && new Date(boss.expiresAt).getTime() > now.getTime();
    const title = boss.status === 'defeated' ? `${name} has been defeated!`
        : boss.status === 'fled' || !live ? `${name} slipped away into the woods`
            : `A giant ${name} blocks the path! (Lv ${boss.level})`;
    const lines = [`**HP** \`${hpBar(boss.hp, boss.maxHp)}\` ${boss.hp.toLocaleString('en-US')} / ${boss.maxHp.toLocaleString('en-US')}`];
    if (live) lines.push(`It runs off ${ts(boss.expiresAt)} unless the server brings it down.`);
    if (boss.board.length) {
        lines.push('', '**Damage board**');
        boss.board.slice(0, 10).forEach((b, i) => lines.push(`${i + 1}. <@${b.userId}> ${b.damage.toLocaleString('en-US')}${b.wiped ? ' (team wiped)' : ''}${boss.status === 'defeated' && b.payout ? ` -> ${formatAcorns(b.payout)}` : ''}`));
    } else if (live) {
        lines.push('', 'Nobody has struck yet. Press **Fight** to send your team in.');
    }
    const footer = boss.status === 'defeated' ? `Brought down by ${boss.fighters} fighter${boss.fighters === 1 ? '' : 's'}`
        : boss.status === 'fled' || !live ? `${boss.fighters} fighter${boss.fighters === 1 ? '' : 's'} tried; it got away`
            : `${boss.fighters} fighter${boss.fighters === 1 ? '' : 's'}, ${boss.wipedCount} wiped`;
    const color = boss.status === 'fled' || (!live && boss.status !== 'defeated') ? 0x6b7280 : boss.tier?.color ?? 0x5f7a4f;
    const embed = new EmbedBuilder().setTitle(title).setDescription(lines.join('\n')).setColor(color).setFooter({ text: `Level ${boss.level} ${boss.tier?.name || ''} boss · ${footer}` });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(BOSS_BUTTONS.inspect).setLabel('Inspect').setStyle(ButtonStyle.Secondary).setDisabled(!live),
        new ButtonBuilder().setCustomId(BOSS_BUTTONS.leaderboard).setLabel('Damage board').setStyle(ButtonStyle.Secondary).setDisabled(!live),
        new ButtonBuilder().setCustomId(BOSS_BUTTONS.fight).setLabel('Fight').setStyle(ButtonStyle.Danger).setDisabled(!live),
    );
    return { embeds: [embed], components: [row] };
}

const roleIdsOf = (member) => {
    if (!member) return [];
    if (member.roles?.cache) return [...member.roles.cache.keys()];
    if (Array.isArray(member.roles)) return member.roles;
    return [];
};

const isAdminOf = (member) => {
    try { return !!member?.permissions?.has?.('ManageGuild'); } catch { return false; }
};

/**
 * Handle any button whose customId starts with guildboss_. Checks the enabled flag and the `boss` feature key
 * (and the channel / role gates) first.
 */
export async function handleBossButton(interaction) {
    const action = String(interaction.customId || '').slice(BOSS_BUTTON_PREFIX.length);
    const ephemeral = { flags: MessageFlags.Ephemeral };
    try {
        if (!interaction.guildId) return;
        const g = await gate(interaction.guildId, { featureKey: 'boss', channelId: interaction.channelId, roleIds: roleIdsOf(interaction.member) });
        if (!g.ok) return interaction.reply({ content: gateMessage(g, { isAdmin: isAdminOf(interaction.member) }), ...ephemeral });
        if (action === 'fight') {
            let res;
            try {
                res = await fightBoss(interaction.guildId, interaction.user.id);
            } catch (err) {
                if (isCritterError(err)) return interaction.reply({ content: err.message, ...ephemeral });
                throw err;
            }
            await interaction.update(bossMessage(res.boss));
            const lines = [`Your team dealt **${res.damage.toLocaleString('en-US')}** damage (your total: ${res.yourTotal.toLocaleString('en-US')}).`];
            if (res.wiped) lines.push('The boss flattened your team. You cannot strike it again.');
            if (res.killed) {
                lines.push('That was the final blow!');
                if (res.yourPayout) lines.push(`You earned ${formatAcorns(res.yourPayout.payout)}${res.yourPayout.top ? ' (including the top-damage bonus)' : ''}.`);
            }
            return interaction.followUp({ content: lines.join('\n'), ...ephemeral });
        }
        const boss = await getBoss(interaction.guildId);
        if (!boss) return interaction.reply({ content: 'There is no boss here right now.', ...ephemeral });
        if (action === 'leaderboard') {
            const top = boss.board.slice(0, 10).map((b, i) => `${i + 1}. <@${b.userId}> ${b.damage.toLocaleString('en-US')}${b.wiped ? ' (wiped)' : ''}`);
            return interaction.reply({
                content: [`**Damage board** (${boss.fighters} fighters, ${boss.wipedCount} wiped, ${boss.totalDamage.toLocaleString('en-US')} total)`, ...(top.length ? top : ['Nobody has struck yet.'])].join('\n'),
                allowedMentions: { parse: [] }, ...ephemeral,
            });
        }
        if (action === 'inspect') {
            const pct = boss.maxHp > 0 ? Math.round((boss.hp / boss.maxHp) * 1000) / 10 : 0;
            return interaction.reply({
                content: [
                    `**${boss.species?.emoji || ''} ${boss.species?.name || 'Boss'}**, level ${boss.level} (${boss.tier?.name || '?'})`,
                    `HP ${boss.hp.toLocaleString('en-US')} / ${boss.maxHp.toLocaleString('en-US')} (${pct}%)`,
                    `Attack ${boss.attack.toLocaleString('en-US')}`,
                    boss.status === 'active' ? `Runs off ${ts(boss.expiresAt)}` : `Status: ${boss.status}`,
                ].join('\n'), ...ephemeral,
            });
        }
        return interaction.reply({ content: 'That button does nothing any more.', ...ephemeral });
    } catch (err) {
        logger.error('[critters] boss button failed', { error: err.message });
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Something went wrong with that boss button.', ...ephemeral }).catch(() => {});
        }
    }
}

/* ----------------------------------------------------------------------------------------------- job messages */

export function lotteryWinMessage(draw) {
    const embed = new EmbedBuilder()
        .setTitle('\u{1F3B2} The acorn lottery has a winner')
        .setDescription(`<@${draw.winnerId}> takes home **${formatAcorns(draw.prize)}**!\n${draw.participants} players, ${formatAcorns(draw.pot)} in tickets plus the house top-up. Their odds were ${draw.chancePct}%.`)
        .setColor(0xf2c94c)
        .setFooter({ text: 'The next draw is at midnight.' });
    return { content: `<@${draw.winnerId}>`, embeds: [embed], allowedMentions: { users: [draw.winnerId] } };
}

export function lotteryRolloverMessage(draw) {
    return {
        content: `<@${draw.soloUserId}> you were the only one in tonight's lottery, so there was no draw. Your ${formatAcorns(draw.amount)} stays in for the next one at midnight.`,
        allowedMentions: { users: [draw.soloUserId] },
    };
}

export function challengeExpiredMessage(row) {
    const refunded = row.refunded && (row.refunded.sender > 0 || row.refunded.receiver > 0);
    return { content: `This battle challenge timed out.${refunded ? ' Every bet has been returned.' : ''}`, embeds: [], components: [] };
}
