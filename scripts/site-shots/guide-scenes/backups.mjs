// Screenshots for the backups guide. The page is dashboard/views/partials/manage/backups.ejs with the rows the
// /manage/:guildId loader passes (dashboard/server.js: id, snapshot_name, created_by_id, created_at). Weekly backups
// are named the way jobs/backup-scheduler.js names them.
export default async function ({ manage, demo }) {
    const { guild, member: M, D } = demo;
    const row = (id, name, by, at) => ({ id, guild_id: guild.id, snapshot_name: name, created_by_id: by, created_at: at });
    const backups = [
        row(46, 'Before the winter event', M.juniper.id, D(2026, 11, 18, 21, 4)),
        row(45, 'Auto Weekly — 2026-11-15', 'auto-scheduler', D(2026, 11, 15, 4, 0)),
        row(44, 'Auto Weekly — 2026-11-08', 'auto-scheduler', D(2026, 11, 8, 4, 0)),
        row(43, 'After the role clean-up', M.hazel.id, D(2026, 11, 3, 18, 30)),
        row(42, 'Auto Weekly — 2026-11-01', 'auto-scheduler', D(2026, 11, 1, 4, 0)),
        row(41, 'Auto Weekly — 2026-10-25', 'auto-scheduler', D(2026, 10, 25, 4, 0)),
    ];
    manage('backups-page', 'backups', { backups }, {
        alt: 'The Backups page: a box to name a new backup, the rejoin setting, and the saved weekly and hand-made backups with Compare, Restore and Delete buttons.',
        guides: ['backups'], height: 900, scrollTo: '#bk-create-title',
    });
}
