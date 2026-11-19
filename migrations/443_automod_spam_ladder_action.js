/**
 * Migration 443 — Message spam rules keep what they did (register H-659).
 *
 * core/automod.js used to ignore a Message spam rule's Delete / Warn / Mute action: every such rule (and any
 * other action except Kick and Ban) deleted the burst and timed the sender out for longer each time
 * (1, 5, 15, 30 minutes ... up to a day). The rule's action is honoured now, and that ladder is its own
 * action, 'ladder' (Delete and time out, longer each time on the AutoMod page).
 *
 * So existing spam rules keep behaving exactly as before, every spam rule whose action is not Kick or Ban
 * becomes 'ladder'. Idempotent: rules already on 'ladder', Kick or Ban are left alone.
 */
export async function up(db) {
    const [res] = await db.query(
        `UPDATE automod_rules SET action = 'ladder'
          WHERE LOWER(REPLACE(filter_type, '_', '')) IN ('antispam', 'spam')
            AND action NOT IN ('kick', 'ban', 'ladder')`);
    console.log(`[migrate 443] ${res.affectedRows} Message spam rule(s) moved to the 'ladder' action`);
}

export async function down() {
    // Not reversible without the old values: 'ladder' and the old Delete / Warn / Mute behaved the same.
}
