const {REST, Routes} = require("discord.js");
require("dotenv").config();

const {DISCORD_CLIENT_ID, DISCORD_TOKEN} = process.env;

// Added checks for required environment variables
if (!DISCORD_CLIENT_ID) {
  console.error("Error: DISCORD_CLIENT_ID is not defined in environment variables. Please check your .env file or environment setup.");
  process.exit(1);
}
if (!DISCORD_TOKEN) {
  console.error("Error: DISCORD_TOKEN is not defined in environment variables. Please check your .env file or environment setup.");
  process.exit(1);
}

const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log("[INFO] Started clearing all global application (/) commands.");

    await rest.put(
      Routes.applicationCommands(DISCORD_CLIENT_ID),
      {body: []},
    );

    console.log("[SUCCESS] Successfully cleared all global application (/) commands.");
  } catch (error) {
    // Improved error logging and process exit on failure
    console.error("[ERROR] Failed to clear global application commands:", error);
    process.exit(1);
  }
})();