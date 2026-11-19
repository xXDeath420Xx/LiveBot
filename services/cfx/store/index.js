// Greenhouse Tycoon (cfx v2): the data layer, built for one table prefix.
//   const store = createStore({ db: pool, prefix: 'gh_' });
//   store.ledger.apply(...), store.accounts.signIn(...), store.sessions.issue(...), store.flags.jobDisabled(...),
//   store.meta (phase 4: quests, seasons, ...), store.review (the Twitch review save)
import { tableNames, existingTables, TABLES, DEFAULT_PREFIX } from './schema.js';
import { createLedger } from './ledger.js';
import { createAccounts } from './accounts.js';
import { createFlags } from './flags.js';
import { createJobRuns } from './job-runs.js';
import { createSessions } from './sessions.js';
import { createMeta } from './meta.js';
import { createReview } from './review.js';

export function createStore({ db, prefix = DEFAULT_PREFIX, now = () => Date.now(), logger = null, allowDevPlatform = false, onLedgerCommit = null, refreshTtlMs = 30 * 86_400_000 }) {
    if (!db || typeof db.getConnection !== 'function') throw new Error('createStore needs a mysql2 pool');
    const t = tableNames(prefix);
    const ledger = createLedger({ db, t, onCommit: onLedgerCommit });
    const accounts = createAccounts({ db, t, ledger, now, allowDevPlatform });
    const flags = createFlags({ db, t, now, logger });
    const jobRuns = createJobRuns({ db, t, prefix });
    const sessions = createSessions({ db, t, now, ttlMs: refreshTtlMs });
    // phase 4: quests, seasons, achievements, notifications, leaderboards; and the Twitch review save
    const meta = createMeta({ db, t, ledger, now, flags, logger });
    const review = createReview({ db, t, ledger, now, flags, meta });

    /** Throws if any v2 table is missing (the migration has not been applied for this prefix). */
    async function assertSchema() {
        const have = new Set(await existingTables(db, prefix));
        const missing = TABLES.map(n => t[n]).filter(n => !have.has(n));
        if (missing.length) throw new Error(`cfx2 schema incomplete for prefix ${prefix}: missing ${missing.join(', ')}`);
    }

    return { db, prefix, t, now, ledger, accounts, flags, jobRuns, sessions, meta, review, assertSchema };
}
