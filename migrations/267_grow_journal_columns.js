/*
 * Migration 267: grow journals, entries and reminders — columns /grow journal and /grow reminder collect.
 *
 * The grow tables existed but /grow journal, /grow stats, /grow reminder and the reminder scheduler
 * wrote columns that were never created, so every journal/reminder command failed. Where an existing
 * column already meant the same thing the code was pointed at it (status instead of is_active,
 * entry_text, ph_in, ec_ppm, watered, wet/dry_weight_grams, message, frequency_hours, created_at).
 * This adds only what the commands collect and no column holds:
 *
 *   grow_journals.breeder            optional "breeder" option on /grow journal create
 *   grow_journals.grow_environment   the create command's "type" option: indoor / outdoor / greenhouse.
 *                                    (grow_type is photo/auto genetics — a different thing the command never asks.)
 *   grow_journals.current_stage      /grow journal stage choices; 'complete' = finished grow
 *   grow_journals.is_public          /grow journal privacy toggle; journals start private
 *   journal_entries.vpd, height_cm   parsed from the log modal (environment text / plant height)
 *   grow_reminders.channel_id        where a reminder posts; NULL = DM
 *   grow_reminders.last_sent         when the scheduler last delivered a repeating reminder
 *   grow_reminders.reminder_type     widened with 'defoliate' and 'train', which /grow reminder set offers
 *
 * All four tables were empty when this was written, so the ALTERs are instant.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows.length > 0;
}

async function addColumn(db, table, column, definition) {
    if (!(await hasColumn(db, table, column))) {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

export async function up(db) {
    await addColumn(db, 'grow_journals', 'breeder',
        'VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL AFTER strain_name');
    await addColumn(db, 'grow_journals', 'grow_environment',
        "ENUM('indoor','outdoor','greenhouse') NULL AFTER grow_type");
    await addColumn(db, 'grow_journals', 'current_stage',
        "ENUM('germination','seedling','vegetative','transition','flowering','harvest','cure','complete') NOT NULL DEFAULT 'germination' AFTER grow_environment");
    await addColumn(db, 'grow_journals', 'is_public',
        'TINYINT(1) NOT NULL DEFAULT 0 AFTER status');

    await addColumn(db, 'journal_entries', 'vpd',
        'DECIMAL(4,2) NULL AFTER humidity_low');
    await addColumn(db, 'journal_entries', 'height_cm',
        'DECIMAL(6,1) NULL AFTER ec_ppm');

    await addColumn(db, 'grow_reminders', 'channel_id',
        'VARCHAR(20) NULL AFTER message');
    await addColumn(db, 'grow_reminders', 'last_sent',
        'TIMESTAMP NULL DEFAULT NULL AFTER next_reminder');

    // Widen the reminder_type ENUM (existing values keep their meaning; only additions).
    const [[typeCol]] = await db.execute(
        `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'grow_reminders' AND COLUMN_NAME = 'reminder_type'`
    );
    if (typeCol && !typeCol.COLUMN_TYPE.includes("'defoliate'")) {
        await db.execute(
            `ALTER TABLE grow_reminders MODIFY COLUMN reminder_type
                ENUM('water','feed','check','defoliate','train','flip','harvest','custom') NOT NULL`
        );
    }
}

export async function down(db) {
    for (const [table, column] of [
        ['grow_journals', 'breeder'],
        ['grow_journals', 'grow_environment'],
        ['grow_journals', 'current_stage'],
        ['grow_journals', 'is_public'],
        ['journal_entries', 'vpd'],
        ['journal_entries', 'height_cm'],
        ['grow_reminders', 'channel_id'],
        ['grow_reminders', 'last_sent']
    ]) {
        await db.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`).catch(() => {});
    }
    // reminder_type is left widened: narrowing it would fail (or truncate) once rows use the new values.
}
