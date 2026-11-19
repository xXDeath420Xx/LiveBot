import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/229_guild_scoped_commands.js';
try { await up(pool); console.log('migration 229 applied'); }
catch (err) { console.error('FAILED:', err.message); }
process.exit(0);
