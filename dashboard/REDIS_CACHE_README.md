# Redis Caching System for CertiFried Announcer Dashboard

## Overview

This Redis caching implementation provides a performant caching layer for the CertiFried Announcer dashboard with automatic fallback to database queries when cache is unavailable.

## Files Created

1. **cache-middleware.ts** - Core caching middleware with Redis connection management
2. **server-cached.ts** - Enhanced server implementation with integrated caching
3. **cache-integration.ts** - Helper classes for cache operations and data updates
4. **cache-setup-example.js** - JavaScript example showing integration with existing server.js

## Features

### Cache TTL Configuration

- **Manage Page Data**: 60 seconds
- **Server List**: 30 seconds
- **Live Streams**: 15 seconds
- **Status Page**: 10 seconds
- **Commands List**: 5 minutes
- **User-Specific Data**: 2 minutes
- **Static Config**: 10 minutes

### Automatic Fallback

If Redis is unavailable or fails, the system automatically falls back to direct database queries, ensuring the dashboard remains functional.

### Cache Invalidation

Automatic cache invalidation occurs on:
- POST/PUT/DELETE/PATCH requests
- Guild settings updates
- Streamer additions/removals
- Live stream status changes

## Setup Instructions

### 1. Environment Variables

Add to your `.env` file:

```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_password_here  # Optional
REDIS_DB=0
```

### 2. Install Redis Server

```bash
# Ubuntu/Debian
sudo apt-get install redis-server

# Start Redis
sudo systemctl start redis
sudo systemctl enable redis

# Test connection
redis-cli ping
# Should return: PONG
```

### 3. Integration with Existing server.js

#### Option A: Minimal Integration (JavaScript)

```javascript
// At the top of server.js
const cacheSetup = require('./cache-setup-example');

// In your server initialization
async function startServer() {
    await cacheSetup.initializeCache();

    // Replace getManagePageData with cached version
    const getManagePageData = cacheSetup.getManagePageDataCached;

    // Setup cached routes
    cacheSetup.setupCachedManageRoutes(app);
    cacheSetup.setupCachedServersRoute(app, botClient);
    cacheSetup.setupCacheInvalidation(app);

    // Start server
    app.listen(PORT);
}
```

#### Option B: Full TypeScript Integration

```typescript
// Import cache middleware
import { initializeRedis, getCachedData, CACHE_TTL } from './cache-middleware';
import { setupCachedRoutes } from './server-cached';

// Initialize on startup
await initializeRedis();

// Setup routes with caching
setupCachedRoutes(app, botClient);
```

## Usage Examples

### 1. Caching Database Queries

```typescript
import { getCachedData, CACHE_TTL } from './cache-middleware';

async function getGuildData(guildId: string) {
    const cacheKey = `guild:${guildId}:data`;

    return getCachedData(
        cacheKey,
        async () => {
            // Expensive database query
            const [data] = await db.execute('SELECT * FROM guilds WHERE guild_id = ?', [guildId]);
            return data;
        },
        CACHE_TTL.MANAGE_PAGE_DATA
    );
}
```

### 2. Invalidating Cache After Updates

```typescript
import { invalidateGuildCache } from './cache-middleware';

app.post('/manage/:guildId/update', async (req, res) => {
    const { guildId } = req.params;

    // Update database
    await updateGuildSettings(guildId, req.body);

    // Invalidate cache
    await invalidateGuildCache(guildId);

    res.redirect(`/manage/${guildId}`);
});
```

### 3. Batch Operations

```typescript
import { BatchCacheOperations } from './cache-integration';

// Prefetch data for multiple guilds
const guildIds = ['123', '456', '789'];
await BatchCacheOperations.prefetchGuildData(guildIds);

// Invalidate multiple guilds
await BatchCacheOperations.invalidateMultipleGuilds(guildIds);
```

### 4. Cache Statistics

```typescript
import { getCacheStats } from './cache-middleware';

app.get('/api/cache-stats', async (req, res) => {
    const stats = await getCacheStats();
    res.json(stats);
    // Returns: { available: true, keys: 42, memory: "2.5 MB", hits: 1000, misses: 50 }
});
```

## API Endpoints

### Cache Management

- `GET /api/cache-stats` - Get cache statistics
- `POST /api/cache/invalidate/guild/:guildId` - Invalidate specific guild cache
- `POST /api/cache/invalidate/livestreams` - Invalidate live stream cache

## Performance Benefits

1. **Reduced Database Load**: Frequently accessed data is served from memory
2. **Faster Page Loads**: Cache hits are ~100x faster than database queries
3. **Better Scalability**: Can handle more concurrent users
4. **Live Data Freshness**: Short TTLs for live data ensure accuracy

## Monitoring

### Check Redis Status

```bash
# Check if Redis is running
redis-cli ping

# Monitor cache operations in real-time
redis-cli monitor

# Get cache statistics
redis-cli info stats

# View all cached keys
redis-cli keys "certifried:*"
```

### Dashboard Metrics

Access `/api/cache-stats` to see:
- Cache availability status
- Number of cached keys
- Memory usage
- Hit/miss ratio

## Troubleshooting

### Redis Connection Issues

1. Check Redis is running: `systemctl status redis`
2. Verify connection settings in `.env`
3. Check Redis logs: `sudo journalctl -u redis`

### Cache Not Working

1. Check `redisAvailable` flag in logs
2. Verify Redis has enough memory: `redis-cli info memory`
3. Check for connection errors in application logs

### Clear All Cache

```bash
# From Redis CLI
redis-cli FLUSHDB

# From application
curl -X POST http://localhost:3000/api/cache/invalidate/all
```

## Best Practices

1. **Use Appropriate TTLs**: Shorter for live data, longer for static data
2. **Invalidate Wisely**: Only invalidate affected cache entries
3. **Monitor Memory**: Set Redis memory limits to prevent OOM
4. **Handle Failures**: Always implement fallback logic
5. **Batch Operations**: Group cache operations when possible

## Security Considerations

1. **Use Redis Password**: Always set a password in production
2. **Bind to Localhost**: Don't expose Redis to public internet
3. **Use SSL/TLS**: For remote Redis connections
4. **Limit Memory**: Set `maxmemory` in Redis config
5. **Regular Updates**: Keep Redis server updated

## Configuration Examples

### redis.conf

```conf
# Set maximum memory
maxmemory 256mb
maxmemory-policy allkeys-lru

# Enable persistence
save 900 1
save 300 10
save 60 10000

# Security
requirepass your_secure_password_here
bind 127.0.0.1
protected-mode yes
```

### PM2 Ecosystem Config

```javascript
module.exports = {
    apps: [{
        name: 'dashboard',
        script: './dashboard/server.js',
        env: {
            REDIS_HOST: 'localhost',
            REDIS_PORT: 6379,
            REDIS_PASSWORD: process.env.REDIS_PASSWORD,
            REDIS_DB: 0
        }
    }]
};
```

## License

This caching implementation is part of the CertiFried Announcer project.