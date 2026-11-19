/*
 * Migration 263: tables for three commands whose tables never existed in the live database.
 *
 *   social_profiles             /fun icebreakers profile | viewprofile | findmatch
 *                               (commands/fun/fun-icebreakers-handler.js). One profile per member
 *                               per server: comma-separated interests (1-10) + optional bio (<=200).
 *   productivity_tasks          /selfcare tasks addtask | tasks | complete | delete | clear | stats
 *                               (commands/tools/selfcare/tasks.js). A member's todo list per server;
 *                               priority is 'high' | 'medium' | 'low', due_date optional.
 *   wellness_pomodoro_sessions  /selfcare wellness pomodoro | pomostat
 *                               (commands/tools/selfcare/wellness.js). One row per focus session;
 *                               `completed` is set when the work timer runs out.
 *
 * Each handler used to issue its own CREATE TABLE IF NOT EXISTS on its write path only, so every
 * read path (viewprofile, findmatch, tasks, stats, pomostat) failed until someone happened to write
 * first. The schemas below are exactly the ones those inline statements declared (the inline DDL
 * was removed from the handlers), so behaviour is unchanged apart from the tables now existing.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS.
 */

export async function up(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS social_profiles (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        guild_id    VARCHAR(20) NOT NULL,
        user_id     VARCHAR(20) NOT NULL,
        interests   TEXT NOT NULL,
        bio         TEXT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await db.execute(`CREATE TABLE IF NOT EXISTS productivity_tasks (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        guild_id          VARCHAR(20) NOT NULL,
        user_id           VARCHAR(20) NOT NULL,
        task_description  TEXT NOT NULL,
        priority          VARCHAR(10) NOT NULL DEFAULT 'medium',
        due_date          DATE NULL,
        completed         TINYINT(1) NOT NULL DEFAULT 0,
        created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at      TIMESTAMP NULL DEFAULT NULL,
        KEY idx_user_tasks (guild_id, user_id, completed)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await db.execute(`CREATE TABLE IF NOT EXISTS wellness_pomodoro_sessions (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        guild_id        VARCHAR(20) NOT NULL,
        user_id         VARCHAR(20) NOT NULL,
        work_duration   INT NOT NULL,
        break_duration  INT NOT NULL,
        started_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed       TINYINT(1) NOT NULL DEFAULT 0,
        KEY idx_user_sessions (guild_id, user_id, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS wellness_pomodoro_sessions');
    await db.execute('DROP TABLE IF EXISTS productivity_tasks');
    await db.execute('DROP TABLE IF EXISTS social_profiles');
}
