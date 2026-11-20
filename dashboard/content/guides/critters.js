// Checked against: LICENSE-OWO-NOTICE.md, docs/owo-cleanroom-spec.md, core/critters/constants.js, core/critters/config.js,
// core/critters/rules/config-rules.js, core/critters/rules/game-rules.js, core/critters/data/tiers.js,
// core/critters/data/species.js, core/critters/data/economy.js, core/critters/boss.js, core/critters/passive.js,
// core/critters/store.js, core/critters-natural-prefix.js, handlers/critters-actions.js, commands/fun/critters.js,
// commands/fun/critters-extra.js, commands/fun/critters-autohunt.js, core/command-registration.js (TEXT_MERGE),
// core/universal-commands.js (describePath), docs/command-split-2026-11-18.md, core/manage-nav.js,
// dashboard/views/partials/manage/critters.ejs, dashboard/routes/api/features/critters.js,
// dashboard/views/partials/manage/logging.ejs.
export default {
    slug: 'critters',
    title: 'Critters: catch, collect and battle',
    area: 'games',
    summary: 'A collecting game: members hunt for critters, keep them in a zoo, build teams of three and battle, all for acorns.',
    result: {
        image: 'critters-discord',
        caption: 'A hunt that finds a rare Ember Fox, then the member\'s zoo with 15 of the 40 critters found.',
    },
    before: [
        'You need **Manage Server**. The settings are on the dashboard under **Games**, then **Critters**.',
        'Critters commands are not in Discord\'s `/` menu: members type them as a message, for example `/owo hunt`. `!owo hunt` works too, and so does the short form with no symbol, such as `owoh` or `owo zoo`.',
    ],
    steps: [
        {
            title: 'Switch the game on',
            text: [
                'Critters is off in every server until you turn it on. Flip **Game on** on the Critters page; it saves straight away. Typing `/owo toggle enabled:True` in the server does the same.',
                'Turning it off later keeps everyone\'s critters and acorns, and also silences the `owo` chat prefix.',
            ],
            command: '/owo toggle enabled:True',
            image: 'critters-page',
        },
        {
            title: 'Set the pace and the rewards',
            text: [
                '**Hunt cooldown** is the wait between hunts: 15 seconds unless you change it, from 1 to 3600. **Acorns per catch**, **Team XP per catch**, **Sell price** (0.5, half price, by default) and **Essence per sacrifice** multiply the game\'s own numbers, from 0.1 to 10. Each section has its own **Save** button.',
            ],
        },
        {
            title: 'Choose where and who',
            text: [
                '**Game channels** keeps every Critters command in the channels you pick; leave it empty for every channel. Members with any of the **Blocked roles** cannot play.',
                'Under **Command switches**, untick any part of the game you do not want, such as **Battles** or **Lottery**, then select **Save switches**. A part that is off stays off for `/owo`, `!owo` and the `owo` prefix alike.',
            ],
        },
        {
            title: 'Hunt, collect and battle',
            text: [
                'Each `/owo hunt` finds one critter (gems can raise that) and pays acorns: 2 for a common critter, up to 40,000 for a fabled one. There are 40 critters in seven tiers, from Common (62% of catches) to Fabled (0.02%). Everyone starts with 15,000 acorns.',
                '`/owo zoo` shows what you have caught. `/owo team add fox` puts a critter on your active team (three slots, up to five teams), and `/owo battle` fights a wild team, or a member with `opponent:` and an optional `bet:` of up to 250,000 acorns.',
            ],
            command: '/owo hunt',
        },
    ],
    notes: [
        'Acorns belong to the game. They are kept apart from the server [economy](/docs/guides/economy), and Critters never gives leveling XP.',
        '`/owo daily` pays 500 acorns, plus 75 for every day of your streak after the first, up to 2,750. Leave more than 48 hours between claims and the streak starts again.',
        '`/owo sell rank:common` and `/owo sacrifice rank:common` only take spares: you always keep one of each critter. Sacrificing gives essence, which feeds your critters pet XP.',
        '`/owo autohunt enable` sends your critters out every 30 minutes, up to 24 trips, until you collect them with `/owo autohunt claim`. Turning autohunt off loses any trips you have not collected.',
        'After any hunt there is a 1.5% chance a guild boss appears. Members fight it with their teams, and if it falls within the hour everyone who fought is paid by damage dealt. Members with Manage Server can call one with `/owo boss action:spawn`.',
        'With **Log rare catches** on, epic, mythical, legendary and fabled catches are posted to the log channel you set for **Critters rare catch** on the **Logging** page.',
        'The **Members** section looks a member up by user ID and can give or take critters, acorns, shards, crates and lootboxes. Every change made there is posted to your log channel.',
        'Critters is CertiFried\'s own game. It keeps the `owo` command words players already know, but its critters, numbers and text were written from scratch.',
    ],
    related: ['economy', 'collecting-games', 'chat-games'],
};
