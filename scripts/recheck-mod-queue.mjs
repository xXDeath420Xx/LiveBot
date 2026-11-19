// Re-check AI mod-queue items that are still pending from before the 2026-11-16/17 prompt tuning, using the
// tuned classifier. Items the tuned prompt still flags stay pending with its verdict; the rest are dismissed
// with action_taken='auto_recheck_clear' (reversible: set status back to 'pending' WHERE action_taken = that).
// Usage: node scripts/recheck-mod-queue.mjs [--apply]   (without --apply: dry run, nothing is changed)
import pool from '../utils/db.js';
import { classifyChatBatch } from '../core/twitch-ai.js';

const APPLY = process.argv.includes('--apply');
const CUTOFF = '2026-11-17 00:00:00'; // tuned prompt deployed then (backups/pre-ai-prompt-tune)
const say = (m) => process.stdout.write(m + '\n');

const [rows] = await pool.query(
    `SELECT id, broadcaster_id, chatter_user_login, chatter_user_id, message_text
       FROM twitch_ai_mod_queue WHERE status = 'pending' AND created_at < ? ORDER BY broadcaster_id, id`, [CUTOFF]);
say(`pending from the old prompt: ${rows.length}${APPLY ? '' : ' (dry run)'}`);

const byBid = new Map();
for (const r of rows) { if (!byBid.has(r.broadcaster_id)) byBid.set(r.broadcaster_id, []); byBid.get(r.broadcaster_id).push(r); }

let kept = 0, cleared = 0, failed = 0;
for (const [bid, items] of byBid) {
    for (let i = 0; i < items.length; i += 40) {
        const batch = items.slice(i, i + 40);
        const c = await classifyChatBatch(bid, batch);
        if (!c.ok) { failed += batch.length; say(`  ${bid} batch ${i / 40 + 1}: FAILED ${String(c.error).slice(0, 120)}`); continue; }
        const flagged = new Map(c.flags.map(f => [f.sample.id, f]));
        for (const it of batch) {
            const f = flagged.get(it.id);
            if (f) {
                kept++;
                if (APPLY) await pool.query(
                    'UPDATE twitch_ai_mod_queue SET severity = ?, category = ?, reason = ?, confidence = ?, provider = ? WHERE id = ? AND status = \'pending\'',
                    [f.severity, f.category, `[rechecked] ${f.reason}`.slice(0, 500), f.confidence, f.provider || c.provider, it.id]);
            } else {
                cleared++;
                if (APPLY) await pool.query(
                    "UPDATE twitch_ai_mod_queue SET status = 'dismissed', action_taken = 'auto_recheck_clear', reviewed_at = NOW() WHERE id = ? AND status = 'pending'",
                    [it.id]);
            }
        }
        say(`  ${bid} batch ${i / 40 + 1}: ${batch.length} checked via ${c.provider}, ${c.flags.length} still flagged`);
    }
}
say(`RESULT kept ${kept}, ${APPLY ? 'dismissed' : 'would dismiss'} ${cleared}, failed ${failed}`);
process.exit(0);
