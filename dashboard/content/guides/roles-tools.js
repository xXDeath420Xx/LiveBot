// Checked against: dashboard/views/partials/manage/role-manager.ejs, dashboard/routes/api/features/role-manager.js
// (Manage Roles check, restore), core/role-manager-logic.js (who can change which role),
// dashboard/views/partials/manage/bulk-roles.ejs, dashboard/routes/api/features/bulk-roles.js, core/bulk-role-creator.js
// (limits), commands/admin/admin.js + commands/admin/admin-roles-handler.js (/admin roles bulk-create),
// dashboard/views/partials/manage/stat-roles.ejs, core/statrole-rules.js, jobs/statrole-scheduler.js,
// dashboard/views/partials/manage/utilities.ejs (Autoroles), core/feature-config-spec.js (sticky-roles, colorroles),
// events/guildMemberAdd.js, dashboard/views/partials/manage/channel-access.ejs,
// dashboard/routes/api/features/channel-access.js, commands/admin/admin-channelaccess-handler.js,
// commands/tools/tools.js + commands/tools/tools-color-handler.js (/tools colorrole), core/manage-nav.js.
export default {
    slug: 'roles-tools',
    title: 'Role tools',
    area: 'community',
    summary: 'Edit and hand out roles from the dashboard, create many at once, give roles for activity, and give members their roles back when they return.',
    result: {
        image: 'roles-tools-page',
        caption: 'Stat roles: rules that give a role for messages sent, time in voice and account age.',
    },
    before: [
        'You need **Manage Server** for the pages, which are on the dashboard under **Roles**. Editing or creating roles on **Roles** and **Bulk roles** also needs **Manage Roles**, and you can only change roles below your own highest role (the server owner can change any of them). The bot can only give or change roles below its own highest role.',
    ],
    steps: [
        {
            title: 'Edit and give roles',
            text: [
                'The **Roles** page lists every role, highest first. Pick one to change its name, colour, permissions, **Display separately** and **Allow anyone to @mention it**, move it up or down, see who has it, give it to someone, or delete it.',
                'On the **Members** tab, look a member up by name, mention or user ID (a user ID also finds people who have left) to see their roles, their role history and what they had when they last left. The **Restore** button gives back the roles they had then.',
            ],
        },
        {
            title: 'Create many roles at once',
            text: [
                'On **Bulk roles**, write one role name per line; lines starting with `//` are skipped. **Colour** (a hex code, a name such as `blurple`, or `random`), **Permissions**, **Placement**, **Display separately** and **Allow @mention** apply to every role, or set them for one line with `Name | #ff0000 | hoist`. **Start from a list** fills in ready-made colour, pronoun or ping roles.',
                'Press **Preview**, then **Create roles**. Names that already exist are skipped. The bot makes up to 50 roles at a time, and a server can have 250 in all.',
            ],
            command: '/admin roles bulk-create color:random',
        },
        {
            title: 'Give roles for activity',
            text: [
                '**Stat roles** gives a role when a member reaches a number. Press **Add rule** and choose the **Role to give**, the **Statistic** and the **Required value**, then **Save**. Statistics are **Messages sent**, **Minutes in voice**, **Level** (leveling must be on), **Members invited** (joins through their invites in the last 180 days), **Account age (days)** and **Days in this server**.',
                'Members are checked as they are active, and everyone every 15 minutes. A role is only taken back when **Remove if no longer met** is ticked, and only if the bot gave it. A server can have up to 50 rules.',
            ],
        },
        {
            title: 'Give roles on join and on return',
            text: [
                '**Autoroles**, on the **Utilities** page, gives **Roles for new members** (up to 10) and separate **Roles for bots**. You can **Wait before giving them** (up to 10080 minutes, which is 7 days), give them **Only members with one of these roles** such as Verified, or **Skip members with any of these roles**. **Give the roles to existing members** hands them to everyone already in the server, about one member a second.',
                '**Sticky Roles** gives members who leave and come back the roles they had. Switch on **Give roles back on rejoin**, set **Remember roles for (days)** (30 by default, 1 to 365) and pick any roles under **Never give back these roles**. Boost roles, bot roles and roles at or above the bot\'s are never given back.',
            ],
        },
        {
            title: 'Turn per-member channel access into a role',
            text: [
                '**Channel access** finds channels where members were let in one by one. Pick the role that should give access, press **Preview**, then **Convert**: everyone on the list gets the role, the role gets only the permissions every listed member shares, and a member\'s own overwrite is deleted only once the role covers it.',
                'Ticket channels and channels with fewer than 3 listed members are skipped. Tick **Keep it enforced** to move anyone given access later onto the role.',
            ],
            command: '/admin channel-access scan',
        },
    ],
    notes: [
        'Members can choose their own name colour by typing `/tools colorrole set hex:#3f8f6b` as a message, and remove it with `/tools colorrole remove`. The **Colour Roles & AFK** page switches this on or off (on by default) and sets the **Level needed to pick a colour** and the **Most colour roles in the server** (50 by default).',
        'Self-assign role panels are in [Reaction roles](/docs/guides/reaction-roles), and level rewards in [Levels](/docs/guides/levels).',
        '`/admin channel-access` needs Administrator; `/admin roles bulk-create` needs Manage Server and Manage Roles, and asks for the names in a form.',
        'Overwrites that only deny permissions are restrictions, so Channel access never counts or changes them.',
    ],
    related: ['reaction-roles', 'levels', 'welcome', 'verification'],
};
