-- This script removes the old, stateful announcement and stream session tables
-- that are no longer needed by the new aggressive stream manager.

-- It is highly recommended to back up your database before running this script.

-- Drop the announcements table
DROP TABLE IF EXISTS `announcements`;

-- Drop the stream_sessions table
DROP TABLE IF EXISTS `stream_sessions`;

-- The subscriptions table is still in use to link streamers to guilds, so it is NOT dropped.
