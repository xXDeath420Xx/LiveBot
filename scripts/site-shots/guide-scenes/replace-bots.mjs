// Screenshots for the replace-bots guide. Formats copied from: commands/admin/takeover.js (the `bots` reply: colour
// 0xF2A65A, "Known bots in this server", one line per bot) and core/takeover-bots.js (each bot's first feature, and
// DISBOARD's "why" text).
export default async function ({ discord, ctx, demo }) {
    const { channels, member: M } = demo;
    const ctxNames = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const origin = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const bot = (extra) => ({ username: 'CertiFried Utility', avatarUrl: `${origin()}/images/CertiFried.png`, ...extra });

    discord('replace-bots-discord', () => ({
        channel: 'bot-commands', ctx: ctxNames,
        messages: [bot({
            usedBy: { name: M.juniper.displayName, command: '/utilities takeover bots' }, ephemeral: true,
            embeds: [{
                color: '#F2A65A', title: 'Known bots in this server',
                description: [
                    '✅ **MEE6** — we cover this (`leveling`)',
                    '✅ **Carl-bot** — we cover this (`reaction_roles`)',
                    '✅ **Streamcord** — we cover this (`streams`)',
                    '⚠️ **DISBOARD** — server-listing bump service — nothing to replace.',
                ].join('\n'),
            }],
        })],
    }), {
        alt: 'The private reply to /utilities takeover bots: MEE6, Carl-bot and Streamcord are covered, and DISBOARD has nothing to replace.',
        guides: ['replace-bots'],
    });
}
