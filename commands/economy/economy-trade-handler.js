import { EmbedBuilder } from 'discord.js';
import tradeManager, { TradeError } from '../../core/trade-manager.js';
import { normalizeOffer, describeOffer } from '../../core/trade-offer.js';
import { themeColor } from '../../core/guild-theme.js';
import logger from '../../utils/logger.js';

async function refuse(interaction, error) {
    if (!(error instanceof TradeError)) throw error;
    const payload = { content: `❌ ${error.message}`.slice(0, 2000), ephemeral: true };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}

/**
 * Post a freshly created trade as the reply to `interaction`, with its buttons, pinging the
 * recipient. Shared by /economy trade offer and /fun games trade.
 */
export async function postTrade(interaction, trade) {
    const payload = {
        content: `<@${trade.recipient_id}>, <@${trade.initiator_id}> sent you a trade offer.`,
        embeds: [await tradeManager.tradeEmbed(trade)],
        components: tradeManager.tradeComponents(trade),
        allowedMentions: { users: [trade.recipient_id] },
    };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply(payload);
    try {
        const message = await interaction.fetchReply();
        await tradeManager.setTradeMessage(trade.id, message.channelId || interaction.channelId, message.id);
    } catch (error) {
        logger.warn('[Trade] Could not record the trade message id', { tradeId: trade.id, error: error.message });
    }
}

export async function handleOffer(interaction) {
    const target = interaction.options.getUser('user');
    if (target.bot) return interaction.reply({ content: '❌ You cannot trade with bots.', ephemeral: true });
    if (target.id === interaction.user.id) return interaction.reply({ content: '❌ You cannot trade with yourself.', ephemeral: true });

    const coins = interaction.options.getInteger('coins') || 0;
    const item = interaction.options.getInteger('item');
    const quantity = interaction.options.getInteger('quantity') || 1;
    const wantCoins = interaction.options.getInteger('want_coins') || 0;
    const wantItem = interaction.options.getInteger('want_item');
    const wantQuantity = interaction.options.getInteger('want_quantity') || 1;

    const give = normalizeOffer({ coins, items: item ? [{ id: item, qty: quantity }] : [] });
    const want = normalizeOffer({ coins: wantCoins, items: wantItem ? [{ id: wantItem, qty: wantQuantity }] : [] });

    let trade;
    try {
        trade = await tradeManager.createTrade({
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            initiatorId: interaction.user.id,
            recipientId: target.id,
            give,
            want,
        });
    } catch (error) {
        return refuse(interaction, error);
    }
    await postTrade(interaction, trade);
}

function tradeLine(t, viewerId, labels) {
    const mine = t.initiator_id === viewerId ? t.initiator_offer : t.recipient_offer;
    const theirs = t.initiator_id === viewerId ? t.recipient_offer : t.initiator_offer;
    const other = t.initiator_id === viewerId ? t.recipient_id : t.initiator_id;
    const give = describeOffer(mine, labels).join(', ') || 'nothing';
    const get = describeOffer(theirs, labels).join(', ') || 'nothing';
    const link = t.message_id && t.channel_id ? ` — [open](https://discord.com/channels/${t.guild_id}/${t.channel_id}/${t.message_id})` : '';
    return `**#${t.id}** with <@${other}>: you give ${give}; you get ${get}${link}`;
}

export async function handleList(interaction) {
    const trades = await tradeManager.listOpenTrades(interaction.guild.id, interaction.user.id);
    if (!trades.length) return interaction.reply({ content: 'You have no open trade offers.', ephemeral: true });
    const labels = await tradeManager.loadLabels(interaction.guild.id, trades.flatMap(t => [t.initiator_offer, t.recipient_offer]));
    const lines = trades.map(t => {
        const turn = t.awaiting_id === interaction.user.id ? '🔔 your answer' : '⏳ waiting on them';
        return `${tradeLine(t, interaction.user.id, labels)} (${turn}, expires <t:${Number(t.expires_unix)}:R>)`;
    });
    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'warning'))
        .setTitle('🤝 Your open trades')
        .setDescription(lines.join('\n\n').slice(0, 4096))
        .setFooter({ text: 'Use the buttons on each offer, or /economy trade cancel <id>' });
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleHistory(interaction) {
    const trades = await tradeManager.listTradeHistory(interaction.guild.id, interaction.user.id, 10);
    if (!trades.length) return interaction.reply({ content: 'You have no finished trades yet.', ephemeral: true });
    const labels = await tradeManager.loadLabels(interaction.guild.id, trades.flatMap(t => [t.initiator_offer, t.recipient_offer]));
    const lines = trades.map(t => {
        const when = t.completed_unix || t.created_unix;
        return `${tradeLine(t, interaction.user.id, labels)} — **${t.status}**${when ? ` <t:${Number(when)}:d>` : ''}`;
    });
    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'info'))
        .setTitle('📜 Your recent trades')
        .setDescription(lines.join('\n\n').slice(0, 4096));
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleCancel(interaction) {
    const tradeId = interaction.options.getInteger('id');
    let trade;
    try {
        const existing = await tradeManager.getTrade(tradeId);
        if (!existing || existing.guild_id !== interaction.guild.id) throw new TradeError('No trade with that ID on this server.');
        trade = await tradeManager.closeTrade({ tradeId, userId: interaction.user.id });
    } catch (error) {
        return refuse(interaction, error);
    }
    await interaction.reply({ content: `Trade #${trade.id} is now **${trade.status}**.`, ephemeral: true });
    await tradeManager.refreshTradeMessage(trade, interaction.client);
}

/** Autocomplete for the item / want_item options: tradeable shop items the giver owns. */
export async function autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    let ownerId = interaction.user.id;
    if (focused.name === 'want_item') {
        ownerId = interaction.options.get('user')?.value;
        if (!ownerId) return interaction.respond([]);
    }
    const rows = await tradeManager.tradeableInventory(interaction.guild.id, ownerId, String(focused.value || ''));
    return interaction.respond(rows.slice(0, 25).map(r => ({
        name: `${r.item_name} (ID ${r.id}) — owns ${r.quantity}`.slice(0, 100),
        value: Number(r.id),
    })));
}
