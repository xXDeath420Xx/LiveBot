import {REST, Routes} from "discord.js";
import * as fs from "fs";
import * as path from "path";

require("dotenv").config();

const commands = [];
const commandsPath = path.join(__dirname, "commands");

let commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"));
if (!commandFiles.length) {
    console.error(`[❌] Error reading commands directory at ${commandsPath}:`);
    process.exit(1); // Exit if commands directory can't be read
}

console.log("Loading commands for deployment...");

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    try {
        const command = require(filePath);
        if ("data" in command && "execute" in command) {
            commands.push(command.data.toJSON());
            console.log(`[✔] Loaded ${file}`);
        } else {
            console.log(`[❌] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    } catch (error) {
        console.error(`[❌] Error loading command file ${file}:`, error.message);
    }
}
const token = process.env.DISCORD_TOKEN ?? null;
if (!token) {
    console.log("Invalid/blank DISCORD_TOKEN");
    process.exit(1);
}
const rest = new REST({version: "10"}).setToken(token);

(async () => {
    try {
        if (!process.env.DISCORD_CLIENT_ID) {
            console.error("DISCORD_CLIENT_ID is not set in environment variables. Commands cannot be deployed.");
            process.exit(1);
        }

        console.log(`\nStarted refreshing ${commands.length} application (/) commands.`);

        const data = await rest.put(
            Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
            {body: commands},
        );

        console.log(`Successfully reloaded ${data.length} application (/) commands globally.`);
    } catch (error) {
        console.error("Failed to deploy commands:", error);
        process.exit(1);
    }
})();
