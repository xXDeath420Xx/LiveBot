// Shareable public sprite-collection profiles: a short random slug per account so others
// can view what a user has/needs at certifriedmultitool.com/sprites/u/<share_id>.
export async function up(db) {
  const [c] = await db.execute("SHOW COLUMNS FROM epic_sprite_accounts LIKE 'share_id'");
  if (!c.length) {
    await db.execute('ALTER TABLE epic_sprite_accounts ADD COLUMN share_id VARCHAR(16) NULL UNIQUE');
  }
}
export async function down(db) {
  await db.execute('ALTER TABLE epic_sprite_accounts DROP COLUMN share_id');
}
