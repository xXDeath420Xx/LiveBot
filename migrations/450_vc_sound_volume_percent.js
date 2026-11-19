/**
 * Migration 450 — vc_sound_config.volume holds a percentage (accuracy audit, VC sound drops page).
 *
 * The VC sound drops page saves Volume (%) as 1-100, while /admin vcsounds volume stored a 0-1
 * fraction and the column defaulted to 0.5. core/vc-sound-manager.js volumePercent() now reads both
 * (under 1 = a fraction) and the command stores a percentage; this turns the old fractions into
 * percentages so the page shows them, and makes the default 50.
 *
 * Run it only after the restart that loads volumePercent(): the code before it multiplies the stored
 * value by 100, so 50 would play at 5000%.
 *
 * Idempotent: only values under 1 change.
 */
export async function up(db) {
    await db.query("UPDATE vc_sound_config SET volume = ROUND(volume * 100) WHERE volume > 0 AND volume < 1");
    await db.query("ALTER TABLE vc_sound_config ALTER COLUMN volume SET DEFAULT 50");
}

export async function down(db) {
    await db.query("UPDATE vc_sound_config SET volume = volume / 100 WHERE volume >= 1");
    await db.query("ALTER TABLE vc_sound_config ALTER COLUMN volume SET DEFAULT 0.5");
}
