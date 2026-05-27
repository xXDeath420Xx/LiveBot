import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import * as h from './fourthwall-handler.js';

const CATEGORY_CHOICES = [
    { name: 'Orders', value: 'orders' },
    { name: 'Donations', value: 'donations' },
    { name: 'Memberships', value: 'memberships' },
    { name: 'Giveaways', value: 'giveaways' },
    { name: 'Promotions', value: 'promotions' },
    { name: 'Newsletter', value: 'newsletter' },
    { name: 'Thank-you', value: 'thank_you' },
    { name: 'Cart abandoned', value: 'cart_abandoned' }
];

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('fourthwall')
        .setDescription('Fourthwall shop integration — notifications, browsing, admin')

        // Connection management
        .addSubcommand(s => s.setName('setup').setDescription('Connect a Fourthwall shop (opens modal)'))
        .addSubcommand(s => s.setName('disconnect').setDescription('Disconnect a shop')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('List connected shops in this guild'))
        .addSubcommand(s => s.setName('resync').setDescription('Replay recent events for a shop')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true))
            .addIntegerOption(o => o.setName('hours').setDescription('Hours back (1-72)').setMinValue(1).setMaxValue(72)))

        // Routing
        .addSubcommand(s => s.setName('route').setDescription('Set channel for an event category')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true))
            .addStringOption(o => o.setName('category').setDescription('Event category').setRequired(true).addChoices(...CATEGORY_CHOICES))
            .addChannelOption(o => o.setName('channel').setDescription('Channel to post to')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
            .addBooleanOption(o => o.setName('enabled').setDescription('Enable this category (default true)')))
        .addSubcommand(s => s.setName('default-channel').setDescription('Set fallback channel for unrouted events')
            .addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
        .addSubcommand(s => s.setName('privacy').setDescription('Toggle privacy options for embeds')
            .addBooleanOption(o => o.setName('show_names').setDescription('Show real customer names (default off)'))
            .addBooleanOption(o => o.setName('show_amounts').setDescription('Show monetary amounts (default on)')))

        // Browse
        .addSubcommand(s => s.setName('shop').setDescription('View a shop overview')
            .addStringOption(o => o.setName('handle').setDescription('Shop handle (default: connected shop)')))
        .addSubcommand(s => s.setName('product').setDescription('Look up a product')
            .addStringOption(o => o.setName('slug').setDescription('Product slug').setRequired(true))
            .addStringOption(o => o.setName('shop').setDescription('Shop handle')))
        .addSubcommand(s => s.setName('collection').setDescription('Look up a collection')
            .addStringOption(o => o.setName('slug').setDescription('Collection slug').setRequired(true))
            .addStringOption(o => o.setName('shop').setDescription('Shop handle')))
        .addSubcommand(s => s.setName('search').setDescription('Search products')
            .addStringOption(o => o.setName('query').setDescription('Search query').setRequired(true))
            .addStringOption(o => o.setName('shop').setDescription('Shop handle')))
        .addSubcommand(s => s.setName('promotions').setDescription('List active promo codes')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle')))

        // Admin
        .addSubcommand(s => s.setName('stats').setDescription('Shop counters (orders/revenue/donations/members)')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true))
            .addStringOption(o => o.setName('period').setDescription('Time period').addChoices(
                { name: 'Last 7 days', value: '7d' },
                { name: 'Last 30 days', value: '30d' },
                { name: 'All time', value: 'all' }
            )))
        .addSubcommand(s => s.setName('recent').setDescription('List recent items (orders/donations/members)')
            .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true))
            .addStringOption(o => o.setName('kind').setDescription('What to list').setRequired(true).addChoices(
                { name: 'Orders', value: 'orders' },
                { name: 'Donations', value: 'donations' },
                { name: 'Members', value: 'members' }
            ))
            .addIntegerOption(o => o.setName('limit').setDescription('How many (5-25)').setMinValue(5).setMaxValue(25)))
        .addSubcommandGroup(g => g.setName('giveaway').setDescription('Giveaway management')
            .addSubcommand(s => s.setName('draw').setDescription('Trigger a giveaway draw')
                .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true))
                .addStringOption(o => o.setName('id').setDescription('Draw ID').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('List active draws')
                .addStringOption(o => o.setName('shop').setDescription('Shop handle').setRequired(true)))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        try {
            if (group === 'giveaway') {
                return await h.handleGiveaway(interaction, sub);
            }
            switch (sub) {
                case 'setup': return await h.handleSetup(interaction);
                case 'disconnect': return await h.handleDisconnect(interaction);
                case 'list': return await h.handleList(interaction);
                case 'resync': return await h.handleResync(interaction);
                case 'route': return await h.handleRoute(interaction);
                case 'default-channel': return await h.handleDefaultChannel(interaction);
                case 'privacy': return await h.handlePrivacy(interaction);
                case 'shop': return await h.handleShop(interaction);
                case 'product': return await h.handleProduct(interaction);
                case 'collection': return await h.handleCollection(interaction);
                case 'search': return await h.handleSearch(interaction);
                case 'promotions': return await h.handlePromotions(interaction);
                case 'stats': return await h.handleStats(interaction);
                case 'recent': return await h.handleRecent(interaction);
                default:
                    return await interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
            }
        } catch (err) {
            const logger = (await import('../../utils/logger.js')).default;
            logger.error('[FW Command] error', { err: err.message, stack: err.stack, sub });
            const reply = interaction.deferred || interaction.replied ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction);
            await reply({ content: `Error: ${err.message}`, ephemeral: true }).catch(() => {});
        }
    }
};
