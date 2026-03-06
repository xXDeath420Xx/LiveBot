/**
 * Check reaction role database entries for Growmie server
 */

import pool from '../utils/db.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';

async function main() {
    console.log('📊 Checking reaction role database...\n');

    // Check panels
    const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE guild_id = ?',
        [GUILD_ID]
    );
    console.log('📋 Panels found:', panels.length);
    if (panels.length > 0) {
        console.log(JSON.stringify(panels, null, 2));
    }

    // Check all mappings
    const [mappings] = await pool.execute('SELECT * FROM reaction_role_mappings');
    console.log('\n🔗 Mappings found:', mappings.length);
    if (mappings.length > 0) {
        console.log(JSON.stringify(mappings, null, 2));
    }

    // Check table structure
    const [panelCols] = await pool.execute('DESCRIBE reaction_role_panels');
    console.log('\n📐 Panel table columns:');
    panelCols.forEach(col => console.log(`  - ${col.Field} (${col.Type})`));

    const [mappingCols] = await pool.execute('DESCRIBE reaction_role_mappings');
    console.log('\n📐 Mapping table columns:');
    mappingCols.forEach(col => console.log(`  - ${col.Field} (${col.Type})`));

    process.exit(0);
}

main().catch(console.error);
