import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

setTimeout(() => { console.log('TIMEOUT - force exit'); process.exit(1); }, 15000);

try {
    console.log('1. Getting token...');
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', ['1473622894138491007']);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));
    console.log('2. Token obtained, fetching messages...');

    const res = await fetch('https://discord.com/api/v10/channels/904428293846098011/messages?limit=10', {
        headers: { Authorization: `Bot ${token}` }
    });
    console.log('3. Fetch status:', res.status);
    const msgs = await res.json();
    console.log('4. Got', msgs.length, 'messages');

    const VALID = new Set(['1473677828753981493', '1473677834433331270']);
    for (const m of msgs) {
        const orphaned = m.author.id === '1473622894138491007' && !VALID.has(m.id);
        console.log(`  ${m.id} ${m.author.username}: ${m.embeds?.[0]?.title || '(no embed)'}${orphaned ? ' ORPHANED' : ''}`);
        if (orphaned) {
            const d = await fetch(`https://discord.com/api/v10/channels/904428293846098011/messages/${m.id}`, {
                method: 'DELETE', headers: { Authorization: `Bot ${token}` }
            });
            console.log(`    -> deleted ${d.status}`);
        }
    }
    console.log('Done');
} catch (e) {
    console.error('Error:', e.message);
}
process.exit(0);
