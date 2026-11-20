// Screenshots for the verification guide. Formats copied from: core/verification.js (buildPanel, panelText),
// core/auto-prune-logic.js (formatMinutes: 5 minutes is "5 min").
export default async function ({ discord, ctx, demo }) {
    const { guild, channels } = demo;
    const BOT = 'CertiFried Utility';
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);   // the local server's origin, once it runs
    const bot = (extra) => ({ username: BOT, avatarUrl: `${B()}/images/CertiFried.png`, ...extra });
    const names = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };

    // The panel in CAPTCHA mode with the defaults: 3 tries, a 5-minute time limit, no custom title or text.
    discord('verification-panel', () => ({
        channel: 'verify', ctx: names,
        messages: [bot({
            embeds: [{
                color: '#5865F2', title: `Welcome to ${guild.name}`,
                description: 'Press **Verify me** and type the code from the picture on the keypad to unlock the server.\nYou have **3** tries within **5 min** of joining.',
                footer: 'This keeps raids and spam bots out of the community.',
            }],
            buttons: [{ label: 'Verify me', style: 'success' }], buttonEmoji: ['🔐'],
        })],
    }), { alt: 'The verification panel in #verify: Welcome to Maple Hollow, press Verify me and type the code from the picture, 3 tries within 5 minutes.', guides: ['verification'] });
}
