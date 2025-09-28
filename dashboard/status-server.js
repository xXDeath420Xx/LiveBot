const express = require("express");
const path = require("path");
const logger = require("../utils/logger");
const db = require("../utils/db");
const cache = require("../utils/cache");
require("dotenv-flow").config({ path: path.resolve(__dirname, "..") });

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// The main route to render the status page
app.get("/status", (req, res) => {
    res.render("status", { user: null, isAuthenticated: false });
});

// The API endpoint the status page will fetch data from
app.get("/api/standalone-status-data", async (req, res) => {
    try {
        // 1. Check Bot Status via Redis Heartbeat
        const lastPing = await cache.get("bot:health:last_ping");
        const botIsAlive = lastPing && (Date.now() - parseInt(lastPing, 10)) < 30000; // 30 second tolerance
        const botStatus = { app: { status: botIsAlive ? 'online' : 'offline' } };

        // 2. Check DB and Redis Connections
        const dbConnectionPromise = db.getConnection().then(c => { c.release(); return { status: "ok" }; }).catch(() => ({ status: "error" }));
        const redisConnectionPromise = cache.redis.ping().then(() => ({ status: "ok" })).catch(() => ({ status: "error" }));

        const [dbStatus, redisStatus] = await Promise.all([dbConnectionPromise, redisConnectionPromise]);

        // 3. Fetch Public Stats from DB
        const [ [[{totalStreamers}]], [[{totalGuilds}]], [platformDistribution] ] = await Promise.all([
            db.execute("SELECT COUNT(*) as totalStreamers FROM streamers"),
            db.execute("SELECT COUNT(DISTINCT guild_id) as totalGuilds FROM subscriptions"),
            db.execute("SELECT platform, COUNT(*) as count FROM streamers WHERE platform IS NOT NULL AND platform != '' GROUP BY platform ORDER BY count DESC"),
        ]);

        res.json({
            ...botStatus,
            db: dbStatus,
            redis: redisStatus,
            totalStreamers,
            totalGuilds,
            platformDistribution
        });

    } catch (error) {
        logger.error("[Status Server API Error]", { error });
        res.status(500).json({ error: true, message: "Internal server error." });
    }
});

app.use((req, res) => {
    res.status(404).render('error', { user: null, error: 'Page Not Found' });
});

const port = process.env.STATUS_PAGE_PORT || 3000;
app.listen(port, () => {
    logger.info(`[Status Server] Standalone status page listening on port ${port}`);
});