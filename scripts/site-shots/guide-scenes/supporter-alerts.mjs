// Screenshots for the supporter-alerts guide. Formats copied from: core/throne-manager.js (the gift post: green bar, the creator as
// author, "🎁 Gift Received!", "<gifter> gifted <item>", Value and Status fields, item thumbnail, the 👑 View Wishlist link button).
// The Throne page renders dashboard/views/partials/manage/throne.ejs. The Throne creator, gifter and item are invented.
export default async function ({ manage, discord, ctx, demo }) {
    const { channel, channels, roles, member: M } = demo;

    ctx.stub(/^\/api\/guilds\/\d+\/throne\/webhooks$/, () => ({ success: true, subscriptions: [] }));
    manage('supporter-alerts-throne', 'throne', {
        throneNotifications: [
            { throne_username: 'sorrelquinnart', channel_id: channel.announcements.id, notify_new_items: 1, notify_gifts: 1, notify_contributions: 1 },
        ],
        throneGuildConfig: null,
        throneSettings: {
            notify_item_added: 1, notify_item_removed: 0, notify_gift_received: 1, notify_contribution: 1, notify_milestone: 1,
            notify_price_change: 0, price_change_threshold: 10, notification_channel_id: null,
            auto_embed_links: 1, birthday_reminder: 0, birthday_channel_id: null, birthday_reminder_days: 3, monthly_spotlight: 0, spotlight_channel_id: null,
        },
    }, {
        alt: 'The Throne wishlists page: one tracked creator, sorrelquinnart, posting in #announcements, and the form for tracking another creator.',
        guides: ['supporter-alerts'],
    });

    const item = await ctx.file('supporter-alerts-item.png', () => ctx.artwork({ from: '#a2475e', to: '#e0a526', caption: 'Brush set' }));
    const BOT = 'CertiFried Utility';
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    discord('supporter-alerts-discord', () => ({
        channel: 'announcements',
        ctx: { channels: channels.map((c) => ({ id: c.id, name: c.name })), roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })) },
        messages: [{
            username: BOT, avatarUrl: `${B()}/images/CertiFried.png`,
            embeds: [{
                color: '#2ECC71', author: M.sorrel.displayName, title: '🎁 Gift Received!',
                description: `**${M.hazel.displayName}** gifted **Watercolour brush set, 24 pieces**`,
                fields: [{ name: 'Value', value: '$34.00', inline: true }, { name: 'Status', value: 'Purchased', inline: true }],
                thumbnail: item(), timestamp: true,
            }],
            buttons: [{ label: 'View Wishlist' }], buttonEmoji: ['👑'],
        }],
    }), {
        alt: 'A Throne gift alert in #announcements: Hazel Marsh gifted Sorrel Quinn a watercolour brush set worth $34.00, with a View Wishlist button.',
        guides: ['supporter-alerts'],
    });
}
