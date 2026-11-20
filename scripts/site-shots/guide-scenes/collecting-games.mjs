// Screenshots for the collecting-games guide. Formats copied from: core/catbot/spawn-manager.js (the default appear
// and caught messages, the cat's picture from assets/catbot/, the Cat Coins line), core/catbot/emoji.js (😸 is the
// Good cat's emoji when the bot has no custom one), core/catbot/constants.js + economy.js (a Good cat is worth 8),
// dashboard/routes/api/features/minigames.js (the Minigames page's data).
import fs from 'node:fs';
import path from 'node:path';

export default async function ({ manage, discord, ctx, demo }) {
    const { channels, member: M } = demo;
    const BOT = 'CertiFried Utility';
    // Invented for these shots (fake id range).
    const cats = { id: '100400000000000092', name: 'cat-cafe' };
    const ctxNames = {
        channels: [...channels, cats].map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const bot = (extra) => ({ username: BOT, avatarUrl: `${B()}/images/CertiFried.png`, ...extra });

    // The bot's own generated cat art (scripts/catbot-generate-art.mjs, original to the project).
    const goodCat = await ctx.file('catbot-good.png', () => fs.readFileSync(path.join(ctx.root, 'assets', 'catbot', 'good.png')));
    discord('collecting-games-discord', () => ({
        channel: cats.name, ctx: ctxNames,
        messages: [
            bot({ time: 'Today at 7:40 PM', content: '😸 Good cat has appeared! Type "cat" to catch it!', images: [goodCat()] }),
            { username: M.pip.displayName, avatarUrl: ctx.av('pip'), bot: false, time: 'Today at 7:40 PM', content: 'cat' },
            bot({ time: 'Today at 7:40 PM', content: `😸 **${M.pip.username}** caught a **Good** cat! (2.418s)\n🪙 +**8** Cat Coins.` }),
        ],
    }), { alt: 'A Good cat appears in #cat-cafe with its picture. Pip types cat, and the bot says pipcalloway caught it in 2.418 seconds and earned 8 Cat Coins.', guides: ['collecting-games'] });

    // The Minigames page loads its settings from /api/guilds/:id/minigames after rendering.
    ctx.stub(/^\/api\/guilds\/\d+\/minigames\/?$/, () => ({
        catbot: {
            enabled: true,
            channels: [{ channel_id: cats.id, channel_name: cats.name, enabled: true, spawn_min: 120, spawn_max: 900, appear_msg: null, caught_msg: null }],
            settings: { guild_id: demo.guild.id, do_reactions: 1, do_rain: 1, auto_delete_catches: 0, anti_double_catch: 1, legacy_catching: 0, mute_achievements: 0 },
        },
        growtree: { planted: true, tree: { guild_id: demo.guild.id, name: 'Old Maple', size: 214 } },
        timezone: { enabled: false, config: null },
    }));
    manage('collecting-games-minigames-page', 'minigames', {}, {
        alt: 'The Minigames page: Cat Bot spawning in #cat-cafe every 120 to 900 seconds, with the form to add another channel and the Cat Bot option switches.',
        guides: ['collecting-games'], scrollTo: '#mg-cat-title',
    });
}
