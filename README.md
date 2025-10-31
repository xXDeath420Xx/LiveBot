# CertiFried MultiTool

> A comprehensive Discord multi-tool bot featuring stream announcements, moderation, music with AI DJ, leveling, giveaways, polls, tickets, forms, feeds, and 20+ other features.

[![Version](https://img.shields.io/badge/version-4.0.0-blue.svg)](#)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue.svg)](https://discord.js.org)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)

---

## 📋 Table of Contents

- [Features](#-features)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Commands](#-commands)
- [Dashboard](#-dashboard)
- [Advanced Features](#-advanced-features)
- [Troubleshooting](#-troubleshooting)
- [License](#-license)

---

## 🎯 Features

CertiFried MultiTool is a feature-rich Discord bot designed to handle everything your server needs. Here are all 21 major feature categories:

### 1. Multi-Platform Stream Announcements
- ✅ Supports **7 platforms**: Twitch, YouTube, Kick, TikTok, Trovo, Facebook Gaming, Instagram
- ✅ Single announcement message per streamer per platform (no duplicates)
- ✅ Live role management (auto-add/remove roles when streaming)
- ✅ Customizable webhooks (post as the streamer with custom avatar/name)
- ✅ Auto-updating embeds every 5 minutes with live stats
- ✅ Stream summary or deletion on stream end
- ✅ Bulk operations (mass add/remove, CSV import/export)

### 2. Twitch Team Synchronization
- ✅ Auto-sync team members from Twitch teams
- ✅ Automatic platform linking when usernames match
- ✅ Team-wide announcements
- ✅ CSV import for teams

### 3. Customizable Bot Appearance
- ✅ Global webhook settings (name, avatar)
- ✅ Per-channel webhook overrides
- ✅ Per-streamer webhook customization
- ✅ Post as the streamer for authentic announcements

### 4. Welcome & Farewell System
- ✅ Customizable welcome messages
- ✅ Welcome cards with user avatars
- ✅ Farewell messages
- ✅ Auto-roles on join
- ✅ DM welcome messages

### 5. Reaction Roles
- ✅ Create reaction role panels with buttons
- ✅ Multiple panels per server
- ✅ Role limits and requirements
- ✅ Auto-remove conflicting roles

### 6. Starboard
- ✅ Highlight best messages with star reactions
- ✅ Configurable star threshold
- ✅ Custom starboard channel
- ✅ Message permalinks

### 7. Leveling System
- ✅ XP gain on messages
- ✅ Level-up announcements
- ✅ Role rewards at specific levels
- ✅ Rank cards with user stats
- ✅ Server leaderboards (XP, levels, reputation)

### 8. Giveaways
- ✅ Timed giveaways with automatic winner selection
- ✅ Multiple winners support
- ✅ Reaction-based entry
- ✅ Commands: `/fun giveaway start`, `end`, `reroll`, `list`, `cancel`

### 9. Polling System
- ✅ Create polls with up to 10 options
- ✅ Automatic poll ending
- ✅ Live results tracking
- ✅ Commands: `/utility poll create`, `end`, `list`, `results`

### 10. Music System with AI DJ
- ✅ Play music from YouTube, Spotify, SoundCloud, and more
- ✅ **yt-dlp integration** with local file caching for reliable YouTube playback
  - Automatically downloads and caches audio files
  - Configurable cache size and retention
  - Fallback to browser-based extraction if needed
- ✅ **AI DJ Mode** with Gemini AI and PiperTTS
  - Generates playlists based on seed songs/genres
  - AI-powered commentary and intros (saved as local files)
  - Passive-aggressive banter when users skip songs
  - Configurable voice models (male, female, UK accents, and more)
  - Seamless transitions between music and DJ commentary
- ✅ Playlist management
- ✅ Filters and effects
- ✅ DJ role permissions
- ✅ Music panels with buttons
- ✅ Commands: `/music play`, `skip`, `queue`, `dj`, `playlist`, and 20+ more

### 11. Comprehensive Moderation
- ✅ Moderation commands: ban, unban, kick, mute, unmute, warn, timeout
- ✅ Bulk message deletion with filters
- ✅ Slowmode, lock/unlock channels
- ✅ Lockdown mode with password protection
- ✅ User history tracking
- ✅ Automod (spam, caps, links, bad words, mentions)
- ✅ Anti-nuke protection
- ✅ Anti-raid measures
- ✅ Join gate (verification)
- ✅ Quarantine system
- ✅ Comprehensive logging (all events)

### 12. Activity & Stat-Based Roles
- ✅ Assign roles based on message count
- ✅ Voice time tracking
- ✅ Automatic role assignment
- ✅ Configurable thresholds

### 13. Social Media Feeds
- ✅ Reddit feeds (subreddit posts)
- ✅ TikTok feeds (via streamer system)
- ✅ YouTube feeds (video uploads)
- ✅ Twitter feeds
- ✅ Auto-posting to designated channels

### 14. AI-Generated Scheduling
- ✅ Gemini AI predicts streamer schedules
- ✅ Analyzes streaming patterns
- ✅ Syncs with Twitch schedules
- ✅ Manual schedule overrides

### 15. Server Utilities
- ✅ Auto-publisher (auto-publish announcement channel messages)
- ✅ Auto-roles (roles assigned on join)
- ✅ Temporary voice channels (create your own VC)

### 16. Custom Commands & Tags
- ✅ Create custom text commands
- ✅ Role-based permissions
- ✅ Channel restrictions
- ✅ Tag system for quick responses

### 17. Ticketing & Forms System
- ✅ Support ticket system
- ✅ Ticket panels with buttons
- ✅ Form creation with multiple question types
- ✅ Form panels for easy access
- ✅ Submission tracking and management

### 18. Server Backups
- ✅ Backup server structure (roles, channels, permissions)
- ✅ Restore from backups
- ✅ Backup management (list, delete)
- ✅ Commands: `/manage backup create`, `list`, `load`, `delete`

### 19. Full Web Dashboard
- ✅ OAuth2 authentication
- ✅ 30+ management pages
- ✅ Real-time configuration
- ✅ CSV import/export
- ✅ Live status monitoring
- ✅ Server metrics

### 20 & 21. Miscellaneous & Security
- ✅ Reminders, 8-ball, weather, dictionary
- ✅ User/server info, find commands
- ✅ Reputation system
- ✅ Command permission system
- ✅ Protected actions with passwords
- ✅ Audit logging

---

## 🚀 Installation

### Prerequisites

- Node.js v18+ ([Download](https://nodejs.org/))
- MariaDB/MySQL ([Download](https://mariadb.org/download/))
- Redis ([Download](https://redis.io/download))
- PM2: `npm install -g pm2`

### Setup

```bash
# Clone repository
git clone https://github.com/yourusername/certifried-multitool.git
cd certifried-multitool

# Install dependencies
npm install

# Create database
mysql -u root -p
CREATE DATABASE livenotif CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
exit

# Import schema
mysql -u root -p livenotif < livebot_full.sql

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Deploy commands
npm run deploy

# Start bot
npm start
```

---

## ⚙️ Configuration

Create a `.env` file:

```env
# Discord
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret

# Database
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=livenotif

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Dashboard
DASHBOARD_PORT=3000
CALLBACK_URL=http://localhost:3000/callback
SESSION_SECRET=random_secret_here

# API Keys (Optional)
TWITCH_CLIENT_ID=your_twitch_id
TWITCH_CLIENT_SECRET=your_twitch_secret
YOUTUBE_API_KEY=your_youtube_key
GEMINI_API_KEY=your_gemini_key

# Piper TTS (for AI DJ)
PIPER_PATH=/path/to/piper
PIPER_MODEL_DIR=/path/to/piper_models

# yt-dlp (for YouTube music with caching)
YTDLP_PATH=yt-dlp                    # Path to yt-dlp binary (optional, defaults to 'yt-dlp')
YTDLP_CACHE_DIR=./audio_cache        # Directory for cached audio files (optional, defaults to ./audio_cache)
YTDLP_MAX_CACHE_MB=1000              # Maximum cache size in MB (optional, defaults to 1000MB / 1GB)
YTDLP_MAX_CACHE_HOURS=24             # Maximum age of cached files in hours (optional, defaults to 24h)
YTDLP_COOKIES=./cookies.txt          # Path to cookies.txt for authentication (optional)
```

---

## 📝 Commands

### Core Commands

**Streamer Management** (`/streamer`)
- `add` - Add a streamer
- `remove` - Remove a streamer
- `edit` - Edit settings
- `list` - List streamers
- `check-live` - Check live status
- `massadd/massremove` - Bulk operations
- `importcsv/exportcsv` - CSV management

**Music** (`/music`)
- `play <song>` - Play music
- `skip` - Skip track
- `queue` - View queue
- `dj <song/genre>` - Start AI DJ
- `playlist create/play` - Playlist management
- 20+ total music commands

**Moderation** (`/manage moderation`)
- `ban/unban` - Ban management
- `kick` - Kick user
- `mute/unmute` - Timeout users
- `warn` - Issue warnings
- `purge` - Bulk delete messages
- `slowmode/lock/lockdown` - Channel controls

**Giveaways** (`/fun giveaway`)
- `start` - Create giveaway
- `end` - End early
- `reroll` - New winner
- `list` - Active giveaways
- `cancel` - Cancel giveaway

**Polls** (`/utility poll`)
- `create` - New poll
- `end` - End early
- `list` - Active polls
- `results` - View results

**Backups** (`/manage backup`)
- `create` - Create backup
- `list` - View backups
- `load` - Restore backup
- `delete` - Delete backup

---

## 🌐 Dashboard

Access at `http://localhost:3000`

**Features:**
- Manage all 21 feature categories
- Real-time configuration
- CSV import/export
- Live metrics and monitoring
- User-friendly interface
- OAuth2 secure login

---

## 🔧 Advanced Features

### AI DJ Setup

1. Get Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Install [Piper TTS](https://github.com/rhasspy/piper)
3. Download voice models
4. Configure in `.env` and dashboard
5. Use `/music dj <song/genre>`

### Custom Voices

Place Piper models in `piper_models/en/en_US/` or `piper_models/en/en_GB/`

Configure voice in dashboard: Settings → Music → DJ Voice

Options: female, male, uk-female, uk-male, or custom model path

---

## 🐛 Troubleshooting

**Bot won't start:**
- Check `.env` configuration
- Verify database connection
- Ensure Redis is running
- View logs: `npm run logs`

**Commands not showing:**
- Run `npm run deploy`
- Wait 1 hour for global sync
- Check bot permissions

**Music not playing:**
- Check FFmpeg installation
- Verify voice permissions
- Test with `/music play`

**Stream announcements:**
- Verify API keys
- Check channel permissions
- Use `/streamer check-live`

---

## 📄 License

MIT License - See LICENSE file

---

## 🙏 Acknowledgments

- [Discord.js](https://discord.js.org/)
- [discord-player](https://github.com/Androz2091/discord-player)
- [Piper TTS](https://github.com/rhasspy/piper)
- [Google Gemini](https://ai.google.dev/)

---

**Made with ❤️ for Discord communities**
