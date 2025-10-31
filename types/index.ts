/**
 * CertiFried MultiTool - Comprehensive Type Definitions
 * Version: 4.0.0
 */

import {
  Client,
  User,
  TextChannel,
  VoiceChannel,
  ButtonInteraction,
  SelectMenuInteraction,
  ModalSubmitInteraction,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Collection
} from 'discord.js';
import { Connection, RowDataPacket } from 'mysql2/promise';

// ============================================================================
// DISCORD TYPES
// ============================================================================

export interface ExtendedClient extends Client {
  commands: Collection<string, Command>;
  buttons: Collection<string, ButtonHandler>;
  selectMenus: Collection<string, SelectMenuHandler>;
  modals: Collection<string, ModalHandler>;
  cooldowns: Collection<string, Collection<string, number>>;
  db: Connection;
}

export interface Command {
  data: any;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
  cooldown?: number;
  category?: string;
  permissions?: bigint[];
  botPermissions?: bigint[];
}

export interface ButtonHandler {
  customId: string | RegExp;
  execute: (interaction: ButtonInteraction) => Promise<void>;
}

export interface SelectMenuHandler {
  customId: string | RegExp;
  execute: (interaction: SelectMenuInteraction) => Promise<void>;
}

export interface ModalHandler {
  customId: string | RegExp;
  execute: (interaction: ModalSubmitInteraction) => Promise<void>;
}

export interface Event {
  name: string;
  once?: boolean;
  execute: (...args: any[]) => Promise<void>;
}

// ============================================================================
// DATABASE TYPES
// ============================================================================

