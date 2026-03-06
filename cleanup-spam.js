import { Client, GatewayIntentBits } from 'discord.js';
import encryption from './utils/encryption.js';

const customBotToken = {
    "iv": "cf1d943b9e34ac44a7ec817e2b85f4c6",
    "encryptedData": "03e8c76b9374dabe2d4d2ce60d4913e6105ee4db7b69e0762b989aa89d0cd888220a8469e7128530c35fdbb333c65bf2da4b3540446496bb5cbd7cbe268b8fbf4c00fd3355f913fd",
    "authTag": "9a830598dbbefe3baa65834c6320c9f6"
};

const token = encryption.decrypt(customBotToken);

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

await client.login(token);

const spamMessages = [
    '1439135404443045921',
    '1439135380812075059',
    '1439134148265771069',
    '1439134121744928944',
    '1439132904117502054',
    '1439098375931822233',
    '1439098694468112476'
];

const channel = await client.channels.fetch('1415373602068496545');

console.log(`Deleting ${spamMessages.length} spam messages...`);

for (const msgId of spamMessages) {
    try {
        const msg = await channel.messages.fetch(msgId);
        await msg.delete();
        console.log(`✓ Deleted: ${msgId}`);
    } catch (err) {
        console.log(`✗ Failed to delete ${msgId}: ${err.message}`);
    }
}

console.log('Cleanup complete');
process.exit(0);
