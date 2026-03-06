import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'CertiFriedDB',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'CertiFriedUtility'
});

console.log('Checking live_announcements table structure...');
const [rows] = await connection.query('DESCRIBE live_announcements');
console.table(rows);

console.log('\nSample data from live_announcements:');
const [data] = await connection.query('SELECT * FROM live_announcements LIMIT 5');
console.table(data);

await connection.end();
