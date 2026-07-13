#!/bin/bash
cd /home/death/CertiFriedUtility
node -e "
import \"dotenv/config\";
import mysql from \"mysql2/promise\";
import fs from \"fs\";
const pool = mysql.createPool({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
const [rows] = await pool.query(\"SELECT guild_id FROM guilds\");
fs.writeFileSync(\"dashboard/public/api/guild-ids.json\", JSON.stringify({guildIds: rows.map(r => r.guild_id), updated: new Date().toISOString()}));
await pool.end();
"
