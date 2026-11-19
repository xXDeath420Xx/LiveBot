/**
 * Repair affiliate mislabelling in community support tracking.
 *
 * Identity writers (presenceUpdate, dashboard link flows) upserted
 * community_twitch_links rows with is_affiliate at its DEFAULT 0 while stamping
 * last_checked = NOW(). checkAffiliateStatus read last_checked as proof of a recent
 * affiliate check, so it trusted the unverified 0 and skipped the Twitch API — and
 * because presence re-stamps on every go-live, the row never aged out. Anyone who
 * streams regularly (i.e. the affiliates) was pinned to non-affiliate.
 *
 * This re-verifies every support/raid target in the window against Twitch, repairs the
 * link cache, and corrects target_is_affiliate + points_awarded on the entries.
 * Only raid points depend on affiliate status; support entries are a flat rate, so
 * their points are left alone and only the label is corrected.
 *
 * Usage:
 *   node scripts/repair-affiliate-backlog.mjs            # dry run, 7 days
 *   node scripts/repair-affiliate-backlog.mjs --apply
 *   node scripts/repair-affiliate-backlog.mjs --days=30 --apply
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const daysArg = process.argv.find(a => a.startsWith('--days='));
const DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;

async function main() {
    if (!Number.isFinite(DAYS) || DAYS <= 0) throw new Error(`bad --days value: ${DAYS}`);

    // Dedicated connection — the shared pool hangs in one-off scripts.
    const db = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    const { getTwitchUsers, getTwitchUser } = await import('../utils/platforms/twitch-api.js');

    console.log(`\n=== Affiliate backlog repair — last ${DAYS} day(s) — ${APPLY ? 'APPLY' : 'DRY RUN'} ===\n`);

    const [entries] = await db.execute(
        `SELECT id, guild_id, user_id, entry_type, target_username, target_twitch_id,
                target_is_affiliate, points_awarded, month_key
         FROM community_support_entries
         WHERE created_at > NOW() - INTERVAL ? DAY
         ORDER BY guild_id, id`,
        [DAYS]
    );
    console.log(`entries in window: ${entries.length}`);
    if (entries.length === 0) { await db.end(); return; }

    // Per-guild points config (defaults match migration 038)
    const [cfgRows] = await db.execute('SELECT * FROM community_support_config');
    const cfg = new Map(cfgRows.map(r => [r.guild_id, r]));
    // Re-price ONLY what the affiliate flag actually controls: raid entries whose flag
    // flipped. Support points are a flat rate independent of affiliate status, and
    // guilds change their configured rates over time — recomputing every entry against
    // today's config would silently re-price history the bug never touched.
    const repricedPoints = (e, isAffiliate) => {
        if (e.entry_type !== 'raid') return e.points_awarded;
        if (!!e.target_is_affiliate === isAffiliate) return e.points_awarded;
        const c = cfg.get(e.guild_id) || {};
        return isAffiliate
            ? (c.raid_affiliate_points ?? 5)
            : (c.raid_non_affiliate_points ?? 10);
    };

    // Resolve every distinct target once, by login (batched 100/req).
    const logins = [...new Set(entries.map(e => e.target_username).filter(Boolean).map(s => s.toLowerCase()))];
    console.log(`distinct targets: ${logins.length}`);

    const truth = new Map(); // login -> { isAffiliate, twitchId, login }
    const users = await getTwitchUsers(logins);
    for (const u of users) {
        truth.set(u.login.toLowerCase(), {
            isAffiliate: u.broadcaster_type === 'affiliate' || u.broadcaster_type === 'partner',
            twitchId: u.id,
            login: u.login.toLowerCase()
        });
    }

    // Anything the login batch missed (renamed account) — retry by stored twitch id.
    const unresolved = logins.filter(l => !truth.has(l));
    for (const l of unresolved) {
        const withId = entries.find(e => e.target_username?.toLowerCase() === l && e.target_twitch_id);
        if (!withId) continue;
        const u = await getTwitchUser(withId.target_twitch_id).catch(() => null);
        if (!u) continue;
        truth.set(l, {
            isAffiliate: u.broadcaster_type === 'affiliate' || u.broadcaster_type === 'partner',
            twitchId: u.id,
            login: u.login.toLowerCase()
        });
        console.log(`  resolved by id: ${l} -> ${u.login} (${u.broadcaster_type || 'none'})`);
    }

    const stillUnresolved = logins.filter(l => !truth.has(l));
    if (stillUnresolved.length) {
        console.log(`\nUNRESOLVED (left untouched): ${stillUnresolved.length} — ${stillUnresolved.join(', ')}`);
    }

    // ── entries ──────────────────────────────────────────────────────────────
    const changes = [];
    for (const e of entries) {
        const t = truth.get((e.target_username || '').toLowerCase());
        if (!t) continue;
        const wasAff = !!e.target_is_affiliate;
        const newPoints = repricedPoints(e, t.isAffiliate);
        if (wasAff === t.isAffiliate && e.points_awarded === newPoints) continue;
        changes.push({ e, t, newPoints, wasAff });
    }

    const labelFlips = changes.filter(c => c.wasAff !== c.t.isAffiliate);
    const pointFlips = changes.filter(c => c.e.points_awarded !== c.newPoints);

    console.log(`\nentries to correct: ${changes.length}`);
    console.log(`  label changes:  ${labelFlips.length} (${labelFlips.filter(c => c.t.isAffiliate).length} -> affiliate, ${labelFlips.filter(c => !c.t.isAffiliate).length} -> non-affiliate)`);
    console.log(`  point changes:  ${pointFlips.length}`);

    for (const c of changes.slice(0, 40)) {
        console.log(`   #${c.e.id} ${c.e.entry_type.padEnd(7)} ${c.e.target_username.padEnd(24)} ` +
            `${c.wasAff ? 'aff' : 'non'} -> ${c.t.isAffiliate ? 'aff' : 'non'}   ` +
            `${c.e.points_awarded}pts -> ${c.newPoints}pts`);
    }
    if (changes.length > 40) console.log(`   ... and ${changes.length - 40} more`);

    // Net points movement per user, so leaderboard shifts are visible before applying.
    const delta = new Map();
    for (const c of changes) {
        const k = `${c.e.guild_id}/${c.e.user_id}`;
        delta.set(k, (delta.get(k) || 0) + (c.newPoints - c.e.points_awarded));
    }
    const moved = [...delta.entries()].filter(([, d]) => d !== 0);
    if (moved.length) {
        console.log(`\nnet point movement (${moved.length} user(s)):`);
        for (const [k, d] of moved) console.log(`   ${k}: ${d > 0 ? '+' : ''}${d}`);
    } else {
        console.log('\nnet point movement: none (support entries are a flat rate)');
    }

    if (APPLY) {
        for (const c of changes) {
            await db.execute(
                `UPDATE community_support_entries
                 SET target_is_affiliate = ?, points_awarded = ?, target_twitch_id = ?, target_username = ?
                 WHERE id = ?`,
                [c.t.isAffiliate ? 1 : 0, c.newPoints, c.t.twitchId, c.t.login, c.e.id]
            );
        }
        console.log(`\napplied ${changes.length} entry correction(s)`);
    }

    // ── link cache ───────────────────────────────────────────────────────────
    // Repair every cached row for the targets we just verified, so the live path
    // stops serving the poisoned value.
    let cacheFixed = 0;
    for (const t of truth.values()) {
        const [rows] = await db.execute(
            `SELECT guild_id, discord_user_id, is_affiliate, affiliate_checked_at
             FROM community_twitch_links
             WHERE twitch_username = ? OR twitch_user_id = ?`,
            [t.login, t.twitchId]
        );
        for (const r of rows) {
            if (!!r.is_affiliate === t.isAffiliate && r.affiliate_checked_at !== null) continue;
            cacheFixed++;
            if (APPLY) {
                await db.execute(
                    `UPDATE community_twitch_links
                     SET is_affiliate = ?, twitch_user_id = ?, affiliate_checked_at = NOW()
                     WHERE guild_id = ? AND discord_user_id = ?`,
                    [t.isAffiliate ? 1 : 0, t.twitchId, r.guild_id, r.discord_user_id]
                );
            }
        }
    }
    console.log(`link cache rows ${APPLY ? 'repaired' : 'to repair'}: ${cacheFixed}`);

    if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply.\n');
    await db.end();
}

main().catch(err => {
    console.error('FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
