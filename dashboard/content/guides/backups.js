// Checked against: utils/backup-utils.js (what a backup holds, BACKUP_CONFIG_TABLES), jobs/backup-scheduler.js,
// index.js (startBackupScheduler), dashboard/routes/features/backups.js (create, restore, delete, compare),
// dashboard/views/partials/manage/backups.ejs, events/guildMemberAdd.js (roles back on rejoin),
// commands/admin/admin.js + commands/admin/admin-backup-handler.js (/admin backup), dashboard/server.js
// (checkGuildAdmin, import-csv, export), dashboard/views/partials/manage/csv.ejs, core/server-transfer-manager.js,
// dashboard/routes/api/features/server-transfer.js, dashboard/views/manage-tailwind.ejs (transfer banner),
// core/manage-nav.js.
export default {
    slug: 'backups',
    title: 'Server backups',
    area: 'tools',
    summary: 'Keep a copy of your roles, channels, permissions and bot settings, and put them back if something goes wrong.',
    result: {
        image: 'backups-page',
        caption: 'The Backups page: name a new backup, then compare, restore or delete the ones already saved.',
    },
    before: [
        'You need **Manage Server**. Backups are on the dashboard under **Bot & server setup**, then **Backups**.',
    ],
    steps: [
        {
            title: 'Know what a backup holds',
            text: [
                'A backup saves your roles (name, colour, permissions, display separately, mentionable), the @everyone permissions, categories and channels with their permission overwrites, topics and slow mode, server settings, emojis, stickers, webhooks, bans, and which roles each member has.',
                'It also saves the bot\'s settings for this server: welcome messages, logging, AutoMod, levels, tickets, reaction-role panels, custom commands, reminders and most other features. Messages are never backed up.',
            ],
        },
        {
            title: 'Let the weekly backup run, or make one now',
            text: [
                'Every server gets an automatic backup each Sunday at 04:00 UTC, named "Auto Weekly" with the date. The 4 newest weekly backups are kept and older ones are deleted. Backups you make yourself are never deleted for you.',
                'Before a big change, type a **Name** under **Create a backup** (up to 100 characters) and press **Create backup**. It takes a few seconds on a large server.',
            ],
        },
        {
            title: 'Compare a backup with the server',
            text: [
                '**Compare** lists what changed since the backup: roles deleted, added or changed (colour, permissions, display separately), categories and channels deleted or added, the server name, verification level and content filter, and how many emojis were added or removed. It changes nothing.',
            ],
        },
        {
            title: 'Restore a backup',
            text: [
                'Choose how long to **Give roles back to members who rejoin** (7 to 90 days, 30 by default, or Off), then press **Restore…** next to the backup. A preview lists what would be created, changed and deleted; nothing changes until you press **Restore** in it.',
                'Roles, categories and channels are matched to the ones in the server (the same item first, then by name). Missing ones are made again, the others are set back to how they were, including their permissions and order, and members still in the server get their roles back. Missing emojis and stickers are added, and the bot\'s settings from the backup are written back; settings added since the backup stay.',
                'Roles, categories and channels made since the backup are kept. Tick **Also remove channels, categories and roles that are not in the backup** to delete them: they are deleted last, and only if everything before worked. **Ban again** re-applies the backup\'s bans and is off by default.',
                'A restore can take several minutes; progress shows on the page. If the bot restarts or a step fails, press **Resume restore**: finished steps are not repeated.',
                'Members who were not in the server get their roles and nickname back if they rejoin within the time you chose.',
            ],
        },
        {
            title: 'Export and import your streamers',
            text: [
                '**Import and export**, in the same section, covers stream alerts only. **Download CSV** gives one row per streamer with the platform, announcement channel, live role, custom message and linked Discord user.',
                'To import, choose a **CSV file** (up to 1 MB and 200 rows) with `platform` and `username` columns, and press **Import**. Platforms are twitch, youtube, kick, tiktok and rumble. New streamers are added; for streamers already there, the channel, role and message in the file replace the current ones. A downloaded file imports as it is.',
            ],
        },
    ],
    notes: [
        'A restore does not bring back AutoMod rules, scheduled events, webhooks (a new webhook gets a new address), the server name, icon or banner, or anything posted in channels.',
        '`/admin backup create`, `list`, `info`, `restore` and `delete` need Administrator. `/admin backup create` saves the same full backup as the dashboard; backups it made before 20 November 2026 have no permission overwrites and none of the bot\'s settings, so a restore of one leaves permissions as they are.',
        '`/admin backup restore` shows the same preview with buttons (**Restore**, **Preview with "also remove"**, **Cancel**) and reads every kind of backup: weekly, dashboard and command-made.',
        'When your own custom bot joins a server that has CertiFried, the dashboard offers a server transfer. That is not a backup: it moves the live panels (reaction roles, tickets, embeds, giveaways, polls, sticky messages, music) to the custom bot, and then the main bot leaves. Giveaway entries cannot be moved.',
    ],
    related: ['custom-bot', 'replace-bots', 'go-live-alerts'],
};
