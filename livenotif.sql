-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: localhost:3306
-- Generation Time: Oct 07, 2025 at 11:44 PM
-- Server version: 10.11.13-MariaDB-0ubuntu0.24.04.1
-- PHP Version: 8.4.11

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `livenotif`
--

-- --------------------------------------------------------

--
-- Table structure for table `action_logs`
--

CREATE TABLE `action_logs` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `event_type` varchar(50) NOT NULL,
  `user_id` varchar(255) DEFAULT NULL,
  `target_id` varchar(255) DEFAULT NULL,
  `details` text DEFAULT NULL,
  `timestamp` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `action_logs`
--

INSERT INTO `action_logs` (`id`, `guild_id`, `event_type`, `user_id`, `target_id`, `details`, `timestamp`) VALUES
(1, '985116833193553930', 'Role Added', '1070577908634099752', '992538724720181259', '{\"roleName\":\"streamer\"}', '2025-10-06 04:19:13'),
(2, '985116833193553930', 'Role Added', '1070577908634099752', '992538724720181259', '{\"roleName\":\"streamer\"}', '2025-10-06 04:19:13'),
(3, '985116833193553930', 'Role Added', '720347799102947489', '992538724720181259', '{\"roleName\":\"streamer\"}', '2025-10-06 04:23:24'),
(4, '985116833193553930', 'Role Added', '720347799102947489', '992538724720181259', '{\"roleName\":\"streamer\"}', '2025-10-06 04:23:24'),
(5, '985116833193553930', 'Role Added', '720347799102947489', '992538724720181259', '{\"roleName\":\"streamer\"}', '2025-10-06 04:37:34'),
(6, '985116833193553930', 'Role Added', '720347799102947489', '992538724720181259', '{\"roleName\":\"streamer\"}', '2025-10-06 04:37:34'),
(7, '985116833193553930', 'Role Added', '1236823892555857922', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-06 05:18:45'),
(8, '985116833193553930', 'Role Added', '1236823892555857922', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-06 05:18:45'),
(9, '985116833193553930', 'Role Added', '811295443744063599', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-06 09:58:04'),
(10, '985116833193553930', 'Role Added', '811295443744063599', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-06 09:58:04'),
(11, '985116833193553930', 'Role Added', '1254988321893908553', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 00:36:54'),
(12, '985116833193553930', 'Role Added', '811295443744063599', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 01:11:25'),
(13, '985116833193553930', 'Role Added', '811295443744063599', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 01:15:57'),
(14, '985116833193553930', 'Role Added', '811295443744063599', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 01:15:57'),
(15, '985116833193553930', 'Role Added', '811295443744063599', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 01:26:26'),
(16, '985116833193553930', 'Role Added', '811295443744063599', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 01:26:26'),
(17, '985116833193553930', 'Role Added', '1341020845841322024', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 01:57:21'),
(18, '985116833193553930', 'Role Added', '1341020845841322024', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 01:57:21'),
(19, '985116833193553930', 'Role Added', '811295443744063599', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 02:18:07'),
(20, '985116833193553930', 'Role Added', '811295443744063599', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 02:19:44'),
(21, '985116833193553930', 'Role Added', '811295443744063599', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 02:30:27'),
(22, '985116833193553930', 'Role Added', '913723013629882440', '992538724720181259', '{\"roleName\":\"streamer\"}', '2025-10-07 04:50:22'),
(23, '985116833193553930', 'Role Added', '913723013629882440', '992538724720181259', '{\"roleName\":\"streamer\"}', '2025-10-07 04:50:22'),
(24, '985116833193553930', 'Role Added', '811295443744063599', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 05:52:32'),
(25, '985116833193553930', 'Role Added', '551352492806504450', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 08:09:55'),
(26, '985116833193553930', 'Role Added', '551352492806504450', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 08:09:55'),
(27, '985116833193553930', 'Role Added', '1236823892555857922', '1347116973636452353', '{\"roleName\":\"Member\"}', '2025-10-07 12:25:50'),
(28, '985116833193553930', 'Role Added', 'System', '811295443744063599', '{\"roleName\":\"Member\"}', '2025-10-07 13:42:05'),
(29, '985116833193553930', 'Role Added', 'System', '811295443744063599', '{\"roleName\":\"Member\"}', '2025-10-07 13:42:05'),
(30, '985116833193553930', 'Role Added', 'System', '811295443744063599', '{\"roleName\":\"Member\"}', '2025-10-07 13:42:05'),
(31, '985116833193553930', 'Role Removed', '1409904443125665875', '477321012569047040', '{\"roleName\":\"Reefer Realm Live\"}', '2025-10-07 14:33:15'),
(32, '985116833193553930', 'Role Added', '1409904443125665875', '477321012569047040', '{\"roleName\":\"streamer\"}', '2025-10-07 14:33:15'),
(33, '985116833193553930', 'Role Added', '1409904443125665875', '477321012569047040', '{\"roleName\":\"streamer\"}', '2025-10-07 14:33:15'),
(34, '985116833193553930', 'Role Added', 'System', '995856691008651406', '{\"roleName\":\"streamer\"}', '2025-10-07 14:33:16'),
(35, '985116833193553930', 'Role Added', 'System', '995856691008651406', '{\"roleName\":\"streamer\"}', '2025-10-07 14:33:16'),
(36, '985116833193553930', 'Role Added', 'System', '1070577908634099752', '{\"roleName\":\"streamer\"}', '2025-10-07 14:48:28'),
(37, '985116833193553930', 'Role Added', 'System', '1070577908634099752', '{\"roleName\":\"streamer\"}', '2025-10-07 14:48:28'),
(38, '985116833193553930', 'Role Added', 'System', '1070577908634099752', '{\"roleName\":\"streamer\"}', '2025-10-07 14:48:28'),
(39, '985116833193553930', 'Role Added', 'System', '298602963537100820', '{\"roleName\":\"streamer\"}', '2025-10-07 15:06:27'),
(40, '985116833193553930', 'Role Added', 'System', '298602963537100820', '{\"roleName\":\"streamer\"}', '2025-10-07 15:06:27'),
(41, '985116833193553930', 'Role Added', 'System', '298602963537100820', '{\"roleName\":\"streamer\"}', '2025-10-07 15:09:14'),
(42, '985116833193553930', 'Role Added', 'System', '1236348230858571929', '{\"roleName\":\"Member\"}', '2025-10-07 15:30:59'),
(43, '985116833193553930', 'Role Added', 'System', '1236348230858571929', '{\"roleName\":\"Member\"}', '2025-10-07 15:30:59'),
(44, '985116833193553930', 'Role Added', '1409904443125665875', '162719798969630720', '{\"roleName\":\"streamer\"}', '2025-10-07 15:51:15'),
(45, '985116833193553930', 'Role Removed', '1409904443125665875', '162719798969630720', '{\"roleName\":\"Reefer Realm Live\"}', '2025-10-07 15:51:15'),
(46, '985116833193553930', 'Role Added', 'System', '811295443744063599', '{\"roleName\":\"Member\"}', '2025-10-07 16:10:50'),
(47, '985116833193553930', 'Role Added', 'System', '811295443744063599', '{\"roleName\":\"Member\"}', '2025-10-07 16:10:50'),
(48, '985116833193553930', 'Role Removed', '365905620060340224', '1412658035473645579', '{\"roleName\":\"Member\"}', '2025-10-07 22:58:38'),
(49, '985116833193553930', 'Role Removed', '365905620060340224', '1412658035473645579', '{\"roleName\":\"Member\"}', '2025-10-07 22:58:38'),
(50, '985116833193553930', 'Role Added', '365905620060340224', '1412658035473645579', '{\"roleName\":\"Bots\"}', '2025-10-07 22:58:46'),
(51, '985116833193553930', 'Role Added', '365905620060340224', '1412658035473645579', '{\"roleName\":\"Bots\"}', '2025-10-07 22:58:46'),
(52, '985116833193553930', 'Role Added', 'System', '811295443744063599', '{\"roleName\":\"Member\"}', '2025-10-07 23:13:47'),
(53, '985116833193553930', 'Role Added', 'System', '811295443744063599', '{\"roleName\":\"Member\"}', '2025-10-07 23:13:47'),
(54, '985116833193553930', 'Role Added', 'System', '811295443744063599', '{\"roleName\":\"Member\"}', '2025-10-07 23:14:13');

-- --------------------------------------------------------

--
-- Table structure for table `afk_statuses`
--

CREATE TABLE `afk_statuses` (
  `guild_id` varchar(255) NOT NULL,
  `user_id` varchar(255) NOT NULL,
  `message` text NOT NULL,
  `timestamp` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `announcements`
--

CREATE TABLE `announcements` (
  `announcement_id` bigint(20) NOT NULL,
  `subscription_id` bigint(20) NOT NULL,
  `streamer_id` bigint(20) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `message_id` varchar(255) NOT NULL,
  `channel_id` varchar(255) NOT NULL,
  `stream_game` varchar(255) DEFAULT NULL,
  `stream_title` text DEFAULT NULL,
  `stream_url` varchar(255) DEFAULT NULL,
  `platform` varchar(255) NOT NULL,
  `stream_thumbnail_url` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

--
-- Dumping data for table `announcements`
--

INSERT INTO `announcements` (`announcement_id`, `subscription_id`, `streamer_id`, `guild_id`, `message_id`, `channel_id`, `stream_game`, `stream_title`, `stream_url`, `platform`, `stream_thumbnail_url`) VALUES
(1, 7, 7, '985116833193553930', '1425255151945650208', '1415373602068496545', 'Art', 'Making Glass Pendants! | ADfree for subs  | !etsy !bomb !tip !merch @FLiiQzy @BacwoodsTV @HazeCute @allie_baby123', 'https://www.twitch.tv/onelovexx1994', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_onelovexx1994-1280x720.jpg'),
(3, 20, 20, '985116833193553930', '1425255171080065125', '1415373602068496545', 'Always On', '#4 worst charge rifle user in Canada. @gyps @dubuco', 'https://www.twitch.tv/gohrdy', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_gohrdy-1280x720.jpg'),
(8, 31, 31, '985116833193553930', '1425255185604808829', '1415373602068496545', 'RuneScape', 'day by day  we makin it RS3 Leagues grinding - Good Vibes 🌿 @thcxducky @spacemonkee @ganja_vibes @XxThatOneGuy_TTV @avocado_thnx', 'https://www.twitch.tv/apitamy', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_apitamy-1280x720.jpg'),
(12, 50, 50, '985116833193553930', '1425255203019559016', '1415373602068496545', 'Fortnite', 'DROP ME IN THE OVEN... IM COOKED', 'https://www.twitch.tv/itsonlygames24', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_itsonlygames24-1280x720.jpg'),
(86, 9, 9, '985116833193553930', '1425255155775045784', '1415373602068496545', 'ASMR', 'NO ADS 4 SUBS✅ | 🌿 18+ 🍃420 710🛢️ | 💋 TUESDAY TEMPTATIONS 💋 | 🖤 GOTH MOMMIES 💄 BRATS 🐆 COUGARS 🌸 STONER BABES 🎮 VIBES 💨', 'https://www.twitch.tv/thcxducky', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_thcxducky-1280x720.jpg'),
(281, 30, 30, '985116833193553930', '1425255181448384542', '1415373602068496545', 'Always On', '[pre recorded] back live 9pm est', 'https://www.twitch.tv/red78phoenix', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_red78phoenix-1280x720.jpg'),
(582, 1, 1, '985116833193553930', '1425255145851195566', '1415373602068496545', 'Just Chatting', '🎁Subs = JumpScare😱|Big thanks to @relishedink9488 for Raiding!💜| @samdavison1 @red_dovah @tesserekts', 'https://www.twitch.tv/spacemonkee', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_spacemonkee-1280x720.jpg'),
(632, 1960, 109, '985116833193553930', '1425255246094930055', '1415373602068496545', 'Runescape', 'RS3 Leagues  grind ftw', 'https://kick.com/APITAMY', 'kick', 'https://files.kick.com/images/user/2971108/profile_image/conversion/4ec13d89-dc15-43f1-a222-1c05fdb0a1d7-fullsize.webp'),
(636, 103, 103, '985116833193553930', '1425255221524693085', '1415244430301990983', 'Fortnite', 'ITs My Birthday', 'https://www.twitch.tv/allie_baby123', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_allie_baby123-1280x720.jpg'),
(654, 1609, 104, '985116833193553930', '1425255237861773384', '1415373602068496545', 'Just Chatting', '🎁Subs = JumpScare😱|Big thanks to @StreamDummy for Hosting!💜| @StreamDummy @KaiiCrew @kingxcowboy', 'https://kick.com/SpaceMonkee', 'kick', 'https://files.kick.com/images/user/1433341/profile_image/conversion/5255ef98-864b-47b7-ae33-a89f8c0c00bf-fullsize.webp'),
(711, 69, 69, '985116833193553930', '1425254373080174724', '1415373602068496545', 'Talk Shows & Podcasts', 'Warzone clips till 3am Wake and Bake chat come watch your boy always networking, playing games, ake music sessions', 'https://www.twitch.tv/cannabisusers', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_cannabisusers-1280x720.jpg'),
(712, 87, 69, '985116833193553930', '1425254377546846270', '1415244430301990983', 'Talk Shows & Podcasts', 'Warzone clips till 3am Wake and Bake chat come watch your boy always networking, playing games, ake music sessions', 'https://www.twitch.tv/cannabisusers', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_cannabisusers-1280x720.jpg'),
(734, 56, 56, '985116833193553930', '1425254368067719238', '1415373602068496545', 'Z1: Battle Royale', 'Untitled Stream', 'https://www.twitch.tv/xgoliathttv', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_xgoliathttv-1280x720.jpg'),
(742, 63, 63, '985116833193553930', '1425254370554937477', '1415373602068496545', '7 Days to Die', 'How we feeling chat? Talk to us👌 @smoknchronic @boxmakerdad @beerdrinkingf00l @gargantuangame', 'https://www.twitch.tv/bejay30x', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_bejay30x-1280x720.jpg'),
(743, 12, 12, '985116833193553930', '1425255166407479356', '1415373602068496545', 'Just Chatting', 'Zero Chill, All Skill |18+|Partner Push| @onelovexx1994 @MisfitPrincess_x0', 'https://www.twitch.tv/shadowxtremetv', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_shadowxtremetv-1280x720.jpg'),
(755, 46, 46, '985116833193553930', '1425255197843652610', '1415373602068496545', 'skate.', 'The HIGHest Skater on Sakte. (2025) 🛹 Season 1 🥇 Skating With Viewers 👀 PS5 🎮 Good Vibes 🍄 420 😶‍🌫️ Chill & Chat 🍻 Discord 🔞', 'https://www.twitch.tv/milehighhippyttv', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_milehighhippyttv-1280x720.jpg'),
(756, 108, 128, '985116833193553930', '1425255223378710578', '1415373602068496545', 'Just Chatting', '🔴18+ {PC} 🥃 Toasted & Turnt Up Tuesday — Shots, Sauce & Shenanigans 🔥 | @SSGRocky', 'https://kick.com/SaucinAwstin', 'kick', 'https://files.kick.com/images/user/2069910/profile_image/conversion/f280b7aa-77f2-4853-a770-e3e489f45275-fullsize.webp'),
(758, 1986, 119, '985116833193553930', '1425255249517482064', '1415373602068496545', 'Just Chatting', 'Stream Crashed we back\n  Kick Partner  18/20 NEW PC SUB GOAL', 'https://kick.com/Canadian_Goose902', 'kick', 'https://files.kick.com/images/user/28467436/profile_image/conversion/0369f0ee-28ef-4cad-88d2-5fa01928ee1a-fullsize.webp'),
(759, 100, 100, '985116833193553930', '1425254383029063751', '1415244430301990983', 'Just Chatting', '(18+) writing music playing games and just living life come join US and hangout with us. we MAD CHILLIN 420 VibeZ 24/7 STREAMER @drizzler', 'https://www.twitch.tv/bizzzargaming420', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_bizzzargaming420-1280x720.jpg'),
(760, 109, 129, '985116833193553930', '1425255226583027802', '1415373602068496545', 'Arena Breakout: Infinite', 'New chat commands!!!!!! !sausage !jumpscare !scarecrow !hand', 'https://kick.com/x2FDx', 'kick', 'https://files.kick.com/images/user/14758299/profile_image/conversion/bd4b7160-4fcd-4fe8-b1cd-832de04c35ce-fullsize.webp'),
(761, 33, 33, '985116833193553930', '1425255189136281723', '1415373602068496545', 'Vampire: The Masquerade - Bloodhunt', '16 years with my Asian mami', 'https://www.twitch.tv/zboricuajoel', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_zboricuajoel-1280x720.jpg'),
(762, 1604, 1613, '985116833193553930', '1425255233948225657', '1415373602068496545', 'Vampire: The Masquerade - Bloodhunt', '16 years with my Asian mami', 'https://kick.com/zBoricuaJoel', 'kick', 'https://files.kick.com/images/user/1128331/profile_image/conversion/158d07b7-65ae-49b0-b6f3-3985a7071945-fullsize.webp'),
(763, 19, 19, '985116833193553930', '1425255169029046292', '1415373602068496545', 'Just Chatting', 'Just gaming and chilling', 'https://www.twitch.tv/zachdadd1', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_zachdadd1-1280x720.jpg'),
(764, 24, 24, '985116833193553930', '1425255177534963813', '1415373602068496545', 'Just Chatting', 'VIBE-A-THON | B-DAY COUNTDOWN | 2 of 44 | VIBE NATION PARTNER GRIND | #Goals #Community #VibeNation #Vibeathon', 'https://www.twitch.tv/ganja_vibes', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_ganja_vibes-1280x720.jpg'),
(765, 34, 34, '985116833193553930', '1425255192433000561', '1415373602068496545', 'Gears of War: Reloaded', 'season 1 heat!', 'https://www.twitch.tv/xxxdominatedxxx', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_xxxdominatedxxx-1280x720.jpg'),
(767, 102, 102, '985116833193553930', '1425255218181963856', '1415244430301990983', 'Apex Legends', 'Trife General Solo Q Demon', 'https://www.twitch.tv/trifedad', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_trifedad-1280x720.jpg'),
(768, 110, 130, '985116833193553930', '1425255229452062741', '1415373602068496545', 'Fortnite', 'WE BACK BABY💚!SUBATHON DAY 14💚1 SUB/GIFTED= 5 PUSH UPS💚FREE !TTS💚SUB FOR !VOICES💚BI-WEEKLY !FISH $ GIVEAWAYS💚!SOCIALS', 'https://kick.com/cvrsify', 'kick', 'https://files.kick.com/images/user/987489/profile_image/conversion/010bd2e6-0b70-481c-8ef9-f5ea4870637b-fullsize.webp'),
(769, 1959, 120, '985116833193553930', '1425255242760589345', '1415373602068496545', 'EA Sports College Football 26', 'south carolina year 1', 'https://kick.com/red78phoenix', 'kick', 'https://files.kick.com/images/user/1140434/profile_image/conversion/052e4d64-7fb6-4f2b-8efa-54cb2445c37c-fullsize.webp'),
(770, 53, 53, '985116833193553930', '1425254365056466945', '1415373602068496545', 'Cocked and Loaded', '🟢#1 TOXIC STREAMER ON TWITCH🟢ANGER🟢AGRESSIVE🟢EXTEME🟢PISSED🟢', 'https://www.twitch.tv/yngsmiley', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_yngsmiley-1280x720.jpg'),
(771, 2026, 139, '985116833193553930', '1425255240382287912', '1415373602068496545', 'Retro Games', '🔴RETRO🔴FIRST TIME PLAYTHROUGH🔴ROCK N ROLL RACING🔴LIVE🔴', 'https://kick.com/yngsmiley', 'kick', 'https://files.kick.com/images/user/2281219/profile_image/conversion/a4d224fe-e7a7-41c0-b454-4994abc0eca2-fullsize.webp'),
(772, 10, 10, '985116833193553930', '1425262518850424905', '1415373602068496545', 'Expeditions: A MudRunner Game', '[18+] Offroading with a @DrtyDuk', 'https://www.twitch.tv/michigan_husky', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_michigan_husky-1280x720.jpg'),
(773, 76, 76, '985116833193553930', '1425262548424593448', '1415373602068496545', 'Grand Theft Auto V', 'chilling with friends night', 'https://www.twitch.tv/kingyork1985', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_kingyork1985-1280x720.jpg'),
(774, 21, 21, '985116833193553930', '1425267057120903388', '1415373602068496545', 'Just Chatting', 'Randomness - Anime - Chit chat - Music - ASMR - and much much more', 'https://www.twitch.tv/wiredkydd', 'twitch', 'https://static-cdn.jtvnw.net/previews-ttv/live_user_wiredkydd-1280x720.jpg');

-- --------------------------------------------------------

--
-- Table structure for table `antinuke_config`
--

CREATE TABLE `antinuke_config` (
  `guild_id` varchar(255) NOT NULL,
  `is_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `action_thresholds` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`action_thresholds`)),
  `time_window_seconds` int(11) NOT NULL DEFAULT 10,
  `whitelisted_users` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `anti_raid_config`
--

CREATE TABLE `anti_raid_config` (
  `guild_id` varchar(255) NOT NULL,
  `is_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `join_limit` int(11) NOT NULL DEFAULT 10,
  `time_period_seconds` int(11) NOT NULL DEFAULT 10,
  `action` varchar(50) NOT NULL DEFAULT 'kick'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `automod_heat_config`
--

CREATE TABLE `automod_heat_config` (
  `guild_id` varchar(255) NOT NULL,
  `is_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `heat_values` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`heat_values`)),
  `action_thresholds` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`action_thresholds`)),
  `decay_minutes` int(11) NOT NULL DEFAULT 10
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `automod_rules`
--

CREATE TABLE `automod_rules` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `filter_type` varchar(50) NOT NULL,
  `is_enabled` tinyint(1) NOT NULL DEFAULT 1,
  `config` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`config`)),
  `action` varchar(50) NOT NULL,
  `action_duration_minutes` int(11) DEFAULT NULL,
  `ignored_roles` text DEFAULT NULL,
  `ignored_channels` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `autoroles_config`
--

CREATE TABLE `autoroles_config` (
  `guild_id` varchar(255) NOT NULL,
  `is_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `roles_to_assign` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `auto_publisher_config`
--

CREATE TABLE `auto_publisher_config` (
  `guild_id` varchar(255) NOT NULL,
  `is_enabled` tinyint(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `blacklisted_users`
--

CREATE TABLE `blacklisted_users` (
  `id` int(11) NOT NULL,
  `platform` varchar(50) NOT NULL,
  `platform_user_id` varchar(255) NOT NULL,
  `username` varchar(255) NOT NULL,
  `discord_user_id` varchar(255) DEFAULT NULL,
  `blacklisted_by` varchar(255) DEFAULT NULL,
  `blacklisted_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `blacklisted_users`
--

INSERT INTO `blacklisted_users` (`id`, `platform`, `platform_user_id`, `username`, `discord_user_id`, `blacklisted_by`, `blacklisted_at`) VALUES
(1, 'twitch', '666535472', 'holydabrip420', '842881525434679336', '365905620060340224', '2025-09-29 14:13:40'),
(3, 'kick', '30516043', 'HolyDabRip420', '842881525434679336', NULL, '2025-10-01 01:19:29'),
(4, 'discord', '842881525434679336', '842881525434679336', '842881525434679336', NULL, '2025-10-01 01:19:44'),
(5, 'discord', '228387683053862914', '228387683053862914', '228387683053862914', NULL, '2025-10-03 21:29:55'),
(6, 'twitch', '141538629', 'darastaking', '228387683053862914', NULL, '2025-10-03 21:30:06'),
(7, 'kick', '7957232', 'DaRastaKing', '228387683053862914', NULL, '2025-10-03 21:30:13');

-- --------------------------------------------------------

--
-- Table structure for table `channel_settings`
--

CREATE TABLE `channel_settings` (
  `channel_id` varchar(25) NOT NULL,
  `guild_id` varchar(25) NOT NULL,
  `override_nickname` varchar(80) DEFAULT NULL,
  `override_avatar_url` varchar(255) DEFAULT NULL,
  `privacy_setting` varchar(255) DEFAULT NULL,
  `summary_persistence` varchar(255) DEFAULT NULL,
  `privacy_level` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `custom_commands`
--

CREATE TABLE `custom_commands` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `command_name` varchar(255) NOT NULL,
  `response` text NOT NULL,
  `action_type` varchar(50) NOT NULL DEFAULT 'reply',
  `action_content` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `escalation_rules`
--

CREATE TABLE `escalation_rules` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `infraction_count` int(11) NOT NULL,
  `time_period_hours` int(11) NOT NULL,
  `action` varchar(50) NOT NULL,
  `action_duration_minutes` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `giveaways`
--

CREATE TABLE `giveaways` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `channel_id` varchar(255) NOT NULL,
  `message_id` varchar(255) NOT NULL,
  `prize` text NOT NULL,
  `winner_count` int(11) NOT NULL DEFAULT 1,
  `ends_at` timestamp NOT NULL,
  `created_by` varchar(255) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `winners` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `global_stats`
--

CREATE TABLE `global_stats` (
  `id` int(11) NOT NULL,
  `total_announcements` bigint(20) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `global_stats`
--

INSERT INTO `global_stats` (`id`, `total_announcements`) VALUES
(1, 0);

-- --------------------------------------------------------

--
-- Table structure for table `guilds`
--

CREATE TABLE `guilds` (
  `guild_id` varchar(255) NOT NULL,
  `announcement_channel_id` varchar(255) DEFAULT NULL,
  `live_role_id` varchar(255) DEFAULT NULL,
  `bot_nickname` varchar(255) DEFAULT NULL,
  `webhook_avatar_url` text DEFAULT NULL,
  `enable_stream_summaries` tinyint(1) DEFAULT 0,
  `avatar_upload_channel_id` varchar(255) DEFAULT NULL,
  `youtube_visibility_level` varchar(50) DEFAULT 'public',
  `privacy_setting` varchar(255) DEFAULT 'public_only',
  `summary_persistence` varchar(255) DEFAULT 'delete_on_offline',
  `members_announcement_channel_id` varchar(255) DEFAULT NULL,
  `subscribers_announcement_channel_id` varchar(255) DEFAULT NULL,
  `privacy_level` varchar(255) DEFAULT 'public',
  `leveling_enabled` tinyint(1) NOT NULL DEFAULT 1,
  `leveling_xp_rate` int(11) NOT NULL DEFAULT 20,
  `leveling_xp_cooldown` int(11) NOT NULL DEFAULT 60,
  `leveling_ignored_channels` text DEFAULT NULL,
  `leveling_ignored_roles` text DEFAULT NULL,
  `sticky_roles_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `afk_enabled` tinyint(1) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

--
-- Dumping data for table `guilds`
--

INSERT INTO `guilds` (`guild_id`, `announcement_channel_id`, `live_role_id`, `bot_nickname`, `webhook_avatar_url`, `enable_stream_summaries`, `avatar_upload_channel_id`, `youtube_visibility_level`, `privacy_setting`, `summary_persistence`, `members_announcement_channel_id`, `subscribers_announcement_channel_id`, `privacy_level`, `leveling_enabled`, `leveling_xp_rate`, `leveling_xp_cooldown`, `leveling_ignored_channels`, `leveling_ignored_roles`, `sticky_roles_enabled`, `afk_enabled`) VALUES
('985116833193553930', NULL, NULL, NULL, NULL, 0, '1290805808879108167', 'public', 'public_only', 'delete_on_offline', NULL, NULL, 'public', 1, 20, 60, '[]', '[\"1347145936601878578\"]', 0, 1);

-- --------------------------------------------------------

--
-- Table structure for table `infractions`
--

CREATE TABLE `infractions` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `user_id` varchar(255) NOT NULL,
  `moderator_id` varchar(255) NOT NULL,
  `type` varchar(50) NOT NULL,
  `reason` text DEFAULT NULL,
  `duration_minutes` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `expires_at` timestamp NULL DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `invites`
--

CREATE TABLE `invites` (
  `guild_id` varchar(255) NOT NULL,
  `code` varchar(255) NOT NULL,
  `inviter_id` varchar(255) NOT NULL,
  `uses` int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `invite_tracker_logs`
--

CREATE TABLE `invite_tracker_logs` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `user_id` varchar(255) NOT NULL,
  `inviter_id` varchar(255) NOT NULL,
  `invite_code` varchar(255) NOT NULL,
  `event_type` enum('join','leave') NOT NULL,
  `timestamp` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `join_gate_config`
--

CREATE TABLE `join_gate_config` (
  `guild_id` varchar(255) NOT NULL,
  `is_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `action` varchar(50) NOT NULL DEFAULT 'none',
  `action_duration_minutes` int(11) DEFAULT NULL,
  `min_account_age_days` int(11) DEFAULT NULL,
  `block_default_avatar` tinyint(1) NOT NULL DEFAULT 0,
  `verification_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `verification_role_id` varchar(255) DEFAULT NULL,
  `verification_channel_id` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `log_config`
--

CREATE TABLE `log_config` (
  `guild_id` varchar(255) NOT NULL,
  `log_channel_id` varchar(255) DEFAULT NULL,
  `enabled_logs` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `manual_schedules`
--

CREATE TABLE `manual_schedules` (
  `schedule_id` int(11) NOT NULL,
  `streamer_id` bigint(20) NOT NULL,
  `monday` varchar(255) DEFAULT NULL,
  `tuesday` varchar(255) DEFAULT NULL,
  `wednesday` varchar(255) DEFAULT NULL,
  `thursday` varchar(255) DEFAULT NULL,
  `friday` varchar(255) DEFAULT NULL,
  `saturday` varchar(255) DEFAULT NULL,
  `sunday` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- --------------------------------------------------------

--
-- Table structure for table `moderation_config`
--

CREATE TABLE `moderation_config` (
  `guild_id` varchar(255) NOT NULL,
  `mod_log_channel_id` varchar(255) DEFAULT NULL,
  `muted_role_id` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `music_config`
--

CREATE TABLE `music_config` (
  `guild_id` varchar(255) NOT NULL,
  `is_enabled` tinyint(1) DEFAULT 0,
  `text_channel_ids` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`text_channel_ids`)),
  `voice_channel_ids` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`voice_channel_ids`)),
  `dj_role_id` varchar(255) DEFAULT NULL,
  `default_volume` int(11) DEFAULT 50
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `music_playlists`
--

CREATE TABLE `music_playlists` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `user_id` varchar(255) NOT NULL,
  `name` varchar(100) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `music_playlist_songs`
--

CREATE TABLE `music_playlist_songs` (
  `id` int(11) NOT NULL,
  `playlist_id` int(11) NOT NULL,
  `title` varchar(255) NOT NULL,
  `url` varchar(255) NOT NULL,
  `duration` varchar(20) NOT NULL,
  `channel` varchar(100) NOT NULL,
  `thumbnail` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `music_queues`
--

CREATE TABLE `music_queues` (
  `guild_id` varchar(255) NOT NULL,
  `queue` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `is_playing` tinyint(1) NOT NULL DEFAULT 0,
  `is_paused` tinyint(1) NOT NULL DEFAULT 0,
  `now_playing` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `music_queues`
--

INSERT INTO `music_queues` (`guild_id`, `queue`, `is_playing`, `is_paused`, `now_playing`) VALUES
('985116833193553930', '[{\"title\":\"Metallica: One (Official Music Video)\",\"url\":\"https://youtube.com/watch?v=WM8bTdBs-cw\",\"duration\":\"7:45\",\"channel\":\"Metallica\",\"thumbnail\":\"https://i.ytimg.com/vi/WM8bTdBs-cw/hq720.jpg\",\"requestedBy\":{\"id\":\"365905620060340224\",\"bot\":false,\"system\":false,\"flags\":64,\"username\":\"death420\",\"globalName\":\"xXDeath420Xx\",\"discriminator\":\"0\",\"avatar\":\"a_5d3a4f5d5149c565030c322d69353915\",\"avatarDecoration\":null,\"avatarDecorationData\":{\"asset\":\"a_40222dd9e7bb6e2949cd8f4bd857fe8b\",\"skuId\":\"1384247972107386911\"},\"collectibles\":null,\"primaryGuild\":{\"identityGuildId\":\"901599353389596712\",\"identityEnabled\":true,\"tag\":\"BEAR\",\"badge\":\"276792224055b144f22c95ef29df1d21\"},\"createdTimestamp\":1507309098020,\"defaultAvatarURL\":\"https://cdn.discordapp.com/embed/avatars/2.png\",\"tag\":\"death420\",\"avatarURL\":\"https://cdn.discordapp.com/avatars/365905620060340224/a_5d3a4f5d5149c565030c322d69353915.gif\",\"displayAvatarURL\":\"https://cdn.discordapp.com/avatars/365905620060340224/a_5d3a4f5d5149c565030c322d69353915.gif\",\"guildTagBadgeURL\":\"https://cdn.discordapp.com/guild-tag-badges/901599353389596712/276792224055b144f22c95ef29df1d21.webp\"}}]', 1, 0, '{\"title\":\"Metallica: One (Official Music Video)\",\"url\":\"https://youtube.com/watch?v=WM8bTdBs-cw\",\"duration\":\"7:45\",\"channel\":\"Metallica\",\"thumbnail\":\"https://i.ytimg.com/vi/WM8bTdBs-cw/hq720.jpg\",\"requestedBy\":{\"id\":\"365905620060340224\",\"bot\":false,\"system\":false,\"flags\":64,\"username\":\"death420\",\"globalName\":\"xXDeath420Xx\",\"discriminator\":\"0\",\"avatar\":\"a_5d3a4f5d5149c565030c322d69353915\",\"avatarDecoration\":null,\"avatarDecorationData\":{\"asset\":\"a_40222dd9e7bb6e2949cd8f4bd857fe8b\",\"skuId\":\"1384247972107386911\"},\"collectibles\":null,\"primaryGuild\":{\"identityGuildId\":\"901599353389596712\",\"identityEnabled\":true,\"tag\":\"BEAR\",\"badge\":\"276792224055b144f22c95ef29df1d21\"},\"createdTimestamp\":1507309098020,\"defaultAvatarURL\":\"https://cdn.discordapp.com/embed/avatars/2.png\",\"tag\":\"death420\",\"avatarURL\":\"https://cdn.discordapp.com/avatars/365905620060340224/a_5d3a4f5d5149c565030c322d69353915.gif\",\"displayAvatarURL\":\"https://cdn.discordapp.com/avatars/365905620060340224/a_5d3a4f5d5149c565030c322d69353915.gif\",\"guildTagBadgeURL\":\"https://cdn.discordapp.com/guild-tag-badges/901599353389596712/276792224055b144f22c95ef29df1d21.webp\"}}');

-- --------------------------------------------------------

--
-- Table structure for table `polls`
--

CREATE TABLE `polls` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `channel_id` varchar(255) NOT NULL,
  `message_id` varchar(255) NOT NULL,
  `question` text NOT NULL,
  `options` text NOT NULL,
  `ends_at` timestamp NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `quarantine_config`
--

CREATE TABLE `quarantine_config` (
  `guild_id` varchar(255) NOT NULL,
  `is_enabled` tinyint(1) DEFAULT 0,
  `quarantine_role_id` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `reaction_role_mappings`
--

CREATE TABLE `reaction_role_mappings` (
  `id` int(11) NOT NULL,
  `panel_id` int(11) NOT NULL,
  `emoji_id` varchar(255) NOT NULL,
  `role_id` varchar(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `reaction_role_panels`
--

CREATE TABLE `reaction_role_panels` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `channel_id` varchar(255) NOT NULL,
  `message_id` varchar(255) NOT NULL,
  `panel_name` varchar(255) NOT NULL,
  `panel_mode` varchar(50) NOT NULL DEFAULT 'standard'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `record_config`
--

CREATE TABLE `record_config` (
  `guild_id` varchar(255) NOT NULL,
  `is_enabled` tinyint(1) DEFAULT 0,
  `allowed_role_ids` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`allowed_role_ids`)),
  `output_channel_id` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `reddit_feeds`
--

CREATE TABLE `reddit_feeds` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `subreddit` varchar(255) NOT NULL,
  `channel_id` varchar(255) NOT NULL,
  `last_post_id` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `reminders`
--

CREATE TABLE `reminders` (
  `id` int(11) NOT NULL,
  `user_id` varchar(255) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `channel_id` varchar(255) NOT NULL,
  `is_dm` tinyint(1) NOT NULL DEFAULT 0,
  `remind_at` timestamp NOT NULL,
  `message` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `reputation`
--

CREATE TABLE `reputation` (
  `guild_id` varchar(255) NOT NULL,
  `user_id` varchar(255) NOT NULL,
  `rep_points` int(11) NOT NULL DEFAULT 0,
  `last_rep_given_to` varchar(255) DEFAULT NULL,
  `last_rep_timestamp` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `role_rewards`
--

CREATE TABLE `role_rewards` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `level` int(11) NOT NULL,
  `role_id` varchar(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `server_backups`
--

CREATE TABLE `server_backups` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `snapshot_name` varchar(255) NOT NULL,
  `snapshot_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `created_by_id` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `server_stats`
--

CREATE TABLE `server_stats` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `date` date NOT NULL,
  `total_members` int(11) NOT NULL DEFAULT 0,
  `online_members` int(11) NOT NULL DEFAULT 0,
  `message_count` int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `starboard_config`
--

CREATE TABLE `starboard_config` (
  `guild_id` varchar(255) NOT NULL,
  `channel_id` varchar(255) NOT NULL,
  `star_threshold` int(11) NOT NULL DEFAULT 3
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `starboard_messages`
--

CREATE TABLE `starboard_messages` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `original_message_id` varchar(255) NOT NULL,
  `starboard_message_id` varchar(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sticky_roles`
--

CREATE TABLE `sticky_roles` (
  `guild_id` varchar(255) NOT NULL,
  `user_id` varchar(255) NOT NULL,
  `roles` text NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `streamers`
--

CREATE TABLE `streamers` (
  `streamer_id` bigint(20) NOT NULL,
  `platform` varchar(50) NOT NULL,
  `platform_user_id` varchar(255) NOT NULL,
  `username` varchar(255) NOT NULL,
  `discord_user_id` varchar(255) DEFAULT NULL,
  `profile_image_url` text DEFAULT NULL,
  `last_vod_id` varchar(255) DEFAULT NULL,
  `kick_username` varchar(255) DEFAULT NULL,
  `normalized_username` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

--
-- Dumping data for table `streamers`
--

INSERT INTO `streamers` (`streamer_id`, `platform`, `platform_user_id`, `username`, `discord_user_id`, `profile_image_url`, `last_vod_id`, `kick_username`, `normalized_username`) VALUES
(1, 'twitch', '730258463', 'spacemonkee', '602939564905988131', 'https://static-cdn.jtvnw.net/jtv_user_pictures/9638d499-89f2-4a9f-8797-2de91ff1f0ca-profile_image-300x300.png', NULL, 'SpaceMonkee', 'spacemonkee'),
(2, 'twitch', '1084078852', 'xxblack_mildxx', '480170575243903017', NULL, NULL, NULL, 'xxblackmildxx'),
(3, 'twitch', '437029977', 'fliiqzy', '515952792226234390', NULL, NULL, 'FLiiQzy', 'fliiqzy'),
(4, 'twitch', '846894942', 'saucinawstin', '324750022887604224', NULL, NULL, 'SaucinAwstin', 'saucinawstin'),
(5, 'twitch', '568219726', 'e710dabdragon', '761300594274861056', NULL, NULL, 'e710dabdragon', 'e7iodabdragon'),
(6, 'twitch', '122673932', 'x2fdx', '527976209058103326', NULL, NULL, 'x2FDx', 'x2fdx'),
(7, 'twitch', '557094470', 'onelovexx1994', '477321012569047040', 'https://static-cdn.jtvnw.net/jtv_user_pictures/4446508f-186c-4a85-a102-3774cb566bed-profile_image-300x300.png', NULL, 'onelovexx1994', 'onelovexxi99a'),
(8, 'twitch', '653746517', 'cvrsify', '510103106705686528', NULL, NULL, 'cvrsify', 'cvrsify'),
(9, 'twitch', '27413355', 'thcxducky', '1239048739239235676', 'https://static-cdn.jtvnw.net/jtv_user_pictures/f0edb13e-07f1-4d32-8b99-ac627fc0d3fd-profile_image-300x300.png', NULL, 'THCxDucky', 'thcxducky'),
(10, 'twitch', '41536288', 'michigan_husky', '187038259304595456', 'https://static-cdn.jtvnw.net/jtv_user_pictures/ec632437-1504-4c22-9e83-bcd225c84085-profile_image-300x300.png', NULL, NULL, 'michiganhusky'),
(11, 'twitch', '957656739', 'realbbgrl143', NULL, NULL, NULL, NULL, 'realbbgrliae'),
(12, 'twitch', '850396027', 'shadowxtremetv', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/c431e70c-380d-4bdc-8cfa-e782997d7d93-profile_image-300x300.png', NULL, 'ShadowXtremeTv', 'shadowxtremetv'),
(13, 'twitch', '926741189', 'afkmastershot420', '609111952962224128', 'https://static-cdn.jtvnw.net/jtv_user_pictures/977930ca-7235-4b5d-b2aa-88c0c1e1b66f-profile_image-300x300.png', NULL, 'Afkmastershot420', 'afkmastershota2o'),
(14, 'twitch', '780960672', 'monstergrl21', '1070577908634099752', 'https://static-cdn.jtvnw.net/jtv_user_pictures/7f5c2185-0614-4218-804a-45cbb841546e-profile_image-300x300.jpeg', NULL, 'MonsterGrl21', 'monstergrl2i'),
(15, 'twitch', '793726554', 'naamahxspeed', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/043d8f33-df94-47c1-a8fb-dab68bc95509-profile_image-300x300.png', NULL, 'NaamahxSpeed', 'naamahxspeed'),
(16, 'twitch', '714038531', 'froggiearmi52', '317534416735830017', 'https://static-cdn.jtvnw.net/jtv_user_pictures/770914a3-ef6f-45e2-af2a-30206bdd7986-profile_image-300x300.png', NULL, NULL, 'froggiearmi52'),
(17, 'twitch', '758854834', 'smaerc', NULL, NULL, NULL, 'smaerC', 'smaerc'),
(18, 'twitch', '83933513', 'astromonky', NULL, NULL, NULL, 'AstroMonky', 'astromonky'),
(19, 'twitch', '646484147', 'zachdadd1', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/dc2e336b-34eb-4afa-8276-16f1d84e906d-profile_image-300x300.png', NULL, 'ZACHDADD1', 'zachdaddi'),
(20, 'twitch', '257242619', 'gohrdy', '387717664140951553', 'https://static-cdn.jtvnw.net/jtv_user_pictures/75e5d3f7-ff53-41e0-b38b-66c16f92d18c-profile_image-300x300.png', NULL, 'Gohrdy', 'gohrdy'),
(21, 'twitch', '96809424', 'wiredkydd', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/2ddcbf70-7af4-473d-b9f8-63e6ca1a5418-profile_image-300x300.png', NULL, 'WiredKydd', 'wiredkydd'),
(22, 'twitch', '949691713', 's3ndo33', '339593983359451167', NULL, NULL, 'S3NDO33', 'sendoee'),
(23, 'twitch', '773534414', 'jkp42069', NULL, NULL, NULL, NULL, 'jkpa2o69'),
(24, 'twitch', '5867649', 'ganja_vibes', '851171083151343616', 'https://static-cdn.jtvnw.net/jtv_user_pictures/ceec76d5-bd9a-484e-a84b-1f6356905bb5-profile_image-300x300.png', NULL, NULL, 'ganjavibes'),
(25, 'twitch', '1055226754', 'xxthatoneguy_ttv', '720347799102947489', 'https://static-cdn.jtvnw.net/jtv_user_pictures/83c24ce5-3638-485f-a29f-52e84a2fbda5-profile_image-300x300.png', NULL, NULL, 'xxthatoneguyttv'),
(26, 'twitch', '100760079', 'floofgamingtv', '444270663637925889', 'https://static-cdn.jtvnw.net/jtv_user_pictures/7722517e-e36d-4e43-b897-498613b251d4-profile_image-300x300.png', NULL, NULL, 'floofgamingtv'),
(27, 'twitch', '615208411', 'boppstiick', '320912849306124288', NULL, NULL, NULL, 'boppstiick'),
(28, 'twitch', '815644130', 'muscularpubezgames', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/21698b95-aff2-450b-abed-e48256e82577-profile_image-300x300.png', NULL, 'MuscularPubezGames', 'muscularpubezgames'),
(29, 'twitch', '915256256', 'imbluntyboi', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/f6c0045b-a824-4502-8cfe-43d7ce590b15-profile_image-300x300.png', NULL, NULL, 'imbluntyboi'),
(30, 'twitch', '67512308', 'red78phoenix', '154990014596382720', 'https://static-cdn.jtvnw.net/jtv_user_pictures/852df629-9ecd-43b1-893a-7fd0caef34f7-profile_image-300x300.png', NULL, 'red78phoenix', 'red78phoenix'),
(31, 'twitch', '243319317', 'apitamy', '312505563781267456', 'https://static-cdn.jtvnw.net/jtv_user_pictures/70fd3261-b40c-42a5-8d1a-2b818e5cfc4f-profile_image-300x300.png', NULL, 'APITAMY', 'apitamy'),
(32, 'twitch', '737440213', 'shadowjamming', NULL, NULL, NULL, NULL, 'shadowjamming'),
(33, 'twitch', '62620281', 'zboricuajoel', '839853423183790111', 'https://static-cdn.jtvnw.net/jtv_user_pictures/42ee300f-0588-4f00-b9ab-63449610b7ac-profile_image-300x300.png', NULL, 'zBoricuaJoel', 'zboricuajoel'),
(34, 'twitch', '742467278', 'xxxdominatedxxx', '178600108344999936', 'https://static-cdn.jtvnw.net/jtv_user_pictures/9908ebab-885a-4274-ae27-38954286277b-profile_image-300x300.png', NULL, NULL, 'xxxdominatedxxx'),
(35, 'twitch', '773346606', 'synthspeed', '913723013629882440', NULL, NULL, 'SYNTHSPEED', 'synthspeed'),
(36, 'twitch', '113330609', 'itzappbro', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/d48282e7-c24c-49b6-b444-f37dcaac971b-profile_image-300x300.png', NULL, 'ItzAppBro', 'itzappbro'),
(37, 'twitch', '546708920', 'thebnandez', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/7546819d-ce26-4f03-89ce-20e559f4b20d-profile_image-300x300.png', NULL, NULL, 'thebnandez'),
(38, 'twitch', '655213051', 'bigpuppylive', '1192284787675762728', NULL, NULL, 'BIGPUPPYLIVE', 'bigpuppylive'),
(39, 'twitch', '531273267', 'yo_its_brendo_', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/d7f0ca32-d47d-45bb-bb01-362c48589f57-profile_image-300x300.png', NULL, NULL, 'yoitsbrendo'),
(40, 'twitch', '71644744', 'bubblez2cute', '298602963537100820', 'https://static-cdn.jtvnw.net/jtv_user_pictures/b87bf327-fa51-4b78-bc68-36dfe4504eb2-profile_image-300x300.jpeg', NULL, 'Bubblez2Cute', 'bubblez2cute'),
(41, 'twitch', '65428570', 'thefizner', '406342396364849154', 'https://static-cdn.jtvnw.net/jtv_user_pictures/5af4e202-cc32-4892-81d6-81669f27bdd4-profile_image-300x300.jpeg', NULL, 'TheFizner', 'thefizner'),
(42, 'twitch', '768726212', 'beachbabe670', '837126414502985758', 'https://static-cdn.jtvnw.net/jtv_user_pictures/1f7f254e-020f-499a-8654-be1f4315cbac-profile_image-300x300.png', NULL, NULL, 'beachbabe67o'),
(43, 'twitch', '657841417', 'ogjul3s', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/daffd33e-9f19-4806-a39b-bd4b574ff108-profile_image-300x300.png', NULL, 'OGJul3s', 'ogjules'),
(44, 'twitch', '651940735', 'chronic_nicole94', '665701029316263937', NULL, NULL, NULL, 'chronicnicole9a'),
(45, 'twitch', '153294054', 'dgt_muzik', '691711644056682528', NULL, NULL, 'Dgt_Muzik', 'dgtmuzik'),
(46, 'twitch', '469956405', 'milehighhippyttv', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/8a3244f7-c6b2-469e-9d38-61d196655a9a-profile_image-300x300.jpeg', NULL, NULL, 'milehighhippyttv'),
(47, 'twitch', '688842379', 'schhnitz', '995856691008651406', 'https://static-cdn.jtvnw.net/jtv_user_pictures/334c35bc-0bc0-42e8-a81d-6d7dbf664b58-profile_image-300x300.png', NULL, 'Schhnitz', 'schhnitz'),
(48, 'twitch', '753124455', 'dabking_506', NULL, NULL, NULL, NULL, 'dabking5o6'),
(49, 'twitch', '946357826', 'ttv_lithium_vtt', '1106263237219074171', NULL, NULL, NULL, 'ttvlithiumvtt'),
(50, 'twitch', '1052745506', 'itsonlygames24', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/18f4f114-ca72-4dfb-9022-7db8523c6b74-profile_image-300x300.jpeg', NULL, NULL, 'itsonlygames2a'),
(51, 'twitch', '101937112', 'azul_wolfin', NULL, NULL, NULL, NULL, 'azulwolfin'),
(52, 'twitch', '481492584', 'gaminggravel', '1064392219370463252', 'https://static-cdn.jtvnw.net/jtv_user_pictures/f2fd6dd6-6729-47af-96af-fa8bc247e00f-profile_image-300x300.png', NULL, 'GamingGravel', 'gaminggravel'),
(53, 'twitch', '632619494', 'yngsmiley', '894651314183762011', 'https://static-cdn.jtvnw.net/jtv_user_pictures/7a832e4d-ad4c-4ff5-a500-2cdd99370c17-profile_image-300x300.png', NULL, 'yngsmiley', 'yngsmiley'),
(54, 'twitch', '624950556', 'therealdavowill', NULL, NULL, NULL, NULL, 'therealdavowill'),
(55, 'twitch', '259502569', 'sasukenova', NULL, NULL, NULL, NULL, 'sasukenova'),
(56, 'twitch', '598917128', 'xgoliathttv', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/5ac8d0ce-cdec-4307-812f-5dd44880d5a5-profile_image-300x300.png', NULL, 'xgoliathttv', 'xgoliathttv'),
(57, 'twitch', '76501219', 'besscalibur01', '318768705997897743', NULL, NULL, NULL, 'besscaliburoi'),
(58, 'twitch', '713509821', 'xatomicplays', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/8ec26141-7e52-4a24-a8cd-8c49b0efa677-profile_image-300x300.png', NULL, NULL, 'xatomicplays'),
(59, 'twitch', '44734140', 'brooklynx5tar', '811295443744063599', NULL, NULL, 'BROOKLYNx5TAR', 'brooklynx5tar'),
(60, 'twitch', '1255296004', 'infinitescience', NULL, NULL, NULL, NULL, 'infinitescience'),
(61, 'twitch', '141538629', 'darastaking', '228387683053862914', NULL, NULL, 'DaRastaKing', 'darastaking'),
(62, 'twitch', '579025908', 'chris_trucci', NULL, NULL, NULL, NULL, 'christrucci'),
(63, 'twitch', '101449184', 'bejay30x', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/56665680-5c32-4380-8d35-439cc747fb8e-profile_image-300x300.png', NULL, 'bejay30x', 'bejayeox'),
(64, 'twitch', '248279769', 'brawler_op', NULL, NULL, NULL, NULL, 'brawlerop'),
(65, 'twitch', '1108137736', 'hunnybunz_xo', NULL, NULL, NULL, NULL, 'hunnybunzxo'),
(66, 'twitch', '139646762', 'rkh1234', '606595057457430680', 'https://static-cdn.jtvnw.net/jtv_user_pictures/8e3e9287-cd22-4f30-9053-f2576bc2bdae-profile_image-300x300.png', NULL, 'RKH1234', 'rkhi2ea'),
(67, 'twitch', '231782346', 'c00kiesays', '874653820037238834', 'https://static-cdn.jtvnw.net/jtv_user_pictures/513f2b37-79ae-4c79-a6c6-40ef36401b8d-profile_image-300x300.png', NULL, NULL, 'cookiesays'),
(68, 'twitch', '96189264', 'xxdeath420xx', '365905620060340224', NULL, NULL, NULL, 'xxdeatha2oxx'),
(69, 'twitch', '584307049', 'cannabisusers', '757627128601772193', 'https://static-cdn.jtvnw.net/jtv_user_pictures/e56c372d-5d97-413d-9318-6992852178a7-profile_image-300x300.png', NULL, 'cannabisusers', 'cannabisusers'),
(70, 'twitch', '85747539', 'ogspade813', '1015271069352984607', NULL, NULL, 'OGSpade813', 'ogspade8ie'),
(71, 'twitch', '583707171', 'abs_vt', NULL, NULL, NULL, NULL, 'absvt'),
(72, 'twitch', '617148929', 'iiin_dica', '823664005771952140', 'https://static-cdn.jtvnw.net/jtv_user_pictures/ed1bc32c-aefd-4076-99f4-821cbc184651-profile_image-300x300.png', NULL, NULL, 'iiindica'),
(73, 'twitch', '488610297', 'jeffdank90', '729651570702155846', 'https://static-cdn.jtvnw.net/jtv_user_pictures/449c1981-9db4-40c4-96ed-fbdf30cedce5-profile_image-300x300.png', NULL, 'Jeffdank90', 'jeffdank9o'),
(74, 'twitch', '499827519', 'elite_pain420', '335070290369576962', NULL, NULL, NULL, 'elitepaina2o'),
(75, 'twitch', '259338819', 'spoons2024', '495308648034074624', NULL, NULL, NULL, 'spoons2o2a'),
(76, 'twitch', '70963315', 'kingyork1985', '754167975782645781', 'https://static-cdn.jtvnw.net/jtv_user_pictures/a47d5e53-e570-4814-a161-7b0ebe978cc2-profile_image-300x300.png', NULL, 'Kingyork1985', 'kingyorki985'),
(77, 'twitch', '765532586', 'mrchefkev7', '806631577513361408', NULL, NULL, 'MrChefKev7', 'mrchefkev7'),
(78, 'twitch', '178377425', 'unclepyyro', '329485270649143304', 'https://static-cdn.jtvnw.net/jtv_user_pictures/0958ec58-82d8-4126-9352-c981e2240e77-profile_image-300x300.jpeg', NULL, 'UnclePyyro', 'unclepyyro'),
(79, 'twitch', '884186564', 'snacky_sh33p', '810207095944118333', NULL, NULL, NULL, 'snackysheep'),
(80, 'twitch', '803564532', 'catalystslays', '691145031486013510', 'https://static-cdn.jtvnw.net/jtv_user_pictures/9529c3a2-fceb-41b3-8079-f024406673e9-profile_image-300x300.png', NULL, 'CatalystSlays', 'catalystslays'),
(81, 'twitch', '60489582', 'vorzs', '162719798969630720', 'https://static-cdn.jtvnw.net/jtv_user_pictures/b8600331-f057-4ec0-a533-650c8205b6a4-profile_image-300x300.png', NULL, 'Vorzs', 'vorzs'),
(82, 'twitch', '930533852', 'pookieru96', '1117583924030357586', NULL, NULL, 'Pookieru96', 'pookieru96'),
(83, 'twitch', '1083792959', 'canadian_goose902', '1395745041871273994', NULL, NULL, 'Canadian_Goose902', 'canadiangoose9o2'),
(84, 'twitch', '824688320', '1xfrankie', '881593846599925790', 'https://static-cdn.jtvnw.net/jtv_user_pictures/c28c0049-5390-4838-bec1-39b69a4bbdb6-profile_image-300x300.png', NULL, '1xFrankie', 'ixfrankie'),
(85, 'twitch', '440245448', 'just_chronic', NULL, NULL, NULL, NULL, 'justchronic'),
(86, 'twitch', '22923626', 'sunriseftw', '218177248845496320', 'https://static-cdn.jtvnw.net/jtv_user_pictures/e8019e4e-e84c-4371-8e37-8a8130eb3da6-profile_image-300x300.png', NULL, 'SunriseFtw', 'sunriseftw'),
(89, 'twitch', '548223683', 'pastelhippy', '1254988321893908553', 'https://static-cdn.jtvnw.net/jtv_user_pictures/cc9b4987-eb9c-44e8-9f1b-61859219c40b-profile_image-300x300.png', NULL, 'pastelhippy', 'pastelhippy'),
(92, 'twitch', '89853740', 'sparkplug2996', '121028845594738688', 'https://static-cdn.jtvnw.net/jtv_user_pictures/c47d2653-1fbc-47a1-a148-1a27ffd68b17-profile_image-300x300.jpeg', NULL, 'Sparkplug2996', 'sparkplug2996'),
(93, 'twitch', '440185119', 'thematesquad', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/8e38713b-3143-4d8e-b334-16c7ff7af92c-profile_image-300x300.png', NULL, NULL, 'thematesquad'),
(98, 'twitch', '413861273', 'chefclips', '541841204543881218', NULL, NULL, 'Chefclips', 'chefclips'),
(100, 'twitch', '854633541', 'bizzzargaming420', '652193601987543060', 'https://static-cdn.jtvnw.net/jtv_user_pictures/1677c414-b492-4c4f-ba3b-b275f56b844a-profile_image-300x300.png', NULL, 'BizZzaRGaming420', 'bizzzargaminga2o'),
(102, 'twitch', '408588891', 'trifedad', '779979946822074368', 'https://static-cdn.jtvnw.net/jtv_user_pictures/7a21407a-0bc2-4bae-abda-46974f273cbc-profile_image-300x300.png', NULL, NULL, 'trifedad'),
(103, 'twitch', '1293634326', 'allie_baby123', NULL, 'https://static-cdn.jtvnw.net/jtv_user_pictures/6621e99e-21ea-409f-ac0c-8b2a24b376a3-profile_image-300x300.png', NULL, NULL, 'alliebabyi2e'),
(104, 'kick', '1388657', 'SpaceMonkee', '602939564905988131', 'https://files.kick.com/images/user/1433341/profile_image/conversion/5255ef98-864b-47b7-ae33-a89f8c0c00bf-fullsize.webp', NULL, 'SpaceMonkee', 'spacemonkee'),
(105, 'kick', '4569942', 'e710dabdragon', '761300594274861056', 'https://files.kick.com/images/user/4655809/profile_image/conversion/646785c5-a7b7-4bee-b7f3-d4fe7f2e978f-fullsize.webp', NULL, 'e710dabdragon', 'e710dabdragon'),
(106, 'kick', '1431345', 'onelovexx1994', '477321012569047040', 'https://files.kick.com/images/user/1476862/profile_image/conversion/3bb3b18c-e1d9-4b0e-9ced-803bd6d617e3-fullsize.webp', NULL, 'onelovexx1994', 'onelovexx1994'),
(107, 'kick', '9549099', 'Afkmastershot420', '609111952962224128', 'https://files.kick.com/images/user/10304893/profile_image/conversion/487bbe02-019e-4038-a000-73e351cd8073-fullsize.webp', NULL, 'Afkmastershot420', 'afkmastershot420'),
(108, 'kick', '24474380', 'S3NDO33', '339593983359451167', NULL, NULL, 'S3NDO33', 's3ndo33'),
(109, 'kick', '2911878', 'APITAMY', '312505563781267456', 'https://files.kick.com/images/user/2971108/profile_image/conversion/4ec13d89-dc15-43f1-a222-1c05fdb0a1d7-fullsize.webp', NULL, 'APITAMY', 'apitamy'),
(110, 'kick', '1987698', 'Bubblez2Cute', '298602963537100820', 'https://files.kick.com/images/user/2041171/profile_image/conversion/6379d74b-5602-455e-8df5-91734d0bd9ad-fullsize.webp', NULL, 'Bubblez2Cute', 'bubblez2cute'),
(111, 'kick', '19977729', 'GamingGravel', '1064392219370463252', 'https://files.kick.com/images/user/20959898/profile_image/conversion/908b6d1c-abc5-4b3f-b033-455b5d8964cb-fullsize.webp', NULL, 'GamingGravel', 'gaminggravel'),
(112, 'kick', '1977775', 'death420', '365905620060340224', NULL, NULL, NULL, 'deatha2o'),
(113, 'kick', '1772050', 'OGSpade813', '1015271069352984607', 'https://files.kick.com/images/user/1822922/profile_image/conversion/9f9ea136-2085-4bdf-ad79-0aa6b6d202a6-fullsize.webp', NULL, 'OGSpade813', 'ogspade813'),
(114, 'kick', '3248284', 'MonsterGrl21', '1070577908634099752', 'https://files.kick.com/images/user/3313412/profile_image/conversion/3e8f7ca5-3eab-4131-89bd-d62429a79bb5-fullsize.webp', NULL, 'MonsterGrl21', 'monstergrl21'),
(115, 'kick', '52209426', 'Pookieru96', '1117583924030357586', 'https://files.kick.com/images/user/53331841/profile_image/conversion/53082ee7-edf6-48d5-9610-65eeb89b071a-fullsize.webp', NULL, 'Pookieru96', 'pookieru96'),
(116, 'kick', '2242051', 'BIGPUPPYLIVE', '1192284787675762728', 'https://files.kick.com/images/user/2296283/profile_image/conversion/edc66779-5492-42bb-ad92-a8e8c88ee7f2-fullsize.webp', NULL, 'BIGPUPPYLIVE', 'bigpuppylive'),
(117, 'kick', '792806', 'THCxDucky', '1239048739239235676', 'https://files.kick.com/images/user/818852/profile_image/conversion/32a65d54-64da-460a-832c-1fdbd47f3d0d-fullsize.webp', NULL, 'THCxDucky', 'thcxducky'),
(118, 'kick', '63838108', 'pastelhippy', '1254988321893908553', 'https://files.kick.com/images/user/64984898/profile_image/conversion/e502e97a-9999-438c-9e3e-df22c173375d-fullsize.webp', NULL, 'pastelhippy', 'pastelhippy'),
(119, 'kick', '27437949', 'Canadian_Goose902', '1395745041871273994', 'https://files.kick.com/images/user/28467436/profile_image/conversion/0369f0ee-28ef-4cad-88d2-5fa01928ee1a-fullsize.webp', NULL, 'Canadian_Goose902', 'canadian_goose902'),
(120, 'kick', '1100600', 'red78phoenix', '154990014596382720', 'https://files.kick.com/images/user/1140434/profile_image/conversion/052e4d64-7fb6-4f2b-8efa-54cb2445c37c-fullsize.webp', NULL, 'red78phoenix', 'red78phoenix'),
(121, 'kick', '960404', 'Vorzs', '162719798969630720', 'https://files.kick.com/images/user/1001937/profile_image/conversion/cab2a9c3-6fa8-4cdb-a3e5-8b82952e22ad-fullsize.webp', NULL, 'Vorzs', 'vorzs'),
(122, 'kick', '28758842', 'SunriseFtw', '218177248845496320', 'https://files.kick.com/images/user/29796957/profile_image/conversion/4f1872ed-390b-456a-ba3b-84b650cfd077-fullsize.webp', NULL, 'SunriseFtw', 'sunriseftw'),
(123, 'kick', '7957232', 'DaRastaKing', '228387683053862914', 'https://files.kick.com/images/user/8709373/profile_image/conversion/b9271a46-8387-403e-a88c-ff5f0a407f86-fullsize.webp', NULL, 'DaRastaKing', 'darastaking'),
(127, 'kick', '2308850', 'FLiiQzy', '515952792226234390', 'https://files.kick.com/images/user/2363341/profile_image/conversion/00ed7e75-6818-43a8-bb8e-52d830580158-fullsize.webp', NULL, 'FLiiQzy', 'fliiqzy'),
(128, 'kick', '2016289', 'SaucinAwstin', '324750022887604224', 'https://files.kick.com/images/user/2069910/profile_image/conversion/f280b7aa-77f2-4853-a770-e3e489f45275-fullsize.webp', NULL, 'SaucinAwstin', 'saucinawstin'),
(129, 'kick', '13989226', 'x2FDx', '527976209058103326', 'https://files.kick.com/images/user/14758299/profile_image/conversion/bd4b7160-4fcd-4fe8-b1cd-832de04c35ce-fullsize.webp', NULL, 'x2FDx', 'x2fdx'),
(130, 'kick', '948741', 'cvrsify', '510103106705686528', 'https://files.kick.com/images/user/987489/profile_image/conversion/010bd2e6-0b70-481c-8ef9-f5ea4870637b-fullsize.webp', NULL, 'cvrsify', 'cvrsify'),
(131, 'kick', '62565227', 'ShadowXtremeTv', NULL, 'https://files.kick.com/images/user/63709332/profile_image/conversion/59ae6855-3ef5-45f4-8540-bcf864951947-fullsize.webp', NULL, 'ShadowXtremeTv', 'shadowxtremetv'),
(132, 'kick', '4569892', 'NaamahxSpeed', NULL, 'https://files.kick.com/images/user/4655759/profile_image/conversion/c9580a6b-9ae9-4c29-abb7-e9ef91141860-fullsize.webp', NULL, 'NaamahxSpeed', 'naamahxspeed'),
(133, 'kick', '1383621', 'cannabisusers', '757627128601772193', 'https://files.kick.com/images/user/1428164/profile_image/conversion/bf6f622e-0556-4e1d-a001-fdafa2353c2f-fullsize.webp', NULL, 'cannabisusers', 'cannabisusers'),
(134, 'kick', '2735728', 'Jeffdank90', '729651570702155846', 'https://files.kick.com/images/user/2791353/profile_image/conversion/62474ee7-14e3-44cd-a94b-503d7936f30d-fullsize.webp', NULL, 'Jeffdank90', 'jeffdank90'),
(135, 'kick', '66578822', 'Sparkplug2996', '121028845594738688', 'https://files.kick.com/images/user/67731888/profile_image/conversion/9304f10e-5265-4910-8a2c-427896a8221c-fullsize.webp', NULL, 'Sparkplug2996', 'sparkplug2996'),
(136, 'kick', '23561365', 'cookiesays', '874653820037238834', 'https://files.kick.com/images/user/24562310/profile_image/conversion/53353cc4-c1a4-435d-a616-7b5622658a4f-fullsize.webp', NULL, NULL, 'cookiesays'),
(137, 'kick', '1798245', 'Dgt_Muzik', '691711644056682528', 'https://files.kick.com/images/user/1849528/profile_image/conversion/080fe83e-c079-4dcf-b936-a2265cb66c1b-fullsize.webp', NULL, 'Dgt_Muzik', 'dgt_muzik'),
(138, 'kick', '36218933', 'trufedad', '779979946822074368', NULL, NULL, NULL, 'trufedad'),
(139, 'kick', '2227047', 'yngsmiley', '894651314183762011', 'https://files.kick.com/images/user/2281219/profile_image/conversion/a4d224fe-e7a7-41c0-b454-4994abc0eca2-fullsize.webp', NULL, 'yngsmiley', 'yngsmiley'),
(140, 'kick', '7685516', 'BROOKLYNx5TAR', '811295443744063599', 'https://files.kick.com/images/user/8436915/profile_image/conversion/147e9f69-52fb-4dce-8141-d34d93f5b7bb-fullsize.webp', NULL, 'BROOKLYNx5TAR', 'brooklynx5tar'),
(143, 'kick', '143510', 'SYNTHSPEED', '913723013629882440', 'https://files.kick.com/images/user/145180/profile_image/conversion/a6e25152-c44e-4df2-8895-ce595e6ff01a-fullsize.webp', NULL, 'SYNTHSPEED', 'synthspeed'),
(1609, 'kick', '4446880', 'ItzAppBro', NULL, 'https://files.kick.com/images/user/4531086/profile_image/conversion/046ab9eb-ded4-4be1-a198-6974061d41c5-fullsize.webp', NULL, 'ItzAppBro', 'itzappbro'),
(1613, 'kick', '1088747', 'zBoricuaJoel', '839853423183790111', 'https://files.kick.com/images/user/1128331/profile_image/conversion/158d07b7-65ae-49b0-b6f3-3985a7071945-fullsize.webp', NULL, 'zBoricuaJoel', 'zboricuajoel'),
(1628, 'kick', '15902581', 'Chefclips', '541841204543881218', NULL, NULL, 'Chefclips', 'chefclips'),
(1629, 'kick', '20771038', 'MrChefKev7', '806631577513361408', 'https://files.kick.com/images/user/21759448/profile_image/conversion/fdd22639-2780-4369-b95d-6b1351a88f8e-fullsize.webp', NULL, 'MrChefKev7', 'mrchefkev7'),
(1645, 'kick', '20576015', 'BizZzaRGaming420', '652193601987543060', 'https://files.kick.com/images/user/21563158/profile_image/conversion/03917df1-c6cf-46d3-82b1-ffdc88abc5c1-fullsize.webp', NULL, 'BizZzaRGaming420', 'bizzzargaming420'),
(1684, 'kick', '71602774', 'UnclePyyro', '329485270649143304', NULL, NULL, 'UnclePyyro', 'unclepyyro'),
(1875, 'youtube', 'UCfT-6lCUZzY8gTE_FqIe8uA', 'UCfT-6lCUZzY8gTE_FqIe8uA', '365905620060340224', NULL, NULL, NULL, NULL),
(1886, 'kick', '12058601', 'Kingyork1985', '754167975782645781', 'https://files.kick.com/images/user/12822028/profile_image/conversion/a5733497-705f-4e20-9567-75bba414b882-fullsize.webp', NULL, 'Kingyork1985', 'kingyork1985'),
(1944, 'kick', '31129160', 'smaerC', NULL, NULL, NULL, 'smaerC', 'smaerc'),
(1945, 'kick', '4641087', 'AstroMonky', NULL, 'https://files.kick.com/images/user/4727793/profile_image/conversion/63c70571-2b6d-4c65-84d0-aab85d99832e-fullsize.webp', NULL, 'AstroMonky', 'astromonky'),
(1946, 'kick', '535031', 'ZACHDADD1', NULL, 'https://files.kick.com/images/user/551285/profile_image/conversion/8b05d567-a451-430a-8d1a-a2f3de3e59d7-fullsize.webp', NULL, 'ZACHDADD1', 'zachdadd1'),
(1947, 'kick', '39128351', 'Gohrdy', '387717664140951553', 'https://files.kick.com/images/user/40209384/profile_image/conversion/06f094d6-45ba-4c97-94f2-a09afa185f7c-fullsize.webp', NULL, 'Gohrdy', 'gohrdy'),
(1948, 'kick', '1599958', 'WiredKydd', NULL, NULL, NULL, 'WiredKydd', 'wiredkydd'),
(1950, 'kick', '1295974', 'MuscularPubezGames', NULL, 'https://files.kick.com/images/user/1339083/profile_image/conversion/13c210fc-bdec-4d79-a3fb-a9636c846f87-fullsize.webp', NULL, 'MuscularPubezGames', 'muscularpubezgames'),
(1958, 'kick', '2715810', 'TheFizner', '406342396364849154', 'https://files.kick.com/images/user/2771382/profile_image/conversion/25e867c3-b0f3-4ef8-b197-378ca261115c-fullsize.webp', NULL, 'TheFizner', 'thefizner'),
(1959, 'kick', '39765129', 'OGJul3s', NULL, 'https://files.kick.com/images/user/40848875/profile_image/conversion/ec8cae57-03c1-4fbf-ac74-9aabb36b30b6-fullsize.webp', NULL, 'OGJul3s', 'ogjul3s'),
(1961, 'kick', '11689605', 'Schhnitz', '995856691008651406', NULL, NULL, 'Schhnitz', 'schhnitz'),
(1964, 'kick', '1548573', 'xgoliathttv', NULL, NULL, NULL, 'xgoliathttv', 'xgoliathttv'),
(1967, 'kick', '3672055', 'bejay30x', NULL, NULL, NULL, 'bejay30x', 'bejay30x'),
(1968, 'kick', '56342240', 'RKH1234', '606595057457430680', 'https://files.kick.com/images/user/57472175/profile_image/conversion/0410a143-0af4-4fcd-a7eb-19ecd9454644-fullsize.webp', NULL, 'RKH1234', 'rkh1234'),
(1975, 'kick', '1799034', 'CatalystSlays', '691145031486013510', 'https://files.kick.com/images/user/1850328/profile_image/conversion/c901004d-bdc7-4b9a-b7ed-8fd7c473c4ae-fullsize.webp', NULL, 'CatalystSlays', 'catalystslays'),
(1979, 'kick', '37997181', '1xFrankie', '881593846599925790', NULL, NULL, '1xFrankie', '1xfrankie');

-- --------------------------------------------------------

--
-- Table structure for table `stream_sessions`
--

CREATE TABLE `stream_sessions` (
  `session_id` bigint(20) NOT NULL,
  `announcement_id` bigint(20) NOT NULL,
  `streamer_id` bigint(20) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `start_time` datetime NOT NULL,
  `end_time` datetime DEFAULT NULL,
  `game_name` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

--
-- Dumping data for table `stream_sessions`
--

INSERT INTO `stream_sessions` (`session_id`, `announcement_id`, `streamer_id`, `guild_id`, `start_time`, `end_time`, `game_name`) VALUES
(1, 1, 7, '985116833193553930', '2025-09-29 00:31:31', NULL, 'Art'),
(2, 2, 9, '985116833193553930', '2025-09-29 00:31:31', '2025-10-01 04:57:12', 'ASMR'),
(3, 3, 10, '985116833193553930', '2025-09-29 00:31:32', NULL, 'Megabonk'),
(4, 4, 20, '985116833193553930', '2025-09-29 00:31:33', NULL, 'BORDERLANDS 4'),
(5, 5, 21, '985116833193553930', '2025-09-29 00:31:33', NULL, 'Just Chatting'),
(6, 6, 22, '985116833193553930', '2025-09-29 00:31:34', '2025-10-01 04:10:53', 'Call of Duty: Warzone'),
(7, 7, 24, '985116833193553930', '2025-09-29 00:31:34', NULL, 'Just Chatting'),
(8, 8, 25, '985116833193553930', '2025-09-29 00:31:35', NULL, 'Just Chatting'),
(9, 9, 26, '985116833193553930', '2025-09-29 00:31:35', '2025-10-01 06:27:37', 'Assassin\'s Creed Shadows'),
(10, 10, 30, '985116833193553930', '2025-09-29 00:31:36', '2025-10-01 02:13:48', 'Always On'),
(11, 11, 42, '985116833193553930', '2025-09-29 00:31:38', '2025-10-01 05:58:52', 'Need for Speed: Heat'),
(12, 12, 46, '985116833193553930', '2025-09-29 00:31:39', NULL, 'MindsEye'),
(13, 13, 50, '985116833193553930', '2025-09-29 00:31:39', '2025-10-01 05:58:52', 'Fortnite'),
(14, 14, 54, '985116833193553930', '2025-09-29 00:31:40', '2025-10-01 07:09:49', 'NBA 2K26'),
(15, 15, 56, '985116833193553930', '2025-09-29 00:31:40', NULL, 'Off The Grid'),
(16, 16, 63, '985116833193553930', '2025-09-29 00:31:41', '2025-10-01 02:40:56', '7 Days to Die'),
(17, 17, 69, '985116833193553930', '2025-09-29 00:31:41', '2025-10-01 05:15:49', 'I\'m Only Sleeping'),
(18, 18, 73, '985116833193553930', '2025-09-29 00:31:42', '2025-10-01 07:09:49', 'Talk Shows & Podcasts'),
(19, 19, 81, '985116833193553930', '2025-09-29 00:31:42', '2025-10-01 05:15:49', 'Arkheron'),
(20, 20, 84, '985116833193553930', '2025-09-29 00:31:43', NULL, 'Fortnite'),
(21, 21, 69, '985116833193553930', '2025-09-29 00:31:43', '2025-10-01 05:09:33', 'I\'m Only Sleeping'),
(22, 22, 73, '985116833193553930', '2025-09-29 00:31:44', NULL, 'Talk Shows & Podcasts'),
(23, 23, 100, '985116833193553930', '2025-09-29 00:31:44', '2025-10-01 02:37:53', 'Music'),
(24, 24, 103, '985116833193553930', '2025-09-29 00:31:44', '2025-10-01 04:10:53', 'Fortnite'),
(25, 1, 7, '985116833193553930', '2025-09-29 00:38:54', NULL, 'Art'),
(26, 2, 9, '985116833193553930', '2025-09-29 00:38:54', '2025-10-01 04:57:12', 'ASMR'),
(27, 3, 10, '985116833193553930', '2025-09-29 00:38:55', NULL, 'Megabonk'),
(28, 4, 12, '985116833193553930', '2025-09-29 00:38:55', NULL, 'Just Chatting'),
(29, 5, 20, '985116833193553930', '2025-09-29 00:38:56', NULL, 'BORDERLANDS 4'),
(30, 6, 21, '985116833193553930', '2025-09-29 00:38:56', '2025-10-01 04:10:53', 'Just Chatting'),
(31, 7, 22, '985116833193553930', '2025-09-29 00:38:56', NULL, 'Call of Duty: Warzone'),
(32, 8, 24, '985116833193553930', '2025-09-29 00:38:57', NULL, 'Just Chatting'),
(33, 9, 25, '985116833193553930', '2025-09-29 00:38:58', '2025-10-01 06:27:37', 'Just Chatting'),
(34, 10, 26, '985116833193553930', '2025-09-29 00:38:58', '2025-10-01 02:13:48', 'Assassin\'s Creed Shadows'),
(35, 11, 30, '985116833193553930', '2025-09-29 00:38:59', '2025-10-01 05:58:52', 'Always On'),
(36, 12, 42, '985116833193553930', '2025-09-29 00:38:59', NULL, 'Need for Speed: Heat'),
(37, 13, 46, '985116833193553930', '2025-09-29 00:39:00', '2025-10-01 05:58:52', 'MindsEye'),
(38, 14, 50, '985116833193553930', '2025-09-29 00:39:00', '2025-10-01 07:09:49', 'Fortnite'),
(39, 15, 54, '985116833193553930', '2025-09-29 00:39:01', NULL, 'NBA 2K26'),
(40, 16, 56, '985116833193553930', '2025-09-29 00:39:01', '2025-10-01 02:40:56', 'Off The Grid'),
(41, 17, 63, '985116833193553930', '2025-09-29 00:39:02', '2025-10-01 05:15:49', '7 Days to Die'),
(42, 18, 69, '985116833193553930', '2025-09-29 00:39:03', '2025-10-01 07:09:49', 'I\'m Only Sleeping'),
(43, 19, 73, '985116833193553930', '2025-09-29 00:39:03', '2025-10-01 05:15:49', 'Talk Shows & Podcasts'),
(44, 20, 81, '985116833193553930', '2025-09-29 00:39:03', NULL, 'Arkheron'),
(45, 21, 84, '985116833193553930', '2025-09-29 00:39:04', '2025-10-01 05:09:33', 'Fortnite'),
(46, 22, 69, '985116833193553930', '2025-09-29 00:39:04', NULL, 'I\'m Only Sleeping'),
(47, 23, 73, '985116833193553930', '2025-09-29 00:39:05', '2025-10-01 02:37:53', 'Talk Shows & Podcasts'),
(48, 24, 100, '985116833193553930', '2025-09-29 00:39:05', '2025-10-01 04:10:53', 'Music'),
(49, 25, 102, '985116833193553930', '2025-09-29 00:39:05', '2025-10-01 02:13:48', 'Games + Demos'),
(50, 26, 103, '985116833193553930', '2025-09-29 00:39:06', NULL, 'Fortnite'),
(51, 1, 7, '985116833193553930', '2025-09-29 07:22:14', NULL, 'Art'),
(52, 2, 9, '985116833193553930', '2025-09-29 07:22:15', '2025-10-01 04:57:12', 'Dead by Daylight'),
(53, 3, 19, '985116833193553930', '2025-09-29 07:22:16', NULL, 'Just Chatting'),
(54, 4, 21, '985116833193553930', '2025-09-29 07:22:17', NULL, 'Just Chatting'),
(55, 5, 22, '985116833193553930', '2025-09-29 07:22:17', NULL, 'Call of Duty: Warzone'),
(56, 6, 24, '985116833193553930', '2025-09-29 07:22:18', '2025-10-01 04:10:53', 'Just Chatting'),
(57, 7, 30, '985116833193553930', '2025-09-29 07:22:19', NULL, 'Always On'),
(58, 8, 42, '985116833193553930', '2025-09-29 07:22:20', NULL, 'Need for Speed: Heat'),
(59, 9, 47, '985116833193553930', '2025-09-29 07:22:21', '2025-10-01 06:27:37', 'Call of Duty: Warzone'),
(60, 10, 50, '985116833193553930', '2025-09-29 07:22:22', '2025-10-01 02:13:48', 'Fortnite'),
(61, 11, 52, '985116833193553930', '2025-09-29 07:22:23', '2025-10-01 05:58:52', 'Hollow Knight: Silksong'),
(62, 12, 54, '985116833193553930', '2025-09-29 07:22:23', NULL, 'NBA 2K26'),
(63, 13, 69, '985116833193553930', '2025-09-29 07:22:23', '2025-10-01 05:58:52', 'Talk Shows & Podcasts'),
(64, 14, 81, '985116833193553930', '2025-09-29 07:22:24', '2025-10-01 07:09:49', 'Mount & Blade II: Bannerlord'),
(65, 15, 69, '985116833193553930', '2025-09-29 07:22:25', NULL, 'Talk Shows & Podcasts'),
(66, 16, 100, '985116833193553930', '2025-09-29 07:22:26', '2025-10-01 02:40:56', 'Just Chatting'),
(67, 17, 103, '985116833193553930', '2025-09-29 07:22:26', '2025-10-01 05:15:49', 'Fortnite'),
(68, 1, 7, '985116833193553930', '2025-09-29 07:32:04', NULL, 'Art'),
(69, 2, 9, '985116833193553930', '2025-09-29 07:32:04', '2025-10-01 04:57:12', 'Dead by Daylight'),
(70, 3, 19, '985116833193553930', '2025-09-29 07:32:05', NULL, 'Just Chatting'),
(71, 4, 21, '985116833193553930', '2025-09-29 07:32:05', NULL, 'Just Chatting'),
(72, 5, 22, '985116833193553930', '2025-09-29 07:32:06', NULL, 'Call of Duty: Warzone'),
(73, 6, 24, '985116833193553930', '2025-09-29 07:32:07', '2025-10-01 04:10:53', 'Just Chatting'),
(74, 7, 30, '985116833193553930', '2025-09-29 07:32:07', NULL, 'Always On'),
(75, 8, 42, '985116833193553930', '2025-09-29 07:32:08', NULL, 'Need for Speed: Heat'),
(76, 9, 47, '985116833193553930', '2025-09-29 07:32:09', '2025-10-01 06:27:37', 'Call of Duty: Warzone'),
(77, 10, 50, '985116833193553930', '2025-09-29 07:32:09', '2025-10-01 02:13:48', 'Fortnite'),
(78, 11, 52, '985116833193553930', '2025-09-29 07:32:10', '2025-10-01 05:58:52', 'Hollow Knight: Silksong'),
(79, 12, 54, '985116833193553930', '2025-09-29 07:32:10', NULL, 'NBA 2K26'),
(80, 13, 69, '985116833193553930', '2025-09-29 07:32:11', '2025-10-01 05:58:52', 'Talk Shows & Podcasts'),
(81, 14, 81, '985116833193553930', '2025-09-29 07:32:11', '2025-10-01 07:09:49', 'Mount & Blade II: Bannerlord'),
(82, 15, 69, '985116833193553930', '2025-09-29 07:32:12', NULL, 'Talk Shows & Podcasts'),
(83, 16, 100, '985116833193553930', '2025-09-29 07:32:12', '2025-10-01 02:40:56', 'Just Chatting'),
(84, 17, 103, '985116833193553930', '2025-09-29 07:32:13', '2025-10-01 05:15:49', 'Fortnite'),
(85, 1, 7, '985116833193553930', '2025-09-29 12:46:21', NULL, 'Art'),
(86, 2, 9, '985116833193553930', '2025-09-29 12:46:22', '2025-10-01 04:57:12', 'Dead by Daylight'),
(87, 3, 19, '985116833193553930', '2025-09-29 12:46:22', NULL, 'Just Chatting'),
(88, 4, 21, '985116833193553930', '2025-09-29 12:46:23', NULL, 'Just Chatting'),
(89, 5, 24, '985116833193553930', '2025-09-29 12:46:23', NULL, 'Just Chatting'),
(90, 6, 30, '985116833193553930', '2025-09-29 12:46:24', '2025-10-01 04:10:53', 'Always On'),
(91, 7, 36, '985116833193553930', '2025-09-29 12:46:25', NULL, 'Watcher of Realms'),
(92, 8, 50, '985116833193553930', '2025-09-29 12:46:25', NULL, 'Fortnite'),
(93, 9, 54, '985116833193553930', '2025-09-29 12:46:26', '2025-10-01 06:27:37', 'NBA 2K26'),
(94, 10, 81, '985116833193553930', '2025-09-29 12:46:26', '2025-10-01 02:13:48', 'Mount & Blade II: Bannerlord'),
(95, 11, 100, '985116833193553930', '2025-09-29 12:46:27', '2025-10-01 05:58:52', 'Music'),
(96, 12, 103, '985116833193553930', '2025-09-29 12:46:27', NULL, 'Fortnite'),
(97, 1, 7, '985116833193553930', '2025-09-29 12:53:42', NULL, 'Art'),
(98, 2, 9, '985116833193553930', '2025-09-29 12:53:42', '2025-10-01 04:57:12', 'Dead by Daylight'),
(99, 3, 19, '985116833193553930', '2025-09-29 12:53:43', NULL, 'Just Chatting'),
(100, 4, 21, '985116833193553930', '2025-09-29 12:53:43', NULL, 'Just Chatting'),
(101, 5, 24, '985116833193553930', '2025-09-29 12:53:44', NULL, 'Just Chatting'),
(102, 6, 30, '985116833193553930', '2025-09-29 12:53:45', '2025-10-01 04:10:53', 'Always On'),
(103, 7, 36, '985116833193553930', '2025-09-29 12:53:46', NULL, 'Watcher of Realms'),
(104, 8, 50, '985116833193553930', '2025-09-29 12:53:46', NULL, 'Fortnite'),
(105, 9, 54, '985116833193553930', '2025-09-29 12:53:47', '2025-10-01 06:27:37', 'NBA 2K26'),
(106, 10, 81, '985116833193553930', '2025-09-29 12:53:47', '2025-10-01 02:13:48', 'Mount & Blade II: Bannerlord'),
(107, 11, 100, '985116833193553930', '2025-09-29 12:53:48', '2025-10-01 05:58:52', 'Music'),
(108, 12, 103, '985116833193553930', '2025-09-29 12:53:50', NULL, 'Fortnite'),
(109, 1, 7, '985116833193553930', '2025-09-29 12:58:11', NULL, 'Art'),
(110, 2, 9, '985116833193553930', '2025-09-29 12:58:12', '2025-10-01 04:57:12', 'Dead by Daylight'),
(111, 3, 19, '985116833193553930', '2025-09-29 12:58:12', NULL, 'Just Chatting'),
(112, 4, 21, '985116833193553930', '2025-09-29 12:58:13', NULL, 'Just Chatting'),
(113, 5, 24, '985116833193553930', '2025-09-29 12:58:13', NULL, 'Just Chatting'),
(114, 6, 30, '985116833193553930', '2025-09-29 12:58:14', '2025-10-01 04:10:53', 'Always On'),
(115, 7, 36, '985116833193553930', '2025-09-29 12:58:15', NULL, 'Watcher of Realms'),
(116, 8, 50, '985116833193553930', '2025-09-29 12:58:15', NULL, 'Fortnite'),
(117, 9, 54, '985116833193553930', '2025-09-29 12:58:16', '2025-10-01 06:27:37', 'NBA 2K26'),
(118, 10, 81, '985116833193553930', '2025-09-29 12:58:17', '2025-10-01 02:13:48', 'Mount & Blade II: Bannerlord'),
(119, 11, 100, '985116833193553930', '2025-09-29 12:58:17', '2025-10-01 05:58:52', 'Music'),
(120, 12, 103, '985116833193553930', '2025-09-29 12:58:17', NULL, 'Fortnite'),
(121, 1, 7, '985116833193553930', '2025-09-29 13:03:56', NULL, 'Art'),
(122, 2, 9, '985116833193553930', '2025-09-29 13:03:56', '2025-10-01 04:57:12', 'Dead by Daylight'),
(123, 3, 19, '985116833193553930', '2025-09-29 13:03:58', NULL, 'Just Chatting'),
(124, 4, 21, '985116833193553930', '2025-09-29 13:03:58', NULL, 'Just Chatting'),
(125, 5, 24, '985116833193553930', '2025-09-29 13:03:59', NULL, 'Just Chatting'),
(126, 6, 30, '985116833193553930', '2025-09-29 13:03:59', '2025-10-01 04:10:53', 'Always On'),
(127, 7, 36, '985116833193553930', '2025-09-29 13:04:00', NULL, 'Watcher of Realms'),
(128, 8, 50, '985116833193553930', '2025-09-29 13:04:01', NULL, 'Fortnite'),
(129, 9, 54, '985116833193553930', '2025-09-29 13:04:02', '2025-10-01 06:27:37', 'NBA 2K26'),
(130, 10, 81, '985116833193553930', '2025-09-29 13:04:03', '2025-10-01 02:13:48', 'Mount & Blade II: Bannerlord'),
(131, 11, 100, '985116833193553930', '2025-09-29 13:04:03', '2025-10-01 05:58:52', 'Music'),
(132, 12, 103, '985116833193553930', '2025-09-29 13:04:04', NULL, 'Fortnite'),
(133, 1, 7, '985116833193553930', '2025-09-29 13:11:11', NULL, 'Art'),
(134, 2, 9, '985116833193553930', '2025-09-29 13:18:55', '2025-10-01 04:57:12', 'Dead by Daylight'),
(135, 3, 19, '985116833193553930', '2025-09-29 13:18:56', NULL, 'Just Chatting'),
(136, 4, 21, '985116833193553930', '2025-09-29 13:18:56', NULL, 'Just Chatting'),
(137, 5, 24, '985116833193553930', '2025-09-29 13:18:57', NULL, 'Just Chatting'),
(138, 6, 30, '985116833193553930', '2025-09-29 13:18:57', '2025-10-01 04:10:53', 'Always On'),
(139, 7, 36, '985116833193553930', '2025-09-29 13:19:06', NULL, 'Watcher of Realms'),
(140, 8, 50, '985116833193553930', '2025-09-29 13:19:06', NULL, 'Fortnite'),
(141, 9, 54, '985116833193553930', '2025-09-29 13:19:07', '2025-10-01 06:27:37', 'NBA 2K26'),
(142, 10, 81, '985116833193553930', '2025-09-29 13:19:07', '2025-10-01 02:13:48', 'Mount & Blade II: Bannerlord'),
(143, 11, 100, '985116833193553930', '2025-09-29 13:19:08', '2025-10-01 05:58:52', 'Music'),
(144, 12, 103, '985116833193553930', '2025-09-29 13:19:09', NULL, 'Fortnite'),
(145, 1, 7, '985116833193553930', '2025-09-29 13:19:32', NULL, 'Art'),
(146, 2, 9, '985116833193553930', '2025-09-29 13:19:32', '2025-10-01 04:57:12', 'Dead by Daylight'),
(147, 3, 19, '985116833193553930', '2025-09-29 13:19:33', NULL, 'Just Chatting'),
(148, 4, 21, '985116833193553930', '2025-09-29 13:19:34', NULL, 'Just Chatting'),
(149, 5, 24, '985116833193553930', '2025-09-29 13:19:34', NULL, 'Just Chatting'),
(150, 6, 30, '985116833193553930', '2025-09-29 13:19:35', '2025-10-01 04:10:53', 'Always On'),
(151, 7, 36, '985116833193553930', '2025-09-29 13:19:35', NULL, 'Watcher of Realms'),
(152, 8, 50, '985116833193553930', '2025-09-29 13:19:36', NULL, 'Fortnite'),
(153, 9, 54, '985116833193553930', '2025-09-29 13:19:36', '2025-10-01 06:27:37', 'NBA 2K26'),
(154, 10, 63, '985116833193553930', '2025-09-29 13:19:37', '2025-10-01 02:13:48', 'Games + Demos'),
(155, 11, 81, '985116833193553930', '2025-09-29 13:19:37', '2025-10-01 05:58:52', 'Mount & Blade II: Bannerlord'),
(156, 12, 100, '985116833193553930', '2025-09-29 13:19:37', NULL, 'Music'),
(157, 13, 103, '985116833193553930', '2025-09-29 13:19:38', '2025-10-01 05:58:52', 'Fortnite'),
(158, 1, 7, '985116833193553930', '2025-09-29 13:37:41', NULL, 'Art'),
(159, 2, 9, '985116833193553930', '2025-09-29 13:37:42', '2025-10-01 04:57:12', 'Dead by Daylight'),
(160, 3, 19, '985116833193553930', '2025-09-29 13:37:43', NULL, 'Just Chatting'),
(161, 4, 21, '985116833193553930', '2025-09-29 13:37:43', NULL, 'Just Chatting'),
(162, 5, 24, '985116833193553930', '2025-09-29 13:37:44', NULL, 'Just Chatting'),
(163, 6, 30, '985116833193553930', '2025-09-29 13:37:44', '2025-10-01 04:10:53', 'Always On'),
(164, 7, 36, '985116833193553930', '2025-09-29 13:37:46', NULL, 'Watcher of Realms'),
(165, 8, 50, '985116833193553930', '2025-09-29 13:37:46', NULL, 'Fortnite'),
(166, 9, 54, '985116833193553930', '2025-09-29 13:37:47', '2025-10-01 06:27:37', 'NBA 2K26'),
(167, 10, 63, '985116833193553930', '2025-09-29 13:37:47', '2025-10-01 02:13:48', '7 Days to Die'),
(168, 11, 66, '985116833193553930', '2025-09-29 13:37:49', '2025-10-01 05:58:52', 'Genshin Impact'),
(169, 12, 81, '985116833193553930', '2025-09-29 13:37:50', NULL, 'Mount & Blade II: Bannerlord'),
(170, 13, 100, '985116833193553930', '2025-09-29 13:37:50', '2025-10-01 05:58:52', 'Music'),
(171, 14, 103, '985116833193553930', '2025-09-29 13:37:51', '2025-10-01 07:09:49', 'Fortnite'),
(172, 1, 7, '985116833193553930', '2025-09-29 14:08:05', NULL, 'Art'),
(173, 2, 9, '985116833193553930', '2025-09-29 14:08:06', '2025-10-01 04:57:12', 'ASMR'),
(174, 3, 19, '985116833193553930', '2025-09-29 14:08:08', NULL, 'Just Chatting'),
(175, 4, 21, '985116833193553930', '2025-09-29 14:08:09', NULL, 'Just Chatting'),
(176, 5, 30, '985116833193553930', '2025-09-29 14:08:10', NULL, 'Always On'),
(177, 6, 54, '985116833193553930', '2025-09-29 14:08:10', '2025-10-01 04:10:53', 'NBA 2K26'),
(178, 7, 63, '985116833193553930', '2025-09-29 14:08:11', NULL, '7 Days to Die'),
(179, 8, 66, '985116833193553930', '2025-09-29 14:08:11', NULL, 'Genshin Impact'),
(180, 9, 69, '985116833193553930', '2025-09-29 14:08:12', '2025-10-01 06:27:37', 'skate.'),
(181, 10, 81, '985116833193553930', '2025-09-29 14:08:13', '2025-10-01 02:13:48', 'Mount & Blade II: Bannerlord'),
(182, 11, 69, '985116833193553930', '2025-09-29 14:08:14', '2025-10-01 05:58:52', 'skate.'),
(183, 12, 100, '985116833193553930', '2025-09-29 14:08:14', NULL, 'Music'),
(184, 13, 103, '985116833193553930', '2025-09-29 14:08:15', '2025-10-01 05:58:52', 'Fortnite'),
(185, 1, 7, '985116833193553930', '2025-09-29 14:12:23', NULL, 'Art'),
(186, 2, 9, '985116833193553930', '2025-09-29 14:12:23', '2025-10-01 04:57:12', 'ASMR'),
(187, 3, 19, '985116833193553930', '2025-09-29 14:12:24', NULL, 'Just Chatting'),
(188, 4, 21, '985116833193553930', '2025-09-29 14:12:25', NULL, 'Just Chatting'),
(189, 5, 30, '985116833193553930', '2025-09-29 14:12:25', NULL, 'Always On'),
(190, 6, 50, '985116833193553930', '2025-09-29 14:12:26', '2025-10-01 04:10:53', 'Fortnite'),
(191, 7, 54, '985116833193553930', '2025-09-29 14:12:26', NULL, 'NBA 2K26'),
(192, 8, 63, '985116833193553930', '2025-09-29 14:12:27', NULL, '7 Days to Die'),
(193, 9, 66, '985116833193553930', '2025-09-29 14:12:27', '2025-10-01 06:27:37', 'Genshin Impact'),
(194, 10, 69, '985116833193553930', '2025-09-29 14:12:28', '2025-10-01 02:13:48', 'skate.'),
(195, 11, 81, '985116833193553930', '2025-09-29 14:12:29', '2025-10-01 05:58:52', 'Mount & Blade II: Bannerlord'),
(196, 12, 69, '985116833193553930', '2025-09-29 14:12:30', NULL, 'skate.'),
(197, 13, 100, '985116833193553930', '2025-09-29 14:12:30', '2025-10-01 05:58:52', 'Music'),
(198, 14, 103, '985116833193553930', '2025-09-29 14:12:31', '2025-10-01 07:09:49', 'Fortnite'),
(199, 1, 7, '985116833193553930', '2025-09-29 14:26:52', NULL, 'Art'),
(200, 2, 9, '985116833193553930', '2025-09-29 14:26:53', '2025-10-01 04:57:12', 'ASMR'),
(201, 3, 19, '985116833193553930', '2025-09-29 14:26:54', NULL, 'Just Chatting'),
(202, 4, 21, '985116833193553930', '2025-09-29 14:26:54', NULL, 'Just Chatting'),
(203, 5, 24, '985116833193553930', '2025-09-29 14:26:55', NULL, 'Just Chatting'),
(204, 6, 30, '985116833193553930', '2025-09-29 14:26:56', '2025-10-01 04:10:53', 'Always On'),
(205, 7, 50, '985116833193553930', '2025-09-29 14:26:57', NULL, 'Fortnite'),
(206, 8, 54, '985116833193553930', '2025-09-29 14:26:58', NULL, 'NBA 2K26'),
(207, 9, 63, '985116833193553930', '2025-09-29 14:26:58', '2025-10-01 06:27:37', '7 Days to Die'),
(208, 10, 66, '985116833193553930', '2025-09-29 14:26:59', '2025-10-01 02:13:48', 'Genshin Impact'),
(209, 11, 69, '985116833193553930', '2025-09-29 14:26:59', '2025-10-01 05:58:52', 'skate.'),
(210, 12, 81, '985116833193553930', '2025-09-29 14:27:00', NULL, 'Mount & Blade II: Bannerlord'),
(211, 13, 69, '985116833193553930', '2025-09-29 14:27:01', '2025-10-01 05:58:52', 'skate.'),
(212, 14, 100, '985116833193553930', '2025-09-29 14:27:02', '2025-10-01 07:09:49', 'Music'),
(213, 15, 103, '985116833193553930', '2025-09-29 14:27:02', NULL, 'Fortnite'),
(214, 1, 7, '985116833193553930', '2025-09-29 14:42:27', NULL, 'Art'),
(215, 2, 9, '985116833193553930', '2025-09-29 14:42:27', '2025-10-01 04:57:12', 'ASMR'),
(216, 3, 19, '985116833193553930', '2025-09-29 14:42:28', NULL, 'Just Chatting'),
(217, 4, 21, '985116833193553930', '2025-09-29 14:42:29', NULL, 'Just Chatting'),
(218, 5, 24, '985116833193553930', '2025-09-29 14:42:29', NULL, 'Just Chatting'),
(219, 6, 30, '985116833193553930', '2025-09-29 14:42:30', '2025-10-01 04:10:53', 'Always On'),
(220, 7, 50, '985116833193553930', '2025-09-29 14:42:31', NULL, 'Fortnite'),
(221, 8, 54, '985116833193553930', '2025-09-29 14:42:31', NULL, 'NBA 2K26'),
(222, 9, 63, '985116833193553930', '2025-09-29 14:42:32', '2025-10-01 06:27:37', '7 Days to Die'),
(223, 10, 66, '985116833193553930', '2025-09-29 14:42:33', '2025-10-01 02:13:48', 'Genshin Impact'),
(224, 11, 69, '985116833193553930', '2025-09-29 14:47:08', '2025-10-01 05:58:52', 'skate.'),
(225, 12, 81, '985116833193553930', '2025-09-29 14:47:09', NULL, 'Mount & Blade II: Bannerlord'),
(226, 13, 69, '985116833193553930', '2025-09-29 14:47:10', '2025-10-01 05:58:52', 'skate.'),
(227, 14, 100, '985116833193553930', '2025-09-29 14:47:11', '2025-10-01 07:09:49', 'Music'),
(228, 15, 103, '985116833193553930', '2025-09-29 14:47:11', NULL, 'Fortnite'),
(229, 1, 7, '985116833193553930', '2025-09-29 14:47:34', NULL, 'Art'),
(230, 2, 9, '985116833193553930', '2025-09-29 14:47:35', '2025-10-01 04:57:12', 'ASMR'),
(231, 3, 19, '985116833193553930', '2025-09-29 14:47:35', NULL, 'Just Chatting'),
(232, 4, 21, '985116833193553930', '2025-09-29 14:47:36', NULL, 'Just Chatting'),
(233, 5, 24, '985116833193553930', '2025-09-29 14:47:36', NULL, 'Just Chatting'),
(234, 6, 30, '985116833193553930', '2025-09-29 14:47:37', '2025-10-01 04:10:53', 'Always On'),
(235, 7, 50, '985116833193553930', '2025-09-29 14:47:38', NULL, 'Fortnite'),
(236, 8, 54, '985116833193553930', '2025-09-29 14:47:38', NULL, 'NBA 2K26'),
(237, 9, 63, '985116833193553930', '2025-09-29 14:47:40', '2025-10-01 06:27:37', '7 Days to Die'),
(238, 10, 66, '985116833193553930', '2025-09-29 14:47:41', '2025-10-01 02:13:48', 'Genshin Impact'),
(239, 11, 69, '985116833193553930', '2025-09-29 14:47:42', '2025-10-01 05:58:52', 'skate.'),
(240, 12, 81, '985116833193553930', '2025-09-29 14:47:42', NULL, 'Mount & Blade II: Bannerlord'),
(241, 13, 69, '985116833193553930', '2025-09-29 14:47:43', '2025-10-01 05:58:52', 'skate.'),
(242, 14, 100, '985116833193553930', '2025-09-29 14:47:43', '2025-10-01 07:09:49', 'Music'),
(243, 15, 103, '985116833193553930', '2025-09-29 14:47:44', NULL, 'Fortnite'),
(244, 1, 7, '985116833193553930', '2025-09-29 14:58:16', NULL, 'Art'),
(245, 2, 9, '985116833193553930', '2025-09-29 14:58:16', '2025-10-01 04:57:12', 'ASMR'),
(246, 3, 19, '985116833193553930', '2025-09-29 14:58:17', NULL, 'Just Chatting'),
(247, 4, 21, '985116833193553930', '2025-09-29 14:58:18', NULL, 'Just Chatting'),
(248, 5, 24, '985116833193553930', '2025-09-29 14:58:18', NULL, 'Just Chatting'),
(249, 6, 30, '985116833193553930', '2025-09-29 14:58:19', '2025-10-01 04:10:53', 'Always On'),
(250, 7, 50, '985116833193553930', '2025-09-29 14:58:19', NULL, 'Fortnite'),
(251, 8, 54, '985116833193553930', '2025-09-29 14:58:20', NULL, 'NBA 2K26'),
(252, 9, 63, '985116833193553930', '2025-09-29 14:58:21', '2025-10-01 06:27:37', '7 Days to Die'),
(253, 10, 66, '985116833193553930', '2025-09-29 14:58:21', '2025-10-01 02:13:48', 'Genshin Impact'),
(254, 11, 69, '985116833193553930', '2025-09-29 14:58:22', '2025-10-01 05:58:52', 'skate.'),
(255, 12, 81, '985116833193553930', '2025-09-29 14:58:23', NULL, 'Mount & Blade II: Bannerlord'),
(256, 13, 69, '985116833193553930', '2025-09-29 14:58:24', '2025-10-01 05:58:52', 'skate.'),
(257, 14, 100, '985116833193553930', '2025-09-29 14:58:25', '2025-10-01 07:09:49', 'Music'),
(258, 15, 103, '985116833193553930', '2025-09-29 14:58:25', NULL, 'Fortnite'),
(259, 1, 7, '985116833193553930', '2025-09-29 15:05:50', NULL, 'Art'),
(260, 2, 9, '985116833193553930', '2025-09-29 15:05:50', '2025-10-01 04:57:12', 'ASMR'),
(261, 3, 19, '985116833193553930', '2025-09-29 15:05:51', NULL, 'Just Chatting'),
(262, 4, 21, '985116833193553930', '2025-09-29 15:05:52', NULL, 'Just Chatting'),
(263, 5, 24, '985116833193553930', '2025-09-29 15:05:53', NULL, 'Just Chatting'),
(264, 6, 30, '985116833193553930', '2025-09-29 15:05:53', '2025-10-01 04:10:53', 'Always On'),
(265, 7, 40, '985116833193553930', '2025-09-29 15:05:54', NULL, 'Call of Duty: Warzone'),
(266, 8, 50, '985116833193553930', '2025-09-29 15:05:55', NULL, 'Fortnite'),
(267, 9, 54, '985116833193553930', '2025-09-29 15:05:58', '2025-10-01 06:27:37', 'NBA 2K26'),
(268, 10, 63, '985116833193553930', '2025-09-29 15:05:59', '2025-10-01 02:13:48', '7 Days to Die'),
(269, 11, 66, '985116833193553930', '2025-09-29 15:05:59', '2025-10-01 05:58:52', 'Genshin Impact'),
(270, 12, 69, '985116833193553930', '2025-09-29 15:06:00', NULL, 'skate.'),
(271, 13, 80, '985116833193553930', '2025-09-29 15:06:01', '2025-10-01 05:58:52', 'Call of Duty: Warzone'),
(272, 14, 81, '985116833193553930', '2025-09-29 15:06:03', '2025-10-01 07:09:49', 'Mount & Blade II: Bannerlord'),
(273, 15, 69, '985116833193553930', '2025-09-29 15:06:04', NULL, 'skate.'),
(274, 16, 89, '985116833193553930', '2025-09-29 15:06:06', '2025-10-01 02:40:56', 'Just Chatting'),
(275, 17, 100, '985116833193553930', '2025-09-29 15:06:07', '2025-10-01 05:15:49', 'Music'),
(276, 18, 103, '985116833193553930', '2025-09-29 15:06:09', '2025-10-01 07:09:49', 'Fortnite'),
(277, 1, 7, '985116833193553930', '2025-09-29 15:14:47', NULL, 'Art'),
(278, 2, 9, '985116833193553930', '2025-09-29 15:14:47', '2025-10-01 04:57:12', 'ASMR'),
(279, 3, 19, '985116833193553930', '2025-09-29 15:14:48', NULL, 'Just Chatting'),
(280, 4, 21, '985116833193553930', '2025-09-29 15:14:48', NULL, 'Just Chatting'),
(281, 5, 24, '985116833193553930', '2025-09-29 15:14:49', NULL, 'Just Chatting'),
(282, 6, 29, '985116833193553930', '2025-09-29 15:14:50', '2025-10-01 04:10:53', 'Apex Legends'),
(283, 7, 30, '985116833193553930', '2025-09-29 15:14:50', NULL, 'Always On'),
(284, 8, 40, '985116833193553930', '2025-09-29 15:14:51', NULL, 'Call of Duty: Warzone'),
(285, 9, 50, '985116833193553930', '2025-09-29 15:14:52', '2025-10-01 06:27:37', 'Fortnite'),
(286, 10, 54, '985116833193553930', '2025-09-29 15:14:53', '2025-10-01 02:13:48', 'NBA 2K26'),
(287, 11, 63, '985116833193553930', '2025-09-29 15:14:54', '2025-10-01 05:58:52', '7 Days to Die'),
(288, 12, 66, '985116833193553930', '2025-09-29 15:14:54', NULL, 'Genshin Impact'),
(289, 13, 69, '985116833193553930', '2025-09-29 15:14:55', '2025-10-01 05:58:52', 'skate.'),
(290, 14, 80, '985116833193553930', '2025-09-29 15:14:56', '2025-10-01 07:09:49', 'Call of Duty: Warzone'),
(291, 15, 81, '985116833193553930', '2025-09-29 15:14:57', NULL, 'Mount & Blade II: Bannerlord'),
(292, 16, 69, '985116833193553930', '2025-09-29 15:14:57', '2025-10-01 02:40:56', 'skate.'),
(293, 17, 89, '985116833193553930', '2025-09-29 15:14:58', '2025-10-01 05:15:49', 'Just Chatting'),
(294, 18, 100, '985116833193553930', '2025-09-29 15:14:58', '2025-10-01 07:09:49', 'Music'),
(295, 19, 103, '985116833193553930', '2025-09-29 15:14:59', '2025-10-01 05:15:49', 'Fortnite'),
(296, 1, 7, '985116833193553930', '2025-09-29 15:44:26', NULL, 'Art'),
(297, 2, 9, '985116833193553930', '2025-09-29 15:44:27', '2025-10-01 04:57:12', 'ASMR'),
(298, 3, 19, '985116833193553930', '2025-09-29 15:44:28', NULL, 'Just Chatting'),
(299, 4, 21, '985116833193553930', '2025-09-29 15:44:28', NULL, 'Just Chatting'),
(300, 5, 24, '985116833193553930', '2025-09-29 15:44:28', NULL, 'Just Chatting'),
(301, 6, 29, '985116833193553930', '2025-09-29 15:44:29', '2025-10-01 04:10:53', 'Ready or Not'),
(302, 7, 30, '985116833193553930', '2025-09-29 15:44:30', NULL, 'Always On'),
(303, 8, 40, '985116833193553930', '2025-09-29 15:44:32', NULL, 'Call of Duty: Warzone'),
(304, 9, 50, '985116833193553930', '2025-09-29 15:44:33', '2025-10-01 06:27:37', 'Fortnite'),
(305, 10, 54, '985116833193553930', '2025-09-29 15:44:34', '2025-10-01 02:13:48', 'NBA 2K26'),
(306, 11, 63, '985116833193553930', '2025-09-29 15:44:34', '2025-10-01 05:58:52', '7 Days to Die'),
(307, 12, 66, '985116833193553930', '2025-09-29 15:44:35', NULL, 'Genshin Impact'),
(308, 13, 69, '985116833193553930', '2025-09-29 15:44:35', '2025-10-01 05:58:52', 'skate.'),
(309, 14, 80, '985116833193553930', '2025-09-29 15:44:36', '2025-10-01 07:09:49', 'Call of Duty: Warzone'),
(310, 15, 81, '985116833193553930', '2025-09-29 15:44:38', NULL, 'Mount & Blade II: Bannerlord'),
(311, 16, 69, '985116833193553930', '2025-09-29 15:44:39', '2025-10-01 02:40:56', 'skate.'),
(312, 17, 89, '985116833193553930', '2025-09-29 15:44:41', '2025-10-01 05:15:49', 'Just Chatting'),
(313, 18, 100, '985116833193553930', '2025-09-29 15:44:42', '2025-10-01 07:09:49', 'Music'),
(314, 19, 103, '985116833193553930', '2025-09-29 15:44:43', '2025-10-01 05:15:49', 'Fortnite'),
(315, 1, 7, '985116833193553930', '2025-09-29 22:02:30', NULL, 'Art'),
(316, 1, 9, '985116833193553930', '2025-09-29 22:02:31', NULL, 'ASMR'),
(317, 2, 12, '985116833193553930', '2025-09-29 22:02:32', '2025-10-01 04:57:12', 'Just Chatting'),
(318, 3, 16, '985116833193553930', '2025-09-29 22:02:32', NULL, 'DJs'),
(319, 4, 19, '985116833193553930', '2025-09-29 22:02:34', NULL, 'Just Chatting'),
(320, 5, 20, '985116833193553930', '2025-09-29 22:02:34', NULL, 'Always On'),
(321, 6, 21, '985116833193553930', '2025-09-29 22:02:35', '2025-10-01 04:10:53', 'Just Chatting'),
(322, 7, 24, '985116833193553930', '2025-09-29 22:02:36', NULL, 'Just Chatting'),
(323, 8, 30, '985116833193553930', '2025-09-29 22:02:37', NULL, 'Always On'),
(324, 9, 31, '985116833193553930', '2025-09-29 22:02:38', '2025-10-01 06:27:37', 'RuneScape'),
(325, 10, 46, '985116833193553930', '2025-09-29 22:02:39', '2025-10-01 02:13:48', 'MindsEye'),
(326, 11, 50, '985116833193553930', '2025-09-29 22:02:39', '2025-10-01 05:58:52', 'Fortnite'),
(327, 12, 53, '985116833193553930', '2025-09-29 22:02:40', NULL, 'Call of Duty: Black Ops II'),
(328, 13, 54, '985116833193553930', '2025-09-29 22:02:41', '2025-10-01 05:58:52', 'NBA 2K26'),
(329, 14, 63, '985116833193553930', '2025-09-29 22:02:41', '2025-10-01 07:09:49', '7 Days to Die'),
(330, 15, 66, '985116833193553930', '2025-09-29 22:02:42', NULL, 'Genshin Impact'),
(331, 16, 69, '985116833193553930', '2025-09-29 22:02:42', '2025-10-01 02:40:56', 'Talk Shows & Podcasts'),
(332, 17, 81, '985116833193553930', '2025-09-29 22:02:43', '2025-10-01 05:15:49', 'Project Zomboid'),
(333, 18, 86, '985116833193553930', '2025-09-29 22:02:46', '2025-10-01 07:09:49', 'Mistfall Hunter'),
(334, 19, 69, '985116833193553930', '2025-09-29 22:02:47', '2025-10-01 05:15:49', 'Talk Shows & Podcasts'),
(335, 20, 86, '985116833193553930', '2025-09-29 22:02:48', NULL, 'Mistfall Hunter'),
(336, 21, 100, '985116833193553930', '2025-09-29 22:02:49', '2025-10-01 05:09:33', 'Music'),
(337, 22, 102, '985116833193553930', '2025-09-29 22:02:49', NULL, 'Mortal Kombat 1'),
(338, 23, 103, '985116833193553930', '2025-09-29 22:02:51', '2025-10-01 02:37:53', 'Fortnite'),
(339, 24, 7, '985116833193553930', '2025-09-29 22:02:52', '2025-10-01 04:10:53', 'Art'),
(340, 25, 66, '985116833193553930', '2025-09-29 22:03:00', '2025-10-01 02:13:48', 'Genshin Impact'),
(341, 26, 69, '985116833193553930', '2025-09-29 22:03:02', NULL, 'Talk Shows & Podcasts'),
(342, 27, 81, '985116833193553930', '2025-09-29 22:03:02', NULL, 'Project Zomboid'),
(343, 28, 86, '985116833193553930', '2025-09-29 22:03:03', NULL, 'Mistfall Hunter'),
(344, 29, 69, '985116833193553930', '2025-09-29 22:03:03', NULL, 'Talk Shows & Podcasts'),
(345, 30, 86, '985116833193553930', '2025-09-29 22:03:04', NULL, 'Mistfall Hunter'),
(346, 31, 100, '985116833193553930', '2025-09-29 22:03:05', NULL, 'Music'),
(347, 32, 102, '985116833193553930', '2025-09-29 22:03:05', NULL, 'Mortal Kombat 1'),
(348, 33, 103, '985116833193553930', '2025-09-29 22:03:06', NULL, 'Fortnite'),
(349, 1, 7, '985116833193553930', '2025-09-29 22:30:55', NULL, 'Art'),
(350, 2, 9, '985116833193553930', '2025-09-29 22:30:56', '2025-10-01 04:57:12', 'ASMR'),
(351, 3, 12, '985116833193553930', '2025-09-29 22:30:57', NULL, 'Just Chatting'),
(352, 4, 16, '985116833193553930', '2025-09-29 22:30:57', NULL, 'DJs'),
(353, 5, 19, '985116833193553930', '2025-09-29 22:30:58', NULL, 'Just Chatting'),
(354, 6, 20, '985116833193553930', '2025-09-29 22:30:59', '2025-10-01 04:10:53', 'Always On'),
(355, 7, 21, '985116833193553930', '2025-09-29 22:30:59', NULL, 'Just Chatting'),
(356, 8, 24, '985116833193553930', '2025-09-29 22:31:00', NULL, 'Just Chatting'),
(357, 9, 30, '985116833193553930', '2025-09-29 22:31:01', '2025-10-01 06:27:37', 'Always On'),
(358, 10, 31, '985116833193553930', '2025-09-29 22:31:01', '2025-10-01 02:13:48', 'RuneScape'),
(359, 11, 46, '985116833193553930', '2025-09-29 22:31:02', '2025-10-01 05:58:52', 'MindsEye'),
(360, 12, 50, '985116833193553930', '2025-09-29 22:31:03', NULL, 'Fortnite'),
(361, 13, 53, '985116833193553930', '2025-09-29 22:31:04', '2025-10-01 05:58:52', 'Call of Duty: Black Ops II'),
(362, 14, 54, '985116833193553930', '2025-09-29 22:31:05', '2025-10-01 07:09:49', 'NBA 2K26'),
(363, 15, 63, '985116833193553930', '2025-09-29 22:31:06', NULL, '7 Days to Die'),
(364, 16, 66, '985116833193553930', '2025-09-29 22:31:06', '2025-10-01 02:40:56', 'Genshin Impact'),
(365, 17, 69, '985116833193553930', '2025-09-29 22:31:07', '2025-10-01 05:15:49', 'Talk Shows & Podcasts'),
(366, 18, 81, '985116833193553930', '2025-09-29 22:31:08', '2025-10-01 07:09:49', 'Project Zomboid'),
(367, 19, 86, '985116833193553930', '2025-09-29 22:31:09', '2025-10-01 05:15:49', 'Mistfall Hunter'),
(368, 20, 69, '985116833193553930', '2025-09-29 22:31:10', NULL, 'Talk Shows & Podcasts'),
(369, 21, 86, '985116833193553930', '2025-09-29 22:31:10', '2025-10-01 05:09:33', 'Mistfall Hunter'),
(370, 22, 100, '985116833193553930', '2025-09-29 22:31:11', NULL, 'Music'),
(371, 23, 102, '985116833193553930', '2025-09-29 22:31:12', '2025-10-01 02:37:53', 'Mortal Kombat 1'),
(372, 24, 103, '985116833193553930', '2025-09-29 22:31:12', '2025-10-01 04:10:53', 'Fortnite'),
(373, 25, 69, '985116833193553930', '2025-09-29 22:31:23', '2025-10-01 02:13:48', 'Talk Shows & Podcasts'),
(374, 26, 81, '985116833193553930', '2025-09-29 22:31:23', NULL, 'Project Zomboid'),
(375, 27, 86, '985116833193553930', '2025-09-29 22:31:24', NULL, 'Mistfall Hunter'),
(376, 28, 69, '985116833193553930', '2025-09-29 22:31:25', NULL, 'Talk Shows & Podcasts'),
(377, 29, 86, '985116833193553930', '2025-09-29 22:31:25', NULL, 'Mistfall Hunter'),
(378, 30, 100, '985116833193553930', '2025-09-29 22:31:26', NULL, 'Call of Duty: Warzone'),
(379, 31, 102, '985116833193553930', '2025-09-29 22:31:27', NULL, 'skate.'),
(380, 32, 103, '985116833193553930', '2025-09-29 22:31:28', NULL, 'Fortnite'),
(381, 1, 7, '985116833193553930', '2025-09-30 08:48:09', NULL, 'Art'),
(382, 1, 9, '985116833193553930', '2025-09-30 08:48:10', NULL, 'ASMR'),
(383, 2, 12, '985116833193553930', '2025-09-30 08:48:11', '2025-10-01 04:57:12', 'Just Chatting'),
(384, 3, 19, '985116833193553930', '2025-09-30 08:48:11', NULL, 'Just Chatting'),
(385, 4, 20, '985116833193553930', '2025-09-30 08:48:12', NULL, 'Always On'),
(386, 5, 21, '985116833193553930', '2025-09-30 08:48:12', NULL, 'Just Chatting'),
(387, 6, 24, '985116833193553930', '2025-09-30 08:48:13', '2025-10-01 04:10:53', 'Just Chatting'),
(388, 7, 30, '985116833193553930', '2025-09-30 08:48:14', NULL, 'Always On'),
(389, 8, 31, '985116833193553930', '2025-09-30 08:48:14', NULL, 'RuneScape'),
(390, 9, 46, '985116833193553930', '2025-09-30 08:48:15', '2025-10-01 06:27:37', 'MindsEye'),
(391, 10, 50, '985116833193553930', '2025-09-30 08:48:16', '2025-10-01 02:13:48', 'Fortnite'),
(392, 11, 53, '985116833193553930', '2025-09-30 08:48:16', '2025-10-01 05:58:52', 'Call of Duty: Black Ops II'),
(393, 12, 54, '985116833193553930', '2025-09-30 08:48:17', NULL, 'NBA 2K26'),
(394, 13, 63, '985116833193553930', '2025-09-30 08:48:17', '2025-10-01 05:58:52', '7 Days to Die'),
(395, 14, 69, '985116833193553930', '2025-09-30 08:48:18', '2025-10-01 07:09:49', 'Talk Shows & Podcasts'),
(396, 15, 81, '985116833193553930', '2025-09-30 08:48:18', NULL, 'Project Zomboid'),
(397, 16, 86, '985116833193553930', '2025-09-30 08:48:19', '2025-10-01 02:40:56', 'Mistfall Hunter'),
(398, 17, 69, '985116833193553930', '2025-09-30 08:48:20', '2025-10-01 05:15:49', 'Talk Shows & Podcasts'),
(399, 18, 86, '985116833193553930', '2025-09-30 08:48:21', '2025-10-01 07:09:49', 'Mistfall Hunter'),
(400, 19, 100, '985116833193553930', '2025-09-30 08:48:21', '2025-10-01 05:15:49', 'Call of Duty: Warzone'),
(401, 20, 102, '985116833193553930', '2025-09-30 08:48:22', NULL, 'skate.'),
(402, 21, 103, '985116833193553930', '2025-09-30 08:48:23', '2025-10-01 05:09:33', 'Fortnite'),
(403, 22, 34, '985116833193553930', '2025-09-30 08:48:23', NULL, 'Call of Duty'),
(404, 23, 41, '985116833193553930', '2025-09-30 08:48:24', '2025-10-01 02:37:53', 'Dead by Daylight'),
(405, 24, 52, '985116833193553930', '2025-09-30 08:48:25', '2025-10-01 04:10:53', 'Temtem'),
(406, 25, 130, '985116833193553930', '2025-09-30 08:48:26', '2025-10-01 02:13:48', 'Skate.'),
(407, 26, 7, '985116833193553930', '2025-09-30 08:48:32', NULL, 'Art'),
(408, 27, 41, '985116833193553930', '2025-09-30 08:48:34', NULL, 'Dead by Daylight'),
(409, 28, 52, '985116833193553930', '2025-09-30 08:48:35', NULL, 'Temtem'),
(410, 29, 81, '985116833193553930', '2025-09-30 08:48:37', NULL, 'Project Zomboid'),
(411, 30, 100, '985116833193553930', '2025-09-30 08:48:37', NULL, 'Call of Duty: Warzone'),
(412, 31, 103, '985116833193553930', '2025-09-30 08:48:38', NULL, 'Fortnite'),
(413, 32, 130, '985116833193553930', '2025-09-30 08:48:39', NULL, 'Skate.'),
(414, 1, 7, '985116833193553930', '2025-09-30 09:43:33', NULL, 'Art'),
(415, 2, 9, '985116833193553930', '2025-09-30 09:43:34', '2025-10-01 04:57:12', 'Just Chatting'),
(416, 3, 20, '985116833193553930', '2025-09-30 09:43:35', NULL, 'Always On'),
(417, 4, 21, '985116833193553930', '2025-09-30 09:43:36', NULL, 'Just Chatting'),
(418, 5, 24, '985116833193553930', '2025-09-30 09:43:37', NULL, 'Just Chatting'),
(419, 6, 30, '985116833193553930', '2025-09-30 09:43:37', '2025-10-01 04:10:53', 'Always On'),
(420, 7, 31, '985116833193553930', '2025-09-30 09:43:38', NULL, 'RuneScape'),
(421, 8, 50, '985116833193553930', '2025-09-30 09:43:39', NULL, 'Fortnite'),
(422, 9, 52, '985116833193553930', '2025-09-30 09:43:39', '2025-10-01 06:27:37', 'Temtem'),
(423, 10, 53, '985116833193553930', '2025-09-30 09:43:40', '2025-10-01 02:13:48', 'Call of Duty: Black Ops II'),
(424, 11, 54, '985116833193553930', '2025-09-30 09:43:40', '2025-10-01 05:58:52', 'NBA 2K26'),
(425, 12, 81, '985116833193553930', '2025-09-30 09:43:41', NULL, 'Project Zomboid'),
(426, 13, 100, '985116833193553930', '2025-09-30 09:43:41', '2025-10-01 05:58:52', 'Call of Duty: Warzone'),
(427, 14, 103, '985116833193553930', '2025-09-30 09:43:42', '2025-10-01 07:09:49', 'Fortnite'),
(428, 15, 130, '985116833193553930', '2025-09-30 09:43:43', NULL, 'Just Chatting'),
(429, 1, 69, '985116833193553930', '2025-09-30 12:35:46', NULL, 'skate.'),
(430, 2, 69, '985116833193553930', '2025-09-30 12:35:48', '2025-10-01 04:57:12', 'skate.'),
(431, 1, 12, '985116833193553930', '2025-09-30 12:54:46', NULL, 'Call of Duty'),
(432, 2, 69, '985116833193553930', '2025-09-30 12:54:47', '2025-10-01 04:57:12', 'skate.'),
(433, 3, 69, '985116833193553930', '2025-09-30 12:54:47', NULL, 'skate.'),
(434, 1, 12, '985116833193553930', '2025-09-30 12:58:21', NULL, 'Call of Duty'),
(435, 2, 69, '985116833193553930', '2025-09-30 12:58:21', '2025-10-01 04:57:12', 'skate.'),
(436, 3, 69, '985116833193553930', '2025-09-30 12:58:22', NULL, 'skate.'),
(437, 1, 12, '985116833193553930', '2025-09-30 13:08:32', NULL, 'Call of Duty'),
(438, 2, 69, '985116833193553930', '2025-09-30 13:08:32', '2025-10-01 04:57:12', 'skate.'),
(439, 3, 69, '985116833193553930', '2025-09-30 13:08:34', NULL, 'skate.'),
(440, 1, 12, '985116833193553930', '2025-09-30 13:14:31', NULL, 'Call of Duty'),
(441, 2, 69, '985116833193553930', '2025-09-30 13:14:32', '2025-10-01 04:57:12', 'skate.'),
(442, 3, 69, '985116833193553930', '2025-09-30 13:14:33', NULL, 'skate.'),
(443, 1, 12, '985116833193553930', '2025-09-30 13:30:02', NULL, 'Call of Duty'),
(444, 2, 47, '985116833193553930', '2025-09-30 13:30:04', '2025-10-01 04:57:12', 'NHL 26'),
(445, 3, 69, '985116833193553930', '2025-09-30 13:30:06', NULL, 'skate.'),
(446, 4, 69, '985116833193553930', '2025-09-30 13:30:07', NULL, 'skate.'),
(447, 1, 12, '985116833193553930', '2025-09-30 13:42:24', NULL, 'Call of Duty'),
(448, 2, 47, '985116833193553930', '2025-09-30 13:42:25', '2025-10-01 04:57:12', 'NHL 26'),
(449, 3, 63, '985116833193553930', '2025-09-30 13:42:26', NULL, '7 Days to Die'),
(450, 4, 69, '985116833193553930', '2025-09-30 13:42:26', NULL, 'skate.'),
(451, 5, 69, '985116833193553930', '2025-09-30 13:42:27', NULL, 'skate.'),
(452, 1, 12, '985116833193553930', '2025-09-30 13:45:34', NULL, 'Call of Duty'),
(453, 2, 47, '985116833193553930', '2025-09-30 13:45:35', '2025-10-01 04:57:12', 'NHL 26'),
(454, 3, 63, '985116833193553930', '2025-09-30 13:45:36', NULL, '7 Days to Die'),
(455, 4, 69, '985116833193553930', '2025-09-30 13:45:36', NULL, 'skate.'),
(456, 5, 69, '985116833193553930', '2025-09-30 13:45:37', NULL, 'skate.'),
(457, 1, 12, '985116833193553930', '2025-09-30 13:49:29', NULL, 'Call of Duty'),
(458, 2, 47, '985116833193553930', '2025-09-30 13:49:30', '2025-10-01 04:57:12', 'NHL 26'),
(459, 3, 63, '985116833193553930', '2025-09-30 13:49:31', NULL, '7 Days to Die'),
(460, 4, 69, '985116833193553930', '2025-09-30 13:49:31', NULL, 'skate.'),
(461, 5, 69, '985116833193553930', '2025-09-30 13:49:32', NULL, 'skate.'),
(462, 1, 12, '985116833193553930', '2025-09-30 13:58:47', NULL, 'Call of Duty'),
(463, 2, 47, '985116833193553930', '2025-09-30 13:58:48', '2025-10-01 04:57:12', 'NHL 26'),
(464, 3, 63, '985116833193553930', '2025-09-30 13:58:49', NULL, '7 Days to Die'),
(465, 4, 69, '985116833193553930', '2025-09-30 13:58:49', NULL, 'skate.'),
(466, 5, 69, '985116833193553930', '2025-09-30 13:58:50', NULL, 'skate.'),
(467, 1, 12, '985116833193553930', '2025-09-30 14:02:52', NULL, 'Call of Duty'),
(468, 2, 47, '985116833193553930', '2025-09-30 14:02:53', '2025-10-01 04:57:12', 'NHL 26'),
(469, 3, 63, '985116833193553930', '2025-09-30 14:02:54', NULL, '7 Days to Die'),
(470, 4, 69, '985116833193553930', '2025-09-30 14:02:54', NULL, 'skate.'),
(471, 5, 69, '985116833193553930', '2025-09-30 14:02:55', NULL, 'skate.'),
(472, 1, 12, '985116833193553930', '2025-09-30 14:15:11', NULL, 'Call of Duty'),
(473, 2, 47, '985116833193553930', '2025-09-30 14:15:12', '2025-10-01 04:57:12', 'NHL 26'),
(474, 3, 63, '985116833193553930', '2025-09-30 14:15:12', NULL, '7 Days to Die'),
(475, 4, 69, '985116833193553930', '2025-09-30 14:15:13', NULL, 'skate.'),
(476, 5, 69, '985116833193553930', '2025-09-30 14:15:13', NULL, 'skate.'),
(477, 1, 12, '985116833193553930', '2025-09-30 14:22:22', NULL, 'Call of Duty'),
(478, 2, 47, '985116833193553930', '2025-09-30 14:22:22', '2025-10-01 04:57:12', 'NHL 26'),
(479, 3, 63, '985116833193553930', '2025-09-30 14:22:23', NULL, '7 Days to Die'),
(480, 4, 69, '985116833193553930', '2025-09-30 14:22:23', NULL, 'skate.'),
(481, 5, 69, '985116833193553930', '2025-09-30 14:22:24', NULL, 'skate.'),
(482, 1, 12, '985116833193553930', '2025-09-30 14:30:47', NULL, 'Call of Duty'),
(483, 2, 47, '985116833193553930', '2025-09-30 14:30:47', '2025-10-01 04:57:12', 'NHL 26'),
(484, 3, 63, '985116833193553930', '2025-09-30 14:30:48', NULL, '7 Days to Die'),
(485, 4, 67, '985116833193553930', '2025-09-30 14:30:49', NULL, 'Just Chatting'),
(486, 5, 69, '985116833193553930', '2025-09-30 14:30:50', NULL, 'skate.'),
(487, 6, 69, '985116833193553930', '2025-09-30 14:30:50', '2025-10-01 04:10:53', 'skate.'),
(488, 7, 67, '985116833193553930', '2025-09-30 14:30:51', NULL, 'Just Chatting'),
(489, 1, 12, '985116833193553930', '2025-09-30 14:43:22', NULL, 'Call of Duty'),
(490, 2, 47, '985116833193553930', '2025-09-30 14:43:22', '2025-10-01 04:57:12', 'NHL 26'),
(491, 3, 63, '985116833193553930', '2025-09-30 14:43:23', NULL, '7 Days to Die'),
(492, 4, 67, '985116833193553930', '2025-09-30 14:43:24', NULL, 'Just Chatting'),
(493, 5, 69, '985116833193553930', '2025-09-30 14:43:24', NULL, 'skate.'),
(494, 6, 69, '985116833193553930', '2025-09-30 14:43:25', '2025-10-01 04:10:53', 'skate.'),
(495, 7, 67, '985116833193553930', '2025-09-30 14:43:26', NULL, 'Just Chatting'),
(496, 1, 12, '985116833193553930', '2025-09-30 14:52:50', NULL, 'Call of Duty'),
(497, 2, 47, '985116833193553930', '2025-09-30 14:52:50', '2025-10-01 04:57:12', 'NHL 26'),
(498, 3, 63, '985116833193553930', '2025-09-30 14:52:51', NULL, '7 Days to Die'),
(499, 4, 67, '985116833193553930', '2025-09-30 14:52:51', NULL, 'Just Chatting'),
(500, 5, 69, '985116833193553930', '2025-09-30 14:52:53', NULL, 'skate.'),
(501, 6, 69, '985116833193553930', '2025-09-30 14:52:53', '2025-10-01 04:10:53', 'skate.'),
(502, 7, 67, '985116833193553930', '2025-09-30 14:52:54', NULL, 'Just Chatting'),
(503, 1, 12, '985116833193553930', '2025-09-30 14:58:08', NULL, 'Call of Duty'),
(504, 2, 43, '985116833193553930', '2025-09-30 14:58:08', '2025-10-01 04:57:12', 'Just Chatting'),
(505, 3, 47, '985116833193553930', '2025-09-30 14:58:09', NULL, 'NHL 26'),
(506, 4, 63, '985116833193553930', '2025-09-30 14:58:09', NULL, '7 Days to Die'),
(507, 5, 67, '985116833193553930', '2025-09-30 14:58:10', NULL, 'Just Chatting'),
(508, 6, 69, '985116833193553930', '2025-09-30 14:58:11', '2025-10-01 04:10:53', 'skate.'),
(509, 7, 69, '985116833193553930', '2025-09-30 14:58:11', NULL, 'skate.'),
(510, 8, 67, '985116833193553930', '2025-09-30 14:58:12', NULL, 'Just Chatting'),
(511, 1, 12, '985116833193553930', '2025-09-30 15:36:54', NULL, 'Just Chatting'),
(512, 2, 43, '985116833193553930', '2025-09-30 15:36:55', '2025-10-01 04:57:12', 'Just Chatting'),
(513, 3, 47, '985116833193553930', '2025-09-30 15:36:55', NULL, 'NHL 26'),
(514, 4, 63, '985116833193553930', '2025-09-30 15:36:56', NULL, '7 Days to Die'),
(515, 5, 67, '985116833193553930', '2025-09-30 15:36:56', NULL, 'Marvel Rivals'),
(516, 6, 69, '985116833193553930', '2025-09-30 15:36:57', '2025-10-01 04:10:53', 'skate.'),
(517, 7, 69, '985116833193553930', '2025-09-30 15:36:58', NULL, 'skate.'),
(518, 8, 89, '985116833193553930', '2025-09-30 15:36:59', NULL, 'Just Chatting'),
(519, 9, 67, '985116833193553930', '2025-09-30 15:36:59', '2025-10-01 06:27:37', 'Marvel Rivals'),
(520, 1, 12, '985116833193553930', '2025-09-30 15:43:50', NULL, 'Just Chatting'),
(521, 2, 43, '985116833193553930', '2025-09-30 15:43:51', '2025-10-01 04:57:12', 'Just Chatting'),
(522, 3, 47, '985116833193553930', '2025-09-30 15:43:51', NULL, 'NHL 26'),
(523, 4, 63, '985116833193553930', '2025-09-30 15:43:52', NULL, '7 Days to Die'),
(524, 5, 67, '985116833193553930', '2025-09-30 15:43:52', NULL, 'Marvel Rivals'),
(525, 6, 69, '985116833193553930', '2025-09-30 15:43:53', '2025-10-01 04:10:53', 'skate.'),
(526, 7, 69, '985116833193553930', '2025-09-30 15:43:56', NULL, 'skate.'),
(527, 8, 89, '985116833193553930', '2025-09-30 15:43:56', NULL, 'Just Chatting'),
(528, 9, 67, '985116833193553930', '2025-09-30 15:43:57', '2025-10-01 06:27:37', 'Marvel Rivals'),
(529, 1, 12, '985116833193553930', '2025-09-30 15:59:05', NULL, 'Just Chatting'),
(530, 2, 43, '985116833193553930', '2025-09-30 15:59:07', '2025-10-01 04:57:12', 'Just Chatting'),
(531, 3, 47, '985116833193553930', '2025-09-30 15:59:08', NULL, 'NHL 26'),
(532, 4, 63, '985116833193553930', '2025-09-30 15:59:09', NULL, '7 Days to Die'),
(533, 5, 67, '985116833193553930', '2025-09-30 15:59:09', NULL, 'Marvel Rivals'),
(534, 6, 69, '985116833193553930', '2025-09-30 15:59:10', '2025-10-01 04:10:53', 'Talk Shows & Podcasts'),
(535, 7, 69, '985116833193553930', '2025-09-30 15:59:11', NULL, 'Talk Shows & Podcasts'),
(536, 8, 89, '985116833193553930', '2025-09-30 15:59:11', NULL, 'The Legend of Zelda: Ocarina of Time'),
(537, 9, 67, '985116833193553930', '2025-09-30 15:59:12', '2025-10-01 06:27:37', 'Marvel Rivals'),
(538, 86, 9, '985116833193553930', '2025-10-01 04:10:54', NULL, 'Just Chatting'),
(539, 87, 37, '985116833193553930', '2025-10-01 04:10:55', '2025-10-01 07:12:37', 'Beyond: Two Souls'),
(540, 88, 130, '985116833193553930', '2025-10-01 04:14:15', '2025-10-01 05:28:17', 'Fortnite'),
(541, 89, 1613, '985116833193553930', '2025-10-01 04:38:46', '2025-10-01 05:28:17', 'Schedule I'),
(542, 90, 41, '985116833193553930', '2025-10-01 05:15:49', NULL, 'Dead by Daylight'),
(543, 91, 104, '985116833193553930', '2025-10-01 05:15:51', '2025-10-01 05:28:17', 'Just Chatting'),
(544, 92, 105, '985116833193553930', '2025-10-01 05:15:53', '2025-10-01 05:28:17', 'Megabonk'),
(545, 93, 143, '985116833193553930', '2025-10-01 05:15:54', '2025-10-01 05:28:17', 'Just Chatting'),
(546, 94, 122, '985116833193553930', '2025-10-01 05:15:54', '2025-10-01 05:28:17', 'Arena Breakout: Infinite'),
(547, 95, 92, '985116833193553930', '2025-10-01 05:31:33', '2025-10-01 05:58:52', 'PERSONA3 RELOAD'),
(548, 96, 133, '985116833193553930', '2025-10-01 06:02:20', '2025-10-01 06:27:37', 'Skate.'),
(549, 97, 1613, '985116833193553930', '2025-10-01 06:02:22', '2025-10-01 06:27:37', 'Schedule I'),
(550, 98, 104, '985116833193553930', '2025-10-01 06:02:24', '2025-10-01 06:27:37', 'Just Chatting'),
(551, 99, 105, '985116833193553930', '2025-10-01 06:02:25', '2025-10-01 06:27:37', 'Megabonk'),
(552, 100, 143, '985116833193553930', '2025-10-01 06:02:25', '2025-10-01 06:27:37', 'Just Chatting'),
(553, 101, 39, '985116833193553930', '2025-10-01 06:18:49', NULL, 'Marvel\'s Spider-Man 2'),
(554, 102, 133, '985116833193553930', '2025-10-01 06:30:51', '2025-10-01 06:42:37', 'Skate.'),
(555, 103, 104, '985116833193553930', '2025-10-01 06:30:51', '2025-10-01 06:42:37', 'Just Chatting'),
(556, 104, 133, '985116833193553930', '2025-10-01 06:45:50', '2025-10-01 06:57:37', 'Skate.'),
(557, 105, 104, '985116833193553930', '2025-10-01 06:45:51', '2025-10-01 06:57:37', 'Just Chatting'),
(558, 106, 133, '985116833193553930', '2025-10-01 07:00:51', '2025-10-01 07:09:49', 'Skate.'),
(559, 107, 104, '985116833193553930', '2025-10-01 07:00:51', '2025-10-01 07:12:37', 'Just Chatting'),
(560, 108, 133, '985116833193553930', '2025-10-01 07:15:50', '2025-10-01 07:21:25', 'Skate.'),
(561, 109, 104, '985116833193553930', '2025-10-01 07:15:51', '2025-10-01 07:21:25', 'Just Chatting'),
(562, 110, 133, '985116833193553930', '2025-10-01 07:24:54', NULL, 'Skate.'),
(563, 111, 104, '985116833193553930', '2025-10-01 07:24:54', NULL, 'Just Chatting'),
(564, 112, 47, '985116833193553930', '2025-10-01 08:03:57', NULL, 'MLB The Show 25'),
(565, 113, 52, '985116833193553930', '2025-10-01 08:03:59', NULL, 'Temtem'),
(566, 114, 69, '985116833193553930', '2025-10-01 08:03:59', NULL, 'Talk Shows & Podcasts'),
(567, 115, 69, '985116833193553930', '2025-10-01 08:04:03', NULL, 'Talk Shows & Podcasts'),
(568, 116, 129, '985116833193553930', '2025-10-01 08:04:05', NULL, 'Arena Breakout: Infinite'),
(569, 117, 130, '985116833193553930', '2025-10-01 08:04:06', NULL, 'Call of Duty: Warzone'),
(570, 118, 105, '985116833193553930', '2025-10-01 08:04:10', NULL, 'Megabonk'),
(571, 119, 143, '985116833193553930', '2025-10-01 08:04:11', NULL, 'Just Chatting'),
(572, 120, 15, '985116833193553930', '2025-10-01 08:04:13', NULL, 'Just Chatting'),
(573, 121, 37, '985116833193553930', '2025-10-01 08:04:22', NULL, 'Beyond: Two Souls'),
(574, 122, 93, '985116833193553930', '2025-10-01 08:11:03', NULL, 'Apex Legends'),
(575, 123, 129, '985116833193553930', '2025-10-01 08:20:16', NULL, 'Arena Breakout: Infinite');
INSERT INTO `stream_sessions` (`session_id`, `announcement_id`, `streamer_id`, `guild_id`, `start_time`, `end_time`, `game_name`) VALUES
(576, 124, 130, '985116833193553930', '2025-10-01 08:20:16', NULL, 'Call of Duty: Warzone'),
(577, 125, 133, '985116833193553930', '2025-10-01 08:20:17', NULL, 'Other, Watch Party'),
(578, 126, 104, '985116833193553930', '2025-10-01 08:20:17', NULL, 'Just Chatting'),
(579, 127, 105, '985116833193553930', '2025-10-01 08:20:18', NULL, 'Megabonk'),
(580, 128, 143, '985116833193553930', '2025-10-01 08:20:19', NULL, 'Just Chatting'),
(581, 129, 102, '985116833193553930', '2025-10-01 08:26:14', NULL, 'Mortal Kombat 1'),
(582, 130, 129, '985116833193553930', '2025-10-01 08:34:05', NULL, 'Arena Breakout: Infinite'),
(583, 131, 130, '985116833193553930', '2025-10-01 08:34:05', NULL, 'Call of Duty: Warzone'),
(584, 132, 133, '985116833193553930', '2025-10-01 08:34:06', NULL, 'Other, Watch Party'),
(585, 133, 104, '985116833193553930', '2025-10-01 08:34:06', NULL, 'Just Chatting'),
(586, 134, 105, '985116833193553930', '2025-10-01 08:34:07', NULL, 'Megabonk'),
(587, 135, 143, '985116833193553930', '2025-10-01 08:34:07', NULL, 'Just Chatting'),
(588, 136, 123, '985116833193553930', '2025-10-01 08:34:08', NULL, 'Other, Watch Party'),
(589, 137, 30, '985116833193553930', '2025-10-01 08:51:23', NULL, 'Always On'),
(590, 138, 129, '985116833193553930', '2025-10-01 08:51:29', NULL, 'Arena Breakout: Infinite'),
(591, 139, 130, '985116833193553930', '2025-10-01 08:51:29', NULL, 'Call of Duty: Warzone'),
(592, 140, 133, '985116833193553930', '2025-10-01 08:51:30', NULL, 'Other, Watch Party'),
(593, 141, 104, '985116833193553930', '2025-10-01 08:51:30', NULL, 'Just Chatting'),
(594, 142, 105, '985116833193553930', '2025-10-01 08:51:31', NULL, 'Megabonk'),
(595, 143, 143, '985116833193553930', '2025-10-01 08:51:31', NULL, 'Just Chatting'),
(596, 144, 123, '985116833193553930', '2025-10-01 08:51:32', NULL, 'Other, Watch Party'),
(597, 145, 129, '985116833193553930', '2025-10-01 09:15:40', NULL, 'Arena Breakout: Infinite'),
(598, 146, 130, '985116833193553930', '2025-10-01 09:15:40', NULL, 'Grand Theft Auto V (GTA)'),
(599, 147, 133, '985116833193553930', '2025-10-01 09:15:41', NULL, 'Other, Watch Party'),
(600, 148, 104, '985116833193553930', '2025-10-01 09:15:42', NULL, 'Just Chatting'),
(601, 149, 105, '985116833193553930', '2025-10-01 09:15:43', NULL, 'Dark and Darker'),
(602, 150, 143, '985116833193553930', '2025-10-01 09:15:43', NULL, 'Just Chatting'),
(603, 151, 123, '985116833193553930', '2025-10-01 09:15:44', NULL, 'Other, Watch Party'),
(604, 152, 30, '985116833193553930', '2025-10-01 09:18:33', NULL, 'Always On'),
(605, 153, 129, '985116833193553930', '2025-10-01 09:30:41', NULL, 'Arena Breakout: Infinite'),
(606, 154, 130, '985116833193553930', '2025-10-01 09:30:41', NULL, 'Grand Theft Auto V (GTA)'),
(607, 155, 133, '985116833193553930', '2025-10-01 09:30:42', NULL, 'Skate.'),
(608, 156, 104, '985116833193553930', '2025-10-01 09:30:42', NULL, 'Just Chatting'),
(609, 157, 105, '985116833193553930', '2025-10-01 09:30:43', NULL, 'Dark and Darker'),
(610, 158, 143, '985116833193553930', '2025-10-01 09:30:44', NULL, 'Just Chatting'),
(611, 159, 123, '985116833193553930', '2025-10-01 09:30:45', NULL, 'Other, Watch Party'),
(612, 160, 102, '985116833193553930', '2025-10-01 09:33:39', NULL, 'Mortal Kombat 1'),
(613, 161, 129, '985116833193553930', '2025-10-01 09:46:23', NULL, 'Arena Breakout: Infinite'),
(614, 162, 130, '985116833193553930', '2025-10-01 09:46:24', NULL, 'Just Chatting'),
(615, 163, 133, '985116833193553930', '2025-10-01 09:46:24', NULL, 'Skate.'),
(616, 164, 104, '985116833193553930', '2025-10-01 09:46:25', NULL, 'Just Chatting'),
(617, 165, 105, '985116833193553930', '2025-10-01 09:46:26', NULL, 'Dark and Darker'),
(618, 166, 143, '985116833193553930', '2025-10-01 09:46:26', NULL, 'Just Chatting'),
(619, 167, 123, '985116833193553930', '2025-10-01 09:46:27', NULL, 'Other, Watch Party'),
(620, 168, 129, '985116833193553930', '2025-10-01 10:01:53', NULL, 'Arena Breakout: Infinite'),
(621, 169, 130, '985116833193553930', '2025-10-01 10:01:53', NULL, 'Counter-Strike 2'),
(622, 170, 133, '985116833193553930', '2025-10-01 10:01:54', NULL, 'Skate.'),
(623, 171, 104, '985116833193553930', '2025-10-01 10:01:55', NULL, 'Just Chatting'),
(624, 172, 105, '985116833193553930', '2025-10-01 10:01:55', NULL, 'Dark and Darker'),
(625, 173, 143, '985116833193553930', '2025-10-01 10:01:56', NULL, 'Just Chatting'),
(626, 174, 123, '985116833193553930', '2025-10-01 10:01:57', NULL, 'Other, Watch Party'),
(627, 175, 129, '985116833193553930', '2025-10-01 10:16:12', NULL, 'Arena Breakout: Infinite'),
(628, 176, 130, '985116833193553930', '2025-10-01 10:16:12', NULL, 'Counter-Strike 2'),
(629, 177, 133, '985116833193553930', '2025-10-01 10:16:13', NULL, 'Skate.'),
(630, 178, 104, '985116833193553930', '2025-10-01 10:16:14', NULL, 'Just Chatting'),
(631, 179, 105, '985116833193553930', '2025-10-01 10:16:15', NULL, 'Dark and Darker'),
(632, 180, 143, '985116833193553930', '2025-10-01 10:16:16', NULL, 'Just Chatting'),
(633, 181, 123, '985116833193553930', '2025-10-01 10:16:16', NULL, 'Other, Watch Party'),
(634, 182, 129, '985116833193553930', '2025-10-01 10:30:26', NULL, 'Arena Breakout: Infinite'),
(635, 183, 130, '985116833193553930', '2025-10-01 10:30:27', NULL, 'Counter-Strike 2'),
(636, 184, 104, '985116833193553930', '2025-10-01 10:30:28', NULL, 'Just Chatting'),
(637, 185, 105, '985116833193553930', '2025-10-01 10:30:29', NULL, 'Dark and Darker'),
(638, 186, 143, '985116833193553930', '2025-10-01 10:30:30', NULL, 'Just Chatting'),
(639, 187, 123, '985116833193553930', '2025-10-01 10:30:31', NULL, 'Other, Watch Party'),
(640, 188, 117, '985116833193553930', '2025-10-01 10:33:58', NULL, 'Megabonk'),
(641, 189, 123, '985116833193553930', '2025-10-01 10:43:52', NULL, 'Other, Watch Party'),
(642, 190, 143, '985116833193553930', '2025-10-01 10:43:53', NULL, 'Just Chatting'),
(643, 191, 130, '985116833193553930', '2025-10-01 10:58:47', NULL, 'Counter-Strike 2'),
(644, 192, 104, '985116833193553930', '2025-10-01 10:58:48', NULL, 'Just Chatting'),
(645, 193, 105, '985116833193553930', '2025-10-01 10:58:48', NULL, 'Dark and Darker'),
(646, 194, 143, '985116833193553930', '2025-10-01 10:58:49', NULL, 'Just Chatting'),
(647, 195, 117, '985116833193553930', '2025-10-01 10:58:50', NULL, 'Megabonk'),
(648, 196, 123, '985116833193553930', '2025-10-01 10:58:51', NULL, 'Other, Watch Party'),
(649, 197, 143, '985116833193553930', '2025-10-01 10:58:52', NULL, 'Just Chatting'),
(650, 198, 130, '985116833193553930', '2025-10-01 11:13:48', NULL, 'Counter-Strike 2'),
(651, 199, 104, '985116833193553930', '2025-10-01 11:13:49', NULL, 'Just Chatting'),
(652, 200, 105, '985116833193553930', '2025-10-01 11:13:50', NULL, 'Dark and Darker'),
(653, 201, 143, '985116833193553930', '2025-10-01 11:13:50', NULL, 'Just Chatting'),
(654, 202, 117, '985116833193553930', '2025-10-01 11:13:51', NULL, 'Megabonk'),
(655, 203, 123, '985116833193553930', '2025-10-01 11:13:51', NULL, 'Other, Watch Party'),
(656, 204, 143, '985116833193553930', '2025-10-01 11:13:52', NULL, 'Just Chatting'),
(657, 205, 30, '985116833193553930', '2025-10-01 11:22:42', NULL, 'Always On'),
(658, 206, 130, '985116833193553930', '2025-10-01 11:27:38', NULL, 'Counter-Strike 2'),
(659, 207, 104, '985116833193553930', '2025-10-01 11:27:39', NULL, 'Just Chatting'),
(660, 208, 105, '985116833193553930', '2025-10-01 11:27:40', NULL, 'Dark and Darker'),
(661, 209, 143, '985116833193553930', '2025-10-01 11:27:40', NULL, 'Just Chatting'),
(662, 210, 117, '985116833193553930', '2025-10-01 11:27:41', NULL, 'Megabonk'),
(663, 211, 123, '985116833193553930', '2025-10-01 11:27:43', NULL, 'Other, Watch Party'),
(664, 212, 143, '985116833193553930', '2025-10-01 11:27:44', NULL, 'Just Chatting'),
(665, 213, 30, '985116833193553930', '2025-10-01 11:47:34', NULL, 'Always On'),
(666, 214, 130, '985116833193553930', '2025-10-01 12:04:49', NULL, 'Counter-Strike 2'),
(667, 215, 104, '985116833193553930', '2025-10-01 12:04:50', NULL, 'Just Chatting'),
(668, 216, 105, '985116833193553930', '2025-10-01 12:04:51', NULL, 'Dark and Darker'),
(669, 217, 143, '985116833193553930', '2025-10-01 12:04:54', NULL, 'Just Chatting'),
(670, 218, 117, '985116833193553930', '2025-10-01 12:04:54', NULL, 'Dead By Daylight'),
(671, 219, 123, '985116833193553930', '2025-10-01 12:04:55', NULL, 'Other, Watch Party'),
(672, 220, 143, '985116833193553930', '2025-10-01 12:04:56', NULL, 'Just Chatting'),
(673, 221, 130, '985116833193553930', '2025-10-01 12:23:14', NULL, 'Counter-Strike 2'),
(674, 222, 104, '985116833193553930', '2025-10-01 12:23:14', NULL, 'Just Chatting'),
(675, 223, 105, '985116833193553930', '2025-10-01 12:23:15', NULL, 'Dark and Darker'),
(676, 224, 143, '985116833193553930', '2025-10-01 12:23:17', NULL, 'Just Chatting'),
(677, 225, 117, '985116833193553930', '2025-10-01 12:23:18', NULL, 'Dead By Daylight'),
(678, 226, 123, '985116833193553930', '2025-10-01 12:23:18', NULL, 'Other, Watch Party'),
(679, 227, 143, '985116833193553930', '2025-10-01 12:23:19', NULL, 'Just Chatting'),
(680, 228, 130, '985116833193553930', '2025-10-01 12:38:13', NULL, 'Counter-Strike 2'),
(681, 229, 104, '985116833193553930', '2025-10-01 12:38:15', NULL, 'Just Chatting'),
(682, 230, 143, '985116833193553930', '2025-10-01 12:38:16', NULL, 'Just Chatting'),
(683, 231, 117, '985116833193553930', '2025-10-01 12:38:16', NULL, 'Dead By Daylight'),
(684, 232, 123, '985116833193553930', '2025-10-01 12:38:17', NULL, 'Other, Watch Party'),
(685, 233, 143, '985116833193553930', '2025-10-01 12:38:17', NULL, 'Just Chatting'),
(686, 234, 66, '985116833193553930', '2025-10-01 13:08:08', NULL, 'Genshin Impact'),
(687, 235, 130, '985116833193553930', '2025-10-01 13:08:12', NULL, 'Counter-Strike 2'),
(688, 236, 104, '985116833193553930', '2025-10-01 13:08:13', NULL, 'Just Chatting'),
(689, 237, 143, '985116833193553930', '2025-10-01 13:08:13', NULL, 'Just Chatting'),
(690, 238, 117, '985116833193553930', '2025-10-01 13:08:14', NULL, 'Dead By Daylight'),
(691, 239, 123, '985116833193553930', '2025-10-01 13:08:15', NULL, 'Other, Watch Party'),
(692, 240, 143, '985116833193553930', '2025-10-01 13:08:16', NULL, 'Just Chatting'),
(693, 241, 109, '985116833193553930', '2025-10-01 13:08:17', NULL, 'Runescape'),
(694, 242, 121, '985116833193553930', '2025-10-01 13:08:18', NULL, 'Project Zomboid'),
(695, 243, 63, '985116833193553930', '2025-10-01 13:30:50', NULL, 'Games + Demos'),
(696, 244, 130, '985116833193553930', '2025-10-01 13:30:53', NULL, 'Counter-Strike 2'),
(697, 245, 117, '985116833193553930', '2025-10-01 13:30:55', NULL, 'Dead By Daylight'),
(698, 246, 109, '985116833193553930', '2025-10-01 13:30:56', NULL, 'Runescape'),
(699, 247, 143, '985116833193553930', '2025-10-01 13:36:29', NULL, 'Just Chatting'),
(700, 248, 143, '985116833193553930', '2025-10-01 13:36:29', NULL, 'Just Chatting'),
(701, 249, 104, '985116833193553930', '2025-10-01 13:36:54', NULL, 'Just Chatting'),
(702, 250, 123, '985116833193553930', '2025-10-01 13:36:56', NULL, 'Other, Watch Party'),
(703, 251, 100, '985116833193553930', '2025-10-01 13:44:57', NULL, 'Just Chatting'),
(704, 252, 130, '985116833193553930', '2025-10-01 13:45:08', NULL, 'Counter-Strike 2'),
(705, 253, 143, '985116833193553930', '2025-10-01 13:45:09', NULL, 'Just Chatting'),
(706, 254, 136, '985116833193553930', '2025-10-01 13:45:10', NULL, 'Just Chatting'),
(707, 255, 136, '985116833193553930', '2025-10-01 13:45:10', NULL, 'Just Chatting'),
(708, 256, 117, '985116833193553930', '2025-10-01 13:45:11', NULL, 'Dead By Daylight'),
(709, 257, 143, '985116833193553930', '2025-10-01 13:45:11', NULL, 'Just Chatting'),
(710, 258, 109, '985116833193553930', '2025-10-01 13:45:12', NULL, 'Runescape'),
(711, 259, 30, '985116833193553930', '2025-10-01 13:48:32', NULL, 'Always On'),
(712, 260, 67, '985116833193553930', '2025-10-01 13:48:36', NULL, 'Just Chatting'),
(713, 261, 67, '985116833193553930', '2025-10-01 13:48:39', NULL, 'Just Chatting'),
(714, 262, 123, '985116833193553930', '2025-10-01 13:54:29', NULL, 'Other, Watch Party'),
(715, 263, 121, '985116833193553930', '2025-10-01 13:54:31', NULL, 'Project Zomboid'),
(716, 264, 117, '985116833193553930', '2025-10-01 13:56:24', NULL, 'Dead By Daylight'),
(717, 265, 130, '985116833193553930', '2025-10-01 14:02:39', NULL, 'Counter-Strike 2'),
(718, 266, 104, '985116833193553930', '2025-10-01 14:02:40', NULL, 'Just Chatting'),
(719, 267, 109, '985116833193553930', '2025-10-01 14:02:41', NULL, 'Runescape'),
(720, 268, 143, '985116833193553930', '2025-10-01 14:07:02', NULL, 'Just Chatting'),
(721, 269, 143, '985116833193553930', '2025-10-01 14:07:03', NULL, 'Just Chatting'),
(722, 270, 121, '985116833193553930', '2025-10-01 14:07:04', NULL, 'Project Zomboid'),
(723, 271, 136, '985116833193553930', '2025-10-01 14:10:42', NULL, 'Call of Duty: Warzone'),
(724, 272, 136, '985116833193553930', '2025-10-01 14:10:43', NULL, 'Call of Duty: Warzone'),
(725, 273, 130, '985116833193553930', '2025-10-01 14:16:44', NULL, 'Counter-Strike 2'),
(726, 274, 104, '985116833193553930', '2025-10-01 14:16:45', NULL, 'Just Chatting'),
(727, 275, 123, '985116833193553930', '2025-10-01 14:16:46', NULL, 'Other, Watch Party'),
(728, 276, 121, '985116833193553930', '2025-10-01 14:16:47', NULL, 'Project Zomboid'),
(729, 277, 25, '985116833193553930', '2025-10-01 14:19:53', NULL, 'Just Chatting'),
(730, 278, 136, '985116833193553930', '2025-10-01 14:20:00', NULL, 'Call of Duty: Warzone'),
(731, 279, 136, '985116833193553930', '2025-10-01 14:20:01', NULL, 'Call of Duty: Warzone'),
(732, 280, 117, '985116833193553930', '2025-10-01 14:20:01', NULL, 'Dead By Daylight'),
(733, 281, 30, '985116833193553930', '2025-10-01 14:42:36', NULL, 'Always On'),
(734, 282, 130, '985116833193553930', '2025-10-01 14:42:44', NULL, 'Counter-Strike 2'),
(735, 283, 104, '985116833193553930', '2025-10-01 14:42:45', NULL, 'Just Chatting'),
(736, 284, 143, '985116833193553930', '2025-10-01 14:42:46', NULL, 'Just Chatting'),
(737, 285, 106, '985116833193553930', '2025-10-01 14:42:47', NULL, 'Just Chatting'),
(738, 286, 123, '985116833193553930', '2025-10-01 14:42:49', NULL, 'Other, Watch Party'),
(739, 287, 143, '985116833193553930', '2025-10-01 14:42:50', NULL, 'Just Chatting'),
(740, 288, 109, '985116833193553930', '2025-10-01 14:42:51', NULL, 'Runescape'),
(741, 289, 121, '985116833193553930', '2025-10-01 14:42:53', NULL, 'Project Zomboid'),
(742, 290, 92, '985116833193553930', '2025-10-01 14:55:20', NULL, 'PERSONA3 RELOAD'),
(743, 291, 117, '985116833193553930', '2025-10-01 15:12:33', NULL, 'Megabonk'),
(744, 292, 109, '985116833193553930', '2025-10-01 15:12:43', NULL, 'Runescape'),
(745, 293, 89, '985116833193553930', '2025-10-01 15:14:16', NULL, 'Just Chatting'),
(746, 294, 130, '985116833193553930', '2025-10-01 15:14:21', NULL, 'Counter-Strike 2'),
(747, 295, 143, '985116833193553930', '2025-10-01 15:14:22', NULL, 'Just Chatting'),
(748, 296, 143, '985116833193553930', '2025-10-01 15:14:25', NULL, 'Just Chatting'),
(749, 297, 143, '985116833193553930', '2025-10-01 15:20:29', NULL, 'Just Chatting'),
(750, 298, 143, '985116833193553930', '2025-10-01 15:20:30', NULL, 'Just Chatting'),
(751, 299, 80, '985116833193553930', '2025-10-01 15:20:38', NULL, 'Call of Duty: Warzone'),
(752, 300, 136, '985116833193553930', '2025-10-01 15:26:30', NULL, 'Call of Duty: Warzone'),
(753, 301, 136, '985116833193553930', '2025-10-01 15:26:30', NULL, 'Call of Duty: Warzone'),
(754, 302, 117, '985116833193553930', '2025-10-01 15:26:31', NULL, 'Megabonk'),
(755, 303, 123, '985116833193553930', '2025-10-01 15:29:04', NULL, 'Other, Watch Party'),
(756, 304, 143, '985116833193553930', '2025-10-01 15:34:11', NULL, 'Just Chatting'),
(757, 305, 143, '985116833193553930', '2025-10-01 15:34:14', NULL, 'Just Chatting'),
(758, 306, 109, '985116833193553930', '2025-10-01 15:34:15', NULL, 'Runescape'),
(759, 307, 130, '985116833193553930', '2025-10-01 15:40:41', NULL, 'Counter-Strike 2'),
(760, 308, 123, '985116833193553930', '2025-10-01 15:40:44', NULL, 'Other, Watch Party'),
(761, 309, 104, '985116833193553930', '2025-10-01 15:46:13', NULL, 'Just Chatting'),
(762, 310, 117, '985116833193553930', '2025-10-01 15:53:46', NULL, 'Megabonk'),
(763, 311, 109, '985116833193553930', '2025-10-01 15:53:48', NULL, 'Runescape'),
(764, 312, 121, '985116833193553930', '2025-10-01 15:53:48', NULL, 'Project Zomboid'),
(765, 313, 117, '985116833193553930', '2025-10-01 16:00:02', NULL, 'Megabonk'),
(766, 314, 106, '985116833193553930', '2025-10-01 16:00:22', NULL, 'Just Chatting'),
(767, 315, 46, '985116833193553930', '2025-10-01 16:04:23', NULL, 'Just Chatting'),
(768, 316, 109, '985116833193553930', '2025-10-01 16:04:34', NULL, 'Runescape'),
(769, 317, 136, '985116833193553930', '2025-10-01 16:06:53', NULL, 'Call of Duty: Warzone'),
(770, 318, 136, '985116833193553930', '2025-10-01 16:06:53', NULL, 'Call of Duty: Warzone'),
(771, 319, 106, '985116833193553930', '2025-10-01 16:12:15', NULL, 'Just Chatting'),
(772, 320, 136, '985116833193553930', '2025-10-01 16:12:15', NULL, 'Call of Duty: Warzone'),
(773, 321, 136, '985116833193553930', '2025-10-01 16:12:15', NULL, 'Call of Duty: Warzone'),
(774, 322, 121, '985116833193553930', '2025-10-01 16:12:16', NULL, 'Project Zomboid'),
(775, 323, 104, '985116833193553930', '2025-10-01 16:14:31', NULL, 'Just Chatting'),
(776, 324, 143, '985116833193553930', '2025-10-01 16:14:32', NULL, 'Just Chatting'),
(777, 325, 143, '985116833193553930', '2025-10-01 16:14:34', NULL, 'Just Chatting'),
(778, 326, 136, '985116833193553930', '2025-10-01 16:17:56', NULL, 'Call of Duty: Warzone'),
(779, 327, 136, '985116833193553930', '2025-10-01 16:17:57', NULL, 'Call of Duty: Warzone'),
(780, 328, 123, '985116833193553930', '2025-10-01 16:17:57', NULL, 'Other, Watch Party'),
(781, 329, 130, '985116833193553930', '2025-10-01 16:19:41', NULL, 'Counter-Strike 2'),
(782, 330, 106, '985116833193553930', '2025-10-01 16:26:16', NULL, 'Just Chatting'),
(783, 331, 117, '985116833193553930', '2025-10-01 16:26:17', NULL, 'Just Chatting'),
(784, 332, 109, '985116833193553930', '2025-10-01 16:26:18', NULL, 'Runescape'),
(785, 333, 29, '985116833193553930', '2025-10-01 16:32:53', NULL, 'Apex Legends'),
(786, 334, 104, '985116833193553930', '2025-10-01 16:33:00', NULL, 'Just Chatting'),
(787, 335, 143, '985116833193553930', '2025-10-01 16:33:01', NULL, 'Just Chatting'),
(788, 336, 143, '985116833193553930', '2025-10-01 16:33:04', NULL, 'Just Chatting'),
(789, 337, 130, '985116833193553930', '2025-10-01 16:39:14', NULL, 'Counter-Strike 2'),
(790, 338, 104, '985116833193553930', '2025-10-01 16:39:15', NULL, 'Just Chatting'),
(791, 339, 143, '985116833193553930', '2025-10-01 16:39:16', NULL, 'Just Chatting'),
(792, 340, 143, '985116833193553930', '2025-10-01 16:39:18', NULL, 'Just Chatting'),
(793, 341, 109, '985116833193553930', '2025-10-01 16:42:13', NULL, 'Runescape'),
(794, 342, 104, '985116833193553930', '2025-10-01 16:46:53', NULL, 'Just Chatting'),
(795, 343, 143, '985116833193553930', '2025-10-01 16:46:54', NULL, 'Just Chatting'),
(796, 344, 117, '985116833193553930', '2025-10-01 16:46:56', NULL, 'Just Chatting'),
(797, 345, 123, '985116833193553930', '2025-10-01 16:46:57', NULL, 'Other, Watch Party'),
(798, 346, 143, '985116833193553930', '2025-10-01 16:46:58', NULL, 'Just Chatting'),
(799, 347, 130, '985116833193553930', '2025-10-01 16:55:28', NULL, 'Counter-Strike 2'),
(800, 348, 104, '985116833193553930', '2025-10-01 16:55:30', NULL, 'Just Chatting'),
(801, 349, 106, '985116833193553930', '2025-10-01 17:06:12', NULL, 'Just Chatting'),
(802, 350, 136, '985116833193553930', '2025-10-01 17:06:13', NULL, 'Marvel Rivals'),
(803, 351, 136, '985116833193553930', '2025-10-01 17:06:13', NULL, 'Marvel Rivals'),
(804, 352, 117, '985116833193553930', '2025-10-01 17:06:14', NULL, 'Just Chatting'),
(805, 353, 24, '985116833193553930', '2025-10-01 17:16:20', NULL, 'Just Chatting'),
(806, 354, 104, '985116833193553930', '2025-10-01 17:16:26', NULL, 'Just Chatting'),
(807, 355, 130, '985116833193553930', '2025-10-01 17:20:43', NULL, 'Counter-Strike 2'),
(808, 356, 109, '985116833193553930', '2025-10-01 17:20:45', NULL, 'Runescape'),
(809, 357, 110, '985116833193553930', '2025-10-01 17:26:49', NULL, 'Just Chatting'),
(810, 358, 106, '985116833193553930', '2025-10-01 17:30:44', NULL, 'Just Chatting'),
(811, 359, 40, '985116833193553930', '2025-10-01 17:33:05', NULL, 'SILENT HILL ƒ'),
(812, 360, 123, '985116833193553930', '2025-10-01 17:36:02', NULL, 'Other, Watch Party'),
(813, 361, 109, '985116833193553930', '2025-10-01 17:39:11', NULL, 'Runescape'),
(814, 362, 104, '985116833193553930', '2025-10-01 17:44:38', NULL, 'Just Chatting'),
(815, 363, 123, '985116833193553930', '2025-10-01 17:51:15', NULL, 'Other, Watch Party'),
(816, 364, 121, '985116833193553930', '2025-10-01 17:51:17', NULL, 'Project Zomboid'),
(817, 365, 143, '985116833193553930', '2025-10-01 17:54:41', NULL, 'Just Chatting'),
(818, 366, 143, '985116833193553930', '2025-10-01 17:54:42', NULL, 'Just Chatting'),
(819, 367, 123, '985116833193553930', '2025-10-01 18:01:25', NULL, 'Other, Watch Party'),
(820, 368, 129, '985116833193553930', '2025-10-01 18:03:09', NULL, 'Arena Breakout: Infinite'),
(821, 369, 130, '985116833193553930', '2025-10-01 18:07:37', NULL, 'Counter-Strike 2'),
(822, 370, 104, '985116833193553930', '2025-10-01 18:10:28', NULL, 'Just Chatting'),
(823, 371, 143, '985116833193553930', '2025-10-01 18:10:29', NULL, 'Just Chatting'),
(824, 372, 106, '985116833193553930', '2025-10-01 18:10:30', NULL, 'Just Chatting'),
(825, 373, 143, '985116833193553930', '2025-10-01 18:10:31', NULL, 'Just Chatting'),
(826, 374, 109, '985116833193553930', '2025-10-01 18:10:31', NULL, 'Runescape'),
(827, 375, 104, '985116833193553930', '2025-10-01 18:17:52', NULL, 'Just Chatting'),
(828, 376, 143, '985116833193553930', '2025-10-01 18:17:53', NULL, 'Just Chatting'),
(829, 377, 143, '985116833193553930', '2025-10-01 18:17:54', NULL, 'Just Chatting'),
(830, 378, 106, '985116833193553930', '2025-10-01 18:23:15', NULL, 'Just Chatting'),
(831, 379, 123, '985116833193553930', '2025-10-01 18:23:15', NULL, 'Other, Watch Party'),
(832, 380, 109, '985116833193553930', '2025-10-01 18:23:16', NULL, 'Runescape'),
(833, 381, 110, '985116833193553930', '2025-10-01 18:23:17', NULL, 'Just Chatting'),
(834, 382, 104, '985116833193553930', '2025-10-01 18:23:28', NULL, 'Just Chatting'),
(835, 383, 129, '985116833193553930', '2025-10-01 18:26:45', NULL, 'Arena Breakout: Infinite'),
(836, 384, 143, '985116833193553930', '2025-10-01 18:31:47', NULL, 'Just Chatting'),
(837, 385, 143, '985116833193553930', '2025-10-01 18:31:48', NULL, 'Just Chatting'),
(838, 386, 104, '985116833193553930', '2025-10-01 18:37:13', NULL, 'Just Chatting'),
(839, 387, 110, '985116833193553930', '2025-10-01 18:37:15', NULL, 'Just Chatting'),
(840, 388, 104, '985116833193553930', '2025-10-01 18:42:13', NULL, 'Just Chatting'),
(841, 389, 143, '985116833193553930', '2025-10-01 18:42:14', NULL, 'Just Chatting'),
(842, 390, 143, '985116833193553930', '2025-10-01 18:42:15', NULL, 'Just Chatting'),
(843, 391, 109, '985116833193553930', '2025-10-01 18:42:16', NULL, 'Runescape'),
(844, 392, 121, '985116833193553930', '2025-10-01 18:42:16', NULL, 'Project Zomboid'),
(845, 393, 119, '985116833193553930', '2025-10-01 18:42:17', NULL, 'Just Chatting'),
(846, 394, 106, '985116833193553930', '2025-10-01 18:42:26', NULL, 'Just Chatting'),
(847, 395, 123, '985116833193553930', '2025-10-01 18:44:57', NULL, 'Other, Watch Party'),
(848, 396, 110, '985116833193553930', '2025-10-01 18:48:02', NULL, 'Just Chatting'),
(849, 397, 129, '985116833193553930', '2025-10-01 18:48:58', NULL, 'Arena Breakout: Infinite'),
(850, 398, 119, '985116833193553930', '2025-10-01 18:57:01', NULL, 'Just Chatting'),
(851, 399, 123, '985116833193553930', '2025-10-01 19:03:44', NULL, 'Other, Watch Party'),
(852, 400, 129, '985116833193553930', '2025-10-01 19:03:56', NULL, 'Arena Breakout: Infinite'),
(853, 401, 104, '985116833193553930', '2025-10-01 19:09:14', NULL, 'Just Chatting'),
(854, 402, 106, '985116833193553930', '2025-10-01 19:09:14', NULL, 'Just Chatting'),
(855, 403, 109, '985116833193553930', '2025-10-01 19:09:15', NULL, 'Runescape'),
(856, 404, 143, '985116833193553930', '2025-10-01 19:10:27', NULL, 'Just Chatting'),
(857, 405, 143, '985116833193553930', '2025-10-01 19:10:29', NULL, 'Just Chatting'),
(858, 406, 104, '985116833193553930', '2025-10-01 19:16:50', NULL, 'Just Chatting'),
(859, 407, 143, '985116833193553930', '2025-10-01 19:16:51', NULL, 'Just Chatting'),
(860, 408, 143, '985116833193553930', '2025-10-01 19:16:52', NULL, 'Just Chatting'),
(861, 409, 109, '985116833193553930', '2025-10-01 19:16:53', NULL, 'Runescape'),
(862, 410, 119, '985116833193553930', '2025-10-01 19:16:54', NULL, 'Just Chatting'),
(863, 411, 128, '985116833193553930', '2025-10-01 19:20:56', NULL, 'Escape the Backrooms'),
(864, 412, 121, '985116833193553930', '2025-10-01 19:24:16', NULL, 'Project Zomboid'),
(865, 413, 119, '985116833193553930', '2025-10-01 19:30:47', NULL, 'Just Chatting'),
(866, 414, 143, '985116833193553930', '2025-10-01 19:30:55', NULL, 'Just Chatting'),
(867, 415, 143, '985116833193553930', '2025-10-01 19:30:56', NULL, 'Just Chatting'),
(868, 416, 106, '985116833193553930', '2025-10-01 19:31:55', NULL, 'Just Chatting'),
(869, 417, 123, '985116833193553930', '2025-10-01 19:36:42', NULL, 'Other, Watch Party'),
(870, 418, 109, '985116833193553930', '2025-10-01 19:36:43', NULL, 'Runescape'),
(871, 419, 39, '985116833193553930', '2025-10-01 19:38:53', NULL, 'Party Animals'),
(872, 420, 103, '985116833193553930', '2025-10-01 19:44:05', NULL, 'Fortnite'),
(873, 421, 33, '985116833193553930', '2025-10-01 19:44:11', NULL, 'Schedule I'),
(874, 422, 92, '985116833193553930', '2025-10-01 19:44:16', NULL, 'PERSONA3 RELOAD'),
(875, 423, 106, '985116833193553930', '2025-10-01 19:44:18', NULL, 'Just Chatting'),
(876, 424, 106, '985116833193553930', '2025-10-01 19:51:01', NULL, 'Just Chatting'),
(877, 425, 103, '985116833193553930', '2025-10-01 19:51:12', NULL, 'Fortnite'),
(878, 426, 128, '985116833193553930', '2025-10-01 19:57:11', NULL, 'Just Chatting'),
(879, 427, 123, '985116833193553930', '2025-10-01 19:57:12', NULL, 'Other, Watch Party'),
(880, 428, 119, '985116833193553930', '2025-10-01 19:57:12', NULL, 'Just Chatting'),
(881, 429, 128, '985116833193553930', '2025-10-01 20:03:14', NULL, 'Just Chatting'),
(882, 430, 106, '985116833193553930', '2025-10-01 20:03:15', NULL, 'Just Chatting'),
(883, 431, 121, '985116833193553930', '2025-10-01 20:03:16', NULL, 'Project Zomboid'),
(884, 432, 92, '985116833193553930', '2025-10-01 20:03:23', NULL, 'PERSONA3 RELOAD'),
(885, 433, 1613, '985116833193553930', '2025-10-01 20:03:45', NULL, 'Schedule I'),
(886, 434, 1613, '985116833193553930', '2025-10-01 20:10:42', NULL, 'Schedule I'),
(887, 435, 109, '985116833193553930', '2025-10-01 20:10:44', NULL, 'Runescape'),
(888, 436, 53, '985116833193553930', '2025-10-01 20:16:41', NULL, 'Call of Duty: Black Ops II'),
(889, 437, 92, '985116833193553930', '2025-10-01 20:16:43', NULL, 'PERSONA3 RELOAD'),
(890, 438, 139, '985116833193553930', '2025-10-01 20:16:46', NULL, 'Retro Games'),
(891, 439, 143, '985116833193553930', '2025-10-01 20:24:12', NULL, 'Just Chatting'),
(892, 440, 143, '985116833193553930', '2025-10-01 20:24:13', NULL, 'Just Chatting'),
(893, 441, 121, '985116833193553930', '2025-10-01 20:24:14', NULL, 'Project Zomboid'),
(894, 442, 122, '985116833193553930', '2025-10-01 20:27:18', NULL, 'Arena Breakout: Infinite'),
(895, 443, 122, '985116833193553930', '2025-10-01 20:27:19', NULL, 'Arena Breakout: Infinite'),
(896, 444, 139, '985116833193553930', '2025-10-01 20:27:20', NULL, 'Retro Games'),
(897, 445, 123, '985116833193553930', '2025-10-01 20:27:22', NULL, 'Just Chatting'),
(898, 446, 121, '985116833193553930', '2025-10-01 20:30:01', NULL, 'Project Zomboid'),
(899, 447, 86, '985116833193553930', '2025-10-01 20:31:25', NULL, 'Arena Breakout: Infinite'),
(900, 448, 86, '985116833193553930', '2025-10-01 20:31:26', NULL, 'Arena Breakout: Infinite'),
(901, 449, 128, '985116833193553930', '2025-10-01 20:31:27', NULL, 'Just Chatting'),
(902, 450, 122, '985116833193553930', '2025-10-01 20:38:14', NULL, 'Arena Breakout: Infinite'),
(903, 451, 106, '985116833193553930', '2025-10-01 20:38:17', NULL, 'Just Chatting'),
(904, 452, 122, '985116833193553930', '2025-10-01 20:38:17', NULL, 'Arena Breakout: Infinite'),
(905, 453, 109, '985116833193553930', '2025-10-01 20:38:18', NULL, 'Runescape'),
(906, 454, 69, '985116833193553930', '2025-10-01 20:44:50', NULL, 'Talk Shows & Podcasts'),
(907, 455, 69, '985116833193553930', '2025-10-01 20:44:52', NULL, 'Talk Shows & Podcasts'),
(908, 456, 69, '985116833193553930', '2025-10-01 20:51:08', NULL, 'Talk Shows & Podcasts'),
(909, 457, 69, '985116833193553930', '2025-10-01 20:51:10', NULL, 'Talk Shows & Podcasts'),
(910, 458, 1613, '985116833193553930', '2025-10-01 20:51:14', NULL, 'Schedule I'),
(911, 459, 139, '985116833193553930', '2025-10-01 20:51:14', NULL, 'Retro Games'),
(912, 460, 109, '985116833193553930', '2025-10-01 20:51:15', NULL, 'Runescape'),
(913, 461, 122, '985116833193553930', '2025-10-01 20:51:29', NULL, 'Arena Breakout: Infinite'),
(914, 462, 122, '985116833193553930', '2025-10-01 20:51:30', NULL, 'Arena Breakout: Infinite'),
(915, 463, 122, '985116833193553930', '2025-10-01 20:57:47', NULL, 'Arena Breakout: Infinite'),
(916, 464, 122, '985116833193553930', '2025-10-01 20:57:48', NULL, 'Arena Breakout: Infinite'),
(917, 465, 69, '985116833193553930', '2025-10-01 20:57:56', NULL, 'Talk Shows & Podcasts'),
(918, 466, 69, '985116833193553930', '2025-10-01 20:57:57', NULL, 'Talk Shows & Podcasts'),
(919, 467, 14, '985116833193553930', '2025-10-01 21:23:37', NULL, 'Just Chatting'),
(920, 468, 84, '985116833193553930', '2025-10-01 21:23:45', NULL, 'Fortnite'),
(921, 469, 1613, '985116833193553930', '2025-10-01 21:23:50', NULL, 'Schedule I'),
(922, 470, 143, '985116833193553930', '2025-10-01 21:23:50', NULL, 'Music Stations '),
(923, 471, 123, '985116833193553930', '2025-10-01 21:23:52', NULL, 'Just Chatting'),
(924, 472, 143, '985116833193553930', '2025-10-01 21:23:54', NULL, 'Music Stations '),
(925, 473, 109, '985116833193553930', '2025-10-01 21:23:54', NULL, 'Runescape'),
(926, 474, 121, '985116833193553930', '2025-10-01 21:23:55', NULL, 'Project Zomboid'),
(927, 475, 119, '985116833193553930', '2025-10-01 21:23:55', NULL, 'Arena Breakout: Infinite'),
(928, 476, 34, '985116833193553930', '2025-10-01 22:06:51', NULL, 'Gears of War: Reloaded'),
(929, 477, 29, '985116833193553930', '2025-10-01 23:00:02', NULL, 'Path of Titans'),
(930, 478, 106, '985116833193553930', '2025-10-01 23:46:27', NULL, 'Minecraft'),
(931, 479, 12, '985116833193553930', '2025-10-02 00:26:26', NULL, 'Just Chatting'),
(932, 480, 56, '985116833193553930', '2025-10-02 00:46:40', NULL, 'Z1: Battle Royale'),
(933, 481, 16, '985116833193553930', '2025-10-02 00:56:57', NULL, 'DJs'),
(934, 482, 47, '985116833193553930', '2025-10-02 07:55:15', NULL, 'MLB The Show 25'),
(935, 483, 52, '985116833193553930', '2025-10-02 07:55:17', NULL, 'Palia'),
(936, 484, 53, '985116833193553930', '2025-10-02 07:55:18', NULL, 'Old School RuneScape'),
(937, 485, 143, '985116833193553930', '2025-10-02 07:58:56', NULL, 'Just Chatting'),
(938, 486, 122, '985116833193553930', '2025-10-02 07:58:57', NULL, 'Arena Breakout: Infinite'),
(939, 487, 122, '985116833193553930', '2025-10-02 07:58:57', NULL, 'Arena Breakout: Infinite'),
(940, 488, 139, '985116833193553930', '2025-10-02 07:58:58', NULL, 'Retro Games'),
(941, 489, 117, '985116833193553930', '2025-10-02 07:58:58', NULL, 'Dead By Daylight'),
(942, 490, 123, '985116833193553930', '2025-10-02 07:58:59', NULL, 'Just Chatting'),
(943, 491, 143, '985116833193553930', '2025-10-02 07:59:00', NULL, 'Just Chatting'),
(944, 492, 109, '985116833193553930', '2025-10-02 07:59:00', NULL, 'Runescape'),
(945, 493, 121, '985116833193553930', '2025-10-02 07:59:01', NULL, 'Project Zomboid'),
(946, 494, 119, '985116833193553930', '2025-10-02 07:59:01', NULL, 'Just Chatting'),
(947, 495, 104, '985116833193553930', '2025-10-02 09:40:38', NULL, 'Just Chatting'),
(948, 496, 143, '985116833193553930', '2025-10-02 09:42:43', NULL, 'Music Stations '),
(949, 497, 143, '985116833193553930', '2025-10-02 09:42:44', NULL, 'Music Stations '),
(950, 498, 117, '985116833193553930', '2025-10-02 09:46:40', NULL, 'Dead By Daylight'),
(951, 499, 123, '985116833193553930', '2025-10-02 09:46:41', NULL, 'Botany'),
(952, 500, 121, '985116833193553930', '2025-10-02 09:46:42', NULL, 'Project Zomboid'),
(953, 501, 119, '985116833193553930', '2025-10-02 09:46:43', NULL, 'Just Chatting'),
(954, 502, 69, '985116833193553930', '2025-10-02 09:58:38', NULL, 'Call of Duty: Black Ops 7'),
(955, 503, 69, '985116833193553930', '2025-10-02 09:58:39', NULL, 'Call of Duty: Black Ops 7'),
(956, 504, 129, '985116833193553930', '2025-10-02 11:04:55', NULL, 'Arena Breakout: Infinite'),
(957, 505, 40, '985116833193553930', '2025-10-02 11:48:13', NULL, 'SILENT HILL ƒ'),
(958, 506, 110, '985116833193553930', '2025-10-02 11:48:23', NULL, 'Silent Hill f'),
(959, 507, 102, '985116833193553930', '2025-10-02 12:42:34', NULL, 'Mortal Kombat 1'),
(960, 508, 106, '985116833193553930', '2025-10-02 12:51:20', NULL, 'Minecraft'),
(961, 509, 63, '985116833193553930', '2025-10-02 13:00:33', NULL, 'Games + Demos'),
(962, 510, 67, '985116833193553930', '2025-10-02 13:00:33', NULL, 'Just Chatting'),
(963, 511, 67, '985116833193553930', '2025-10-02 13:00:38', NULL, 'Just Chatting'),
(964, 512, 136, '985116833193553930', '2025-10-02 13:03:19', NULL, 'Just Chatting'),
(965, 513, 136, '985116833193553930', '2025-10-02 13:03:19', NULL, 'Just Chatting'),
(966, 514, 92, '985116833193553930', '2025-10-02 13:48:38', NULL, 'PERSONA3 RELOAD'),
(967, 515, 66, '985116833193553930', '2025-10-02 14:12:33', NULL, 'Genshin Impact'),
(968, 516, 80, '985116833193553930', '2025-10-02 14:42:34', NULL, 'Call of Duty: Warzone'),
(969, 517, 43, '985116833193553930', '2025-10-02 15:00:32', NULL, 'Just Chatting'),
(970, 518, 89, '985116833193553930', '2025-10-02 15:24:36', NULL, 'Just Chatting'),
(971, 519, 128, '985116833193553930', '2025-10-02 15:48:38', NULL, 'Just Chatting'),
(972, 520, 39, '985116833193553930', '2025-10-02 16:31:26', NULL, 'Borderlands 4'),
(973, 521, 46, '985116833193553930', '2025-10-02 16:31:27', NULL, 'Grand Theft Auto V'),
(974, 522, 127, '985116833193553930', '2025-10-02 16:38:02', NULL, 'Call of Duty: Black Ops 7'),
(975, 523, 127, '985116833193553930', '2025-10-02 16:38:02', NULL, 'Call of Duty: Black Ops 7'),
(976, 524, 133, '985116833193553930', '2025-10-02 16:52:44', NULL, 'Skate.'),
(977, 525, 133, '985116833193553930', '2025-10-02 16:52:48', NULL, 'Skate.'),
(978, 526, 43, '985116833193553930', '2025-10-02 17:27:07', NULL, 'SILENT HILL ƒ'),
(979, 527, 129, '985116833193553930', '2025-10-02 17:51:53', NULL, 'Arena Breakout: Infinite'),
(980, 528, 102, '985116833193553930', '2025-10-02 18:03:52', NULL, 'IRL'),
(981, 529, 92, '985116833193553930', '2025-10-02 18:33:57', NULL, 'PERSONA3 RELOAD'),
(982, 530, 24, '985116833193553930', '2025-10-02 18:39:46', NULL, 'Just Chatting'),
(983, 531, 102, '985116833193553930', '2025-10-02 19:09:55', NULL, 'Apex Legends'),
(984, 532, 84, '985116833193553930', '2025-10-02 19:21:54', NULL, 'Fortnite'),
(985, 533, 140, '985116833193553930', '2025-10-02 19:42:36', NULL, 'Dying Light: The Beast'),
(986, 534, 37, '985116833193553930', '2025-10-02 20:27:47', NULL, 'Beyond: Two Souls'),
(987, 535, 1613, '985116833193553930', '2025-10-02 21:06:36', NULL, 'Schedule I'),
(988, 536, 33, '985116833193553930', '2025-10-02 21:09:47', NULL, 'Schedule I'),
(989, 537, 122, '985116833193553930', '2025-10-02 21:18:37', NULL, 'Arena Breakout: Infinite'),
(990, 538, 122, '985116833193553930', '2025-10-02 21:18:38', NULL, 'Arena Breakout: Infinite'),
(991, 539, 86, '985116833193553930', '2025-10-02 21:21:51', NULL, 'Arena Breakout: Infinite'),
(992, 540, 86, '985116833193553930', '2025-10-02 21:21:52', NULL, 'Arena Breakout: Infinite'),
(993, 541, 69, '985116833193553930', '2025-10-02 22:09:50', NULL, 'Call of Duty: Black Ops 7'),
(994, 542, 69, '985116833193553930', '2025-10-02 22:09:51', NULL, 'Call of Duty: Black Ops 7'),
(995, 543, 84, '985116833193553930', '2025-10-02 22:15:51', NULL, 'Fortnite'),
(996, 544, 130, '985116833193553930', '2025-10-02 22:51:57', NULL, 'Call of Duty: Black Ops 7'),
(997, 545, 1645, '985116833193553930', '2025-10-02 23:24:36', NULL, 'Call of Duty: Black Ops 7'),
(998, 546, 34, '985116833193553930', '2025-10-02 23:59:22', NULL, 'Call of Duty'),
(999, 547, 46, '985116833193553930', '2025-10-03 00:05:25', NULL, 'Grand Theft Auto V'),
(1000, 548, 58, '985116833193553930', '2025-10-03 00:05:26', NULL, 'Ghost of Yōtei'),
(1001, 549, 13, '985116833193553930', '2025-10-03 00:22:23', NULL, 'Call of Duty: Warzone'),
(1002, 550, 105, '985116833193553930', '2025-10-03 00:25:44', NULL, 'Dark and Darker'),
(1003, 551, 128, '985116833193553930', '2025-10-03 00:34:27', NULL, 'Just Chatting'),
(1004, 552, 129, '985116833193553930', '2025-10-03 00:34:27', NULL, 'Arena Breakout: Infinite'),
(1005, 553, 130, '985116833193553930', '2025-10-03 00:34:29', NULL, 'Call of Duty: Black Ops 7'),
(1006, 554, 127, '985116833193553930', '2025-10-03 00:34:30', NULL, 'Skate.'),
(1007, 555, 127, '985116833193553930', '2025-10-03 00:34:32', NULL, 'Skate.'),
(1008, 556, 106, '985116833193553930', '2025-10-03 00:34:34', NULL, 'Minecraft'),
(1009, 557, 123, '985116833193553930', '2025-10-03 00:34:35', NULL, 'Just Chatting'),
(1010, 558, 109, '985116833193553930', '2025-10-03 00:34:36', NULL, 'Runescape'),
(1011, 559, 121, '985116833193553930', '2025-10-03 00:34:37', NULL, 'Project Zomboid'),
(1012, 560, 53, '985116833193553930', '2025-10-03 01:17:05', NULL, 'Call of Duty: Black Ops II'),
(1013, 561, 139, '985116833193553930', '2025-10-03 01:17:16', NULL, 'Retro Games'),
(1014, 562, 56, '985116833193553930', '2025-10-03 01:35:04', NULL, 'Off The Grid'),
(1015, 563, 47, '985116833193553930', '2025-10-03 02:05:03', NULL, 'NHL 26'),
(1016, 564, 21, '985116833193553930', '2025-10-03 02:40:58', NULL, 'Just Chatting'),
(1017, 565, 26, '985116833193553930', '2025-10-03 02:40:59', NULL, 'Ghost of Yōtei'),
(1018, 566, 78, '985116833193553930', '2025-10-03 02:41:04', NULL, 'Marvel Rivals'),
(1019, 567, 52, '985116833193553930', '2025-10-03 02:59:02', NULL, 'Deep Rock Galactic'),
(1020, 568, 41, '985116833193553930', '2025-10-03 03:17:01', NULL, 'Dead by Daylight'),
(1021, 569, 14, '985116833193553930', '2025-10-03 03:34:59', NULL, 'Just Chatting'),
(1022, 570, 129, '985116833193553930', '2025-10-03 05:23:05', NULL, 'Arena Breakout: Infinite'),
(1023, 571, 107, '985116833193553930', '2025-10-03 05:41:10', NULL, 'Call of Duty: Black Ops 7'),
(1024, 572, 69, '985116833193553930', '2025-10-03 06:35:03', NULL, 'Just Chatting'),
(1025, 573, 73, '985116833193553930', '2025-10-03 06:35:03', NULL, 'Fortnite'),
(1026, 574, 69, '985116833193553930', '2025-10-03 06:35:05', NULL, 'Just Chatting'),
(1027, 575, 73, '985116833193553930', '2025-10-03 06:35:06', NULL, 'Fortnite'),
(1028, 576, 134, '985116833193553930', '2025-10-03 06:37:31', NULL, 'Fortnite'),
(1029, 577, 134, '985116833193553930', '2025-10-03 06:37:33', NULL, 'Fortnite'),
(1030, 578, 117, '985116833193553930', '2025-10-03 06:47:09', NULL, 'Just Chatting'),
(1031, 579, 42, '985116833193553930', '2025-10-03 07:17:02', NULL, 'Need for Speed: Heat'),
(1032, 580, 104, '985116833193553930', '2025-10-03 08:49:14', NULL, 'Just Chatting'),
(1033, 581, 102, '985116833193553930', '2025-10-03 09:01:13', NULL, 'Fortnite'),
(1034, 582, 1, '985116833193553930', '2025-10-03 09:07:06', NULL, 'Just Chatting'),
(1035, 583, 119, '985116833193553930', '2025-10-03 09:55:17', NULL, 'Just Chatting'),
(1036, 584, 36, '985116833193553930', '2025-10-03 12:49:09', NULL, 'Watcher of Realms'),
(1037, 585, 63, '985116833193553930', '2025-10-03 12:49:11', NULL, 'Games + Demos'),
(1038, 586, 92, '985116833193553930', '2025-10-03 12:55:28', NULL, 'PERSONA3 RELOAD'),
(1039, 587, 67, '985116833193553930', '2025-10-03 13:31:59', NULL, 'Just Chatting'),
(1040, 588, 67, '985116833193553930', '2025-10-03 13:32:03', NULL, 'Just Chatting'),
(1041, 589, 136, '985116833193553930', '2025-10-03 13:32:04', NULL, 'Just Chatting'),
(1042, 590, 136, '985116833193553930', '2025-10-03 13:32:05', NULL, 'Just Chatting'),
(1043, 591, 80, '985116833193553930', '2025-10-03 13:50:02', NULL, 'Call of Duty: Warzone'),
(1044, 592, 106, '985116833193553930', '2025-10-03 14:13:11', NULL, 'Minecraft'),
(1045, 593, 104, '985116833193553930', '2025-10-03 14:26:03', NULL, 'Just Chatting'),
(1046, 594, 143, '985116833193553930', '2025-10-03 14:26:03', NULL, 'Music Stations '),
(1047, 595, 106, '985116833193553930', '2025-10-03 14:26:04', NULL, 'Minecraft'),
(1048, 596, 136, '985116833193553930', '2025-10-03 14:26:04', NULL, 'Fortnite'),
(1049, 597, 136, '985116833193553930', '2025-10-03 14:26:05', NULL, 'Fortnite'),
(1050, 598, 139, '985116833193553930', '2025-10-03 14:26:06', NULL, 'Retro Games'),
(1051, 599, 117, '985116833193553930', '2025-10-03 14:26:07', NULL, 'Megabonk'),
(1052, 600, 123, '985116833193553930', '2025-10-03 14:26:08', NULL, 'Just Chatting'),
(1053, 601, 143, '985116833193553930', '2025-10-03 14:26:09', NULL, 'Music Stations '),
(1054, 602, 109, '985116833193553930', '2025-10-03 14:26:10', NULL, 'Runescape'),
(1055, 603, 121, '985116833193553930', '2025-10-03 14:26:11', NULL, 'Project Zomboid'),
(1056, 604, 40, '985116833193553930', '2025-10-03 15:17:28', NULL, 'Call of Duty: Warzone'),
(1057, 605, 110, '985116833193553930', '2025-10-03 15:17:38', NULL, 'Call of Duty: Warzone'),
(1058, 606, 128, '985116833193553930', '2025-10-03 15:29:35', NULL, 'Just Chatting'),
(1059, 607, 92, '985116833193553930', '2025-10-03 15:47:35', NULL, 'PERSONA3 RELOAD'),
(1060, 608, 46, '985116833193553930', '2025-10-03 15:59:29', NULL, 'Grand Theft Auto V'),
(1061, 609, 103, '985116833193553930', '2025-10-03 15:59:34', NULL, 'Fortnite'),
(1062, 610, 43, '985116833193553930', '2025-10-03 16:11:29', NULL, 'Just Chatting'),
(1063, 611, 102, '985116833193553930', '2025-10-03 16:11:35', NULL, 'Mortal Kombat 1'),
(1064, 612, 89, '985116833193553930', '2025-10-03 16:17:34', NULL, 'Just Chatting'),
(1065, 613, 100, '985116833193553930', '2025-10-03 17:41:11', NULL, 'Music'),
(1066, 614, 1645, '985116833193553930', '2025-10-03 17:47:38', NULL, 'Call of Duty: Black Ops 7'),
(1067, 615, 66, '985116833193553930', '2025-10-03 17:53:33', NULL, 'Genshin Impact'),
(1068, 616, 39, '985116833193553930', '2025-10-03 18:05:29', NULL, 'Party Animals'),
(1069, 617, 21, '985116833193553930', '2025-10-03 19:17:29', NULL, 'Just Chatting'),
(1070, 618, 29, '985116833193553930', '2025-10-03 19:35:29', NULL, 'Tom Clancy\'s Rainbow Six Siege X'),
(1071, 619, 86, '985116833193553930', '2025-10-03 19:35:36', NULL, 'Arena Breakout: Infinite'),
(1072, 620, 86, '985116833193553930', '2025-10-03 19:35:38', NULL, 'Arena Breakout: Infinite'),
(1073, 621, 122, '985116833193553930', '2025-10-03 19:35:42', NULL, 'Arena Breakout: Infinite'),
(1074, 622, 122, '985116833193553930', '2025-10-03 19:35:44', NULL, 'Arena Breakout: Infinite'),
(1075, 623, 24, '985116833193553930', '2025-10-03 19:53:29', NULL, 'Just Chatting'),
(1076, 624, 127, '985116833193553930', '2025-10-03 19:53:41', NULL, 'Just Chatting'),
(1077, 625, 127, '985116833193553930', '2025-10-03 19:53:42', NULL, 'Just Chatting'),
(1078, 626, 53, '985116833193553930', '2025-10-03 20:05:32', NULL, 'Call of Duty: Black Ops II'),
(1079, 627, 139, '985116833193553930', '2025-10-03 20:05:44', NULL, 'Retro Games'),
(1080, 628, 129, '985116833193553930', '2025-10-03 20:53:35', NULL, 'Ark: Survival Ascended'),
(1081, 629, 12, '985116833193553930', '2025-10-03 21:23:27', NULL, 'Call of Duty: Black Ops 6'),
(1082, 630, 130, '985116833193553930', '2025-10-03 21:31:34', NULL, 'Fortnite'),
(1083, 631, 128, '985116833193553930', '2025-10-03 21:35:53', NULL, 'R.E.P.O.'),
(1084, 632, 109, '985116833193553930', '2025-10-03 21:43:58', NULL, 'Other, Watch Party'),
(1085, 633, 121, '985116833193553930', '2025-10-03 21:43:58', NULL, 'Project Zomboid'),
(1086, 634, 33, '985116833193553930', '2025-10-03 22:32:32', NULL, 'Vampire: The Masquerade - Bloodhunt'),
(1087, 635, 1613, '985116833193553930', '2025-10-03 22:32:41', NULL, 'Schedule I'),
(1088, 636, 103, '985116833193553930', '2025-10-03 23:20:37', NULL, 'Fortnite'),
(1089, 637, 12, '985116833193553930', '2025-10-03 23:26:29', NULL, 'Fortnite'),
(1090, 638, 119, '985116833193553930', '2025-10-03 23:26:42', NULL, 'Slots & Casino'),
(1091, 639, 76, '985116833193553930', '2025-10-03 23:56:34', NULL, 'Grand Theft Auto V'),
(1092, 640, 25, '985116833193553930', '2025-10-04 00:02:33', NULL, 'Just Chatting'),
(1093, 641, 106, '985116833193553930', '2025-10-04 00:02:44', NULL, 'Minecraft'),
(1094, 642, 102, '985116833193553930', '2025-10-04 00:44:41', NULL, 'Fortnite'),
(1095, 643, 105, '985116833193553930', '2025-10-04 01:08:39', NULL, 'Megabonk'),
(1096, 644, 42, '985116833193553930', '2025-10-04 01:20:34', NULL, 'Cyberpunk 2077'),
(1097, 645, 84, '985116833193553930', '2025-10-04 01:20:37', NULL, 'Fortnite'),
(1098, 646, 25, '985116833193553930', '2025-10-04 01:32:31', NULL, 'Just Chatting'),
(1099, 647, 102, '985116833193553930', '2025-10-04 02:26:37', NULL, 'Mortal Kombat 1'),
(1100, 648, 46, '985116833193553930', '2025-10-04 02:32:34', NULL, 'Grand Theft Auto V'),
(1101, 649, 52, '985116833193553930', '2025-10-04 02:32:35', NULL, 'Hollow Knight: Silksong'),
(1102, 650, 26, '985116833193553930', '2025-10-04 02:44:32', NULL, 'Ghost of Yōtei'),
(1103, 651, 25, '985116833193553930', '2025-10-04 02:50:32', NULL, 'Just Chatting'),
(1104, 652, 72, '985116833193553930', '2025-10-04 02:56:35', NULL, 'NARAKA: BLADEPOINT'),
(1105, 653, 41, '985116833193553930', '2025-10-04 03:14:38', NULL, 'Dead by Daylight'),
(1106, 654, 104, '985116833193553930', '2025-10-04 04:20:41', NULL, 'Just Chatting'),
(1107, 655, 47, '985116833193553930', '2025-10-04 04:56:34', NULL, 'Call of Duty: Warzone'),
(1108, 656, 117, '985116833193553930', '2025-10-04 05:14:40', NULL, 'Dead By Daylight'),
(1109, 657, 86, '985116833193553930', '2025-10-04 05:56:34', NULL, 'Arena Breakout: Infinite'),
(1110, 658, 86, '985116833193553930', '2025-10-04 05:56:35', NULL, 'Arena Breakout: Infinite'),
(1111, 659, 122, '985116833193553930', '2025-10-04 05:56:39', NULL, 'Arena Breakout: Infinite'),
(1112, 660, 122, '985116833193553930', '2025-10-04 05:56:40', NULL, 'Arena Breakout: Infinite'),
(1113, 661, 66, '985116833193553930', '2025-10-04 08:38:33', NULL, 'Genshin Impact'),
(1114, 662, 129, '985116833193553930', '2025-10-04 08:50:38', NULL, 'Arena Breakout: Infinite'),
(1115, 663, 69, '985116833193553930', '2025-10-04 09:32:32', NULL, 'Call of Duty: Black Ops 7'),
(1116, 664, 69, '985116833193553930', '2025-10-04 09:32:33', NULL, 'Call of Duty: Black Ops 7'),
(1117, 665, 39, '985116833193553930', '2025-10-04 09:44:31', NULL, 'Marvel\'s Spider-Man 2'),
(1118, 666, 102, '985116833193553930', '2025-10-04 11:08:23', NULL, 'IRL'),
(1119, 667, 14, '985116833193553930', '2025-10-04 11:20:28', NULL, 'Just Chatting'),
(1120, 668, 106, '985116833193553930', '2025-10-04 12:56:37', NULL, 'Minecraft'),
(1121, 669, 92, '985116833193553930', '2025-10-04 13:02:35', NULL, 'PERSONA3 RELOAD'),
(1122, 670, 119, '985116833193553930', '2025-10-04 13:32:39', NULL, 'Arena Breakout: Infinite'),
(1123, 671, 12, '985116833193553930', '2025-10-04 13:50:28', NULL, 'Just Chatting'),
(1124, 672, 63, '985116833193553930', '2025-10-04 13:56:33', NULL, 'Games + Demos'),
(1125, 673, 128, '985116833193553930', '2025-10-04 15:44:35', NULL, 'Just Chatting'),
(1126, 674, 29, '985116833193553930', '2025-10-04 16:32:31', NULL, 'Tom Clancy\'s Rainbow Six Siege X'),
(1127, 675, 106, '985116833193553930', '2025-10-04 16:32:36', NULL, 'Minecraft'),
(1128, 676, 129, '985116833193553930', '2025-10-04 17:26:36', NULL, 'Arena Breakout: Infinite'),
(1129, 677, 46, '985116833193553930', '2025-10-04 18:08:24', NULL, 'skate.'),
(1130, 678, 92, '985116833193553930', '2025-10-04 19:08:34', NULL, 'PERSONA3 RELOAD'),
(1131, 679, 10, '985116833193553930', '2025-10-04 20:02:30', NULL, 'Forza Horizon 5'),
(1132, 680, 12, '985116833193553930', '2025-10-04 20:38:30', NULL, 'Just Chatting'),
(1133, 681, 127, '985116833193553930', '2025-10-04 20:38:36', NULL, 'Just Chatting'),
(1134, 682, 127, '985116833193553930', '2025-10-04 20:38:37', NULL, 'Just Chatting'),
(1135, 683, 119, '985116833193553930', '2025-10-04 21:02:43', NULL, 'Arena Breakout: Infinite'),
(1136, 684, 106, '985116833193553930', '2025-10-04 21:26:38', NULL, 'Minecraft'),
(1137, 685, 129, '985116833193553930', '2025-10-04 21:32:39', NULL, 'Arena Breakout: Infinite'),
(1138, 686, 13, '985116833193553930', '2025-10-04 21:38:31', NULL, 'Call of Duty: Warzone'),
(1139, 687, 86, '985116833193553930', '2025-10-04 21:38:38', NULL, 'Arena Breakout: Infinite'),
(1140, 688, 86, '985116833193553930', '2025-10-04 21:38:39', NULL, 'Arena Breakout: Infinite'),
(1141, 689, 122, '985116833193553930', '2025-10-04 21:38:42', NULL, 'Arena Breakout: Infinite'),
(1142, 690, 122, '985116833193553930', '2025-10-04 21:38:43', NULL, 'Arena Breakout: Infinite'),
(1143, 691, 24, '985116833193553930', '2025-10-05 00:27:45', NULL, 'Just Chatting'),
(1144, 692, 28, '985116833193553930', '2025-10-05 00:27:46', NULL, 'No Man\'s Sky'),
(1145, 693, 73, '985116833193553930', '2025-10-05 00:27:48', NULL, 'Fortnite'),
(1146, 694, 84, '985116833193553930', '2025-10-05 00:27:50', NULL, 'Fortnite'),
(1147, 695, 73, '985116833193553930', '2025-10-05 00:27:51', NULL, 'Fortnite'),
(1148, 696, 102, '985116833193553930', '2025-10-05 00:27:54', NULL, 'Fortnite'),
(1149, 697, 130, '985116833193553930', '2025-10-05 00:27:56', NULL, 'Fortnite'),
(1150, 698, 134, '985116833193553930', '2025-10-05 00:27:57', NULL, 'Fortnite'),
(1151, 699, 134, '985116833193553930', '2025-10-05 00:28:00', NULL, 'Fortnite'),
(1152, 700, 33, '985116833193553930', '2025-10-05 00:57:20', NULL, 'Cyberpunk 2077'),
(1153, 701, 1613, '985116833193553930', '2025-10-05 01:00:42', NULL, 'Apex Legends'),
(1154, 702, 42, '985116833193553930', '2025-10-05 01:27:20', NULL, 'Cyberpunk 2077'),
(1155, 703, 47, '985116833193553930', '2025-10-05 07:40:49', NULL, 'Call of Duty: Black Ops 7'),
(1156, 704, 52, '985116833193553930', '2025-10-05 07:40:50', NULL, 'Palia'),
(1157, 705, 53, '985116833193553930', '2025-10-05 07:40:51', NULL, 'Call of Duty: Black Ops II'),
(1158, 706, 129, '985116833193553930', '2025-10-05 07:40:56', NULL, 'Arena Breakout: Infinite'),
(1159, 707, 139, '985116833193553930', '2025-10-05 07:40:59', NULL, 'Retro Games'),
(1160, 708, 117, '985116833193553930', '2025-10-05 07:40:59', NULL, 'Dead By Daylight'),
(1161, 709, 66, '985116833193553930', '2025-10-05 08:42:48', NULL, 'Genshin Impact'),
(1162, 710, 119, '985116833193553930', '2025-10-05 10:42:52', NULL, 'Just Chatting');
INSERT INTO `stream_sessions` (`session_id`, `announcement_id`, `streamer_id`, `guild_id`, `start_time`, `end_time`, `game_name`) VALUES
(1163, 711, 69, '985116833193553930', '2025-10-05 11:30:46', NULL, 'Fortnite'),
(1164, 712, 69, '985116833193553930', '2025-10-05 11:30:47', NULL, 'Fortnite'),
(1165, 713, 33, '985116833193553930', '2025-10-05 11:42:44', NULL, 'Cyberpunk 2077'),
(1166, 714, 92, '985116833193553930', '2025-10-05 12:06:46', NULL, 'PERSONA3 RELOAD'),
(1167, 715, 102, '985116833193553930', '2025-10-05 12:18:48', NULL, 'IRL'),
(1168, 716, 25, '985116833193553930', '2025-10-06 03:30:47', NULL, 'Just Chatting'),
(1169, 717, 46, '985116833193553930', '2025-10-06 03:30:49', NULL, 'Deadside'),
(1170, 718, 56, '985116833193553930', '2025-10-06 03:30:50', NULL, 'Off The Grid'),
(1171, 719, 63, '985116833193553930', '2025-10-06 03:30:51', NULL, '7 Days to Die'),
(1172, 720, 86, '985116833193553930', '2025-10-06 03:30:52', NULL, 'Arena Breakout: Infinite'),
(1173, 721, 86, '985116833193553930', '2025-10-06 03:30:54', NULL, 'Arena Breakout: Infinite'),
(1174, 722, 130, '985116833193553930', '2025-10-06 03:30:55', NULL, 'Minecraft'),
(1175, 723, 105, '985116833193553930', '2025-10-06 03:30:56', NULL, 'Dark and Darker'),
(1176, 724, 122, '985116833193553930', '2025-10-06 03:30:57', NULL, 'Arena Breakout: Infinite'),
(1177, 725, 122, '985116833193553930', '2025-10-06 03:30:57', NULL, 'Arena Breakout: Infinite'),
(1178, 726, 120, '985116833193553930', '2025-10-06 03:30:58', NULL, 'Borderlands 4'),
(1179, 727, 102, '985116833193553930', '2025-10-06 03:42:51', NULL, 'Apex Legends'),
(1180, 728, 52, '985116833193553930', '2025-10-06 04:18:45', NULL, 'Hollow Knight: Silksong'),
(1181, 729, 53, '985116833193553930', '2025-10-06 04:31:52', NULL, 'Call of Duty: Black Ops II'),
(1182, 730, 139, '985116833193553930', '2025-10-06 04:31:58', NULL, 'Retro Games'),
(1183, 731, 47, '985116833193553930', '2025-10-06 04:51:44', NULL, 'Call of Duty: Warzone'),
(1184, 732, 129, '985116833193553930', '2025-10-06 05:36:40', NULL, 'Arena Breakout: Infinite'),
(1185, 733, 14, '985116833193553930', '2025-10-06 07:21:11', NULL, 'Just Chatting'),
(1186, 734, 56, '985116833193553930', '2025-10-06 10:12:25', NULL, 'Z1: Battle Royale'),
(1187, 735, 117, '985116833193553930', '2025-10-06 11:21:52', NULL, 'Megabonk'),
(1188, 736, 102, '985116833193553930', '2025-10-06 11:33:50', NULL, 'IRL'),
(1189, 737, 110, '985116833193553930', '2025-10-06 12:48:07', NULL, 'Call of Duty: Black Ops 7'),
(1190, 738, 40, '985116833193553930', '2025-10-06 12:54:49', NULL, 'Call of Duty: Warzone'),
(1191, 739, 106, '985116833193553930', '2025-10-07 09:53:22', NULL, 'Minecraft'),
(1192, 740, 119, '985116833193553930', '2025-10-07 09:53:24', NULL, 'Just Chatting'),
(1193, 741, 47, '985116833193553930', '2025-10-07 09:53:29', NULL, 'Call of Duty: Black Ops 7'),
(1194, 742, 63, '985116833193553930', '2025-10-07 09:53:43', NULL, 'Games + Demos'),
(1195, 743, 12, '985116833193553930', '2025-10-07 13:33:47', NULL, 'Just Chatting'),
(1196, 744, 66, '985116833193553930', '2025-10-07 13:33:54', NULL, 'Genshin Impact'),
(1197, 745, 81, '985116833193553930', '2025-10-07 13:33:55', NULL, 'Project Zomboid'),
(1198, 746, 121, '985116833193553930', '2025-10-07 13:34:00', NULL, 'Project Zomboid'),
(1199, 747, 106, '985116833193553930', '2025-10-07 14:42:38', NULL, 'Minecraft'),
(1200, 748, 47, '985116833193553930', '2025-10-07 14:48:31', NULL, 'Call of Duty: Warzone'),
(1201, 749, 43, '985116833193553930', '2025-10-07 15:00:36', NULL, 'Just Chatting'),
(1202, 750, 89, '985116833193553930', '2025-10-07 15:12:36', NULL, 'Just Chatting'),
(1203, 751, 92, '985116833193553930', '2025-10-07 15:18:36', NULL, 'PERSONA3 RELOAD'),
(1204, 752, 39, '985116833193553930', '2025-10-07 15:42:32', NULL, 'PEAK'),
(1205, 753, 40, '985116833193553930', '2025-10-07 15:42:32', NULL, 'SILENT HILL ƒ'),
(1206, 754, 110, '985116833193553930', '2025-10-07 15:45:31', NULL, 'Silent Hill f'),
(1207, 755, 46, '985116833193553930', '2025-10-07 16:24:35', NULL, 'skate.'),
(1208, 756, 128, '985116833193553930', '2025-10-07 16:30:44', NULL, 'Just Chatting'),
(1209, 757, 129, '985116833193553930', '2025-10-07 16:48:44', NULL, 'Arena Breakout: Infinite'),
(1210, 758, 119, '985116833193553930', '2025-10-07 16:57:29', NULL, 'Just Chatting'),
(1211, 759, 100, '985116833193553930', '2025-10-07 17:42:37', NULL, 'Just Chatting'),
(1212, 760, 129, '985116833193553930', '2025-10-07 17:54:40', NULL, 'Ark: Survival Ascended'),
(1213, 761, 33, '985116833193553930', '2025-10-07 19:00:32', NULL, 'Vampire: The Masquerade - Bloodhunt'),
(1214, 762, 1613, '985116833193553930', '2025-10-07 19:00:40', NULL, 'Vampire: The Masquerade - Bloodhunt'),
(1215, 763, 19, '985116833193553930', '2025-10-07 20:36:29', NULL, 'Just Chatting'),
(1216, 764, 24, '985116833193553930', '2025-10-07 21:12:30', NULL, 'Just Chatting'),
(1217, 765, 34, '985116833193553930', '2025-10-07 22:51:32', NULL, 'skate.'),
(1218, 766, 66, '985116833193553930', '2025-10-07 22:51:35', NULL, 'Genshin Impact'),
(1219, 767, 102, '985116833193553930', '2025-10-07 22:51:38', NULL, 'Apex Legends'),
(1220, 768, 130, '985116833193553930', '2025-10-07 22:51:42', NULL, 'Slots & Casino'),
(1221, 769, 120, '985116833193553930', '2025-10-07 22:51:46', NULL, 'EA Sports College Football 26'),
(1222, 770, 53, '985116833193553930', '2025-10-07 22:52:00', NULL, 'Call of Duty: Black Ops II'),
(1223, 771, 139, '985116833193553930', '2025-10-07 22:55:29', NULL, 'Retro Games'),
(1224, 772, 10, '985116833193553930', '2025-10-07 23:24:24', NULL, 'Expeditions: A MudRunner Game'),
(1225, 773, 76, '985116833193553930', '2025-10-07 23:24:31', NULL, 'Grand Theft Auto V'),
(1226, 774, 21, '985116833193553930', '2025-10-07 23:42:27', NULL, 'Just Chatting');

-- --------------------------------------------------------

--
-- Table structure for table `subscriptions`
--

CREATE TABLE `subscriptions` (
  `subscription_id` bigint(20) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `streamer_id` bigint(20) NOT NULL,
  `announcement_channel_id` varchar(255) DEFAULT NULL,
  `live_role_id` varchar(255) DEFAULT NULL,
  `custom_message` text DEFAULT NULL,
  `override_nickname` varchar(255) DEFAULT NULL,
  `override_avatar_url` text DEFAULT NULL,
  `team_subscription_id` int(11) DEFAULT NULL,
  `youtube_vod_notifications` tinyint(1) DEFAULT 0,
  `tiktok_vod_notifications` tinyint(1) DEFAULT 0,
  `youtube_visibility_level` varchar(255) DEFAULT NULL,
  `privacy_setting` varchar(255) DEFAULT NULL,
  `summary_persistence` varchar(255) DEFAULT NULL,
  `privacy_level` varchar(255) DEFAULT NULL,
  `delete_on_end` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

--
-- Dumping data for table `subscriptions`
--

INSERT INTO `subscriptions` (`subscription_id`, `guild_id`, `streamer_id`, `announcement_channel_id`, `live_role_id`, `custom_message`, `override_nickname`, `override_avatar_url`, `team_subscription_id`, `youtube_vod_notifications`, `tiktok_vod_notifications`, `youtube_visibility_level`, `privacy_setting`, `summary_persistence`, `privacy_level`, `delete_on_end`) VALUES
(1, '985116833193553930', 1, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(2, '985116833193553930', 2, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(3, '985116833193553930', 3, '1415373602068496545', NULL, 'Hey @here our main man FLiiQzy is live! You know what to do ', NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(4, '985116833193553930', 4, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(5, '985116833193553930', 5, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(6, '985116833193553930', 6, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(7, '985116833193553930', 7, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(8, '985116833193553930', 8, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(9, '985116833193553930', 9, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(10, '985116833193553930', 10, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(11, '985116833193553930', 11, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(12, '985116833193553930', 12, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(13, '985116833193553930', 13, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(14, '985116833193553930', 14, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(15, '985116833193553930', 15, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(16, '985116833193553930', 16, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(17, '985116833193553930', 17, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(18, '985116833193553930', 18, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(19, '985116833193553930', 19, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(20, '985116833193553930', 20, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(21, '985116833193553930', 21, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(22, '985116833193553930', 22, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(23, '985116833193553930', 23, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(24, '985116833193553930', 24, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(25, '985116833193553930', 25, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(26, '985116833193553930', 26, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(27, '985116833193553930', 27, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(28, '985116833193553930', 28, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(29, '985116833193553930', 29, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(30, '985116833193553930', 30, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(31, '985116833193553930', 31, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(32, '985116833193553930', 32, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(33, '985116833193553930', 33, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(34, '985116833193553930', 34, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(35, '985116833193553930', 35, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(36, '985116833193553930', 36, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(37, '985116833193553930', 37, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(38, '985116833193553930', 38, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(39, '985116833193553930', 39, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(40, '985116833193553930', 40, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(41, '985116833193553930', 41, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(42, '985116833193553930', 42, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(43, '985116833193553930', 43, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(44, '985116833193553930', 44, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(45, '985116833193553930', 45, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(46, '985116833193553930', 46, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(47, '985116833193553930', 47, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(48, '985116833193553930', 48, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(49, '985116833193553930', 49, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(50, '985116833193553930', 50, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(51, '985116833193553930', 51, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(52, '985116833193553930', 52, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(53, '985116833193553930', 53, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(54, '985116833193553930', 54, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(55, '985116833193553930', 55, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(56, '985116833193553930', 56, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(57, '985116833193553930', 57, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(58, '985116833193553930', 58, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(59, '985116833193553930', 59, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(60, '985116833193553930', 60, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(62, '985116833193553930', 62, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(63, '985116833193553930', 63, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(64, '985116833193553930', 64, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(65, '985116833193553930', 65, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(66, '985116833193553930', 66, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(67, '985116833193553930', 67, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(68, '985116833193553930', 68, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(69, '985116833193553930', 69, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(70, '985116833193553930', 70, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(71, '985116833193553930', 71, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(72, '985116833193553930', 72, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(73, '985116833193553930', 73, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(74, '985116833193553930', 74, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(75, '985116833193553930', 75, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(76, '985116833193553930', 76, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(77, '985116833193553930', 77, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(78, '985116833193553930', 78, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(79, '985116833193553930', 79, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(80, '985116833193553930', 80, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(81, '985116833193553930', 81, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(82, '985116833193553930', 82, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(83, '985116833193553930', 83, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(84, '985116833193553930', 84, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(85, '985116833193553930', 85, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(86, '985116833193553930', 86, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(87, '985116833193553930', 69, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(88, '985116833193553930', 68, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(89, '985116833193553930', 89, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(90, '985116833193553930', 73, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(91, '985116833193553930', 85, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(92, '985116833193553930', 92, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(93, '985116833193553930', 93, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(94, '985116833193553930', 3, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(95, '985116833193553930', 35, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(96, '985116833193553930', 86, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(98, '985116833193553930', 98, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(99, '985116833193553930', 77, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(100, '985116833193553930', 100, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(101, '985116833193553930', 45, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(102, '985116833193553930', 102, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(103, '985116833193553930', 103, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(105, '985116833193553930', 67, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(108, '985116833193553930', 128, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(109, '985116833193553930', 129, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(110, '985116833193553930', 130, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(111, '985116833193553930', 131, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(112, '985116833193553930', 132, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(128, '985116833193553930', 127, '1415373602068496545', NULL, 'Hey @here our main man FLiiQzy is live! You know what to do ', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, 1),
(129, '985116833193553930', 133, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(130, '985116833193553930', 134, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(132, '985116833193553930', 140, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(133, '985116833193553930', 141, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(134, '985116833193553930', 142, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(1600, '985116833193553930', 1609, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1604, '985116833193553930', 1613, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1608, '985116833193553930', 118, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(1609, '985116833193553930', 104, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1614, '985116833193553930', 127, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(1615, '985116833193553930', 105, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1616, '985116833193553930', 143, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(1618, '985116833193553930', 122, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(1619, '985116833193553930', 1628, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(1620, '985116833193553930', 1629, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(1621, '985116833193553930', 106, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1636, '985116833193553930', 1645, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(1638, '985116833193553930', 137, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(1674, '985116833193553930', 1629, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1675, '985116833193553930', 1684, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1731, '985116833193553930', 137, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1784, '985116833193553930', 136, '1415244430301990983', NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, 1),
(1785, '985116833193553930', 136, '1415373602068496545', NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, 1),
(1787, '985116833193553930', 134, '1415373602068496545', NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, 1),
(1794, '985116833193553930', 135, '1415244430301990983', NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, 1),
(1796, '985116833193553930', 122, '1415373602068496545', NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, 1),
(1797, '985116833193553930', 139, '1415373602068496545', NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, 1),
(1798, '985116833193553930', 138, '1415244430301990983', NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, 1),
(1855, '985116833193553930', 117, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1863, '985116833193553930', 143, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1881, '985116833193553930', 112, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(1882, '985116833193553930', 112, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1895, '985116833193553930', 1886, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1913, '985116833193553930', 1875, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1914, '985116833193553930', 1875, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(1949, '985116833193553930', 107, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1950, '985116833193553930', 114, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1952, '985116833193553930', 1944, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1953, '985116833193553930', 1945, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1954, '985116833193553930', 1946, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1955, '985116833193553930', 1947, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1956, '985116833193553930', 1948, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1957, '985116833193553930', 108, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1958, '985116833193553930', 1950, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1959, '985116833193553930', 120, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1960, '985116833193553930', 109, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1964, '985116833193553930', 116, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1965, '985116833193553930', 110, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1966, '985116833193553930', 1958, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1967, '985116833193553930', 1959, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1969, '985116833193553930', 1961, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1970, '985116833193553930', 111, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1972, '985116833193553930', 1964, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1975, '985116833193553930', 1967, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1976, '985116833193553930', 1968, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1977, '985116833193553930', 133, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1978, '985116833193553930', 113, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1983, '985116833193553930', 1975, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1984, '985116833193553930', 121, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1985, '985116833193553930', 115, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1986, '985116833193553930', 119, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(1987, '985116833193553930', 1979, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(2026, '985116833193553930', 139, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(2034, '985116833193553930', 134, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(2036, '985116833193553930', 127, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1),
(2040, '985116833193553930', 135, '1415244430301990983', NULL, NULL, NULL, NULL, 2, 0, 0, NULL, NULL, NULL, NULL, 1),
(2057, '985116833193553930', 122, '1415373602068496545', NULL, NULL, NULL, NULL, 1, 0, 0, NULL, NULL, NULL, NULL, 1);

-- --------------------------------------------------------

--
-- Table structure for table `tags`
--

CREATE TABLE `tags` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `tag_name` varchar(100) NOT NULL,
  `tag_content` text NOT NULL,
  `creator_id` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `temp_channel_config`
--

CREATE TABLE `temp_channel_config` (
  `guild_id` varchar(255) NOT NULL,
  `creator_channel_id` varchar(255) NOT NULL,
  `category_id` varchar(255) NOT NULL,
  `naming_template` varchar(255) DEFAULT '{user}''s Channel'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `tickets`
--

CREATE TABLE `tickets` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `channel_id` varchar(255) NOT NULL,
  `user_id` varchar(255) NOT NULL,
  `status` enum('open','closed') NOT NULL DEFAULT 'open',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `closed_at` timestamp NULL DEFAULT NULL,
  `closed_by_id` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `ticket_config`
--

CREATE TABLE `ticket_config` (
  `guild_id` varchar(255) NOT NULL,
  `panel_channel_id` varchar(255) DEFAULT NULL,
  `panel_message_id` varchar(255) DEFAULT NULL,
  `ticket_category_id` varchar(255) DEFAULT NULL,
  `support_role_id` varchar(255) DEFAULT NULL,
  `log_channel_id` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `twitch_schedule_sync_config`
--

CREATE TABLE `twitch_schedule_sync_config` (
  `id` int(10) UNSIGNED NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `streamer_id` int(10) UNSIGNED NOT NULL,
  `discord_channel_id` varchar(255) NOT NULL,
  `is_enabled` tinyint(1) DEFAULT 0,
  `mention_role_id` varchar(255) DEFAULT NULL,
  `custom_message` text DEFAULT NULL,
  `last_synced` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `twitch_teams`
--

CREATE TABLE `twitch_teams` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `team_name` varchar(255) NOT NULL,
  `announcement_channel_id` varchar(255) DEFAULT NULL,
  `live_role_id` varchar(255) DEFAULT NULL,
  `webhook_name` varchar(255) DEFAULT NULL,
  `webhook_avatar_url` text DEFAULT NULL,
  `members_announcement_channel_id` varchar(255) DEFAULT NULL,
  `subscribers_announcement_channel_id` varchar(255) DEFAULT NULL,
  `privacy_level` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

--
-- Dumping data for table `twitch_teams`
--

INSERT INTO `twitch_teams` (`id`, `guild_id`, `team_name`, `announcement_channel_id`, `live_role_id`, `webhook_name`, `webhook_avatar_url`, `members_announcement_channel_id`, `subscribers_announcement_channel_id`, `privacy_level`) VALUES
(1, '985116833193553930', 'reeferrealm', '1415373602068496545', '1415371559966609552', 'ReeferRealm Announcer', 'https://media.discordapp.net/attachments/1347194826336243712/1347195489493323916/Reefer_Realm_upscale_Official_12.12.24.png?ex=68da8612&is=68d93492&hm=185eb27e8f66248d5fc058263e4d3f1d18e8c7caeaa82e3bd533a3fad54926b1&=&format=webp&quality=lossless&width=934&height=1008', NULL, NULL, NULL),
(2, '985116833193553930', 'stonerstation', '1415244430301990983', '1415371635422265366', 'Stoner Station Announcer', 'https://media.discordapp.net/attachments/1407920787645665320/1408010063410630768/imageedit_116_7027750905.png?ex=68daf0ce&is=68d99f4e&hm=a32a8ffe11812c1ad6a76a1207c6e330f0de679590c66dcfca01951c8c758b71&=&format=webp&quality=lossless', NULL, NULL, NULL);

-- --------------------------------------------------------

--
-- Table structure for table `twitter_feeds`
--

CREATE TABLE `twitter_feeds` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `twitter_username` varchar(255) NOT NULL,
  `channel_id` varchar(255) NOT NULL,
  `last_tweet_id` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` int(11) NOT NULL,
  `discord_id` varchar(255) NOT NULL,
  `username` varchar(255) NOT NULL,
  `discriminator` varchar(255) NOT NULL,
  `avatar` varchar(255) DEFAULT NULL,
  `guilds` text DEFAULT NULL,
  `access_token` varchar(255) NOT NULL,
  `refresh_token` varchar(255) NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `users`
--

INSERT INTO `users` (`id`, `discord_id`, `username`, `discriminator`, `avatar`, `guilds`, `access_token`, `refresh_token`, `created_at`, `updated_at`) VALUES
(1, '365905620060340224', 'death420', '0', 'a_5d3a4f5d5149c565030c322d69353915', '[{\"id\":\"165901047515185152\",\"name\":\"Weanii Watchers\",\"icon\":\"303da916a443e1a8fe1d32eec3c88890\",\"banner\":\"6a1b1e9eb844410c75b447bced307f9c\",\"owner\":false,\"permissions\":104189505,\"permissions_new\":\"1667828247023169\",\"features\":[\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"INVITE_SPLASH\",\"ANIMATED_ICON\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"416101806423146496\",\"name\":\"Nerd Parade\",\"icon\":\"f8e9c7aa4b1c08654009d5d19964ecc9\",\"banner\":\"8277c43d7635954dbcd095c5c7c897cb\",\"owner\":false,\"permissions\":37047361,\"permissions_new\":\"2222085119495233\",\"features\":[\"MEMBER_VERIFICATION_GATE_ENABLED\",\"COMMUNITY\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"ACTIVITY_FEED_DISABLED_BY_USER\",\"ANIMATED_ICON\",\"VIP_REGIONS\",\"NEWS\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"ROLE_ICONS\",\"DISCOVERABLE\",\"AGE_VERIFICATION_LARGE_GUILD\",\"VANITY_URL\",\"WELCOME_SCREEN_ENABLED\",\"COMMUNITY_EXP_LARGE_UNGATED\",\"AUDIO_BITRATE_128_KBPS\",\"THREADS_ENABLED\",\"BANNER\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"ROLE_SUBSCRIPTIONS_ENABLED\",\"VIDEO_QUALITY_1080_60FPS\",\"STAGE_CHANNEL_VIEWERS_150\",\"AUTO_MODERATION\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"PREVIEW_ENABLED\",\"VIDEO_BITRATE_ENHANCED\",\"ENABLED_DISCOVERABLE_BEFORE\",\"NEW_THREAD_PERMISSIONS\",\"CREATOR_MONETIZABLE_PROVISIONAL\",\"CREATOR_ACCEPTED_NEW_TERMS\",\"AUDIO_BITRATE_256_KBPS\",\"MAX_FILE_SIZE_50_MB\",\"INVITE_SPLASH\"]},{\"id\":\"439178636311134218\",\"name\":\"MartinVanquish17 Community\",\"icon\":\"69eed36dae9b8aa00b9d45df1440b660\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"THREADS_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"NEW_THREAD_PERMISSIONS\",\"WELCOME_SCREEN_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"538201414367707137\",\"name\":\"Insomniac Crew\",\"icon\":\"a_9405a10911014450603fccffe3e37b46\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"THREADS_ENABLED\",\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"GUILD_TAGS\",\"NEW_THREAD_PERMISSIONS\",\"INVITE_SPLASH\",\"ANIMATED_ICON\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"687832815378759684\",\"name\":\"THE HATERS\",\"icon\":\"830ec2fd39f9bab19011f55bb899c094\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"CHANNEL_ICON_EMOJIS_GENERATED\"]},{\"id\":\"689782361650626609\",\"name\":\"Coyo\'s Cantina\",\"icon\":\"1d0c3c0e6d7c2b04cd0aef73e8437d82\",\"banner\":null,\"owner\":false,\"permissions\":2004344641,\"permissions_new\":\"2231054978506561\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"GUESTS_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"701199171927015444\",\"name\":\"Manee\'s Minecraft Mondays\",\"icon\":\"a_98717310d952bfb5941a20009f1fd92f\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"INVITE_SPLASH\",\"GUESTS_ENABLED\",\"AUTO_MODERATION\",\"ANIMATED_ICON\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"704534218579116062\",\"name\":\"Draconic Lair\",\"icon\":\"5eef2f31c833b4611866e51746c7364c\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"COMMUNITY\",\"NEWS\"]},{\"id\":\"711921837503938640\",\"name\":\"PCG\",\"icon\":\"a_fbded1f6d528c46814781175a7562cd2\",\"banner\":\"b432f1975c60b1b0caa40a012c1acf6d\",\"owner\":false,\"permissions\":104189504,\"permissions_new\":\"1095807322672704\",\"features\":[\"THREADS_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TEXT_IN_VOICE_ENABLED\",\"BANNER\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"GUILD_TAGS\",\"VIDEO_QUALITY_1080_60FPS\",\"STAGE_CHANNEL_VIEWERS_150\",\"ANIMATED_ICON\",\"MAX_FILE_SIZE_50_MB\",\"COMMUNITY_EXP_LARGE_GATED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"PREVIEW_ENABLED\",\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"ROLE_ICONS\",\"ENABLED_DISCOVERABLE_BEFORE\",\"GUILD_ONBOARDING\",\"DISCOVERABLE\",\"NEW_THREAD_PERMISSIONS\",\"AGE_VERIFICATION_LARGE_GUILD\",\"AUDIO_BITRATE_256_KBPS\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"WELCOME_SCREEN_ENABLED\",\"INVITE_SPLASH\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"736592308706738247\",\"name\":\"Real Civil Engineer\",\"icon\":\"a_f7a6dc139818f8b4ce13eef831f433ea\",\"banner\":\"a_b2a499eef48856687780c0182fb911d5\",\"owner\":false,\"permissions\":37030977,\"permissions_new\":\"422631261408321\",\"features\":[\"AUDIO_BITRATE_384_KBPS\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"ANIMATED_BANNER\",\"ANIMATED_ICON\",\"ENHANCED_ROLE_COLORS\",\"MAX_FILE_SIZE_100_MB\",\"NEWS\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"ROLE_ICONS\",\"VERIFIED\",\"DISCOVERABLE\",\"GUILD_SERVER_GUIDE\",\"AGE_VERIFICATION_LARGE_GUILD\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"VANITY_URL\",\"WELCOME_SCREEN_ENABLED\",\"COMMUNITY_EXP_LARGE_UNGATED\",\"AUDIO_BITRATE_128_KBPS\",\"THREADS_ENABLED\",\"BANNER\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"GUILD_WEB_PAGE_VANITY_URL\",\"GUILD_TAGS\",\"VIDEO_QUALITY_1080_60FPS\",\"STAGE_CHANNEL_VIEWERS_150\",\"AUTO_MODERATION\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"GUILD_ONBOARDING_HAS_PROMPTS\",\"PREVIEW_ENABLED\",\"VIDEO_BITRATE_ENHANCED\",\"ENABLED_DISCOVERABLE_BEFORE\",\"GUILD_ONBOARDING\",\"CONSIDERED_EXTERNALLY_DISCOVERABLE\",\"NEW_THREAD_PERMISSIONS\",\"STAGE_CHANNEL_VIEWERS_300\",\"AUDIO_BITRATE_256_KBPS\",\"REPORT_TO_MOD_SURVEY\",\"MAX_FILE_SIZE_50_MB\",\"INVITE_SPLASH\"]},{\"id\":\"737499117907083375\",\"name\":\"𝚃𝚑𝚎 𝙻𝚘𝚟𝚎 𝚂𝚑𝚊𝚌𝚔\",\"icon\":\"a_431f5c2e801e430048a56cde151af4bf\",\"banner\":\"a_1e7c57745acd1099060a6c9624634912\",\"owner\":false,\"permissions\":104189505,\"permissions_new\":\"2222085186637377\",\"features\":[\"MEMBER_VERIFICATION_GATE_ENABLED\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"GUESTS_ENABLED\",\"ANIMATED_ICON\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"PREVIEW_ENABLED\",\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"GUILD_ONBOARDING\",\"GUILD_SERVER_GUIDE\",\"CREATOR_MONETIZABLE_PROVISIONAL\",\"CREATOR_ACCEPTED_NEW_TERMS\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"INVITE_SPLASH\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"739469743995486268\",\"name\":\"Muzik Gang\",\"icon\":\"98a96a45ab5162f63d139f45fdf9b9fe\",\"banner\":\"069a5fd0652b7ee6127ba0c3abab85d3\",\"owner\":false,\"permissions\":2146959351,\"permissions_new\":\"2232000013926391\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"GUESTS_ENABLED\",\"AUTO_MODERATION\",\"WELCOME_SCREEN_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"746422955575345192\",\"name\":\"The Wirtual Bear\'s Den\",\"icon\":\"52d6f4206ff260fa40cf481ca4edc591\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"THREADS_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"SOUNDBOARD\",\"NEW_THREAD_PERMISSIONS\",\"WELCOME_SCREEN_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"751573148813492295\",\"name\":\"The Soulless\",\"icon\":\"7b496cdcec97810607b2cd2a8472bc36\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"THREADS_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"NEW_THREAD_PERMISSIONS\",\"AUTO_MODERATION\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"783851647897305089\",\"name\":\"Chaos\'s Dominion 》 18+\",\"icon\":\"cecde8809d08299addfebc038ec0b046\",\"banner\":\"95924795c3c697a693d320378abdab8d\",\"owner\":false,\"permissions\":1610612695,\"permissions_new\":\"2251799276814295\",\"features\":[\"THREADS_ENABLED\",\"BANNER\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"ROLE_SUBSCRIPTIONS_ENABLED\",\"GUILD_TAGS\",\"VIDEO_QUALITY_1080_60FPS\",\"STAGE_CHANNEL_VIEWERS_150\",\"ANIMATED_ICON\",\"MAX_FILE_SIZE_50_MB\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"ROLE_ICONS\",\"NEW_THREAD_PERMISSIONS\",\"CREATOR_MONETIZABLE_PROVISIONAL\",\"CREATOR_ACCEPTED_NEW_TERMS\",\"AUDIO_BITRATE_256_KBPS\",\"WELCOME_SCREEN_ENABLED\",\"INVITE_SPLASH\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"787228676869324852\",\"name\":\"The YMCA\",\"icon\":\"7b591150a2ff85626b705691d37f6730\",\"banner\":null,\"owner\":false,\"permissions\":1177939520,\"permissions_new\":\"2231996897422912\",\"features\":[\"PREVIEW_ENABLED\",\"THREADS_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"GUILD_ONBOARDING\",\"GUILD_SERVER_GUIDE\",\"SOUNDBOARD\",\"NEW_THREAD_PERMISSIONS\",\"AUTO_MODERATION\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"GUILD_ONBOARDING_HAS_PROMPTS\",\"NEWS\"]},{\"id\":\"789323062456746005\",\"name\":\"The Devils Den\",\"icon\":\"f61d0a4175439234404943ebe65132fe\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"THREADS_ENABLED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"SOUNDBOARD\",\"NEW_THREAD_PERMISSIONS\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"794954991684681728\",\"name\":\"The Fox Den\",\"icon\":\"c4a42e1872b42f0dc6216b20a62c926a\",\"banner\":null,\"owner\":false,\"permissions\":104189505,\"permissions_new\":\"2222085186637377\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"SOUNDBOARD\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"805601527284105216\",\"name\":\"Sanctuary\",\"icon\":\"031e1e7e886972372daccb7231d887b0\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"AUTO_MODERATION\",\"WELCOME_SCREEN_ENABLED\",\"NEWS\"]},{\"id\":\"805841124803346432\",\"name\":\"Oasis\",\"icon\":\"a_e89609b3adeab4023779187fe7a34839\",\"banner\":\"4a3eb00b8a84917dd0d1d7361a177d83\",\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"THREADS_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"NEW_THREAD_PERMISSIONS\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"806885111580459011\",\"name\":\"The Collective\",\"icon\":\"53f8fc55227112d98333044a897fbfad\",\"banner\":null,\"owner\":false,\"permissions\":104320577,\"permissions_new\":\"1096185279925825\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"SOUNDBOARD\",\"ENABLED_MODERATION_EXPERIENCE_FOR_NON_COMMUNITY\",\"CHANNEL_ICON_EMOJIS_GENERATED\"]},{\"id\":\"806935226680213504\",\"name\":\"𝓣𝓱𝓮𝓜𝓪𝓭𝓗𝓸𝓾𝓼𝓮\",\"icon\":\"1710787e0ab5fe671677ccc737e11fd2\",\"banner\":null,\"owner\":false,\"permissions\":103927360,\"permissions_new\":\"140739739766336\",\"features\":[\"THREADS_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"ACTIVITY_FEED_DISABLED_BY_USER\",\"AUTO_MODERATION\",\"ANIMATED_ICON\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"PREVIEW_ENABLED\",\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"NEW_THREAD_PERMISSIONS\",\"AUTOMOD_TRIGGER_USER_PROFILE\",\"WELCOME_SCREEN_ENABLED\",\"INVITE_SPLASH\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"810661128878424074\",\"name\":\"DoorMarkSociety\",\"icon\":\"bbe086a9cd6bf0f1561e49c6da805eef\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"SOUNDBOARD\"]},{\"id\":\"823330787020898314\",\"name\":\"Agave Acres\",\"icon\":\"5e5a900daf18f43a0a8c3ead967726b0\",\"banner\":null,\"owner\":false,\"permissions\":104189505,\"permissions_new\":\"2221982107422273\",\"features\":[\"MEMBER_VERIFICATION_GATE_ENABLED\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"GUILD_TAGS\",\"ANIMATED_ICON\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"GUILD_ONBOARDING_HAS_PROMPTS\",\"NEWS\",\"PREVIEW_ENABLED\",\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"GUILD_ONBOARDING\",\"GUILD_SERVER_GUIDE\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"WELCOME_SCREEN_ENABLED\",\"INVITE_SPLASH\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"837109519930228768\",\"name\":\"CPWGames\",\"icon\":\"a_3ee8aacb318ade6f95fd294c99f142c2\",\"banner\":\"dfa22bf2984bc0edce8506caa90546a0\",\"owner\":false,\"permissions\":37068353,\"permissions_new\":\"391945867599425\",\"features\":[\"THREADS_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"AUTO_MODERATION\",\"ANIMATED_ICON\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"GUILD_ONBOARDING_HAS_PROMPTS\",\"NEWS\",\"PREVIEW_ENABLED\",\"VIDEO_BITRATE_ENHANCED\",\"GUILD_ONBOARDING\",\"GUILD_SERVER_GUIDE\",\"NEW_THREAD_PERMISSIONS\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"WELCOME_SCREEN_ENABLED\",\"INVITE_SPLASH\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"848791370764386378\",\"name\":\"Sadist’s gremlins cave\",\"icon\":\"2b36998d78b5584288a95bb6046dd1bf\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"COMMUNITY\",\"TEXT_IN_VOICE_ENABLED\",\"NEWS\"]},{\"id\":\"849383522459582464\",\"name\":\"🥂𝔊𝔬𝔬𝔩𝔦𝔤𝔞𝔫𝔰 ℌ𝔦𝔡𝔢𝔬𝔲𝔱 🍻\",\"icon\":\"9832260f228b76173c1da2e010d44e13\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"VIDEO_BITRATE_ENHANCED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"ROLE_SUBSCRIPTIONS_ENABLED\",\"INVITE_SPLASH\",\"CREATOR_MONETIZABLE_PROVISIONAL\",\"CREATOR_ACCEPTED_NEW_TERMS\",\"ANIMATED_ICON\",\"WELCOME_SCREEN_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"859178883697475634\",\"name\":\"Queen\'s Throne\",\"icon\":\"12afbb5dd859bcef763791ea94b4e4c8\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"THREADS_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"NEW_THREAD_PERMISSIONS\",\"AUTO_MODERATION\",\"WELCOME_SCREEN_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"863890289793826846\",\"name\":\"Killers Squad\",\"icon\":\"1215cc9497a15fa103c60a07a1520c84\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[]},{\"id\":\"869577842088878130\",\"name\":\"Lil Demons\",\"icon\":\"c8f6ff9cf382689877f75b099452404e\",\"banner\":\"e9fb92fdb35afc3d4b17a2fc9d5fde94\",\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"THREADS_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"NEW_THREAD_PERMISSIONS\",\"AUTO_MODERATION\",\"WELCOME_SCREEN_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"870617982148173824\",\"name\":\"Fleet\'s Garden\",\"icon\":\"44ec54013474adb364e86594e600e620\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"AUTO_MODERATION\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"877253051994501130\",\"name\":\"CruciCafe Fam\",\"icon\":\"80f48a8aeb2afc96307eb96382ee622a\",\"banner\":null,\"owner\":true,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"COMMUNITY\",\"WELCOME_SCREEN_ENABLED\",\"NEWS\"]},{\"id\":\"879457883333464114\",\"name\":\"Spoodercord\",\"icon\":\"4498047dc917e47c944fcf9682d70a7c\",\"banner\":null,\"owner\":false,\"permissions\":2147483633,\"permissions_new\":\"2248501278801905\",\"features\":[\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"880656752297783347\",\"name\":\"Anoraks Army\",\"icon\":\"4aa4748bc277e95f7d41cd0b0b117272\",\"banner\":null,\"owner\":false,\"permissions\":104189505,\"permissions_new\":\"2222085186637377\",\"features\":[\"THREADS_ENABLED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"NEW_THREAD_PERMISSIONS\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"889550752123613194\",\"name\":\"Twitch Moderators Community\",\"icon\":\"a_747747cae80d628f84dfd8e5d251a9d0\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"GUILD_ONBOARDING\",\"AUTO_MODERATION\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"WELCOME_SCREEN_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"900491365564153877\",\"name\":\"The JLD Universe\",\"icon\":\"e3f02d117c039a6f18d599f40044ec68\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"900949346583969802\",\"name\":\"Certified™\",\"icon\":\"e092cdd4efd06086b7a975a36119a94f\",\"banner\":null,\"owner\":true,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"SOUNDBOARD\",\"AUTO_MODERATION\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"901599353389596712\",\"name\":\"KumaCaste\",\"icon\":\"d2b89e2e502c0131f0c3dfe2865414ed\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"GUILD_TAGS\",\"PIN_PERMISSION_MIGRATION_COMPLETE\",\"AUTO_MODERATION\",\"ANIMATED_ICON\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"GUILD_ONBOARDING\",\"GUILD_SERVER_GUIDE\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"INVITE_SPLASH\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"902393911958470717\",\"name\":\"Vognarfamily\",\"icon\":\"a7a598625b95941074cfa1731e0af69b\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"INVITE_SPLASH\",\"ANIMATED_ICON\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"903226445587968001\",\"name\":\"FuniFungis Pastures\",\"icon\":\"c489c9d0a334c7d0e92310b617d38d33\",\"banner\":null,\"owner\":false,\"permissions\":104320577,\"permissions_new\":\"2248473465835073\",\"features\":[\"SOUNDBOARD\"]},{\"id\":\"907035603084931103\",\"name\":\"Battle Nation\",\"icon\":\"a23db8d48d91f571349329f5c16cec4f\",\"banner\":null,\"owner\":true,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"COMMUNITY\",\"NEWS\"]},{\"id\":\"907325329746571315\",\"name\":\"Wolves of Odin\",\"icon\":\"bf9286b85647f5ed1195e35eae6334b1\",\"banner\":null,\"owner\":true,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"COMMUNITY\",\"NEWS\"]},{\"id\":\"908397851707576350\",\"name\":\"Dragoonation\",\"icon\":\"f064fc17c5a7eb3c5e5e719bfc6e5add\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"SOUNDBOARD\",\"COMMUNITY\",\"NEWS\"]},{\"id\":\"912179627953360946\",\"name\":\"Apo’s Acolytes\",\"icon\":\"c2d8e1198fa1ac2fb921cd8759482300\",\"banner\":null,\"owner\":true,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"WELCOME_SCREEN_ENABLED\",\"COMMUNITY\",\"NEWS\"]},{\"id\":\"912924861704319046\",\"name\":\"The Stoner Station\",\"icon\":\"b515cd9fe8ae34d66db7eed9223d8079\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"SOUNDBOARD\",\"NEWS\"]},{\"id\":\"922914785958457394\",\"name\":\"The Willgrimage\",\"icon\":\"6b16184ee997e5080eb14803c2f24d6b\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"WELCOME_SCREEN_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"927416865112870923\",\"name\":\"Chibi\'s Channel\",\"icon\":\"47f1e307f201ac947a49f0ad98fdcb4d\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"SOUNDBOARD\",\"COMMUNITY\",\"NEWS\"]},{\"id\":\"932377274337099817\",\"name\":\"Exploring With Shannon\",\"icon\":\"d0c1d65a4161bb21ad82c86d7df61985\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"VIDEO_BITRATE_ENHANCED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"INVITE_SPLASH\",\"AUTO_MODERATION\",\"ANIMATED_ICON\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"934566273428389909\",\"name\":\"𝐇𝐈𝐆𝐇 𝐅𝐀𝐌\",\"icon\":\"a_5ae6b50796434244e5c509eadfbc2215\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"SOUNDBOARD\",\"CHANNEL_ICON_EMOJIS_GENERATED\"]},{\"id\":\"938911040593338398\",\"name\":\"LightyCord\",\"icon\":\"839af9e272664e8b4b7c77b5d5617e46\",\"banner\":null,\"owner\":true,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"COMMUNITY\",\"NEWS\"]},{\"id\":\"941431146946891806\",\"name\":\"The Think Tank\",\"icon\":\"ae9b935cf7b8f8c4c8f6bfa5247af64b\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"COMMUNITY\",\"NEWS\"]},{\"id\":\"952825938738040833\",\"name\":\"Bella\'s Squad\",\"icon\":\"367c187141769b0ba7f32bdb16a93817\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PREVIEW_ENABLED\",\"MEMBER_VERIFICATION_GATE_ENABLED\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"PIN_PERMISSION_MIGRATION_COMPLETE\",\"WELCOME_SCREEN_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"953890977880358932\",\"name\":\"Rekkrs Roughnecks\",\"icon\":\"7b30ec391d40e52da0a9c43801cf5635\",\"banner\":\"d5f84445551d54b67d84ffbea97f9a2d\",\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"MEMBER_VERIFICATION_GATE_ENABLED\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"GUILD_TAGS\",\"AUTO_MODERATION\",\"ANIMATED_ICON\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"PREVIEW_ENABLED\",\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"GUILD_ONBOARDING\",\"GUILD_SERVER_GUIDE\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"INVITE_SPLASH\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"961514092848382043\",\"name\":\"YYZ Studio\",\"icon\":\"a_f2926e8cc50b014c2c3c3e73f276e83d\",\"banner\":\"a_8d9f9e1bd02fc925518403de5c170776\",\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"MEMBER_VERIFICATION_GATE_ENABLED\",\"COMMUNITY\",\"GUILD_WEB_PAGE_VANITY_URL\",\"TIERLESS_BOOSTING\",\"AUTO_MODERATION\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"GUILD_ONBOARDING_HAS_PROMPTS\",\"NEWS\",\"PREVIEW_ENABLED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"ENABLED_DISCOVERABLE_BEFORE\",\"GUILD_ONBOARDING\",\"DISCOVERABLE\",\"GUILD_SERVER_GUIDE\",\"AUTOMOD_TRIGGER_USER_PROFILE\",\"AGE_VERIFICATION_LARGE_GUILD\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"WELCOME_SCREEN_ENABLED\"]},{\"id\":\"975795817380184124\",\"name\":\"home of the super genius\",\"icon\":\"ca30ccc1936b00a1a750d24bf12b3446\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"CHANNEL_ICON_EMOJIS_GENERATED\",\"COMMUNITY\",\"NEWS\"]},{\"id\":\"980331356196311070\",\"name\":\"The Stab Crazies\",\"icon\":\"7a2273213b21bc738eb4ebe9896e1215\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"TEXT_IN_VOICE_ENABLED\",\"COMMUNITY\",\"SOUNDBOARD\",\"GUESTS_ENABLED\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"985116833193553930\",\"name\":\"⁴²⁰𝑅𝑒𝑒𝒇𝑒𝓇 𝑅𝑒𝒶𝓁𝓂⁷¹⁰\",\"icon\":\"a_fb92f9aaeb14bc223e01051b33233fcc\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"MEMBER_VERIFICATION_GATE_ENABLED\",\"BANNER\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"GUILD_TAGS\",\"VIDEO_QUALITY_1080_60FPS\",\"ACTIVITY_FEED_DISABLED_BY_USER\",\"STAGE_CHANNEL_VIEWERS_150\",\"PIN_PERMISSION_MIGRATION_COMPLETE\",\"AUTO_MODERATION\",\"ANIMATED_ICON\",\"MAX_FILE_SIZE_50_MB\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\",\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"ROLE_ICONS\",\"GUILD_SERVER_GUIDE\",\"AUDIO_BITRATE_256_KBPS\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"WELCOME_SCREEN_ENABLED\",\"INVITE_SPLASH\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"992269105941991444\",\"name\":\"CrazyScavenger\'s server\",\"icon\":\"a45c732c3e64e5216612d1dd91b7dc7f\",\"banner\":null,\"owner\":false,\"permissions\":104320577,\"permissions_new\":\"2248473465835073\",\"features\":[\"SOUNDBOARD\",\"GUESTS_ENABLED\"]},{\"id\":\"1012546511739039786\",\"name\":\"🌴Cultivation Station🌴\",\"icon\":\"a_0877ac97e93d637382d0c4a1f5f46086\",\"banner\":null,\"owner\":false,\"permissions\":104320577,\"permissions_new\":\"2222085186768449\",\"features\":[\"GUESTS_ENABLED\",\"SOUNDBOARD\",\"CHANNEL_ICON_EMOJIS_GENERATED\"]},{\"id\":\"1031699935562838088\",\"name\":\"Sam Fam\",\"icon\":\"0bfe75d72df757f1967704c5b31baa05\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"SOUNDBOARD\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"1038641169174904993\",\"name\":\"Cryptic\'s Realm\",\"icon\":\"3956b137e437c12110018d7ac1c65d3d\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"COMMUNITY\",\"AUTO_MODERATION\",\"WELCOME_SCREEN_ENABLED\",\"NEWS\"]},{\"id\":\"1048442460252164136\",\"name\":\"GreazyFam\",\"icon\":\"e851f7e479325f854567029a06d44bde\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"SOUNDBOARD\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"1075236106074861618\",\"name\":\"The Frying Pan\",\"icon\":\"ed91a149f74f2532a6e60779cc4ca9ab\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"SOUNDBOARD\",\"CHANNEL_ICON_EMOJIS_GENERATED\"]},{\"id\":\"1089623135864758455\",\"name\":\"Dawny’s Dragon Den\",\"icon\":\"c403f1b18c9186c6fe6ce7b0ef54f28b\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"SOUNDBOARD\",\"NEWS\",\"COMMUNITY\"]},{\"id\":\"1120210564564648029\",\"name\":\"𝕋𝕙𝕖 ℂ𝕖𝕤𝕤𝕡𝕠𝕠𝕝\",\"icon\":\"1a16eb5c446cb3d1773d7fb29397e437\",\"banner\":null,\"owner\":false,\"permissions\":104324689,\"permissions_new\":\"2248473465839185\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"SOUNDBOARD\",\"CHANNEL_ICON_EMOJIS_GENERATED\"]},{\"id\":\"1120223568983228466\",\"name\":\"Sanctuary of Souls\",\"icon\":\"a_bb2ee8951639744b68e0f226e252bf21\",\"banner\":\"7f5a9f6cede5697309b389579d0155cc\",\"owner\":false,\"permissions\":104189505,\"permissions_new\":\"2222085186637377\",\"features\":[\"MEMBER_VERIFICATION_GATE_ENABLED\",\"BANNER\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"GUILD_TAGS\",\"VIDEO_QUALITY_1080_60FPS\",\"STAGE_CHANNEL_VIEWERS_150\",\"AUTO_MODERATION\",\"ANIMATED_ICON\",\"ENHANCED_ROLE_COLORS\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"GUILD_ONBOARDING_HAS_PROMPTS\",\"NEWS\",\"VIDEO_BITRATE_ENHANCED\",\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"ROLE_ICONS\",\"GUILD_ONBOARDING\",\"GUILD_SERVER_GUIDE\",\"AUDIO_BITRATE_256_KBPS\",\"GUILD_ONBOARDING_EVER_ENABLED\",\"MAX_FILE_SIZE_50_MB\",\"INVITE_SPLASH\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"1152271085883101335\",\"name\":\"The C00KIE Jar 🍪🌳\",\"icon\":\"4f7b0768a5d51307c7c95009934442b7\",\"banner\":null,\"owner\":false,\"permissions\":104189505,\"permissions_new\":\"2222085186637377\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"SOUNDBOARD\",\"ACTIVITY_FEED_DISABLED_BY_USER\",\"AUTO_MODERATION\",\"CHANNEL_ICON_EMOJIS_GENERATED\",\"NEWS\"]},{\"id\":\"1205421606315233340\",\"name\":\"CocoTheLoco\'s server\",\"icon\":\"d2e8ab0065e9ed87dc4678c3302a55ff\",\"banner\":null,\"owner\":false,\"permissions\":104189505,\"permissions_new\":\"2222085186637377\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\",\"COMMUNITY\",\"SOUNDBOARD\",\"CREATOR_MONETIZABLE_PROVISIONAL\",\"CREATOR_ACCEPTED_NEW_TERMS\",\"NEWS\"]},{\"id\":\"1238667856007397426\",\"name\":\"Bossie\'s Bigger Pasture\",\"icon\":\"b1948939b7852baab8e158578c64d61b\",\"banner\":null,\"owner\":false,\"permissions\":104189505,\"permissions_new\":\"2248473465704001\",\"features\":[\"AUTO_MODERATION\",\"SOUNDBOARD\",\"ENABLED_MODERATION_EXPERIENCE_FOR_NON_COMMUNITY\"]},{\"id\":\"1313635365642436629\",\"name\":\"The Nest\",\"icon\":\"411e5894f0cd73da2e54eab1d3b4ad86\",\"banner\":null,\"owner\":false,\"permissions\":104320577,\"permissions_new\":\"2248473465835073\",\"features\":[\"TIERLESS_BOOSTING_SYSTEM_MESSAGE\"]},{\"id\":\"1321904235440373902\",\"name\":\"CannaFriend | Twitch Companion\",\"icon\":\"ab949835ae31d20f050d0bb767b79d73\",\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"PIN_PERMISSION_MIGRATION_COMPLETE\"]},{\"id\":\"1342779579168981065\",\"name\":\"CertiFried™\",\"icon\":\"8fd20e96397753455b7d65043918445b\",\"banner\":null,\"owner\":true,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[\"MEMBER_VERIFICATION_GATE_ENABLED\",\"COMMUNITY\",\"ACTIVITY_FEED_DISABLED_BY_USER\",\"PIN_PERMISSION_MIGRATION_COMPLETE\",\"AUTO_MODERATION\",\"NEWS\"]},{\"id\":\"1364758578266898533\",\"name\":\"420 squad\",\"icon\":\"a_e140a08c0fc4640b3f0b0637c9e4c14e\",\"banner\":null,\"owner\":false,\"permissions\":104189505,\"permissions_new\":\"2222085186637377\",\"features\":[\"VIDEO_BITRATE_ENHANCED\",\"COMMUNITY\",\"VIDEO_QUALITY_720_60FPS\",\"STAGE_CHANNEL_VIEWERS_50\",\"TIERLESS_BOOSTING\",\"SOUNDBOARD\",\"ANIMATED_ICON\",\"INVITE_SPLASH\",\"NEWS\",\"AUDIO_BITRATE_128_KBPS\"]},{\"id\":\"1396733259357880340\",\"name\":\"CreatorBridge⸸\",\"icon\":null,\"banner\":null,\"owner\":false,\"permissions\":2147483647,\"permissions_new\":\"9007199254740991\",\"features\":[]}]', 'MTQwOTkwNDQ0MzEyNTY2NTg3NQ.DwRcQ1CSIPQGQorkXY3kUokIgBXP5t', '9HUMUZlIuznpzlpp3rtYTQGfCUK25q', '2025-10-07 07:23:31', '2025-10-07 13:52:42');

-- --------------------------------------------------------

--
-- Table structure for table `user_levels`
--

CREATE TABLE `user_levels` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `user_id` varchar(255) NOT NULL,
  `xp` int(11) DEFAULT 0,
  `level` int(11) DEFAULT 0,
  `last_message_timestamp` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `user_levels`
--

INSERT INTO `user_levels` (`id`, `guild_id`, `user_id`, `xp`, `level`, `last_message_timestamp`) VALUES
(1, '985116833193553930', '390359779094298644', 25, 0, '2025-10-05 01:21:37'),
(2, '985116833193553930', '1383192652027134045', 24, 0, '2025-10-05 13:51:12');

-- --------------------------------------------------------

--
-- Table structure for table `user_preferences`
--

CREATE TABLE `user_preferences` (
  `discord_user_id` varchar(255) NOT NULL,
  `privacy_level` varchar(255) DEFAULT 'public'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `welcome_settings`
--

CREATE TABLE `welcome_settings` (
  `guild_id` varchar(255) NOT NULL,
  `channel_id` varchar(255) DEFAULT NULL,
  `message` text DEFAULT NULL,
  `banner_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `card_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `card_background_url` text DEFAULT NULL,
  `card_title_text` varchar(255) DEFAULT 'WELCOME',
  `card_subtitle_text` varchar(255) DEFAULT 'You are member #{server.count}!',
  `card_title_color` varchar(7) DEFAULT '#FFFFFF',
  `card_username_color` varchar(7) DEFAULT '#FFFFFF',
  `card_subtitle_color` varchar(7) DEFAULT '#FFFFFF',
  `banner_background_url` text DEFAULT NULL,
  `goodbye_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `goodbye_channel_id` varchar(255) DEFAULT NULL,
  `goodbye_message` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `youtube_feeds`
--

CREATE TABLE `youtube_feeds` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `youtube_channel_id` varchar(255) NOT NULL,
  `discord_channel_id` varchar(255) NOT NULL,
  `last_video_id` varchar(255) DEFAULT NULL,
  `channel_name` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `youtube_subscriptions`
--

CREATE TABLE `youtube_subscriptions` (
  `subscription_id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `discord_channel_id` varchar(255) NOT NULL,
  `youtube_channel_id` varchar(255) NOT NULL,
  `channel_name` varchar(255) DEFAULT NULL,
  `last_video_id` varchar(255) DEFAULT NULL,
  `custom_message` text DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `action_logs`
--
ALTER TABLE `action_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guild_id` (`guild_id`);

--
-- Indexes for table `afk_statuses`
--
ALTER TABLE `afk_statuses`
  ADD PRIMARY KEY (`guild_id`,`user_id`);

--
-- Indexes for table `announcements`
--
ALTER TABLE `announcements`
  ADD PRIMARY KEY (`announcement_id`) USING BTREE,
  ADD UNIQUE KEY `subscription_id_2` (`subscription_id`),
  ADD UNIQUE KEY `subscription_id_3` (`subscription_id`),
  ADD KEY `subscription_id` (`subscription_id`) USING BTREE,
  ADD KEY `guild_id` (`guild_id`) USING BTREE;

--
-- Indexes for table `antinuke_config`
--
ALTER TABLE `antinuke_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `anti_raid_config`
--
ALTER TABLE `anti_raid_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `automod_heat_config`
--
ALTER TABLE `automod_heat_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `automod_rules`
--
ALTER TABLE `automod_rules`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guild_id` (`guild_id`);

--
-- Indexes for table `autoroles_config`
--
ALTER TABLE `autoroles_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `auto_publisher_config`
--
ALTER TABLE `auto_publisher_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `blacklisted_users`
--
ALTER TABLE `blacklisted_users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `platform_user` (`platform`,`platform_user_id`);

--
-- Indexes for table `channel_settings`
--
ALTER TABLE `channel_settings`
  ADD PRIMARY KEY (`channel_id`,`guild_id`),
  ADD KEY `guild_id` (`guild_id`),
  ADD KEY `idx_guild_channel` (`guild_id`,`channel_id`);

--
-- Indexes for table `custom_commands`
--
ALTER TABLE `custom_commands`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guild_command_unique` (`guild_id`,`command_name`);

--
-- Indexes for table `escalation_rules`
--
ALTER TABLE `escalation_rules`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guild_id` (`guild_id`);

--
-- Indexes for table `giveaways`
--
ALTER TABLE `giveaways`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guild_message_idx` (`guild_id`,`message_id`);

--
-- Indexes for table `global_stats`
--
ALTER TABLE `global_stats`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `guilds`
--
ALTER TABLE `guilds`
  ADD PRIMARY KEY (`guild_id`) USING BTREE;

--
-- Indexes for table `infractions`
--
ALTER TABLE `infractions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guild_user_idx` (`guild_id`,`user_id`);

--
-- Indexes for table `invites`
--
ALTER TABLE `invites`
  ADD PRIMARY KEY (`guild_id`,`code`);

--
-- Indexes for table `invite_tracker_logs`
--
ALTER TABLE `invite_tracker_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guild_id` (`guild_id`),
  ADD KEY `user_id` (`user_id`);

--
-- Indexes for table `join_gate_config`
--
ALTER TABLE `join_gate_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `log_config`
--
ALTER TABLE `log_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `manual_schedules`
--
ALTER TABLE `manual_schedules`
  ADD PRIMARY KEY (`schedule_id`) USING BTREE,
  ADD UNIQUE KEY `streamer_id` (`streamer_id`) USING BTREE;

--
-- Indexes for table `moderation_config`
--
ALTER TABLE `moderation_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `music_config`
--
ALTER TABLE `music_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `music_playlists`
--
ALTER TABLE `music_playlists`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guild_user_name` (`guild_id`,`user_id`,`name`);

--
-- Indexes for table `music_playlist_songs`
--
ALTER TABLE `music_playlist_songs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `playlist_id` (`playlist_id`);

--
-- Indexes for table `music_queues`
--
ALTER TABLE `music_queues`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `polls`
--
ALTER TABLE `polls`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `message_id` (`message_id`);

--
-- Indexes for table `quarantine_config`
--
ALTER TABLE `quarantine_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `reaction_role_mappings`
--
ALTER TABLE `reaction_role_mappings`
  ADD PRIMARY KEY (`id`),
  ADD KEY `panel_id` (`panel_id`);

--
-- Indexes for table `reaction_role_panels`
--
ALTER TABLE `reaction_role_panels`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `message_id` (`message_id`);

--
-- Indexes for table `record_config`
--
ALTER TABLE `record_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `reddit_feeds`
--
ALTER TABLE `reddit_feeds`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guild_subreddit_channel` (`guild_id`,`subreddit`,`channel_id`);

--
-- Indexes for table `reminders`
--
ALTER TABLE `reminders`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `reputation`
--
ALTER TABLE `reputation`
  ADD PRIMARY KEY (`guild_id`,`user_id`);

--
-- Indexes for table `role_rewards`
--
ALTER TABLE `role_rewards`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guild_level` (`guild_id`,`level`);

--
-- Indexes for table `server_backups`
--
ALTER TABLE `server_backups`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guild_id` (`guild_id`);

--
-- Indexes for table `server_stats`
--
ALTER TABLE `server_stats`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guild_date` (`guild_id`,`date`);

--
-- Indexes for table `starboard_config`
--
ALTER TABLE `starboard_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `starboard_messages`
--
ALTER TABLE `starboard_messages`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `original_message_id` (`original_message_id`);

--
-- Indexes for table `sticky_roles`
--
ALTER TABLE `sticky_roles`
  ADD PRIMARY KEY (`guild_id`,`user_id`);

--
-- Indexes for table `streamers`
--
ALTER TABLE `streamers`
  ADD PRIMARY KEY (`streamer_id`) USING BTREE,
  ADD UNIQUE KEY `platform_user` (`platform`,`platform_user_id`) USING BTREE,
  ADD KEY `discord_user_id` (`discord_user_id`) USING BTREE,
  ADD KEY `username` (`username`) USING BTREE,
  ADD KEY `idx_normalized_username` (`normalized_username`),
  ADD KEY `streamer_id` (`streamer_id`);

--
-- Indexes for table `stream_sessions`
--
ALTER TABLE `stream_sessions`
  ADD PRIMARY KEY (`session_id`) USING BTREE,
  ADD KEY `announcement_id` (`announcement_id`) USING BTREE;

--
-- Indexes for table `subscriptions`
--
ALTER TABLE `subscriptions`
  ADD PRIMARY KEY (`subscription_id`) USING BTREE,
  ADD UNIQUE KEY `guild_streamer_channel_team_unique` (`guild_id`,`streamer_id`,`announcement_channel_id`,`team_subscription_id`);

--
-- Indexes for table `tags`
--
ALTER TABLE `tags`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guild_tag_name` (`guild_id`,`tag_name`);

--
-- Indexes for table `temp_channel_config`
--
ALTER TABLE `temp_channel_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `tickets`
--
ALTER TABLE `tickets`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `channel_id` (`channel_id`),
  ADD KEY `guild_id` (`guild_id`);

--
-- Indexes for table `ticket_config`
--
ALTER TABLE `ticket_config`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `twitch_schedule_sync_config`
--
ALTER TABLE `twitch_schedule_sync_config`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guild_id` (`guild_id`,`streamer_id`);

--
-- Indexes for table `twitch_teams`
--
ALTER TABLE `twitch_teams`
  ADD PRIMARY KEY (`id`) USING BTREE;

--
-- Indexes for table `twitter_feeds`
--
ALTER TABLE `twitter_feeds`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guild_user_channel` (`guild_id`,`twitter_username`,`channel_id`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `discord_id` (`discord_id`);

--
-- Indexes for table `user_levels`
--
ALTER TABLE `user_levels`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guild_user` (`guild_id`,`user_id`);

--
-- Indexes for table `user_preferences`
--
ALTER TABLE `user_preferences`
  ADD PRIMARY KEY (`discord_user_id`);

--
-- Indexes for table `welcome_settings`
--
ALTER TABLE `welcome_settings`
  ADD PRIMARY KEY (`guild_id`);

--
-- Indexes for table `youtube_feeds`
--
ALTER TABLE `youtube_feeds`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guild_ytchannel_discordchannel` (`guild_id`,`youtube_channel_id`,`discord_channel_id`);

--
-- Indexes for table `youtube_subscriptions`
--
ALTER TABLE `youtube_subscriptions`
  ADD PRIMARY KEY (`subscription_id`),
  ADD UNIQUE KEY `guild_id_youtube_channel_id_discord_channel_id` (`guild_id`,`youtube_channel_id`,`discord_channel_id`),
  ADD KEY `idx_guild_channel_youtube_channel` (`guild_id`,`discord_channel_id`,`youtube_channel_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `action_logs`
--
ALTER TABLE `action_logs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=55;

--
-- AUTO_INCREMENT for table `announcements`
--
ALTER TABLE `announcements`
  MODIFY `announcement_id` bigint(20) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=775;

--
-- AUTO_INCREMENT for table `automod_rules`
--
ALTER TABLE `automod_rules`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `blacklisted_users`
--
ALTER TABLE `blacklisted_users`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=8;

--
-- AUTO_INCREMENT for table `custom_commands`
--
ALTER TABLE `custom_commands`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `escalation_rules`
--
ALTER TABLE `escalation_rules`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `giveaways`
--
ALTER TABLE `giveaways`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `infractions`
--
ALTER TABLE `infractions`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `invite_tracker_logs`
--
ALTER TABLE `invite_tracker_logs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `manual_schedules`
--
ALTER TABLE `manual_schedules`
  MODIFY `schedule_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `music_playlists`
--
ALTER TABLE `music_playlists`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `music_playlist_songs`
--
ALTER TABLE `music_playlist_songs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `polls`
--
ALTER TABLE `polls`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `reaction_role_mappings`
--
ALTER TABLE `reaction_role_mappings`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `reaction_role_panels`
--
ALTER TABLE `reaction_role_panels`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `reddit_feeds`
--
ALTER TABLE `reddit_feeds`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `reminders`
--
ALTER TABLE `reminders`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `role_rewards`
--
ALTER TABLE `role_rewards`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `server_backups`
--
ALTER TABLE `server_backups`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `server_stats`
--
ALTER TABLE `server_stats`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `starboard_messages`
--
ALTER TABLE `starboard_messages`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `streamers`
--
ALTER TABLE `streamers`
  MODIFY `streamer_id` bigint(20) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6421;

--
-- AUTO_INCREMENT for table `stream_sessions`
--
ALTER TABLE `stream_sessions`
  MODIFY `session_id` bigint(20) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1227;

--
-- AUTO_INCREMENT for table `subscriptions`
--
ALTER TABLE `subscriptions`
  MODIFY `subscription_id` bigint(20) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6429;

--
-- AUTO_INCREMENT for table `tags`
--
ALTER TABLE `tags`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `tickets`
--
ALTER TABLE `tickets`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `twitch_schedule_sync_config`
--
ALTER TABLE `twitch_schedule_sync_config`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `twitch_teams`
--
ALTER TABLE `twitch_teams`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `twitter_feeds`
--
ALTER TABLE `twitter_feeds`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `user_levels`
--
ALTER TABLE `user_levels`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `youtube_feeds`
--
ALTER TABLE `youtube_feeds`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `youtube_subscriptions`
--
ALTER TABLE `youtube_subscriptions`
  MODIFY `subscription_id` int(11) NOT NULL AUTO_INCREMENT;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
