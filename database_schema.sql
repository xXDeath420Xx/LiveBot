CREATE TABLE IF NOT EXISTS `guilds` (
  `guild_id` varchar(25) NOT NULL,
  `announcement_channel_id` varchar(25) DEFAULT NULL,
  `live_role_id` varchar(25) DEFAULT NULL,
  PRIMARY KEY (`guild_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `streamers` (
  `streamer_id` int(11) NOT NULL AUTO_INCREMENT,
  `platform` varchar(20) NOT NULL,
  `username` varchar(100) NOT NULL,
  `platform_user_id` varchar(100) DEFAULT NULL,
  `discord_user_id` varchar(25) DEFAULT NULL,
  PRIMARY KEY (`streamer_id`),
  UNIQUE KEY `platform_username` (`platform`,`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `subscriptions` (
  `subscription_id` int(11) NOT NULL AUTO_INCREMENT,
  `guild_id` varchar(25) NOT NULL,
  `streamer_id` int(11) NOT NULL,
  `custom_message` text DEFAULT NULL,
  PRIMARY KEY (`subscription_id`),
  UNIQUE KEY `guild_streamer` (`guild_id`,`streamer_id`),
  KEY `streamer_id` (`streamer_id`),
  CONSTRAINT `subscriptions_ibfk_1` FOREIGN KEY (`streamer_id`) REFERENCES `streamers` (`streamer_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `announcements` (
  `announcement_id` int(11) NOT NULL AUTO_INCREMENT,
  `guild_id` varchar(25) NOT NULL,
  `username_key` varchar(100) DEFAULT NULL,
  `discord_user_id` varchar(25) DEFAULT NULL,
  `message_id` varchar(25) NOT NULL,
  `channel_id` varchar(25) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`announcement_id`),
  KEY `guild_user` (`guild_id`,`discord_user_id`),
  KEY `guild_username` (`guild_id`, `username_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
