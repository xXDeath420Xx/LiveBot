// New OwO players start with 15,000 cowoncy, not 0.
//
// Upstream starts you at zero. That is fine in a server that has always run OwO, and wrong in one we
// are taking over from it: a brand-new player's zero sitting next to a carried-over 1.6 million reads
// as having been robbed, and there is nothing they can do about it but grind dailies.
//
// The real gate is `ensureRow()` in core/owo/cowoncy.js — that is the ONLY place a cowoncy row is
// ever created, so it is the only place the starting balance can actually be set. This column default
// exists so a direct INSERT that forgets to name `money` lands on the same number rather than on 0.
// Belt and braces, not the mechanism.
//
// EXISTING BALANCES ARE NOT TOUCHED. A column default only applies to new rows, and ensureRow uses
// INSERT IGNORE. Topping people up would mint currency they did not earn, in live servers, silently.

const STARTING_COWONCY = 15000;

export async function up(db) {
  await db.execute(
    `ALTER TABLE owo_cowoncy MODIFY COLUMN money BIGINT UNSIGNED NOT NULL DEFAULT ${STARTING_COWONCY}`);
}

export async function down(db) {
  await db.execute('ALTER TABLE owo_cowoncy MODIFY COLUMN money BIGINT UNSIGNED NOT NULL DEFAULT 0');
}
