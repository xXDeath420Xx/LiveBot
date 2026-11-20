// Screenshots for the ai-assistant guide. Formats copied from: events/messageCreate.js (the answer is a plain reply to the member's
// message, no embed) and core/ai-assistant.js (get_server_info: the server's name, member count and owner).
export default async function ({ discord, ctx, demo }) {
    const { guild, channels, roles, member: M } = demo;
    const BOT = 'CertiFried Utility';
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    discord('ai-assistant-discord', () => ({
        channel: 'general',
        ctx: {
            channels: channels.map((c) => ({ id: c.id, name: c.name })),
            roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
            users: [{ id: demo.BOT_ID, name: BOT }, ...demo.members.map((m) => ({ id: m.id, name: m.displayName }))],
        },
        messages: [
            { username: M.wren.displayName, avatarUrl: ctx.av('wren'), bot: false, time: 'Today at 7:41 PM',
                content: `<@${demo.BOT_ID}> how many people are in this server, and who runs it?` },
            { username: BOT, avatarUrl: `${B()}/images/CertiFried.png`,
                content: `${guild.name} has ${guild.memberCount.toLocaleString('en-GB')} members, and it is owned by ${M.juniper.displayName}.` },
        ],
    }), {
        alt: 'Wren Alder mentions the bot in #general to ask how many people are in the server and who runs it; the bot replies that Maple Hollow has 1,284 members and is owned by Juniper Vale.',
        guides: ['ai-assistant'],
    });
}
