import pool from '../utils/db.js';

const GUILD_ID = process.argv[2] || '1321904235440373902';

async function main() {
    console.log(`\nChecking automod_rules for guild: ${GUILD_ID}\n`);

    const [rules] = await pool.execute('SELECT * FROM automod_rules WHERE guild_id = ?', [GUILD_ID]);

    if (rules.length === 0) {
        console.log('No automod rules found.');
    } else {
        for (const rule of rules) {
            console.log(`Rule ID: ${rule.id}`);
            console.log(`  Filter Type: ${rule.filter_type}`);
            console.log(`  Action: ${rule.action}`);
            console.log(`  Enabled: ${rule.is_enabled ? 'Yes' : 'No'}`);
            console.log(`  Config: ${rule.config}`);
            console.log('');
        }
    }

    // Also check heat config
    console.log('Checking automod_heat_config...');
    const [heatConfig] = await pool.execute('SELECT * FROM automod_heat_config WHERE guild_id = ?', [GUILD_ID]);

    if (heatConfig.length === 0) {
        console.log('No heat config found.');
    } else {
        const config = heatConfig[0];
        console.log(`  Enabled: ${config.is_enabled ? 'Yes' : 'No'}`);
        console.log(`  Heat Values: ${config.heat_values}`);
        console.log(`  Decay Minutes: ${config.decay_minutes}`);
        console.log(`  Action Thresholds: ${config.action_thresholds}`);
    }

    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
