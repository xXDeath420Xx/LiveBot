// Checked against: dashboard/views/partials/manage/custom-commands.ejs, dashboard/routes/api/features/custom-commands.js,
// core/custom-commands.js, core/custom-command-handler.js, core/custom-command-vars.js, core/custom-command-templates.js,
// commands/admin/cc.js, core/command-mounts.js, core/command-registration.js, core/universal-commands.js (describePath,
// runUniversalCommand, parseOptions), core/prefix-command-manager.js, dashboard/views/partials/manage/command-center.ejs,
// dashboard/views/partials/manage/autoresponders.ejs, dashboard/routes/api/features/autoresponders.js,
// core/auto-response-manager.js, dashboard/views/partials/manage/tags.ejs, commands/community/engage.js (tags group),
// commands/community/engage-tags-handler.js, core/tags-manager.js, events/messageCreate.js, core/manage-nav.js,
// docs/command-split-2026-11-18.md.
export default {
    slug: 'custom-commands',
    title: 'Custom commands, auto-responses and tags',
    area: 'tools',
    summary: 'Commands with your own replies, answers the bot posts when a message matches a phrase, and saved snippets members can post by name.',
    result: {
        image: 'custom-commands-discord',
        caption: 'A member runs the custom command !cookie, then another asks where to get roles and an auto-response answers.',
    },
    before: [
        'You need **Manage Server**. The pages are on the dashboard under **Custom commands & AI**: **Custom commands**, **Auto-responses** and **Tags**.',
    ],
    steps: [
        {
            title: 'Create a custom command',
            text: [
                'On **Custom commands**, give it a **Name**: letters, numbers, - and _, up to 30 characters, without the prefix. A name that is already a built-in command is refused.',
                'Under **What it does**, pick **Reply**, **Give a role** or **Remove a role**. A role command gives or takes the role from whoever runs it, or from the member they mention; roles above the bot\'s highest role cannot be used. Write the **Reply** (up to 2,000 characters), select **Test** to see exactly what the bot will send, then **Create command**.',
                '**Start from a template** fills in the editor with one of 10 ready-made commands, each under a name that is free to use. A name chat already answers, such as `welcome` (it runs the bot\'s own welcome commands), is refused.',
            ],
            image: 'custom-commands-page',
        },
        {
            title: 'Use variables, API calls and storage',
            text: [
                '`{user.mention}` pings the member mentioned (or whoever ran it), `{sender}` is the name of whoever ran it, and `{touser}` is the first person mentioned. `{args}` is everything typed after the name and `{arg1}` to `{arg9}` are single words. `{random:1-100}` and `{choice:a|b|c}` pick at random. Click a variable in the **Variables** panel to insert it.',
                '`{api:https://...}` fetches a public web address and inserts the reply: up to 3 calls per reply, 5 seconds and 400 characters each, and 20 calls a minute per server. `{db:incr:cookies}` keeps a count for each member and `{sdb:...}` keeps one value for the whole server.',
            ],
        },
        {
            title: 'Limit it, then run it from chat',
            text: [
                '**Only members with** takes up to 25 roles (any one of them will do) and **Only in** up to 25 channels; anywhere else the bot says where it can be used.',
                'Members type the server prefix and the name, for example `!cookie`; the **Run with** box at the top of the page shows your prefix. They can also be used from Discord by typing `/cc list`, `/cc show` or `/cc run` as a message, which anyone can do; `/cc add` and `/cc remove` need **Manage Server**.',
            ],
            command: '/cc add cookie {sender} has {db:incr:cookies} cookies',
        },
        {
            title: 'Reply to phrases with auto-responses',
            text: [
                'On **Auto-responses**, type a **Trigger** (up to 500 characters) and choose how it is matched under **Match**: contains, exact, starts with, ends with, a wildcard or a regular expression. **Reply with** is **Text**, **Embed** or **Reactions** (up to 20 emoji, nothing is posted).',
                'Text and embeds can use `{user}`, `{username}`, `{displayname}`, `{server}`, `{channel}`, `{membercount}` and `{#channel-name}`. **Reply to the message**, **Delete the trigger message**, **Case sensitive**, a cooldown of up to 86,400 seconds (per member, per channel, or for everyone) and channel and role limits are on the same form.',
            ],
        },
        {
            title: 'Let members save tags',
            text: [
                'Any member can save a tag with `/engage tags create`, giving a **name**, the **content** and, if they want, an embed title, description and colour. Anyone then posts it by typing `!` and the name, or with `/engage tags get`.',
                'Only the member who made a tag can edit or delete it from Discord. Staff can read and delete any tag on the **Tags** page, which also shows who made each one and how often it was used.',
            ],
            command: '/engage tags create name:faq content:Read #rules first, then ask in #support.',
        },
    ],
    notes: [
        'Custom commands from chat need **Prefix commands** switched on (it is on unless you changed it) on the **Prefixes and aliases** page. See [Commands, prefixes and who can use them](/docs/guides/commands).',
        'A built-in command always wins over a custom command or a tag with the same name, and a custom command wins over a tag.',
        'Text from an API call or from storage can never ping @everyone, @here or a role. If a call fails, the reply shows `(API error)`.',
        'Only the first auto-response that matches a message answers it. Changes to auto-responses apply at once.',
        'Tags always use `!`, whatever your server prefix is. Editing a tag with `/engage tags edit` and no embed options removes its embed.',
        'The **Uses** column on each page counts how often each command, auto-response or tag was used.',
    ],
    related: ['commands', 'announcements', 'ai-assistant', 'moderation'],
};
