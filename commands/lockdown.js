const {SlashCommandBuilder, PermissionsBitField, ChannelType} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");
const crypto = require("crypto");

// In a real scenario, you would use a proper password hashing library like bcrypt.
// Using crypto for demonstration purposes as it's a built-in Node module.
function verifyPassword(plainPassword, hash) {
  const [salt, key] = hash.split(":");
  const keyBuffer = Buffer.from(key, "hex");
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64);
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lockdown")
    .setDescription("Locks the current channel, preventing messages. Requires a special password.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addStringOption(option =>
      option.setName("password")
        .setDescription("The password required to execute this sensitive action.")
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName("unlock")
        .setDescription("Set to true to unlock the channel.")
        .setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const password = interaction.options.getString("password");
    const shouldUnlock = interaction.options.getBoolean("unlock") || false;
    const memberRoles = interaction.member.roles.cache;

    try {
      // This is a placeholder for the new table `protected_actions_config`
      // We will simulate fetching a password hash for the user's highest role that has one.
      // const [protectedRoles] = await db.execute('SELECT role_id, password_hash FROM protected_actions_config WHERE guild_id = ?', [interaction.guild.id]);

      // --- SIMULATED LOGIC START ---
      const protectedRoles = [
        // Example data you would have in your `protected_actions_config` table
        {role_id: "YOUR_ADMIN_ROLE_ID", password_hash: "e4a23c3b5e...:..."} // Replace with a real role ID and hash
      ];
      // --- SIMULATED LOGIC END ---

      const userProtectedRole = protectedRoles.find(p_role => memberRoles.has(p_role.role_id));

      if (!userProtectedRole) {
        return interaction.editReply({content: "You do not have a role configured for protected actions."});
      }

      // const isVerified = verifyPassword(password, userProtectedRole.password_hash);
      const isVerified = (password === "override-password-123"); // Placeholder verification

      if (!isVerified) {
        logger.warn(`Failed lockdown attempt by ${interaction.user.tag}. Incorrect password.`, {guildId: interaction.guild.id, category: "security"});
        return interaction.editReply({content: "❌ Incorrect password."});
      }

      const channel = interaction.channel;
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: shouldUnlock
      });

      const action = shouldUnlock ? "unlocked" : "locked";
      await interaction.editReply(`✅ Channel has been ${action}.`);
      logger.info(`Channel ${channel.name} was ${action} by ${interaction.user.tag} using a protected command.`, {guildId: interaction.guild.id, category: "security"});

    } catch (error) {
      // This will likely fail if the table doesn't exist yet.
      if (error.code !== "ER_NO_SUCH_TABLE") {
        logger.error("[Lockdown Command Error]", error);
      }
      await interaction.editReply({content: "An error occurred, or this feature has not been fully configured by the bot owner yet."});
    }
  },
  category: "Utility",
};