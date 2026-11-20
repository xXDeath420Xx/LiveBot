// Screenshots for the confessions-qotd guide. Formats copied from: commands/fun/fun-confess-handler.js
// (confessionEmbed: "📝 Confession #N", primary colour, "Anonymous" footer), core/qotd-poster.js (postQOTD: the ping
// roles as message content, the embed with the channel's title or "Question of the Day", colour #5865f2, timestamp).
export default async function ({ discord, ctx, demo }) {
    const { channel, channels, role } = demo;
    const BOT = 'CertiFried Utility';
    // Invented for these shots (fake id range).
    const confessions = { id: '100400000000000093', name: 'confessions' };
    const ctxNames = {
        channels: [...channels, confessions].map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const bot = (extra) => ({ username: BOT, avatarUrl: `${B()}/images/CertiFried.png`, ...extra });

    discord('confessions-qotd-discord', () => ({
        channel: confessions.name, ctx: ctxNames,
        messages: [
            bot({
                time: 'Today at 11:12 PM',
                embeds: [{
                    color: '#5865F2', title: '📝 Confession #12',
                    description: 'I have been watering the server tree at 3am for a month so I could see it pass 200 ft first. No regrets.',
                    footer: 'Anonymous', timestamp: true,
                }],
            }),
        ],
    }), { alt: 'Confession number 12 in #confessions: a member admits to watering the server tree at 3am for a month, with the footer Anonymous.', guides: ['confessions-qotd'] });

    discord('confessions-qotd-qotd-discord', () => ({
        channel: channel.general.name, ctx: ctxNames,
        messages: [
            bot({
                time: 'Today at 9:00 AM',
                content: `<@&${role.regulars.id}>`,
                embeds: [{
                    color: '#5865F2', title: 'Question of the Day',
                    description: 'If you could master any skill overnight, which would you pick and why?',
                    timestamp: true,
                }],
            }),
        ],
    }), { alt: 'A Question of the Day post in #general at 9:00 AM, pinging the Regulars role, asking which skill you would master overnight.', guides: ['confessions-qotd'] });
}
