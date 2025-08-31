const { REST, Routes } = require('discord.js');
require('dotenv').config();

const { DISCORD_CLIENT_ID, DISCORD_TOKEN } = process.env;

const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
    try {
        console.log('[INFO] Started clearing all global application (/) commands.');

        await rest.put(
            Routes.applicationCommands(DISCORD_CLIENT_ID),
            { body: [] },
        );

        console.log('[SUCCESS] Successfully cleared all global application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();
