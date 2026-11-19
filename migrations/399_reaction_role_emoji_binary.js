/**
 * Wave 399 — reaction_role_mappings.emoji_id compares byte for byte.
 *
 * Under utf8mb4_unicode_ci every emoji outside the Basic Multilingual Plane has the same weight, so
 * `emoji_id IN ('🟪')` matched all of a panel's emoji (🟩 🟪 🟥 🟦 …) and the handler gave the first mapping's
 * role for any reaction. Found 2026-11-05 on Crispy's games menu (every square gave Jackbox); 81 panels across
 * servers had colliding emoji. utf8mb4_bin only makes values more distinct, so no existing row can clash.
 */
export async function up(pool) {
    await pool.query(
        'ALTER TABLE reaction_role_mappings MODIFY emoji_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT NULL');
}

export async function down(pool) {
    await pool.query(
        'ALTER TABLE reaction_role_mappings MODIFY emoji_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL');
}
