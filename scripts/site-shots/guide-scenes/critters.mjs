// Screenshots for the critters guide. Formats copied from: handlers/critters-actions.js (huntText, doZoo, doDaily),
// core/critters/constants.js (formatAcorns), core/critters/data/tiers.js and species.js (tiers, icons, critters),
// dashboard/views/partials/manage/critters.ejs and dashboard/routes/api/features/critters.js (the page and its API).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export default async function ({ manage, discord, ctx, demo }) {
    const { channels, channel, role, member: M } = demo;
    const imp = (rel) => import(pathToFileURL(path.join(ctx.root, rel)).href);
    const [{ TIERS }, { SPECIES }] = await Promise.all([imp('core/critters/data/tiers.js'), imp('core/critters/data/species.js')]);

    const BOT = 'CertiFried Utility';
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const bot = (extra) => ({ username: BOT, avatarUrl: `${B()}/images/CertiFried.png`, ...extra });
    const ctxNames = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const used = (k, command) => ({ name: M[k].displayName, command });
    const sp = (key) => SPECIES.find((s) => s.key === key);
    const tier = (key) => TIERS.find((t) => t.key === key);
    const acorns = (n) => `\u{1F330} ${n.toLocaleString('en-US')} ${n === 1 ? 'acorn' : 'acorns'}`;

    // ── Discord: a hunt, the zoo and the daily (handlers/critters-actions.js) ──
    const fox = sp('fox');
    const zoo = [
        ['common', [['worm', 6], ['ant', 9], ['snail', 4], ['ladybug', 7], ['cricket', 3], ['chick', 5], ['hamster', 2], ['frog', 4]]],
        ['uncommon', [['hedgehog', 3], ['duck', 2], ['rabbit', 4], ['squirrel', 1], ['bat', 2]]],
        ['rare', [['fox', 1], ['owl', 1]]],
    ];
    const kinds = zoo.reduce((n, [, l]) => n + l.length, 0);
    const caught = zoo.reduce((n, [, l]) => n + l.reduce((a, [, c]) => a + c, 0), 0);
    const pct = Math.round((kinds / SPECIES.length) * 1000) / 10;
    discord('critters-discord', () => ({
        channel: 'bot-commands', ctx: ctxNames,
        messages: [
            bot({
                usedBy: used('sorrel', '/owo hunt'),
                content: [
                    `**${M.sorrel.displayName}** pokes around the undergrowth and spots a ${tier(fox.tier).name.toLowerCase()} critter: ${fox.emoji} **${fox.name}**`,
                    `+${acorns(tier('rare').points)} · first ${fox.name} you have ever caught`,
                    `Your team picks up ${tier('rare').xp} XP each.`,
                ].join('\n'),
            }),
            bot({
                usedBy: used('sorrel', '/owo zoo'), time: 'Today at 7:43 PM',
                embeds: [{
                    color: '#5f7a4f', title: `${M.sorrel.displayName}'s zoo`,
                    fields: zoo.map(([t, list]) => ({ name: `${tier(t).icon} ${tier(t).name}`, value: list.map(([k, c]) => `${sp(k).emoji} ${c}`).join('  ') })),
                    footer: `${kinds}/${SPECIES.length} kinds found · ${caught} caught in all · ${pct}% of the catalog`,
                }],
            }),
        ],
    }), { alt: 'Sorrel Quinn hunts with /owo hunt and finds a rare Ember Fox for 25 acorns, then /owo zoo shows 15 of 40 kinds of critter caught.', guides: ['critters'] });

    // ── Dashboard: Games > Critters (loads everything from /api/guilds/:id/owo) ──
    const total = TIERS.reduce((s, t) => s + t.weight, 0);
    const catalog = TIERS.map((t) => ({
        rank: t.key, name: t.name, rarity: Math.round((t.weight / total) * 1e5) / 1e3, order: t.order, price: t.sell, points: t.points,
        essence: t.essence, xp: t.xp, ranch: t.ranch, emoji: t.icon, color: `#${t.color.toString(16).padStart(6, '0')}`,
        animals: SPECIES.filter((s) => s.tier === t.key).map((s) => ({ name: s.name, key: s.key, emoji: s.emoji, rank: s.tier, description: s.description })),
    }));
    const byRank = [[5712, 8], [2290, 8], [846, 7], [281, 6], [71, 5], [13, 3], [1, 1]];
    ctx.stub(/^\/api\/guilds\/\d+\/owo\/catalog$/, () => ({ success: true, catalog, rewards: [] }));
    ctx.stub(/^\/api\/guilds\/\d+\/owo\/config$/, () => ({
        success: true,
        config: {
            enabled: true, hunt_cooldown_seconds: 15, reward_currency_multiplier: 1, reward_xp_multiplier: 1, sell_multiplier: 0.5, sacrifice_xp_multiplier: 1,
            disabled_subcommands: ['lottery'], allowed_channel_ids: [channel['bot-commands'].id], blocked_role_ids: [role.muted.id], announce_rare_catches: true, hasRow: true,
        },
    }));
    ctx.stub(/^\/api\/guilds\/\d+\/owo\/stats$/, () => ({
        success: true,
        stats: { hunters: 48, uniqueCatches: 38, totalCatches: byRank.reduce((a, [n]) => a + n, 0), last24hCatches: 312, byRank: TIERS.map((t, i) => ({ rank: t.key, total: byRank[i][0], uniqueAnimals: byRank[i][1] })) },
    }));
    ctx.stub(/^\/api\/guilds\/\d+\/owo\/leaderboard\/\w+$/, () => ({
        success: true,
        leaderboard: [['pip', 1204], ['sorrel', 988], ['wren', 731], ['thistle', 540], ['hazel', 402]].map(([k, n]) => ({ userId: M[k].id, displayName: M[k].displayName, total: n })),
    }));
    ctx.stub(/^\/api\/guilds\/\d+\/owo\/module-snapshot$/, () => ({
        success: true,
        snapshot: { hunters: 48, weaponOwners: 21, teamOwners: 33, battlesFought: 1460, autohuntActive: 9, questHolders: 27, ranchClaims: 380, luckRolls: 610, cratesUnopened: 14, totalShards: 5230 },
    }));
    manage('critters-page', 'owo', {}, {
        alt: 'The Critters page on the dashboard: the game switched on, 48 hunters and 9,214 catches so far, and rare catches sent to the log channel.',
        guides: ['critters'], height: 900,
    });
}
