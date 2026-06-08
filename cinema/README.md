# CertiFried Cinema service

Standalone PM2 process streaming Jellyfin titles into Discord voice as Go Live.

## Run
    pm2 start cinema/index.js --name CertiFried-Cinema
    pm2 logs CertiFried-Cinema

## Requirements
- Node >= 22.4 (the @dank074/discord-video-stream v6 dependency requires it). The
  repo currently runs Node 20; upgrade before running this service in production.
- system ffmpeg (already present), and cmake for the native deps on a clean install
  (`sudo apt-get install cmake`).

## Env (cinema/.env — gitignored)
CINEMA_USER_TOKEN, CINEMA_API_SECRET, CINEMA_PORT, JELLYFIN_URL, JELLYFIN_API_KEY, CINEMA_IDLE_TIMEOUT_MIN

## Token re-extraction
Selfbot tokens rotate on password change / periodically. Re-extract (browser
login + read the Authorization header / localStorage), update CINEMA_USER_TOKEN,
then `pm2 restart CertiFried-Cinema`.

## If login 401s
discord.js-selfbot-v13 was archived Oct 2025; swap to discord.js-selfbot-youtsuho-v13
and update the import in cinema/index.js.

## Risks
Selfbot = ToS violation isolated to the throwaway account (user id 791459428049223682),
never the bot fleet. The library may break on Discord updates; it is a separate,
swappable service for exactly that reason.
