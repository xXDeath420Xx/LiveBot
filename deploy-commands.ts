const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

let commandFiles;
try {
    commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
} catch (error) {
    console.error(`[❌] Error reading commands directory at ${commandsPath}:`, error.message);
    process.exit(1);
}

console.log('Loading commands for deployment...');

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    try {
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            commands.push(command.data.toJSON());
            console.log(`[✔] Loaded ${file}`);
        } else {
            console.log(`[❌] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    } catch (error) {
        console.error(`[❌] Error loading command file ${file}:`, error.message);
    }
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        if (!process.env.DISCORD_CLIENT_ID) {
            console.error('DISCORD_CLIENT_ID is not set in environment variables. Commands cannot be deployed.');
            process.exit(1);
        }
        if (!process.env.DISCORD_TOKEN) {
            console.error('DISCORD_TOKEN is not set in environment variables. Commands cannot be deployed.');
            process.exit(1);
        }

        console.log(`\nStarted refreshing ${commands.length} application (/) commands.`);

        const data = await rest.put(
            Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
            { body: commands },
        );

        console.log(`Successfully reloaded ${data.length} application (/) commands globally.`);
    } catch (error) {
        console.error('Failed to deploy commands:', error);
        process.exit(1);
    }
})();
