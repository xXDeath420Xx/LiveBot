// Run AFTER kicking VoiceMaster from guild 1469931133981687873.
// Configures CertiFried's JTC handler to take over the existing trigger channel + category.
import 'dotenv/config';
import pool from '../utils/db.js';

const GUILD_ID    = '1469931133981687873';
const TRIGGER_VC  = '1471385969398775822';  // #𝒥𝑜𝒾𝓃 𝓉𝑜 𝒞𝓇𝑒𝒶𝓉𝑒
const PARENT_CAT  = '1469931134845456534';  // 🎀 𝐻𝑒𝓁𝓁🏵 voice category
const NAME_TPL    = "{user}'s Room";

(async () => {
  await pool.execute(
    `INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       creator_channel_id = VALUES(creator_channel_id),
       category_id        = VALUES(category_id),
       naming_template    = VALUES(naming_template)`,
    [GUILD_ID, TRIGGER_VC, PARENT_CAT, NAME_TPL]
  );
  console.log('✓ temp_channel_config seeded for the Forsaken Warriors');
  console.log(`  trigger channel:  #${TRIGGER_VC}`);
  console.log(`  parent category:  ${PARENT_CAT}`);
  console.log(`  naming template:  ${NAME_TPL}`);
  console.log('');
  console.log('Next: have any member join the trigger VC. CertiFried should create a temp room named');
  console.log(`"${NAME_TPL.replace('{user}', '<their name>')}" under the parent category. Once inside, /voice info / /voice rename etc. will work.`);
  await pool.end();
})();
