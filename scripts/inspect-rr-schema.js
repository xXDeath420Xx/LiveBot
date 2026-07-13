import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
const [cols] = await pool.execute('SHOW COLUMNS FROM reaction_role_mappings');
console.log('reaction_role_mappings columns:');
cols.forEach(c => console.log(`  ${c.Field}\t${c.Type}\t${c.Null}\t${c.Default ?? ''}`));
const [pcols] = await pool.execute('SHOW COLUMNS FROM reaction_role_panels');
console.log('\nreaction_role_panels columns:');
pcols.forEach(c => console.log(`  ${c.Field}\t${c.Type}\t${c.Null}\t${c.Default ?? ''}`));
await pool.end();
