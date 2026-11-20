/**
 * Backup restore kill switch (register H-801).
 *
 * While RESTORE_DISABLED is true every restore entry point (the /admin backup restore command,
 * which the text prefix also reaches, and the dashboard POST /manage/:guildId/restore-backup)
 * returns RESTORE_UNAVAILABLE_MESSAGE before it reads the backup or touches the server.
 */
// Off since the rebuilt restore (core/backup-restore.js) passed its mocked-guild tests on 2026-11-20. Set to true
// to take every restore entry point offline again without touching anything else.
export const RESTORE_DISABLED = false;

export const RESTORE_UNAVAILABLE_MESSAGE = "Restore is temporarily unavailable while we fix it; your server has not been changed.";

export function isRestoreDisabled() {
    return RESTORE_DISABLED === true;
}
