LiveBot - Multi-Platform Stream Announcer
LiveBot is a powerful and customizable Discord bot that announces when your favorite streamers go live on multiple platforms, including Twitch, Kick, YouTube, TikTok, and Trovo. It offers a comprehensive web dashboard for easy management, deep customization options, and robust features for handling Twitch Teams.

Features
Multi-Platform Support: Get instant notifications for Twitch, YouTube, Kick, Trovo, and TikTok.

Twitch Team Powerhouse: Automate your entire Twitch Team. The bot syncs members, assigns roles, and even cross-posts to Kick if they're live there—all automatically.

Full Web Dashboard: Manage all servers and streamers from a sleek, intuitive web interface. No more wrestling with complicated slash commands.

Unmatched Customization: From custom webhook avatars to per-streamer messages using placeholders like {username}, tailor every detail.

Mass Management: Easily manage hundreds of streamers across different channels and servers using CSV file imports and exports.

Live Role: Automatically assign a "Live" role to linked Discord users when they go live.

Reliable & Fast: Built with efficiency in mind to deliver announcements as quickly as possible.

Commands
Command	Description	Permissions
/addstreamer	Adds a streamer to the notification list using an interactive form.	Manage Guild
/removestreamer	Removes a streamer and all their subscriptions from this server.	Manage Guild
/liststreamers	Lists all tracked streamers and their live status.	Manage Guild
/check-live	Instantly lists all currently live streamers for this server.	
/addteam	Adds all members of a Twitch Team to the announcement list for a channel.	Manage Guild
/removeteam	Removes all members of a Twitch Team from a channel and purges their announcements.	Manage Guild
/subscribe-team	Automate syncing a Twitch Team with a channel (adds/removes members).	Manage Guild
/unsubscribe-team	Stops automatically syncing a Twitch Team with a channel.	Manage Guild
/massaddstreamer	Adds multiple streamers from a platform.	Manage Guild
/massremovestreamer	Removes multiple streamers and purges their active announcements.	Manage Guild
/importcsv	Bulk adds/updates streamer subscriptions from a CSV file.	Manage Guild
/exportcsv	Exports all streamer subscriptions on this server to a CSV file.	Manage Guild
/importteamcsv	Syncs a specific channel with a CSV, adding/updating and removing streamers.	Manage Guild
/clearstreamers	Deletes ALL tracked streamers from this server and purges their announcements.	Administrator
/config	Configures all features for the bot on this server.	Manage Guild
/editstreamer	Edit settings for a specific streamer subscription.	Manage Guild
/global-reinit	Restarts the entire bot application (Bot Owner Only).	
/help	Displays a guide for all bot commands and their permissions.	
/permissions	Manage command permissions for roles on this server.	Administrator
/privacy	Set your personal announcement privacy preference.	
/reinit	Purges all announcements and re-validates roles for this server.	Manage Guild
/reset-database	Wipes the entire bot database (Bot Owner Only).	
/schedule	Displays a streamer's official or predicted weekly schedule.	Send Messages
/setup-requests	Creates the panel for users to request live announcements.	Administrator
/setup	Starts an interactive setup guide for the bot.	Administrator
/stats	Displays streaming analytics.	Send Messages
/tiktok	Manage TikTok live announcements.	Manage Guild
/trovo	Manage Trovo stream announcements.	Manage Guild
/youtube	Manage YouTube video upload announcements.	Manage Guild

Export to Sheets
Installation and Setup
Clone the repository:

Bash

git clone https://github.com/your-username/LiveBot.git
cd LiveBot
Install dependencies:

Bash

npm install
Create a .env file in the root directory and add the following environment variables:

Code snippet

# Discord Bot
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id
BOT_OWNER_ID=your_discord_user_id

# Dashboard
DASHBOARD_CLIENT_ID=your_dashboard_client_id
DASHBOARD_CLIENT_SECRET=your_dashboard_client_secret
DASHBOARD_CALLBACK_URL=http://localhost:3000/auth/discord/callback
SESSION_SECRET=a_secure_random_string

# Database
DB_HOST=localhost
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=livebot

# APIs
TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret
YOUTUBE_API_KEY=your_youtube_api_key

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# Other
TEMP_UPLOAD_CHANNEL_ID=a_discord_channel_id_for_temp_uploads
Deploy slash commands:

Bash

npm run deploy
Start the bot:

Bash

npm start
For production, it is recommended to use a process manager like PM2:

Bash

pm2 start ecosystem.config.js --env production
Dependencies
LiveBot is built with Node.js and relies on the following key dependencies:

discord.js: The official Discord API library for Node.js.

express: A fast, unopinionated, minimalist web framework for Node.js, used for the web dashboard.

mysql2: A fast Node.js MySQL client.

passport: Simple, unobtrusive authentication for Node.js.

bullmq: A robust and fast job queue system for Node.js, powered by Redis.

playwright: For browser automation to check live status on certain platforms.

cycletls: To handle TLS fingerprinting for API requests.

axios: A promise-based HTTP client for the browser and Node.js.

ejs: Embedded JavaScript templating.

dotenv: A zero-dependency module that loads environment variables from a .env file.

multer: A node.js middleware for handling multipart/form-data.

papaparse: A powerful CSV parser for the browser and Node.js.
