/*
 * Trade offer buttons and the counter-offer form (core/trade-manager.js).
 *   trade:acc:<id>   accept the current terms (only the side the terms wait for) — settles atomically
 *   trade:ctr:<id>   open the Counter / Edit form (trade_ctr:<id>), prefilled with the current terms
 *   trade:dec:<id>   decline (awaiting side) / withdraw (other side)
 *   trade:can:<id>   same as decline — the manager decides declined vs cancelled by who pressed it
 *   trade_ctr:<id>   modal submit: "You give" / "You want" in the trade grammar (core/trade-offer.js)
 * Keyed by trade id; the trade itself lives in the `trades` table, so this survives restarts.
 */
import { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import tradeManager, { TradeError } from '../../core/trade-manager.js';
import { offerToText, parseOfferText } from '../../core/trade-offer.js';
import logger from '../../utils/logger.js';

async function fail(interaction, error, context) {
    const message = error instanceof TradeError ? error.message : 'Something went wrong with that trade — try again.';
    if (!(error instanceof TradeError)) logger.error(`[Trade] ${context} failed`, { error: error.message, customId: interaction.customId });
    const payload = { content: `❌ ${message}`.slice(0, 2000), ephemeral: true };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => {});
    return interaction.reply(payload).catch(() => {});
}

/** Edit the message the button sits on when we can; otherwise find it by id. */
async function redraw(interaction, trade, note = null) {
    const payload = { embeds: [await tradeManager.tradeEmbed(trade, note)], components: tradeManager.tradeComponents(trade) };
    if (interaction.message && interaction.message.id === trade.message_id && !interaction.replied && !interaction.deferred) {
        return interaction.update(payload);
    }
    await tradeManager.refreshTradeMessage(trade, interaction.client, note);
    if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({ content: `Trade #${trade.id} is now **${trade.status}**.`, ephemeral: true });
    }
    return null;
}

export async function handleTradeButton(interaction) {
    const [, action, rawId] = interaction.customId.split(':');
    const tradeId = parseInt(rawId, 10);
    try {
        if (!Number.isInteger(tradeId) || !interaction.guild) throw new TradeError('That trade button is no longer valid.');
        const trade = await tradeManager.getTrade(tradeId);
        if (!trade || trade.guild_id !== interaction.guild.id) throw new TradeError('That trade no longer exists.');
        const isParty = interaction.user.id === trade.initiator_id || interaction.user.id === trade.recipient_id;
        if (!isParty) throw new TradeError('Only the two traders can use these buttons.');

        if (action === 'acc') {
            const done = await tradeManager.acceptTrade({ tradeId, userId: interaction.user.id, guild: interaction.guild });
            await redraw(interaction, done, 'Everything has changed hands.');
            const other = interaction.user.id === done.initiator_id ? done.recipient_id : done.initiator_id;
            await interaction.followUp({
                content: `✅ <@${other}>, <@${interaction.user.id}> accepted trade #${done.id} — it's done.`,
                allowedMentions: { users: [other] },
            }).catch(error => logger.warn('[Trade] Could not ping the other trader', { tradeId, error: error.message }));
            return;
        }

        if (action === 'ctr') {
            if (trade.status !== 'pending') throw new TradeError(`This trade is already ${trade.status}.`);
            const mine = interaction.user.id === trade.initiator_id ? trade.initiator_offer : trade.recipient_offer;
            const theirs = interaction.user.id === trade.initiator_id ? trade.recipient_offer : trade.initiator_offer;
            const counter = trade.awaiting_id === interaction.user.id;
            const modal = new ModalBuilder()
                .setCustomId(`trade_ctr:${trade.id}`)
                .setTitle(counter ? `Counter-offer for trade #${trade.id}` : `Edit your offer (trade #${trade.id})`);
            const give = new TextInputBuilder()
                .setCustomId('give')
                .setLabel('You give')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(500)
                .setPlaceholder('e.g. 500 coins, item 12 x2, card 45 — or "nothing"')
                .setValue(offerToText(mine));
            const want = new TextInputBuilder()
                .setCustomId('want')
                .setLabel('You want')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(500)
                .setPlaceholder('e.g. 1.5k coins, item 7, card 102 — or "nothing"')
                .setValue(offerToText(theirs));
            modal.addComponents(new ActionRowBuilder().addComponents(give), new ActionRowBuilder().addComponents(want));
            return interaction.showModal(modal);
        }

        if (action === 'dec' || action === 'can') {
            const closed = await tradeManager.closeTrade({ tradeId, userId: interaction.user.id });
            return redraw(interaction, closed, closed.status === 'declined' ? `Declined by <@${interaction.user.id}>.` : `Withdrawn by <@${interaction.user.id}>.`);
        }

        throw new TradeError('Unknown trade action.');
    } catch (error) {
        return fail(interaction, error, `button ${action}`);
    }
}

export async function handleTradeCounterModal(interaction) {
    const tradeId = parseInt(interaction.customId.split(':')[1], 10);
    try {
        if (!Number.isInteger(tradeId) || !interaction.guild) throw new TradeError('That trade form is no longer valid.');
        const give = parseOfferText(interaction.fields.getTextInputValue('give'));
        const want = parseOfferText(interaction.fields.getTextInputValue('want'));
        const errors = [...give.errors.map(e => `You give: ${e}`), ...want.errors.map(e => `You want: ${e}`)];
        if (errors.length) throw new TradeError(errors.join('\n'));

        const before = await tradeManager.getTrade(tradeId);
        if (!before || before.guild_id !== interaction.guild.id) throw new TradeError('That trade no longer exists.');
        const wasCounter = before.awaiting_id === interaction.user.id;

        const trade = await tradeManager.counterTrade({ tradeId, userId: interaction.user.id, give: give.offer, want: want.offer });
        await redraw(interaction, trade, wasCounter ? `Counter-offer from <@${interaction.user.id}>.` : `Offer revised by <@${interaction.user.id}>.`);
        await interaction.followUp({
            content: `<@${trade.awaiting_id}>, <@${interaction.user.id}> ${wasCounter ? 'countered' : 'changed'} trade #${trade.id} — have a look.`,
            allowedMentions: { users: [trade.awaiting_id] },
        }).catch(error => logger.warn('[Trade] Could not ping the other trader', { tradeId, error: error.message }));
    } catch (error) {
        return fail(interaction, error, 'counter modal');
    }
}

export default { handleTradeButton, handleTradeCounterModal };
