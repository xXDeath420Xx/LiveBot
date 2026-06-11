/**
 * Shared renderer for the live PvP combat board.
 *
 * Used by both the slash handler (handlePvP) and the button handler
 * (interactions/buttons/pvp_act.js) so the board looks identical no matter
 * which entry-point drove the turn.
 *
 * All output stays within Discord embed limits (description short, each field
 * value <= 1024 chars).
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const BAR_SLOTS = 12;

/** Render a simple textual HP bar. */
function hpBar(hp, maxHp) {
    const h = Math.max(0, Number(hp) || 0);
    const m = Math.max(1, Number(maxHp) || 1);
    const filled = Math.round((h / m) * BAR_SLOTS);
    const clampedFilled = Math.min(BAR_SLOTS, Math.max(0, filled));
    return `${'█'.repeat(clampedFilled)}${'░'.repeat(BAR_SLOTS - clampedFilled)} ${h}/${m}`;
}

/** Truncate a combat log array to fit a single embed field (<= 1024). */
function renderLog(logLines) {
    if (!logLines || logLines.length === 0) return '_No blows landed yet._';
    let text = logLines.join('\n');
    if (text.length <= 1000) return text;

    // Keep the most-recent lines (the tail is the most useful in a live duel).
    const tail = [];
    for (let i = logLines.length - 1; i >= 0; i--) {
        const candidate = logLines[i];
        if ((tail.join('\n').length + candidate.length + 1) > 980) break;
        tail.unshift(candidate);
    }
    return `… (${logLines.length - tail.length} earlier turns) …\n${tail.join('\n')}`.slice(0, 1024);
}

/**
 * Build the live combat board embed.
 *
 * @param {object} state - getLiveState() result
 * @param {object} [opts]
 * @param {boolean} [opts.ended] - render the final/ended board
 * @param {object}  [opts.result] - endMatch result (for ELO display)
 * @param {string}  [opts.headline] - headline shown when ended (e.g. "X wins!")
 * @returns {EmbedBuilder}
 */
export function buildPvpBoardEmbed(state, opts = {}) {
    const { challenger, defender, round, whoseTurn, log } = state;
    const ended = !!opts.ended;

    const embed = new EmbedBuilder()
        .setColor(ended ? '#2ECC71' : '#E67E22')
        .setTitle('⚔️ Live Duel');

    if (ended) {
        embed.setDescription(`**${opts.headline || 'Match over!'}**`);
    } else {
        const turnName = Number(whoseTurn) === Number(challenger.characterId)
            ? challenger.name : defender.name;
        embed.setDescription(`Round **${round}** — 🎯 **${turnName}'s** turn`);
    }

    embed.addFields(
        { name: `🟥 ${challenger.name}`, value: hpBar(challenger.hp, challenger.maxHp), inline: true },
        { name: `🟦 ${defender.name}`, value: hpBar(defender.hp, defender.maxHp), inline: true },
        { name: 'Combat Log', value: renderLog(log), inline: false },
    );

    if (ended && opts.result?.elo_changes) {
        const ec = opts.result.elo_changes;
        embed.addFields({
            name: 'ELO Change',
            value: `Winner ${ec.winner >= 0 ? '+' : ''}${ec.winner} | Loser ${ec.loser}`,
            inline: false,
        });
    } else if (!ended) {
        embed.setFooter({ text: 'Attack to strike • Defend to brace • Forfeit to surrender' });
    }

    return embed;
}

/**
 * Build the action button row for a live match.
 *
 * @param {number} matchId
 * @param {object} [opts]
 * @param {boolean} [opts.disabled] - disable all buttons (match ended)
 * @returns {ActionRowBuilder}
 */
export function buildPvpActionRow(matchId, opts = {}) {
    const disabled = !!opts.disabled;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`pvp_act:${matchId}:attack`)
            .setLabel('Attack')
            .setEmoji('⚔️')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`pvp_act:${matchId}:defend`)
            .setLabel('Defend')
            .setEmoji('🛡️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`pvp_act:${matchId}:forfeit`)
            .setLabel('Forfeit')
            .setEmoji('🏳️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
    );
}

export default { buildPvpBoardEmbed, buildPvpActionRow };
