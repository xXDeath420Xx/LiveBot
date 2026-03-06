import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

async function check() {
    const [columns] = await pool.execute('DESCRIBE dnd_characters');
    console.log('Current dnd_characters columns:');
    columns.forEach(col => {
        console.log(`  ${col.Field}: ${col.Type} ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'} ${col.Default ? 'DEFAULT ' + col.Default : ''}`);
    });
    await pool.end();
}

check().catch(console.error);