export interface Streamer extends RowDataPacket {
  id: number;
  guild_id: string;
  user_id: string;
  username: string;
  display_name: string;
  platform: Platform;
  profile_image_url: string | null;
  is_live: boolean;
  stream_title: string | null;
  stream_game: string | null;
  stream_viewers: number | null;
  stream_started_at: Date | null;
  custom_message: string | null;
  custom_offline_message: string | null;
  notification_role_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Team extends RowDataPacket {
  id: number;
  guild_id: string;
  team_name: string;
  platform: Platform;
  team_id: string;
  custom_message: string | null;
  notification_role_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface LiveAnnouncement extends RowDataPacket {
  id: number;
  guild_id: string;
  user_id: string;
  username: string;
  display_name: string;
  platform: Platform;
  message_id: string;
  channel_id: string;
  stream_title: string;
  stream_game: string;
  stream_viewers: number;
  stream_started_at: Date;
  thumbnail_url: string | null;
  profile_image_url: string | null;
  created_at: Date;
}

export interface GuildSettings extends RowDataPacket {
  guild_id: string;
  prefix: string;
  announcement_channel_id: string | null;
  live_role_id: string | null;
  mod_log_channel_id: string | null;
  muted_role_id: string | null;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  farewell_message: string | null;
  autorole_ids: string | null;
  timezone: string;
  language: string;
  created_at: Date;
  updated_at: Date;
}

export interface UserLevel extends RowDataPacket {
  id: number;
  guild_id: string;
  user_id: string;
  xp: number;
  level: number;
  messages: number;
  last_message_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface Economy extends RowDataPacket {
  id: number;
  guild_id: string;
  user_id: string;
  balance: number;
  bank: number;
  daily_streak: number;
  last_daily: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Infraction extends RowDataPacket {
  id: number;
  guild_id: string;
  user_id: string;
  user_tag: string;
  moderator_id: string;
  moderator_tag: string;
  type: InfractionType;
  reason: string | null;
  duration: number | null;
  expires_at: Date | null;
  active: boolean;
  created_at: Date;
}

export interface Ticket extends RowDataPacket {
  id: number;
  guild_id: string;
  user_id: string;
  channel_id: string;
  category: string;
  status: TicketStatus;
  claimed_by: string | null;
  closed_by: string | null;
  closed_reason: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

export interface Form extends RowDataPacket {
  id: number;
  guild_id: string;
  title: string;
  description: string;
  submission_channel_id: string | null;
  notification_role_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface FormQuestion extends RowDataPacket {
  id: number;
  form_id: number;
  question: string;
  type: FormQuestionType;
  required: boolean;
  options: string | null;
  order_index: number;
  created_at: Date;
}

export interface Giveaway extends RowDataPacket {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string;
  prize: string;
  winners_count: number;
  ends_at: Date;
  ended: boolean;
  created_by: string;
  created_at: Date;
}

export interface Poll extends RowDataPacket {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string;
  question: string;
  options: string;
  ends_at: Date | null;
  ended: boolean;
  created_by: string;
  created_at: Date;
}

export interface Reminder extends RowDataPacket {
  id: number;
  guild_id: string;
  user_id: string;
  channel_id: string;
  reminder_text: string;
  remind_at: Date;
  sent: boolean;
  created_at: Date;
}

export interface Feed extends RowDataPacket {
  id: number;
  guild_id: string;
  channel_id: string;
  feed_type: FeedType;
  feed_url: string;
  custom_message: string | null;
  last_item_id: string | null;
  last_check: Date;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

// ============================================================================
// API RESPONSE TYPES
// ============================================================================

export interface TwitchStreamData {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  type: 'live' | '';
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
  tag_ids: string[];
  is_mature: boolean;
}

export interface TwitchUserData {
  id: string;
  login: string;
  display_name: string;
  type: string;
  broadcaster_type: string;
  description: string;
  profile_image_url: string;
  offline_image_url: string;
  view_count: number;
  created_at: string;
}

export interface KickStreamData {
  id: number;
  slug: string;
  channel_id: number;
  created_at: string;
  session_title: string;
  is_live: boolean;
  risk_level_id: number | null;
  source: string | null;
  twitch_channel: string | null;
  duration: number;
  language: string;
  is_mature: boolean;
  viewer_count: number;
  thumbnail: {
    src: string;
    srcset: string;
  } | null;
  categories: Array<{
    id: number;
    name: string;
    slug: string;
    icon: string;
  }>;
}

export interface YouTubeStreamData {
  id: string;
  snippet: {
    publishedAt: string;
    channelId: string;
    title: string;
    description: string;
    thumbnails: {
      default: { url: string; width: number; height: number };
      medium: { url: string; width: number; height: number };
      high: { url: string; width: number; height: number };
    };
    channelTitle: string;
    liveBroadcastContent: string;
  };
  statistics?: {
    viewCount: string;
    likeCount: string;
    commentCount: string;
  };
  liveStreamingDetails?: {
    actualStartTime: string;
    actualEndTime?: string;
    scheduledStartTime: string;
    concurrentViewers: string;
  };
}

// ============================================================================
// ENUMS
// ============================================================================

export type Platform = 'twitch' | 'youtube' | 'kick' | 'tiktok' | 'trovo' | 'facebook' | 'instagram';

export type InfractionType = 'warn' | 'timeout' | 'kick' | 'ban' | 'unmute' | 'unban';

export type TicketStatus = 'open' | 'claimed' | 'closed';

export type FormQuestionType = 'text' | 'textarea' | 'select' | 'multiselect' | 'number' | 'date';

export type FeedType = 'reddit' | 'youtube' | 'twitter' | 'twitch_schedule';

// ============================================================================
// UTILITY TYPES
// ============================================================================

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface StreamCheckResult {
  username: string;
  platform: Platform;
  isLive: boolean;
  streamData?: {
    title: string;
    game: string;
    viewers: number;
    startedAt: Date;
    thumbnailUrl: string;
    profileImageUrl: string;
  };
}

export interface EmbedOptions {
  title?: string;
  description?: string;
  color?: number;
  thumbnail?: string;
  image?: string;
  footer?: {
    text: string;
    iconURL?: string;
  };
  timestamp?: boolean;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
}

export interface CacheOptions {
  ttl?: number; // Time to live in seconds
  refreshOnAccess?: boolean;
}

export interface LogOptions {
  category?: string;
  metadata?: Record<string, any>;
}

// ============================================================================
// EXPRESS/DASHBOARD TYPES
// ============================================================================

export interface DashboardUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  email?: string;
  verified?: boolean;
  guilds?: DashboardGuild[];
}

export interface DashboardGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
  features: string[];
}

export interface SessionData {
  user?: DashboardUser;
  accessToken?: string;
  refreshToken?: string;
  [key: string]: any;
}

// ============================================================================
// MUSIC TYPES
// ============================================================================

export interface Track {
  title: string;
  author: string;
  url: string;
  thumbnail: string;
  duration: number;
  requestedBy: User;
}

export interface Queue {
  guildId: string;
  tracks: Track[];
  currentTrack: Track | null;
  volume: number;
  loop: 'off' | 'track' | 'queue';
  paused: boolean;
  voiceChannel: VoiceChannel;
  textChannel: TextChannel;
}

// ============================================================================
// WORKER/JOB TYPES
// ============================================================================

export interface JobData {
  type: string;
  guildId?: string;
  userId?: string;
  data: Record<string, any>;
  attempts?: number;
  maxAttempts?: number;
}

export interface SchedulerConfig {
  name: string;
  schedule: string; // Cron expression
  enabled: boolean;
  runOnStart?: boolean;
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

export interface BotConfig {
  token: string;
  clientId: string;
  guildId?: string;
  ownerId: string;
  superAdmins: string[];
  environment: 'development' | 'production';
  shardCount?: number | 'auto';
}

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
}

export interface APIConfig {
  twitch: {
    clientId: string;
    clientSecret: string;
  };
  youtube: {
    apiKey: string;
  };
  kick: {
    enabled: boolean;
  };
  spotify: {
    clientId: string;
    clientSecret: string;
  };
  elevenlabs: {
    apiKey: string;
  };
  gemini: {
    apiKey: string;
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export * from 'discord.js';
export type { Connection, RowDataPacket } from 'mysql2/promise';
