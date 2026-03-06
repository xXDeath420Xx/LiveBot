import { Client, GatewayIntentBits } from 'discord.js';
import encryption from './utils/encryption.js';

const customBotToken = {
    "iv": "cf1d943b9e34ac44a7ec817e2b85f4c6",
    "encryptedData": "03e8c76b9374dabe2d4d2ce60d4913e6105ee4db7b69e0762b989aa89d0cd888220a8469e7128530c35fdbb333c65bf2da4b3540446496bb5cbd7cbe268b8fbf4c00fd3355f913fd",
    "authTag": "9a830598dbbefe3baa65834c6320c9f6"
};

const token = encryption.decrypt(customBotToken);
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

await client.login(token);

const guildId = '985116833193553930';
const liveRoleId = '1415371559966609552';

const usersToAssign = [
    '1239048739239235676',
    '154990014596382720',
    '162719798969630720',
    '387717664140951553',
    '406342396364849154',
    '510103106705686528',
    '515952792226234390',
    '527976209058103326',
    '729651570702155846',
    '851171083151343616',
    '894651314183762011'
];

const guild = await client.guilds.fetch(guildId);
const role = await guild.roles.fetch(liveRoleId);

console.log(`Assigning "${role.name}" to ${usersToAssign.length} live users...`);

let assigned = 0;
let failed = 0;

for (const userId of usersToAssign) {
    try {
        const member = await guild.members.fetch(userId);
        if (!member.roles.cache.has(liveRoleId)) {
            await member.roles.add(liveRoleId);
            console.log(`✓ Assigned to ${member.user.tag}`);
            assigned++;
        } else {
            console.log(`- ${member.user.tag} already has role`);
        }
    } catch (err) {
        console.log(`✗ Failed for ${userId}: ${err.message}`);
        failed++;
    }
}

console.log(`\nComplete: ${assigned} assigned, ${failed} failed`);
process.exit(0);
