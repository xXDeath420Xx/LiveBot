import "dotenv/config";
import express from "express";
import mysql from "mysql2/promise";

const app = express();
app.use(express.json());

const SECRET = process.env.JELLYFIN_SHARED_SECRET;
const PORT = 4099;

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2
});

app.post("/api/check-guilds", async (req, res) => {
    const secret = req.headers["x-api-secret"];
    if (!secret || secret !== SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const guildIds = req.body && req.body.guildIds;
    if (!Array.isArray(guildIds) || guildIds.length === 0) {
        return res.status(400).json({ error: "guildIds must be a non-empty array" });
    }

    try {
        const placeholders = guildIds.map(() => "?").join(",");
        const [rows] = await pool.query(
            `SELECT DISTINCT guild_id FROM guilds WHERE guild_id IN (${placeholders})`,
            guildIds
        );
        const shared = rows.map(r => r.guild_id);
        const [countResult] = await pool.query("SELECT COUNT(*) as total FROM guilds");

        res.json({ shared, totalBotGuilds: countResult[0].total });
    } catch (err) {
        console.error("[GuildCheck] DB error:", err.message);
        res.status(500).json({ error: "Internal error" });
    }
});

app.listen(PORT, "0.0.0.0", () => console.log(`[GuildCheck] API running on port ${PORT} (DB-backed)`));
