/**
 * dnd_session_messages had no link to dnd_sessions, so deleting a session left its messages behind
 * (298 orphans found 2026-11-18, register H-125). Cascade delete keeps them in step.
 * Applied by hand on 2026-11-18 after deleting the orphans; this file makes the schema reproducible.
 */
export async function up(pool) {
    const [[has]] = await pool.query(
        "SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dnd_session_messages' AND CONSTRAINT_NAME = 'fk_session_messages_session'");
    if (has.n) return;
    await pool.query('DELETE m FROM dnd_session_messages m LEFT JOIN dnd_sessions s ON s.session_id = m.session_id WHERE s.session_id IS NULL');
    await pool.query('ALTER TABLE dnd_session_messages ADD CONSTRAINT fk_session_messages_session FOREIGN KEY (session_id) REFERENCES dnd_sessions(session_id) ON DELETE CASCADE');
}

export async function down(pool) {
    await pool.query('ALTER TABLE dnd_session_messages DROP FOREIGN KEY fk_session_messages_session').catch(() => {});
}
