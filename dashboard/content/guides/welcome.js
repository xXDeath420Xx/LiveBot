// Checked against: core/greeting-manager.js (join, leave and ban posts, the card), core/template-resolver.js,
// dashboard/views/partials/manage/welcome.ejs, commands/community/manage.js (welcome group),
// commands/community/manage-welcome-handler.js, core/welcome-background.js.
export default {
    slug: 'welcome',
    title: 'Welcome messages and cards',
    area: 'community',
    summary: 'Greet new members in a channel with a message and a welcome card, and say goodbye when they leave.',
    result: {
        image: 'welcome-discord',
        caption: 'A welcome post with the card. Its heading is picked at random from a list of greetings.',
    },
    before: [
        'You need **Manage Server**. Settings are on the dashboard under **Verification & joining**, then **Welcome messages**.',
    ],
    steps: [
        {
            title: 'Pick the channel and the style',
            text: [
                'Choose the **Welcome channel**. **Message style** is Plain text or Embed; an embed takes the **Embed colour** (light purple if you leave it empty).',
            ],
            image: 'welcome-page',
        },
        {
            title: 'Write the welcome text',
            text: [
                '`{user.mention}` mentions the new member and `{user}` is their username as plain text. `{server}` is the server name and `{memberCount}` the number of members.',
                '`{choice:Hi|Hello|Hey}` picks one option at random for each join, and `{random:1-100}` picks a number. A placeholder the bot does not know is left as you typed it.',
            ],
        },
        {
            title: 'Add the welcome card',
            text: [
                'Turn on **Banner image** to attach a card with the member\'s avatar. Set the **Banner title** and **Banner subtitle**; on the card, `{user}` is the member\'s display name, and `{server}`, `{memberCount}` and `{memberOrdinal}` (for example 1284th) work too.',
                'Upload a **Background image** (JPG or PNG, up to 5 MB) or paste a link to one. Without one the card is plain black.',
            ],
        },
        {
            title: 'Set farewells and a welcome DM',
            text: [
                '**Farewell messages** post when someone leaves; the default is "**{user}** left the server." **Send a DM on join** sends the new member a private message as well. **Ban announcements** post when someone is banned, at most 5 a minute.',
            ],
        },
    ],
    notes: [
        'Bots that join get no greeting, only the bot autoroles you choose.',
        'To give every new member a role, use `/manage welcome set-autorole role:@Members`.',
        'The welcome message can also be set with `/manage welcome set-welcome channel:#welcome message:...`, but the dashboard has every option. Leaving out `enable-banner:` keeps the banner as it is, and a `background:` image (PNG or JPG, up to 5 MB) is saved the same way as a dashboard upload.',
        '`/manage welcome test` shows you the welcome post as a new member would get it, card included. Only you see it.',
    ],
    related: ['reaction-roles', 'raid-protection', 'levels'],
};
