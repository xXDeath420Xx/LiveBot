/*
 * Cross-channel spam: make a flag mean something.
 *
 * cross_channel_spam had 89 rows and `action_taken` was NULL on every one of them, in every guild,
 * since the feature shipped. Two separate reasons, both fixed here and in adaptive-spam-manager:
 *
 *   1. Nothing ever wrote the column, even when an action was taken on other grounds.
 *   2. The cluster could not carry a decision on its own. It contributes `min(40, channels * 10)`
 *      to a score that needs 80 to act, and that cap means a 4-channel spread and a 10-channel
 *      spread score identically. A member spamming ten channels in twenty-three seconds — the
 *      August 30 and 31 incidents in guild 961514092848382043 — topped out at 40 and was never
 *      actioned. Both were banned by hand.
 *
 * `decisive_channel_count` is the spread at which the cluster is enough by itself. It is separate
 * from `cross_channel_threshold` (which stays the flag-and-alert point) precisely so that raising
 * enforcement does not also raise flagging: 3-5 channels keeps alerting a human, 6+ acts.
 *
 * The default of 6 is deliberately well clear of ordinary behaviour. Sharing something in two or
 * three channels is normal; the same content in six inside the window is not something a member
 * does by accident. Guilds that want it stricter can lower it, but the floor is enforced in the
 * manager so nobody can set it below the flag threshold and have "acted" mean less than "flagged".
 */
export async function up(db) {
  const [cols] = await db.execute('SHOW COLUMNS FROM adaptive_spam_config');
  const have = new Set(cols.map(c => c.Field));

  if (!have.has('decisive_channel_count')) {
    await db.execute(
      'ALTER TABLE adaptive_spam_config ADD COLUMN decisive_channel_count INT NOT NULL DEFAULT 6'
    );
  }

  // Referenced as `config.action_threshold || 80` by calculateSpamScore since the manager was
  // written, but never actually added as a column — so the fallback was the only value that ever
  // applied and the setting was unreachable. Adding it makes the existing read meaningful.
  if (!have.has('action_threshold')) {
    await db.execute(
      'ALTER TABLE adaptive_spam_config ADD COLUMN action_threshold INT NOT NULL DEFAULT 80'
    );
  }

  const [ccCols] = await db.execute('SHOW COLUMNS FROM cross_channel_spam');
  if (!ccCols.some(c => c.Field === 'action_taken')) {
    await db.execute('ALTER TABLE cross_channel_spam ADD COLUMN action_taken VARCHAR(32) NULL');
  }
}

export async function down(db) {
  for (const [table, col] of [
    ['adaptive_spam_config', 'decisive_channel_count'],
    ['adaptive_spam_config', 'action_threshold'],
  ]) {
    const [cols] = await db.execute(`SHOW COLUMNS FROM ${table}`);
    if (cols.some(c => c.Field === col)) await db.execute(`ALTER TABLE ${table} DROP COLUMN ${col}`);
  }
  // cross_channel_spam.action_taken predates this migration; left in place.
}
