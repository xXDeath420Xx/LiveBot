CREATE TABLE IF NOT EXISTS `reminders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` varchar(255) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `channel_id` varchar(255) NOT NULL,
  `is_dm` tinyint(1) NOT NULL,
  `remind_at` datetime NOT NULL,
  `message` text NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;