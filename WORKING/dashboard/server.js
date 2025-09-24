const express = require("express");
const session = require("express-session");
const passport = require("passport");
require("./passport-setup");
const path = require("path");
const fs = require("fs");
const db = require("../utils/db");
const apiChecks = require("../utils/api_checks.js");
const multer = require("multer");
const {PermissionsBitField} = require("discord.js");
const Papa = require("papaparse");
const {exec} = require("child_process");
const pm2 = require("pm2");

const upload = multer({dest: "uploads/"});
const app = express();
const port = process.env.DASHBOARD_PORT || 3000;
let client;

const getDefaultAvatar = (discriminator) => {
  return `https://cdn.discordapp.com/embed/avatars/${discriminator % 5}.png`;
};

function start(botClient) {
  client = botClient;
  if (!process.env.SESSION_SECRET) {
    console.error("[Dashboard] FATAL: SESSION_SECRET is not defined in the environment variables.");
    process.exit(1);
  }
  app.use(session({secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: {maxAge: 1000 * 60 * 60 * 24}}));
  app.use(passport.initialize());
  app.use(passport.session());
  app.use(express.json());
  app.use(express.urlencoded({extended: true}));
  app.use(express.static(path.join(__dirname, "public")));
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  const checkAuth = (req, res, next) => {
    if (req.isAuthenticated()) {
      return next();
    }
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({error: true, message: "Unauthorized"});
    }
    res.redirect("/login");
  };

  const checkGuildAdmin = (req, res, next) => {
    try {
      const isApiRequest = req.path.startsWith("/api/");
      if (!req.user || !req.user.guilds) {
        if (isApiRequest) {
          return res.status(403).json({error: true, message: "Authentication error"});
        }
        return res.status(403).render("error", {user: req.user, error: "Authentication error."});
      }
      const guild = req.user.guilds.find(g => g.id === req.params.guildId);
      if (guild && new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(req.params.guildId)) {
        req.guildObject = client.guilds.cache.get(req.params.guildId);
        return next();
      }
      if (isApiRequest) {
        return res.status(403).json({error: true, message: "Permission denied."});
      }
      res.status(403).render("error", {user: req.user, error: "Permission denied."});
    } catch (e) {
      console.error("[checkGuildAdmin Middleware Error]", e);
      res.status(500).render("error", {user: req.user, error: "An internal error occurred."});
    }
  };

  // --- MAIN ROUTES ---
  app.get("/", (req, res) => res.render("landing", {user: req.user, client_id: process.env.DISCORD_CLIENT_ID}));
  app.get("/help", (req, res) => res.render("commands", {user: req.user}));
  app.get("/login", passport.authenticate("discord"));
  app.get("/auth/discord/callback", passport.authenticate("discord", {failureRedirect: "/"}), (req, res) => res.redirect("/dashboard"));
  app.get("/logout", (req, res) => {
    req.logout(() => {
      res.redirect("/");
    });
  });
  app.get("/status", (req, res) => res.render("status", {user: req.user, isAuthenticated: req.isAuthenticated()}));

  app.get("/dashboard", checkAuth, (req, res) => {
    const manageableGuilds = req.user.guilds.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.ManageGuild) && client.guilds.cache.has(g.id));
    res.render("dashboard", {manageableGuilds, user: req.user});
  });

  // --- FULL MANAGEMENT ROUTES (RESTORED ORIGINAL LOGIC) ---
  app.get("/manage/:guildId", checkAuth, checkGuildAdmin, async (req, res) => {
    try {
      const botGuild = req.guildObject;
      const guildId = botGuild.id;
      const [[allSubscriptions], [guildSettingsResult], [channelSettingsResult], allRoles, allChannels, [rawTeamSubscriptions], [allStreamers]] = await Promise.all([
        db.execute(`SELECT sub.*, s.platform, s.username, s.discord_user_id, s.kick_username, s.streamer_id
                    FROM subscriptions sub
                             JOIN streamers s ON sub.streamer_id = s.streamer_id
                    WHERE sub.guild_id = ?
                    ORDER BY s.username`, [guildId]),
        db.execute("SELECT * FROM guilds WHERE guild_id = ?", [guildId]),
        db.execute("SELECT * FROM channel_settings WHERE guild_id = ?", [guildId]),
        botGuild.roles.fetch(),
        botGuild.channels.fetch(),
        db.execute("SELECT * FROM twitch_teams WHERE guild_id = ?", [guildId]),
        db.execute("SELECT streamer_id, platform, username, kick_username, discord_user_id FROM streamers")
      ]);

      const channelsData = {};
      const allChannelsMap = new Map(allChannels.map(ch => [ch.id, ch.name]));
      const linkedStreamerMap = new Map();
      const streamerIdToDataMap = new Map(allStreamers.map(s => [s.streamer_id, s]));

      allStreamers.forEach(s => {
        if (s.discord_user_id) {
          const existing = linkedStreamerMap.get(`discord-${s.discord_user_id}`);
          if (!existing) {
            linkedStreamerMap.set(`discord-${s.discord_user_id}`, {[s.platform]: s.streamer_id, twitch_username: s.platform === "twitch" ? s.username : null, kick_username: s.platform === "kick" ? s.username : null});
          } else {
            existing[s.platform] = s.streamer_id;
            if (s.platform === "twitch") {
              existing.twitch_username = s.username;
            }
            if (s.platform === "kick") {
              existing.kick_username = s.username;
            }
          }
        } else if (s.platform === "twitch" && s.kick_username) {
          const kickStreamer = allStreamers.find(streamer => streamer.platform === "kick" && streamer.username === s.kick_username);
          if (kickStreamer) {
            const existing = linkedStreamerMap.get(`twitch-kick-${s.streamer_id}`);
            if (!existing) {
              linkedStreamerMap.set(`twitch-kick-${s.streamer_id}`, {twitch: s.streamer_id, kick: kickStreamer.streamer_id, twitch_username: s.username, kick_username: kickStreamer.username});
            } else {
              existing.kick = kickStreamer.streamer_id;
              existing.kick_username = kickStreamer.username;
            }
          }
        }
      });

      allChannels.filter(c => c.isTextBased()).forEach(ch => {
        channelsData[ch.id] = {name: ch.name, individualStreamers: [], teams: []};
      });
      channelsData["default"] = {name: "Server Default", individualStreamers: [], teams: []};
      const teamSubscriptions = [];
      const processedStreamerSubscriptionKeys = new Set();
      for (const teamSub of rawTeamSubscriptions) {
        const [rawMembers] = await db.execute(`SELECT sub.*, s.platform, s.username, s.kick_username, s.discord_user_id
                                               FROM subscriptions sub
                                                        JOIN streamers s ON sub.streamer_id = s.streamer_id
                                               WHERE sub.guild_id = ?
                                                 AND sub.announcement_channel_id = ?
                                                 AND s.platform = 'twitch'`, [guildId, teamSub.announcement_channel_id]);
        teamSub.members = rawMembers.map(rawMember => {
          let kickUsername = rawMember.kick_username;
          if (rawMember.discord_user_id) {
            const linked = linkedStreamerMap.get(`discord-${rawMember.discord_user_id}`);
            if (linked?.kick) {
              const kickData = streamerIdToDataMap.get(linked.kick);
              if (kickData) {
                kickUsername = kickData.username;
              }
            }
          } else if (rawMember.platform === "twitch" && rawMember.kick_username) {
            const kickStreamer = allStreamers.find(s => s.platform === "kick" && s.username === kickUsername);
            if (kickStreamer) {
              kickUsername = kickStreamer.username;
            }
          }
          processedStreamerSubscriptionKeys.add(`${rawMember.streamer_id}-${teamSub.announcement_channel_id}`);
          if (kickUsername) {
            const kickStreamer = allStreamers.find(s => s.platform === "kick" && s.username === kickUsername);
            if (kickStreamer) {
              processedStreamerSubscriptionKeys.add(`${kickStreamer.streamer_id}-${teamSub.announcement_channel_id}`);
            }
          }
          return {...rawMember, twitch_username: rawMember.username, kick_username: kickUsername};
        });
        teamSubscriptions.push(teamSub);
        if (!channelsData[teamSub.announcement_channel_id]) {
          channelsData[teamSub.announcement_channel_id] = {name: allChannelsMap.get(teamSub.announcement_channel_id) || "Unknown", individualStreamers: [], teams: []};
        }
        channelsData[teamSub.announcement_channel_id].teams.push(teamSub);
      }
      for (const sub of allSubscriptions) {
        const subChannelId = sub.announcement_channel_id || "default";
        if (!processedStreamerSubscriptionKeys.has(`${sub.streamer_id}-${subChannelId}`)) {
          if (!channelsData[subChannelId]) {
            channelsData[subChannelId] = {name: allChannelsMap.get(subChannelId) || "Unknown", individualStreamers: [], teams: []};
          }
          channelsData[subChannelId].individualStreamers.push(sub);
        }
      }
      const filteredChannelsData = Object.fromEntries(Object.entries(channelsData).filter(([, data]) => data.individualStreamers.length > 0 || data.teams.length > 0));
      res.render("manage", {
        guild: botGuild, channelsData: filteredChannelsData,
        totalSubscriptions: allSubscriptions.length, user: req.user,
        settings: guildSettingsResult[0] || {}, channelSettings: channelSettingsResult,
        roles: allRoles.filter(r => !r.managed && r.name !== "@everyone"),
        channels: allChannels.filter(c => c.isTextBased()),
        teamSubscriptions
      });
    } catch (error) {
      console.error("[Dashboard GET Error]", error);
      res.status(500).render("error", {user: req.user, error: "Error loading management page."});
    }
  });

  app.post("/manage/:guildId/settings", checkAuth, checkGuildAdmin, async (req, res) => {
    const {channelId, roleId} = req.body;
    await db.execute("INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = ?, live_role_id = ?", [req.params.guildId, channelId || null, roleId || null, channelId || null, roleId || null]);
    res.redirect(`/manage/${req.params.guildId}?success=settings`);
  });

  app.post("/manage/:guildId/add", checkAuth, checkGuildAdmin, async (req, res) => {
    const {platform, username, discord_user_id, announcement_channel_id} = req.body;
    let streamerInfo = {puid: null, dbUsername: null, pfp: null};
    try {
      if (platform === "twitch") {
        const u = await apiChecks.getTwitchUser(username);
        if (u) {
          streamerInfo = {puid: u.id, dbUsername: u.login, pfp: u.profile_image_url};
        }
      } else if (platform === "youtube") {
        const c = await apiChecks.getYouTubeChannelId(username);
        if (c?.channelId) {
          streamerInfo = {puid: c.channelId, dbUsername: c.channelName || username};
        }
      } else if (["tiktok", "trovo"].includes(platform)) {
        streamerInfo = {puid: username, dbUsername: username};
      }

      if (!streamerInfo.puid) {
        return res.status(400).render("error", {user: req.user, error: `Could not find streamer "${username}" on ${platform}.`});
      }

      await db.execute("INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username=VALUES(username), discord_user_id=VALUES(discord_user_id), profile_image_url=VALUES(profile_image_url)", [platform, streamerInfo.puid, streamerInfo.dbUsername, discord_user_id || null, streamerInfo.pfp]);
      const [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", [platform, streamerInfo.puid]);

      if (!streamer || !streamer.streamer_id) {
        return res.status(500).render("error", {user: req.user, error: "Failed to retrieve streamer ID."});
      }

      const ids = announcement_channel_id ? (Array.isArray(announcement_channel_id) ? announcement_channel_id : [announcement_channel_id]) : [""];
      for (const channelId of ids) {
        await db.execute("INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)", [req.params.guildId, streamer.streamer_id, channelId || null]);
      }
      res.redirect(`/manage/${req.params.guildId}?success=add`);
    } catch (error) {
      console.error("[Dashboard Add Streamer Error]:", error);
      res.status(500).render("error", {user: req.user, error: "An error occurred."});
    }
  });

  app.post("/manage/:guildId/subscribe-team", checkAuth, checkGuildAdmin, async (req, res) => {
    await db.execute("INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id) VALUES (?, ?, ?)", [req.params.guildId, req.body.teamName, req.body.channelId]);
    res.redirect(`/manage/${req.params.guildId}?success=team_added#teams-tab`);
  });

  app.post("/manage/:guildId/update-team", checkAuth, checkGuildAdmin, async (req, res) => {
    const {teamSubscriptionId, liveRoleId, webhookName, webhookAvatarUrl} = req.body;
    await db.execute("UPDATE twitch_teams SET live_role_id = ?, webhook_name = ?, webhook_avatar_url = ? WHERE id = ? AND guild_id = ?", [liveRoleId || null, webhookName || null, webhookAvatarUrl || null, teamSubscriptionId, req.params.guildId]);
    res.redirect(`/manage/${req.params.guildId}?success=team_updated#teams-tab`);
  });

  app.post("/manage/:guildId/removeteam", checkAuth, checkGuildAdmin, async (req, res) => {
    const {teamSubscriptionId} = req.body;
    const {guildId} = req.params;
    const [[teamSub]] = await db.execute("SELECT team_name, announcement_channel_id FROM twitch_teams WHERE id = ? AND guild_id = ?", [teamSubscriptionId, guildId]);
    if (teamSub) {
      const teamMembers = await apiChecks.getTwitchTeamMembers(teamSub.team_name);
      if (teamMembers?.length > 0) {
        const memberLogins = teamMembers.map(m => m.user_login);
        const [streamerIds] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = 'twitch' AND username IN (?)", [memberLogins]);
        if (streamerIds.length > 0) {
          const idsToRemove = streamerIds.map(s => s.streamer_id);
          await db.execute("DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (?)", [guildId, teamSub.announcement_channel_id, idsToRemove]);
        }
      }
      await db.execute("DELETE FROM twitch_teams WHERE id = ? AND guild_id = ?", [teamSubscriptionId, guildId]);
    }
    res.redirect(`/manage/${req.params.guildId}?success=team_removed#teams-tab`);
  });

  app.post("/manage/:guildId/channel-appearance/save", checkAuth, checkGuildAdmin, upload.single("avatar"), async (req, res) => {
    const {channelId, nickname, avatar_url_text} = req.body;
    const finalNickname = (nickname?.toLowerCase() === "reset") ? null : nickname;
    const finalAvatarUrl = (avatar_url_text?.toLowerCase() === "reset" || avatar_url_text === "") ? null : avatar_url_text;
    await db.execute("INSERT INTO channel_settings (guild_id, channel_id, override_nickname, override_avatar_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url)", [req.params.guildId, channelId, finalNickname, finalAvatarUrl]);
    res.redirect(`/manage/${req.params.guildId}?success=appearance#appearance-tab`);
  });

  app.post("/manage/:guildId/remove-subscription", checkAuth, checkGuildAdmin, async (req, res) => {
    await db.execute("DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?", [req.body.subscription_id, req.params.guildId]);
    res.redirect(`/manage/${req.params.guildId}?success=remove`);
  });

  app.post("/manage/:guildId/edit-subscription", checkAuth, checkGuildAdmin, async (req, res) => {
    const {subscription_id, discord_user_id, kick_username, announcement_channel_id, override_nickname, custom_message, override_avatar_url_text, reset_avatar} = req.body;
    const [[sub]] = await db.execute("SELECT streamer_id, override_avatar_url FROM subscriptions WHERE subscription_id = ?", [subscription_id]);
    if (!sub) {
      return res.status(404).render("error", {user: req.user, error: "Subscription not found."});
    }

    let finalAvatarUrl = (reset_avatar === "true" || override_avatar_url_text?.toLowerCase() === "reset") ? null : (override_avatar_url_text || sub.override_avatar_url);

    await db.execute("UPDATE streamers SET discord_user_id = ?, kick_username = ? WHERE streamer_id = ?", [discord_user_id || null, kick_username || null, sub.streamer_id]);
    await db.execute("UPDATE subscriptions SET announcement_channel_id = ?, override_nickname = ?, custom_message = ?, override_avatar_url = ? WHERE subscription_id = ?", [announcement_channel_id || null, override_nickname || null, custom_message || null, finalAvatarUrl, subscription_id]);
    res.redirect(`/manage/${req.params.guildId}?success=edit`);
  });

  app.get("/manage/:guildId/export", checkAuth, checkGuildAdmin, async (req, res) => {
    const [rows] = await db.execute(`SELECT s.platform, s.username, s.discord_user_id, s.kick_username, sub.announcement_channel_id, sub.custom_message
                                     FROM subscriptions sub
                                              JOIN streamers s ON sub.streamer_id = s.streamer_id
                                     WHERE sub.guild_id = ?`, [req.params.guildId]);
    if (rows.length === 0) {
      return res.status(404).send("No subscriptions to export.");
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="subscriptions-${req.params.guildId}.csv"`);
    res.send(Papa.unparse(rows));
  });

  app.post("/manage/:guildId/import-team", checkAuth, checkGuildAdmin, upload.single("csvfile"), async (req, res) => {
    if (!req.file) {
      return res.status(400).render("error", {user: req.user, error: "No CSV file uploaded."});
    }
    const csvData = fs.readFileSync(req.file.path, "utf8");
    fs.unlinkSync(req.file.path);
    const {data: rows} = Papa.parse(csvData, {header: true, skipEmptyLines: true});

    for (const row of rows) {
      if (!row.platform || !row.username) {
        continue;
      }
      let [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND username = ?", [row.platform, row.username]);
      if (!streamer) {
        const [result] = await db.execute("INSERT INTO streamers (platform, username) VALUES (?, ?)", [row.platform, row.username]);
        streamer = {streamer_id: result.insertId};
      }
      await db.execute("INSERT IGNORE INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)", [req.params.guildId, streamer.streamer_id, req.body.channelId]);
    }
    res.redirect(`/manage/${req.params.guildId}?success=import#csv-tab`);
  });

  // --- API ROUTES ---
  async function getFormattedLiveRows(rows) {
    const platformPriority = ["kick", "twitch", "youtube", "tiktok", "trovo"];
    const streamersMap = new Map();
    for (const row of rows) {
      const key = row.discord_user_id || (row.username ? row.username.toLowerCase() : `_missing_user_${row.streamer_id}`);
      if (!streamersMap.has(key)) {
        streamersMap.set(key, []);
      }
      streamersMap.get(key).push(row);
    }
    const discordUserIds = rows.map(r => r.discord_user_id).filter(id => id);
    const allAssociatedAccounts = new Map();
    if (discordUserIds.length > 0) {
      const [accounts] = await db.query("SELECT discord_user_id, username, platform, profile_image_url, platform_user_id FROM streamers WHERE discord_user_id IN (?)", [[...new Set(discordUserIds)]]);
      for (const acc of accounts) {
        if (!allAssociatedAccounts.has(acc.discord_user_id)) {
          allAssociatedAccounts.set(acc.discord_user_id, []);
        }
        allAssociatedAccounts.get(acc.discord_user_id).push(acc);
      }
      allAssociatedAccounts.forEach(userAccounts => userAccounts.sort((a, b) => platformPriority.indexOf(a.platform) - platformPriority.indexOf(b.platform)));
    }

    const formattedResult = [];
    for (const userAnnouncements of streamersMap.values()) {
      userAnnouncements.sort((a, b) => platformPriority.indexOf(a.platform) - platformPriority.indexOf(b.platform));
      const primaryLiveAnnouncement = userAnnouncements[0];

      // If the primary live announcement doesn't even have a username, we cannot process it. Skip this user.
      if (!primaryLiveAnnouncement.username) {
        continue;
      }

      const discordId = primaryLiveAnnouncement.discord_user_id;
      let primaryIdentity = primaryLiveAnnouncement, bestAvatar = primaryLiveAnnouncement.profile_image_url;
      const userAccounts = allAssociatedAccounts.get(discordId);
      if (userAccounts?.length > 0) {
        primaryIdentity = userAccounts[0];
        bestAvatar = userAccounts.find(acc => acc.profile_image_url)?.profile_image_url || bestAvatar;
      }
      const live_platforms = [...new Map(userAnnouncements.map(a => {
        let url = "#";
        switch (a.platform) {
          case "twitch":
            url = `https://www.twitch.tv/${a.username}`;
            break;
          case "kick":
            url = `https://kick.com/${a.username}`;
            break;
          case "youtube":
            url = `https://www.youtube.com/channel/${a.platform_user_id}`;
            break;
          case "tiktok":
            url = `https://www.tiktok.com/@${a.username}`;
            break;
          case "trovo":
            url = `https://trovo.live/s/${a.username}`;
            break;
        }
        return [a.platform, {platform: a.platform, game: a.stream_game || "N/A", url: url}];
      })).values()];

      // Final check to ensure we push a valid object
      if (primaryIdentity.username) {
        formattedResult.push({username: primaryIdentity.username, avatar_url: bestAvatar || getDefaultAvatar(0), live_platforms});
      }
    }
    return formattedResult;
  }

  app.get("/api/status-data", async (req, res) => {
    try {
      // *** FIX PART 1: Modify database queries to EXCLUDE invalid records from the start.
      const [
        [[{totalStreamers}]],
        [[{totalGuilds}]],
        [[{totalAnnouncements}]],
        [platformDistribution],
        [liveRows]
      ] = await Promise.all([
        db.execute("SELECT COUNT(*) as totalStreamers FROM streamers"),
        db.execute("SELECT COUNT(DISTINCT guild_id) as totalGuilds FROM subscriptions"),
        db.execute("SELECT COUNT(*) as totalAnnouncements FROM announcements"),
        db.execute("SELECT platform, COUNT(*) as count FROM streamers WHERE platform IS NOT NULL AND platform != \"\" GROUP BY platform ORDER BY count DESC"),
        db.execute(`SELECT s.username, s.discord_user_id, s.profile_image_url, s.platform_user_id, s.streamer_id, a.platform, a.stream_game
                    FROM announcements a
                             JOIN streamers s ON a.streamer_id = s.streamer_id
                    WHERE s.username IS NOT NULL
                      AND s.username != ''
                      AND a.platform IS NOT NULL
                      AND a.platform != ''`)
      ]);

      const formattedLiveStreamers = await getFormattedLiveRows(liveRows);

      const publicData = {
        liveCount: formattedLiveStreamers.length,
        liveStreamers: formattedLiveStreamers,
        totalStreamers: totalStreamers || 0,
        totalGuilds: totalGuilds || 0,
        totalAnnouncements: totalAnnouncements || 0,
        platformDistribution
      };

      if (req.isAuthenticated()) {
        const pm2DataPromise = new Promise((resolve) => {
          pm2.describe("CertiFriedAnnouncer", (err, procList) => {
            if (err || !procList || procList.length === 0) {
              return resolve({app: {status: "offline", uptime: "N/A", memory: "N/A"}});
            }
            const proc = procList[0];
            const uptime = proc.pm2_env.pm_uptime ? new Date(Date.now() - proc.pm2_env.pm_uptime).toISOString().slice(11, 19) : "N/A";
            resolve({app: {status: proc.pm2_env.status, uptime, memory: `${(proc.monit.memory / 1024 / 1024).toFixed(1)} MB`}});
          });
        });
        const dbConnectionPromise = db.getConnection().then(c => {
          c.release();
          return {status: "ok"};
        }).catch(() => ({status: "error"}));
        const twitchApiPromise = apiChecks.getTwitchUser("twitch").then(u => ({status: u ? "ok" : "error"})).catch(() => ({status: "error"}));

        const [pm2Result, dbStatus, twitchStatus] = await Promise.all([pm2DataPromise, dbConnectionPromise, twitchApiPromise]);
        return res.json({...publicData, ...pm2Result, db: {status: dbStatus.status}, api: {twitch: twitchStatus.status}});
      }
      res.json(publicData);
    } catch (error) {
      console.error("[API status-data Error]", error);
      res.status(500).json({error: true, message: "Internal server error."});
    }
  });

  app.get("/api/authenticated-logs", checkAuth, async (req, res) => {
    const logPath = process.env.PM2_LOG_PATH || path.join(require("os").homedir(), ".pm2", "logs", "CertiFriedAnnouncer-out.log");
    const logCommand = `tail -n 100 "${logPath}"`;
    exec(logCommand, {maxBuffer: 1024 * 500}, (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({logs: `Log file not found at: ${logPath}`, error: "Failed to read logs."});
      }
      res.json({logs: stdout, error: stderr || null});
    });
  });

  app.get("/api/global-live-status", async (req, res) => {
    const [liveRows] = await db.execute(`SELECT s.username, s.discord_user_id, s.profile_image_url, s.platform_user_id, a.platform, a.stream_game
                                         FROM announcements a
                                                  JOIN streamers s ON a.streamer_id = s.streamer_id
                                         WHERE s.username IS NOT NULL
                                           AND s.username != ''`);
    const formatted = await getFormattedLiveRows(liveRows);
    const [[{totalStreamers}]] = await db.execute("SELECT COUNT(*) as totalStreamers FROM streamers");
    const [[{totalGuilds}]] = await db.execute("SELECT COUNT(DISTINCT guild_id) as totalGuilds FROM subscriptions");
    res.json({liveStreamers: formatted, liveCount: formatted.length, totalStreamers, totalGuilds});
  });

  app.get("/api/guilds/:guildId/livestatus", checkAuth, checkGuildAdmin, async (req, res) => {
    const [liveRows] = await db.execute(`SELECT s.username, s.discord_user_id, s.profile_image_url, s.platform_user_id, a.platform, a.stream_game
                                         FROM announcements a
                                                  JOIN streamers s ON a.streamer_id = s.streamer_id
                                         WHERE a.guild_id = ?
                                           AND s.username IS NOT NULL
                                           AND s.username != ''`, [req.params.guildId]);
    res.json(await getFormattedLiveRows(liveRows));
  });

  app.use((req, res) => {
    res.status(404).render('error', {user: req.user, error: 'Page Not Found'});
  });

  app.listen(port, () => console.log(`[Dashboard] Web dashboard listening on port ${port}`));
}

module.exports = {start};