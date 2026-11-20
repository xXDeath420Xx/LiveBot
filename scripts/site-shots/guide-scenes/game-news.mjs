// Screenshots for the game-news guide. Formats copied from: core/free-games-manager.js (sendNotification content,
// buildAnnouncementEmbed: store colour, price line, links, footer). The game, its price and its art are invented.
export default async function ({ manage, discord, ctx, demo }) {
    const { channels, role, roles } = demo;
    const freeGames = { id: '100400000000000091', name: 'free-games', type: 0, parentId: null };
    const allChannels = [...channels, freeGames];

    manage('game-news-free-games', 'free-games', {
        channels: allChannels,
        freeGamesSubs: [{
            id: 1, guild_id: demo.guild.id, discord_channel_id: freeGames.id, mention_role_id: role.gamers.id, custom_message: null, is_enabled: 1,
            notify_free: 1, notify_weekend: 0, notify_dlc: 0, notify_prime: 0, notify_gamepass: 0,
            filter_steam: 1, filter_epic: 1, filter_gog: 1, filter_prime: 1, filter_windows: 1, filter_mac: 0, filter_linux: 0,
        }],
    }, {
        alt: 'The Free games page: the form for adding a subscription with its preview, and one subscription posting free-to-keep games to #free-games with a Gamers mention.',
        guides: ['game-news'], scrollTo: '[aria-labelledby="fg-add-title"]',
    });

    const art = await ctx.file('game-news-art.png', () => ctx.artwork({ from: '#1f4f6b', to: '#c0763a', caption: 'Lanternwood' }));
    const BOT = 'CertiFried Utility';
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const names = {
        channels: allChannels.map((c) => ({ id: c.id, name: c.name })),
        roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    discord('game-news-discord', () => ({
        channel: 'free-games', ctx: names,
        messages: [{
            username: BOT, avatarUrl: `${B()}/images/CertiFried.png`,
            content: `<@&${role.gamers.id}> 🎮 **Free Game Alert!**`,
            embeds: [{
                color: '#0078F2', title: 'Lanternwood', url: 'https://example.invalid/',
                description: 'Light the lanterns of a forest village, trade with travelling merchants and keep the paths safe through the long winter nights.',
                fields: [
                    { name: '​', value: '~~$19.99~~ **Free** until 2026-11-26    8.4/10 ★' },
                    { name: '​', value: '[Open in browser ↗](https://example.invalid/)    [Open in Epic Games Launcher ↗](https://example.invalid/)' },
                ],
                image: art(), footer: 'via freestuffbot.xyz • Epic Games',
            }],
        }],
    }), {
        alt: 'A free game alert in #free-games pinging Gamers: an invented game on Epic Games, $19.99 struck through and free until 26 November, with links to the store and the launcher.',
        guides: ['game-news'],
    });
}
