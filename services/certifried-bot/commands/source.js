/**
 * !source (alias !sourcecode)
 * AGPL-3.0 section 13: everyone who talks to CertiFried's Twitch/Kick channel bot can get its source code.
 * Its row in tokes_global_command_config comes from migrations/460_channel_bot_source_command.js.
 */
export const SOURCE_URL = 'https://github.com/xXDeath420Xx/LiveBot';
export const SOURCE_REPLY = `CertiFried is free software (AGPL-3.0-or-later). Source code: ${SOURCE_URL}`;

export async function sourceCommand(ctx) {
    ctx.reply(SOURCE_REPLY);
}

export default sourceCommand;
