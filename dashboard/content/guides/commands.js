// Checked against: dashboard/views/partials/manage/commands.ejs, dashboard/views/partials/manage/command-center.ejs,
// dashboard/views/partials/manage/language.ejs, dashboard/views/partials/manage/core.ejs (Prefix commands),
// dashboard/views/manage-tailwind.ejs, dashboard/server.js (/manage loader: commandSettings, commandRestrictions,
// prefixConfig, availableLocaleMeta; POST /manage/:guildId/language), dashboard/routes/api/features/commands.js,
// dashboard/routes/api/features/prefix-commands.js, core/command-restrictions.js, core/command-registration.js,
// core/universal-commands.js (DEFAULT_PREFIXES, describePath), core/prefix-command-manager.js (stripPrefix,
// handlePrefixCommand, hintUnknownSlashText, built-in prefix, alias, disable, enable), core/prefix-command-registry.js,
// events/interactionCreate.js (ADMIN_CATEGORIES), commands/tools/settings.js, utils/i18n-catalogue.js,
// docs/command-split-2026-11-18.md, core/manage-nav.js.
export default {
    slug: 'commands',
    title: 'Commands, prefixes and who can use them',
    area: 'start',
    summary: 'How members run the bot\'s commands, and how to turn commands off, keep them for staff or limit them to certain roles and channels.',
    result: {
        image: 'commands-page',
        caption: 'The Commands page: each command with Slash or Text, its uses in the last 30 days, and who can use it.',
    },
    before: [
        'You need **Manage Server**. The pages are on the dashboard under **Bot & server setup**: **Commands**, **Prefixes and aliases** and **Language**.',
    ],
    steps: [
        {
            title: 'Know how a command is run',
            text: [
                'Admin, setup, moderation and protection commands are slash commands: pick them from the / menu. Games, fun and lookup commands are typed as an ordinary message that starts with `/`, such as `/owo hunt`, and are not in the / menu.',
                'Every command also works with a prefix: `!`, `?`, `$` and `.` by default, so `!play` runs `/music play`. On **Commands**, each command is marked **Slash**, **Text** or **Slash and text**, and its **Settings** say exactly what to type.',
            ],
        },
        {
            title: 'Turn a command off or keep it for staff',
            text: [
                'On **Commands**, the list next to each command sets who can use it. **Everyone** adds no check of its own. **Mod only** means members also need **Manage Server**. **Disabled** means nobody can use it in this server. Select **Save changes** in the bar that appears.',
                'Admin commands start as **Mod only**; everything else starts as **Everyone**. Discord also checks the permission most admin commands ask for, whatever you pick here. To change who passes that check, use **Server Settings**, **Integrations** in Discord.',
            ],
        },
        {
            title: 'Limit it by role, channel and cooldown',
            text: [
                '**Settings** on a command opens its rules: **Allowed roles** and **Blocked roles** (a blocked role wins over an allowed one), **Allowed channels** and **Blocked channels**, and a **Cooldown** in seconds for each member, each channel or the whole server.',
                '**Private replies** shows the reply only to the person who used it (slash commands only). **Delete the reply after** removes it after up to 600 seconds, and **Refusal message** replaces the usual "not allowed" text. A subcommand follows its command until you turn off **Same as**; its own rules then replace the command\'s.',
                'The rules apply the same way whether the command is picked from the / menu or typed in chat.',
            ],
            image: 'commands-drawer',
        },
        {
            title: 'Set your prefixes and shortcuts',
            text: [
                'On **Prefixes and aliases**, **Prefixes** lists the symbols that start a command in chat. A prefix is 1 to 5 symbols with no letters or digits, you can have up to 8, and it only counts when a letter follows it, so `...` and `$5` stay ordinary messages. `/` always works.',
                '**Respond to @mentions** lets members start a command by mentioning the bot. **Reach every slash command from chat** is what makes `!play` work. **Prefix commands** is the main switch: with it off, only slash commands and commands typed with `/` work. Select **Save**.',
                'The **Shortcuts** tab points a short word at any command, for example `pp` at `music play`. A shortcut is letters, numbers, `-` and `_`, up to 30 characters, and members type it after a prefix.',
            ],
        },
        {
            title: 'Choose the language',
            text: [
                'On **Language**, **Default language** is used for members who have not picked one. The default is **Follow each member\'s Discord language**. The bot has English, German, Spanish, French, Japanese and Portuguese (Brazil); text that is not translated yet is shown in English.',
                'Members can pick their own with `/settings language` and `scope:` Me. `scope:` Server changes the server default and needs **Manage Server**.',
            ],
            command: '/settings language',
        },
    ],
    notes: [
        'A message that starts with `/` and a word that is not a command gets the reply "Unknown command — try /help", at most once a minute for each member. Tone tags such as `/s` and `/j` are left alone.',
        'Commands typed as a message keep the same permissions, role and channel rules, cooldowns and feature switches as slash commands.',
        'In chat, members with **Manage Server** can use `!prefix` to change the main prefix, `!alias add` and `!alias remove` for shortcuts, and `!disable` and `!enable` to turn a prefix command off and on.',
        '**General settings**, under **Prefix commands**, has **Delete trigger messages** (removes the member\'s message after a built-in prefix command runs), **Self-destruct delay** and **Private categories** (replies to built-in prefix commands in those categories delete themselves after the delay).',
        'With [your own branded bot](/docs/guides/custom-bot), all of this works the same.',
    ],
    related: ['getting-started', 'custom-bot', 'custom-commands', 'moderation'],
};
