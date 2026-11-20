// Checked against: dashboard/views/partials/manage/name-filters.ejs, avatar-protection.ejs and quarantine.ejs,
// dashboard/services/manage-sections.js (quarantine), dashboard/server.js (POST update-quarantine, release-quarantine),
// commands/admin/namefilter.js, commands/admin/avatarfilter.js, commands/admin/admin.js (mod quarantine),
// commands/admin/admin-mod-handler.js (handleQuarantine), core/command-mounts.js (namefilter under /moderation),
// core/name-filters.js, core/name-filter-logic.js, core/name-filter-templates.js, core/avatar-protection.js,
// core/avatar-match-logic.js, core/join-gate.js, core/raid-lockdown.js, core/manage-nav.js.
export default {
    slug: 'quarantine-name-avatar',
    title: 'Impersonators: name filters, avatar protection and quarantine',
    area: 'moderation',
    summary: 'Catch accounts that copy your staff\'s names or avatars, or use known scam names, and hold suspects in quarantine while you look.',
    result: {
        image: 'quarantine-name-avatar-test',
        caption: 'Testing the name "Jun1per V4le": with lookalikes folded it matches the protected staff name Juniper Vale.',
    },
    before: [
        'You need **Manage Server**. The pages are under **Protection & anti-raid**: **Name filters**, **Avatar protection** and **Quarantine**. The name commands are under `/moderation namefilter`; the avatar commands are `/avatarfilter`.',
        'Name and avatar checks are off until you turn them on, and new filters only log until you give them another action.',
    ],
    steps: [
        {
            title: 'Protect your staff\'s names',
            text: [
                'On **Name filters**, turn on the switch at the top of the page (**Check names**). Names are checked when someone joins and every time they change their username, display name or server nickname.',
                'Under **Auto-Pilot: protect staff names**, switch on **Auto-Pilot on**, add your **Staff roles covered** and pick the **Action for impersonators**. Auto-Pilot keeps an exact-name filter for each staff member and updates it when they rename. Names under 4 letters are skipped. **Fuzzy matching** is on by default, so lookalike letters, accents, invisible characters and leetspeak are folded first: `Jun1per V4le` still matches Juniper Vale.',
            ],
            command: '/moderation namefilter autopilot enabled:True add_role:@Moderators action:kick',
        },
        {
            title: 'Add your own filters and the scam templates',
            text: [
                'In **Add a filter**, the **Filter type** is a phrase the name contains (3 or more letters), a regex or an exact name. The **Action** is Log only, Flag with role, Timeout, Kick or Ban. **Preview who it hits** lists the members it would catch before you save; **Save** keeps it, and **Save and act** acts on them as well.',
                '**Templates** add curated packs that stay up to date: Staff & support impersonation, Ticket & appeal scams, Nitro & giveaway lures, and Web3 & crypto wallet lures. **Generated scam usernames** catches names like `fluffy_panda_4821`; start it on log only.',
            ],
            command: '/moderation namefilter add type:phrase pattern:hollow support action:kick',
        },
        {
            title: 'Protect your staff\'s avatars',
            text: [
                'On **Avatar protection**, turn on the switch at the top of the page (**Check avatars**). Under **Protected images**, protect a member\'s avatar, every member of a role, the server icon or an uploaded image. Accounts whose avatar looks like one of them are caught when they join and whenever they change avatar.',
                'At or above the **Act threshold** (0.90 by default) the **Action at the act threshold** is carried out; between it and the **Review threshold** (0.75) the member waits in the review queue. The action is Log only until you change it. **Known scam avatars** matches exact copies only, such as the plain black avatars scam accounts use.',
            ],
            command: '/avatarfilter add role:@Moderators',
        },
        {
            title: 'Check the members already here',
            text: [
                'Filters act on joins and name or avatar changes. To check everyone already in the server, run a cleanse from either page. **Start review cleanse** puts matches in the **Review queue**, where you choose Ban, Kick, Mark safe (Not a match for avatars) or Skip. **Force cleanse** acts at once with each filter\'s own action.',
                'Staff (the owner or anyone with a moderation permission), members on the **Protection settings** allowlist and members you marked safe are never acted on.',
            ],
            command: '/moderation namefilter cleanse mode:review',
        },
        {
            title: 'Hold a suspect in quarantine',
            text: [
                'On **Quarantine**, turn on the switch at the top of the page, pick a **Quarantine role** below the bot\'s highest role and select **Save**. Give that role as few permissions as possible, ideally one channel where they can talk to staff.',
                'Quarantining a member saves and removes their roles (managed roles such as boosts stay) and gives them the quarantine role. Releasing them, with `enable:False` or the **Release** button, gives back the saved roles the bot can still assign. The optional `reason:` is saved with the quarantine and shown in the audit log. **In quarantine now** lists everyone held.',
            ],
            command: '/admin mod quarantine user:@name enable:True reason:Copying a moderator\'s name',
            image: 'quarantine-name-avatar-page',
        },
    ],
    notes: [
        'Test before you act: `/moderation namefilter test` and `/avatarfilter test` show what a name, a member or an image matches. Nothing is acted on.',
        'The Flag action gives the member the **Role for the flag action** and takes it off again when they change to a clean name or avatar. It is not the quarantine role.',
        '**Tell people why by DM** is on by default for kicks, bans and timeouts. The filter itself is never shown to them.',
        'A raid lockdown set to quarantine every new join uses the same quarantine role and list. See [Raid protection and lockdown](/docs/guides/raid-protection).',
        'Both pages can export and import their lists as a JSON file: `/moderation namefilter export` and `/avatarfilter export`. Avatar files hold fingerprints, not pictures.',
        '`/moderation namefilter status` and `/avatarfilter status` show what each check is doing, and `hits` lists the most recent matches.',
    ],
    related: ['anti-nuke-join-gate', 'raid-protection', 'moderation', 'global-ban'],
};
