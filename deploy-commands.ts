import 'dotenv-flow/config';
import { REST, Routes, Client, GatewayIntentBits, RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';

const commands: RESTPostAPIApplicationCommandsJSONBody[] = [];

// Grab all the command files from the commands directory
const commandsPath: string = path.join(__dirname, 'commands');
const commandFiles: string[] = fs.readdirSync(commandsPath).filter((file: string) => file.endsWith('.js'));

// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
for (const file of commandFiles) {
  const filePath: string = path.join(commandsPath, file);
  const command = require(filePath);
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
  } else {
    console.log(
      `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`
    );
  }
}

// Add context menu commands
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const ContextMenuManager = require('./core/context-menu-manager');
const contextMenuManager = new ContextMenuManager(client);

const contextMenuCommands: RESTPostAPIApplicationCommandsJSONBody[] = contextMenuManager.getMenuCommands();
commands.push(...contextMenuCommands);

console.log(`Loaded ${commandFiles.length} slash commands and ${contextMenuCommands.length} context menu commands`);

// Validate environment variables
const token: string | undefined = process.env.DISCORD_TOKEN;
const clientId: string | undefined = process.env.DISCORD_CLIENT_ID;

if (!token) {
  throw new Error('DISCORD_TOKEN is not defined in environment variables');
}

if (!clientId) {
  throw new Error('DISCORD_CLIENT_ID is not defined in environment variables');
}

// Construct and prepare an instance of the REST module
const rest: REST = new REST().setToken(token);

// Deploy commands
(async (): Promise<void> => {
  try {
    console.log(
      `Started refreshing ${commands.length} application (/) commands.`
    );

    // The put method is used to fully refresh all commands in the guild with the current set
    const data = await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    ) as RESTPostAPIApplicationCommandsJSONBody[];

    console.log(
      `Successfully reloaded ${data.length} application (/) commands.`
    );
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(('Error deploying commands:', error as any).message);
      console.error((error as any).stack);
    } else {
      console.error('An unknown error occurred:', error as any);
    }
    process.exit(1);
  }
})();
