/**
 * Pre-loaded Interaction Handler Registry
 * Eliminates dynamic imports on each interaction for better performance
 */
import logger from '../utils/logger.js';

// Pre-load all button handlers
import { handleSelfPromoJoin } from './buttons/selfpromo_join.js';
import { handleShowcaseUploadButton } from './buttons/showcase_upload.js';
import { handleSelfPromoJoinModal } from './modals/selfpromo_join_modal.js';
import { handleSelfPromoFriend, handleSelfPromoFriendModal } from './buttons/selfpromo_friend.js';
import { handleTicketCreate } from './buttons/ticket_create.js';
import { handleTicketClose } from './buttons/ticket_close.js';
import { handleTicketFeedback, handleTicketFeedbackModal } from './buttons/ticket_feedback.js';
import { handleSuggestionUpvote } from './buttons/suggestion_upvote.js';
import { handleSuggestionDownvote } from './buttons/suggestion_downvote.js';
import { handleSuggestionReviewButton, handleSuggestionRejectModal } from './buttons/suggestion_review.js';
import { handleButton as handleTriviaButton } from '../core/trivia-manager.js';
import { handleBattleAttack, handleBattleFlee } from './buttons/rpg_battle.js';
import { handleQuickAttack, handleQuickSearch, handleQuickTalk, handleQuickRest } from './buttons/rpg_quick_actions.js';
import RPGLeaderboardManager from '../core/rpg-leaderboard-manager.js';

// RPG buttons: achievements earned during the action are announced to the player afterwards
// (one ephemeral follow-up). The handler's return value is passed through unchanged.
const withRpgAchievementNotices = (handler) => (interaction, ...args) =>
  RPGLeaderboardManager.withAchievementNotices(interaction, () => handler(interaction, ...args));
import { handleRequestAnnouncementButton } from './buttons/request_announcement.js';
import { handleApproveAnnouncement, handleDenyAnnouncement } from './buttons/announcement_approval.js';
import { handlePanelCreateBasic } from './buttons/panel_create_basic.js';
import { handlePollWriteIn } from './buttons/poll_write_in.js';
import { handleStaffIntroButton } from './buttons/staff_intro.js';
import { handleSuggestionFormButton, handleBugReportFormButton } from './buttons/forum_submit.js';
import {
  handleVerifyAccept, handleVerifyKeypad, handleVerifyModal, handleVerifyWizardConfirm, handleVerifyWizardCancel,
} from './buttons/verify_accept.js';
import { handleColourPick, handleColourOther, handleColourCustomModal, handleColourClear } from './buttons/colour_picker.js';
import { handleBanRequestApprove, handleBanRequestDeny } from './buttons/ban_request.js';
import { handleAddChannel, handleAddChannelCategory, handleAddChannelModal,
         handleAddRole, handleAddRoleModal, handleQuiet, handlePower,
         handleRename, handleRenameModal, handleRestyle, handleRestyleModal,
         handleBuildConfirm, handleBuildCancel, handleBuildRequest, handleBuildRequestModal }
  from './buttons/build_panel.js';
import { handleScheduleStyle, handleScheduleLayout, handleScheduleBackground,
         handleScheduleStyleModal, handleScheduleNow } from './buttons/schedule_style.js';
import { handleTreeGrow, handleTreeRefresh } from './buttons/tree_grow.js';
import { handleTradeButton as handleDigimonTrade } from '../commands/games/digimon.js';
import { handleTreeCatch } from './buttons/tree_catch.js';
import { handleCatGameButton, handleCatQuestButton } from './buttons/catbot_game.js';
import { handleBossButton as handleGuildBossButton } from '../core/critters/views.js';
import { handleTakeoverButton } from '../commands/admin/takeover.js';
import { handleCommissionReview } from './buttons/commission_review.js';
import { handleCommissionFalsePositive } from './buttons/commission_false_positive.js';
import { handleLinkReview } from './buttons/link_review.js';
import { handlePrivacyDeleteButton } from './buttons/privacy_delete.js';
import { handleStreamSignupAdd } from './buttons/stream_signup_add.js';
import { handleJoinGateApply, handleJoinGateSubmit, handleJoinGateDecision } from './buttons/join_gate.js';
import { handleSpammerScanConfirm, handleSpammerScanCancel } from './buttons/spammer_scan.js';
import { handleNameFilterSave, handleNameFilterForce, handleNameFilterCancel, handleNameFilterImport } from './buttons/name_filter.js';
import { handleAvatarFilterForce, handleAvatarFilterCancel, handleAvatarFilterImport } from './buttons/avatar_filter.js';
import { handleMessageThreatButton } from './buttons/message_threats.js';
import { handleWordFilterButton, handleWordFilterModal } from './buttons/word_filter.js';
import { handleDomainReportButton, handleDomainReportModal } from './buttons/domain_report.js';
import { handleLockdownConfirm, handleLockdownCancel } from './buttons/raid_lockdown.js';
import { handleEventReminderOptOut } from './buttons/event_reminder_optout.js';
import { handleGiveawayCreateButton } from './buttons/giveaway_create.js';
import { handleGiveawayCreateModal } from './modals/giveaway_create_modal.js';
import { handlePvpAct } from './buttons/pvp_act.js';
import { handleTournamentButton } from '../commands/games/tournament-handler.js';
import { handleStreamSignupSubmit } from './modals/stream_signup_submit.js';
import {
    handleCahJoin, handleCahLeave, handleCahStart, handleCahHand,
    handleCahStatus, handleCahJudge
} from './buttons/cah_buttons.js';

// Pre-load all select menu handlers
import { handlePanelSelectCategory, handlePanelSelectChannel, handlePanelSelectRole } from './select-menus/panel_select_handlers.js';
import { handleCahPick } from './select-menus/cah_pick.js';

// Pre-load all modal handlers
import { handleTicketFormSubmit } from './modals/ticket_form_submit.js';
import { handleFormOpen, handleFormNav, handleFormText } from './buttons/form_flow.js';
import { handleFormAnswer } from './select-menus/form_answer.js';
import { handleFormTextAnswer } from './modals/form_text_answer.js';
import {
  handleFormReplyTemplate, handleFormReplyWrite, handleFormReplyModal,
  handleFormReplyConfirm, handleFormReplyEdit, handleFormReplyCancel
} from './buttons/form_reply.js';
import { handleAnnouncementRequestForm } from './modals/announcement_request_form.js';
import { handlePanelCreateModal } from './modals/panel_create_modal.js';
import { handlePollWriteInSubmit } from './modals/poll_write_in_submit.js';
import { handleEmbedCreate, handleEmbedEdit } from './modals/embed_modal.js';
import { handleAnnounceModal } from '../commands/admin/announce.js';
import { handleStaffIntroSubmit } from './modals/staff_intro_submit.js';
import { handleForumSuggestionSubmit, handleForumBugReportSubmit } from './modals/forum_submit_handlers.js';
import { handleCahBlankSubmit } from './modals/cah_blank.js';
import { handleCahPasswordJoin } from './modals/cah_pwjoin.js';
import { handleFourthwallSetupSubmit } from './modals/fourthwall_setup_submit.js';
import { handleBmcLinkSubmit } from './modals/bmc_link_submit.js';
import { handleSetupButton, handleSetupSelect, handleSetupChannelSelect, handleSetupRoleSelect } from './setup-wizard-handler.js';
import { handleFourthwallShopPage } from './buttons/fourthwall_shop_page.js';
import { handleFourthwallShopPick } from './select-menus/fourthwall_shop_pick.js';
import { handleBirthdayMonthSelect } from './select-menus/birthday_month.js';
import { handleBirthdayAdminUserSelect } from './select-menus/birthday_admin_user.js';
import { handleBirthdayAdminRemoveUserSelect } from './select-menus/birthday_admin_remove_user.js';
import { handleBirthdayAdminStart } from './buttons/birthday_admin.js';
import { handleBirthdayRemoveSelf, handleBirthdayAdminRemoveStart } from './buttons/birthday_remove.js';
import { handleBirthdaySetModal } from './modals/birthday_set.js';
import { handleBirthdayOpen } from './buttons/birthday_open.js';
import { handleConfessModal } from '../commands/fun/fun-confess-handler.js';
import { handleBulkCreateModal } from '../commands/admin/admin-roles-handler.js';
import { handleTheaterBrowse, handleTheaterBrowsePage, handleTheaterPick, handleTheaterSearchModal, handleTheaterResultSelect } from '../handlers/cinema/theater-panel.js';
import { handleCinemaButton, handleCinemaSeekModal, handleCinemaSelect, handleCinemaStart, handleCinemaSeasonSelect, handleCinemaEpisodeSelect, handleCinemaEpiPage, handleCinemaPlaySeason, handleCinemaPlayFrom, handleCinemaShowFrom, handleCinemaPlayShow } from '../handlers/cinema/panel.js';
import { handleActivityOpen } from '../handlers/activities/launch.js';
import { handleFishAgain, handleFishSellAll, handleFishInv } from './buttons/fish_actions.js';
import { handleSoundboardPlay, handleSoundboardPage } from './buttons/soundboard_play.js';
import { handleSteamLibraryButton, handleSteamLibraryPasteModal } from './buttons/steam_library.js';
import { handleDiscoverSelect } from './discover-handler.js';
import { handleHeistButton, handleHeistStakeModal } from './buttons/heist_buttons.js';
import { handleTradeButton, handleTradeCounterModal } from './buttons/trade_buttons.js';
import { handlePollBetSubmit } from './modals/poll_bet_submit.js';
import {
  handleModmailOpen, handleModmailCancel, handleModmailPick, handleModmailRoute,
  handleModmailClose, handleModmailBlock, handleModmailCloseModal,
} from './modmail-handlers.js';
import { handleReviewButton as handleDmSpamReportReview } from '../core/dm-spam-reports.js';
import { handleDmReportModal } from '../commands/context/report-dm-spam.js';

// /music lastfm link: the Verify button, lastfm_verify:<discord id>:<token> (handlers/music/lastfm.js, fix wave 7).
// Loaded on first use; the customId carries everything, so it works after a restart within the token's hour.
async function handleLastfmVerify(interaction) {
  const mod = await import('../handlers/music/lastfm.js');
  return mod.handleVerifyButton(interaction);
}

/**
 * Button handler registry
 * Maps button customId prefixes to their handlers
 */
export const buttonHandlers = {
  // DM-spam report review buttons (core/dm-spam-reports.js). `dmsr:confirm:<id>` /
  // `dmsr:reject:<id>` land here from the per-guild review channel embed.
  'dmsr:': handleDmSpamReportReview,
  // #server-development build panel. 'build_do:' carries a preview token.
  'build_schedule_style': handleScheduleStyle,
  'build_schedule_now': handleScheduleNow,
  'schedstyle_layout:': handleScheduleLayout,
  'schedstyle_bg:': handleScheduleBackground,
  'build_add_channel': handleAddChannel,
  'build_add_role': handleAddRole,
  'build_rename': handleRename,
  'build_restyle': handleRestyle,
  'build_quiet': handleQuiet,
  'build_power': handlePower,
  'build_request': handleBuildRequest,
  'build_do:': handleBuildConfirm,
  'build_cancel': handleBuildCancel,
  'banreq_approve:': handleBanRequestApprove,
  'banreq_deny:': handleBanRequestDeny,
  'colour_other': handleColourOther,
  'colour_clear': handleColourClear,
  // Account-age join gate. `jgate_apply` is pressed in a DM, where there is no guild at all, so the
  // guild id rides in the customId — see interactions/buttons/join_gate.js.
  'jgate_apply:': handleJoinGateApply,
  'jgate_ok:': handleJoinGateDecision,
  'jgate_no:': handleJoinGateDecision,
  // `/protection joingate spammer-scan` confirm / cancel (core/spammer-guard.js keeps the list).
  'spamscan_ok:': handleSpammerScanConfirm,
  'spamscan_no:': handleSpammerScanCancel,
  // `/namefilter add` preview (save / save and act) and force cleanse (core/name-filters.js keeps the pending entry).
  'namefilter_save:': handleNameFilterSave,
  'namefilter_act:': handleNameFilterSave,
  'namefilter_force:': handleNameFilterForce,
  'namefilter_import:': handleNameFilterImport,
  'namefilter_no:': handleNameFilterCancel,
  // `/avatarfilter cleanse mode:force` confirmation (core/avatar-protection.js).
  'avatarfilter_force:': handleAvatarFilterForce,
  'avatarfilter_import:': handleAvatarFilterImport,
  'avatarfilter_no:': handleAvatarFilterCancel,
  // `/tools checkurl` report / dispute buttons (core/domain-reports.js).
  'domrep_report:': handleDomainReportButton,
  'domrep_dispute:': handleDomainReportButton,
  // `/lockdown start|stop` confirm / cancel (interactions/buttons/raid_lockdown.js keeps the request).
  'rlock_go:': handleLockdownConfirm,
  'rlock_no:': handleLockdownCancel,
  // Event reminder DM "stop reminders from this server" (pressed in a DM; guild id rides in the customId).
  'evrem_optout:': handleEventReminderOptOut,

  // /setup wizard buttons
  'setup_on_': handleSetupButton,
  'setup_apply_': handleSetupButton,
  'setup_home_': handleSetupButton,
  'setup_cat_': handleSetupButton,

  // Commission filter review decisions
  'commrev_del:': handleCommissionReview,
  'commrev_ok:': handleCommissionReview,
  'commfp:': handleCommissionFalsePositive,
  'commoff:': handleCommissionFalsePositive,

  // /privacy delete confirm/cancel. Ids carry the user and issue time — see interactions/buttons/privacy_delete.js.
  'privdel:': handlePrivacyDeleteButton,

  // Link policy decisions
  'linkok:': handleLinkReview,
  'linkfp:': handleLinkReview,
  'linkdeny:': handleLinkReview,

  // Message threats: Ban / Dismiss on flagged-message cards (interactions/buttons/message_threats.js).
  'mthreat_ban:': handleMessageThreatButton,
  'mthreat_ok:': handleMessageThreatButton,
  // Filtered words: Warn / Mute / Kick / Ban / Dismiss on the moderators' card.
  'wfilter:': handleWordFilterButton,

  // Ticket handlers
  'ticket_create': handleTicketCreate,
  'ticket_close_': handleTicketClose,
  'ticket_feedback_': handleTicketFeedback,

  // Standalone form panels. The panel button opens an ephemeral STEPPER rather than a modal:
  // a modal caps a question at 45 characters of heading plus 100 of help text, which cannot show
  // a long question at all. See core/form-flow.js.
  'form_open_': handleFormOpen,
  'formq_back_': handleFormNav,
  'formq_next_': handleFormNav,
  'formq_submit_': handleFormNav,
  'formq_txt_': handleFormText,
  // Replying to an applicant from the notification DM itself. `_t_` only PREVIEWS; `_c_` is the
  // single path that actually sends, so no one press can put a message in front of a real person.
  'formrep_t_': handleFormReplyTemplate,
  'formrep_c_': handleFormReplyConfirm,
  'formrep_e_': handleFormReplyEdit,
  'formrep_x': handleFormReplyCancel,
  'formrep_w_': handleFormReplyWrite,

  // Suggestion handlers
  'suggestion_upvote_': handleSuggestionUpvote,
  'suggestion_downvote_': handleSuggestionDownvote,
  // Approve / Reject on a held suggestion's review card (core/suggestion-review.js).
  'sgr:approve:': handleSuggestionReviewButton,
  'sgr:reject:': handleSuggestionReviewButton,

  // Trivia handler
  'trivia_answer_': handleTriviaButton,
  // /tournament sign-up Join/Leave and report Confirm/Dispute: bgt:join|leave:<tid>, bgt:ok|no:<matchId>
  'bgt:': handleTournamentButton,

  // RPG battle handlers
  'rpg_battle_attack': withRpgAchievementNotices(handleBattleAttack),
  'rpg_battle_flee': withRpgAchievementNotices(handleBattleFlee),

  // RPG quick action handlers
  'rpg_quick_attack': withRpgAchievementNotices(handleQuickAttack),
  'rpg_quick_search': withRpgAchievementNotices(handleQuickSearch),
  'rpg_quick_talk': withRpgAchievementNotices(handleQuickTalk),
  'rpg_quick_rest': withRpgAchievementNotices(handleQuickRest),

  // Announcement handlers
  'request_announcement_button_': handleRequestAnnouncementButton,
  'approve_announcement_': handleApproveAnnouncement,
  'deny_announcement_': handleDenyAnnouncement,

  // Panel handlers
  'panel_create_basic': handlePanelCreateBasic,

  // Poll handlers
  'poll_write_in': handlePollWriteIn,

  // Staff intro
  'staff_intro_button': handleStaffIntroButton,

  // Forum submit buttons
  'forum_submit_suggestion': handleSuggestionFormButton,
  'forum_submit_bug_report': handleBugReportFormButton,

  // Verification (core/verification.js): the panel button ("I agree" or "Verify me" by mode), the old
  // `/admin verification setup` panel's id, the CAPTCHA keypad and the `/systems verification setup` preview.
  'verify_accept': handleVerifyAccept,
  'verify_member': handleVerifyAccept,
  'vcap:': handleVerifyKeypad,
  'vwiz_ok:': handleVerifyWizardConfirm,
  'vwiz_no:': handleVerifyWizardCancel,
  // Static ids: the tree is resolved from the guild, so old messages keep working.
  'tree_grow': handleTreeGrow,
  // Prefix match: `dgt:accept:<trade id>`, `dgt:decline:<id>`, `dgt:cancel:<id>`. Survives restarts, unlike a collector.
  'dgt:': handleDigimonTrade,
  // Prefix match: the encounter id rides in the customId (`gat_net:12`, `gat_basket:12:3`).
  'gat_net': handleTreeCatch,
  'gat_basket': handleTreeCatch,
  'tree_refresh': handleTreeRefresh,

  // Cat Bot: cbg:<game>:<action> tables, cbq:<claim|season> battlepass.
  'cbg:': handleCatGameButton,
  'cbq:': handleCatQuestButton,

  // Critters guild boss: guildboss_fight | guildboss_leaderboard | guildboss_inspect (static ids; the handler checks
  // the game is on, the boss switch and the game channels / blocked roles first).
  'guildboss_': handleGuildBossButton,

  // Takeover plan confirm/cancel (tko:apply | tko:cancel)
  'tko:': handleTakeoverButton,

  // Stream signup button
  'stream_signup_add': handleStreamSignupAdd,

  // Giveaway panel — role-gated in code, because /manage is hidden from any role
  // without Manage Server and Discord filters that before we ever see it.
  'giveaway_create': handleGiveawayCreateButton,

  // Live PvP combat action buttons (pvp_act:<matchId>:attack|defend|forfeit)
  'pvp_act:': withRpgAchievementNotices(handlePvpAct),

  // Self-promo "add me" button (level-gated → opens paste-links modal)
  'selfpromo_join': handleSelfPromoJoin,
  // "Track a friend's stream" — same flow, but never links the clicker's Discord
  'selfpromo_friend': handleSelfPromoFriend,
  'showcase_upload': handleShowcaseUploadButton,

  // CAH buttons
  'cah_join:': handleCahJoin,
  'cah_leave:': handleCahLeave,
  'cah_startgame:': handleCahStart,
  'cah_hand:': handleCahHand,
  'cah_status:': handleCahStatus,
  'cah_judge:': handleCahJudge,
  'fw_shop_page:': handleFourthwallShopPage,

  // Birthday admin entry button
  'bday:adminstart': handleBirthdayAdminStart,
  'bday:adminremove': handleBirthdayAdminRemoveStart,

  // Birthday self-service set (opens month/day/year modal) and removal
  'bday:open': handleBirthdayOpen,
  'bday:removeself': handleBirthdayRemoveSelf,

  // Cinema control buttons
  'cinema_pause': handleCinemaButton,
  'cinema_resume': handleCinemaButton,
  'cinema_seek': handleCinemaButton,
  'cinema_stop': handleCinemaButton,
  'cinema_skip': handleCinemaButton,
  'cinema_start:': handleCinemaStart,
  // Discord Activities: "Open Watch Together" / "Play Greenhouse Tycoon" (handlers/activities/launch.js)
  'activity_open:': handleActivityOpen,
  'cinema_epi_page:': handleCinemaEpiPage,
  'cinema_play_season:': handleCinemaPlaySeason,
  'cinema_play_from:': handleCinemaPlayFrom,
  'cinema_showfrom:': handleCinemaShowFrom,
  'cinema_playshow:': handleCinemaPlayShow,
  'theater_bpage:': handleTheaterBrowsePage,

  // Fishing minigame buttons
  'fish_again': handleFishAgain,
  'fish_sellall': handleFishSellAll,
  'fish_inv': handleFishInv,

  // Soundboard panel buttons (sb_play:<soundId>) + pagination (sb_page:<n>)
  'sb_play:': handleSoundboardPlay,
  'sb_page:': handleSoundboardPage,

  // Steam library panel (static ids) + game night RSVPs (stlib_rsvp:<nightId>:<in|maybe|out>).
  'stlib_': handleSteamLibraryButton,
  // Economy heists (heist:join|cancel:<heistId>) and trades (trade:acc|ctr|dec|can:<tradeId>); ids ride in the customId.
  'heist:': handleHeistButton,
  'trade:': handleTradeButton,

  // Modmail (core/modmail-manager.js). DM: mmail_open:<guildId>:<dmMsgId>, mmail_cancel.
  // Staff channel: mmail_close:<threadId> (opens the reason modal), mmail_block:<threadId>.
  'mmail_open:': handleModmailOpen,
  'mmail_cancel': handleModmailCancel,
  'mmail_close:': handleModmailClose,
  'mmail_block:': handleModmailBlock,
  'lastfm_verify:': handleLastfmVerify,
};

/**
 * Select menu handler registry
 * Maps select menu customIds to their handlers
 */
// Forward-message channel select — dispatches to the context-command module's
// onChannelSelect handler. The customId shape is `forward-msg:dst:<srcChan>:<srcMsg>`
// so we match the prefix.
async function handleForwardMessageSelect(interaction) {
  const mod = await import('../commands/context/forward-message.js');
  return mod.default.onChannelSelect(interaction);
}

export const selectMenuHandlers = {
  'forward-msg:dst:': handleForwardMessageSelect,
  'build_add_channel_cat': handleAddChannelCategory,
  // one menu per shade group: colour_pick:pinks, colour_pick:warm, …
  'colour_pick:': handleColourPick,
  // Every answer control in the form stepper — string, user, role and channel selects all route
  // here and are decoded from the question row.
  'formq_sel_': handleFormAnswer,
  // The select-menu form of "send a saved reply", used when a form has more than four templates.
  'formrep_s_': handleFormReplyTemplate,
  'panel_select_category': handlePanelSelectCategory,
  'panel_select_channel': handlePanelSelectChannel,
  'panel_select_role': handlePanelSelectRole,
  'cah_pick:': handleCahPick,

  // Feature catalog category dropdown. Prefix-matched and fully
  // stateless (the customId carries everything), so it keeps working
  // across restarts without reposting the message.
  'discover:': handleDiscoverSelect,
  'fw_shop_pick:': handleFourthwallShopPick,

  // Birthday panel selects
  'bday:month': handleBirthdayMonthSelect,
  'bday:adminmonth:': handleBirthdayMonthSelect,
  'bday:adminuser': handleBirthdayAdminUserSelect,
  'bday:adminremoveuser': handleBirthdayAdminRemoveUserSelect,

  // Cinema track-select menus
  'cinema_audio:': handleCinemaSelect,
  'theater_result': handleTheaterResultSelect,
  'theater_browse': handleTheaterBrowse,
  'theater_pick:': handleTheaterPick,
  'cinema_sub:': handleCinemaSelect,
  'cinema_season:': handleCinemaSeasonSelect,
  'cinema_episode:': handleCinemaEpisodeSelect,

  // /setup wizard channel picker
  'setup_chan_': handleSetupChannelSelect,
  'setup_role_': handleSetupRoleSelect,
  // String selects. Note 'setup_cat_menu' (a select) and 'setup_cat_<Category>'
  // (a button) look alike but live in separate registries, so they cannot
  // collide. getSelectMenuHandler tries exact match before prefix, so the
  // exact 'setup_cat_menu' entry wins over any prefix rule.
  'setup_preset_': handleSetupSelect,
  'setup_cat_menu': handleSetupSelect,
  'setup_feat_': handleSetupSelect,
  // Modmail DM pickers: which server to contact / which open conversation a DM is for.
  'mmail_pick:': handleModmailPick,
  'mmail_route:': handleModmailRoute,
};

/**
 * Modal handler registry
 * Maps modal customId prefixes to their handlers
 */
export const modalHandlers = {
  // Reason for rejecting a suggestion from its review card.
  'sgr:rejectmodal:': handleSuggestionRejectModal,
  // Right-click "Report DM spam" modal (commands/context/report-dm-spam.js). customId carries the
  // reported user id after the `dmreport:` prefix.
  'dmreport:': handleDmReportModal,
  'schedstyle_modal:': handleScheduleStyleModal,
  'build_add_channel_modal:': handleAddChannelModal,
  'build_add_role_modal': handleAddRoleModal,
  'build_rename_modal': handleRenameModal,
  'build_restyle_modal': handleRestyleModal,
  'build_request_modal': handleBuildRequestModal,
  'colour_custom_modal': handleColourCustomModal,
  'jgate_form:': handleJoinGateSubmit,
  // `/tools checkurl` report / dispute reason (interactions/buttons/domain_report.js).
  'domrep_modal:': handleDomainReportModal,
  // Reason (and mute length) behind the filtered-word card's buttons.
  'wfilter_modal:': handleWordFilterModal,
  // CAPTCHA "type it" box (core/verification.js).
  'vcapm:': handleVerifyModal,
  'stlib_paste_modal': handleSteamLibraryPasteModal,
  'ticket_form_submit_': handleTicketFormSubmit,
  // Standalone form panels (dashboard → Forms). Distinct from the ticket flow: these record a
  // response and post it, they do not open a ticket channel.
  // One typed answer from the stepper's single-field modal.
  'formq_mod_': handleFormTextAnswer,
  'formrep_m_': handleFormReplyModal,
  'ticket_feedback_comment_': handleTicketFeedbackModal,
  'announcement_request_form_': handleAnnouncementRequestForm,
  'panel_create_modal': handlePanelCreateModal,
  'poll_write_in_submit_': handlePollWriteInSubmit,
  'announce_modal:': handleAnnounceModal,
  'embed_create_': handleEmbedCreate,
  'embed_edit_': handleEmbedEdit,
  'staff_intro_submit': handleStaffIntroSubmit,
  'forum_suggestion_submit': handleForumSuggestionSubmit,
  'forum_bug_report_submit': handleForumBugReportSubmit,
  'stream_signup_submit': handleStreamSignupSubmit,
  'giveaway_create_modal': handleGiveawayCreateModal,
  'selfpromo_join_modal': handleSelfPromoJoinModal,
  'selfpromo_friend_modal': handleSelfPromoFriendModal,
  'cah_blank:': handleCahBlankSubmit,
  'cah_pwjoin:': handleCahPasswordJoin,
  'fourthwall_setup_submit': handleFourthwallSetupSubmit,
  'bmc_link_submit': handleBmcLinkSubmit,

  // Birthday set modal (self + admin)
  'bday:modal:': handleBirthdaySetModal,

  // Cinema seek modal
  'cinema_seek_modal': handleCinemaSeekModal,
  'theater_search_modal': handleTheaterSearchModal,

  // /fun confess. Registered here because the old route looked up commands.get('confess') — a
  // command that hasn't existed since confess.js was folded into /fun, so every submission fell
  // through unhandled and died as "This interaction failed".
  'confession_modal': handleConfessModal,

  // /admin roles bulk-create. The options ride in the customId after the prefix,
  // so this stays message-independent and survives a restart mid-form.
  'bulkroles:': handleBulkCreateModal,
  'heist_stake:': handleHeistStakeModal,
  'trade_ctr:': handleTradeCounterModal,
  'poll_bet_modal:': handlePollBetSubmit,

  // Modmail close reason (mmail_closem:<threadId>).
  'mmail_closem:': handleModmailCloseModal
};

/**
 * Get a button handler for the given customId
 * @param {string} customId - The button's customId
 * @returns {Function|null} The handler function or null if not found
 */
export function getButtonHandler(customId) {
  // Check exact matches first
  if (buttonHandlers[customId]) {
    return buttonHandlers[customId];
  }

  // Check prefix matches
  for (const [prefix, handler] of Object.entries(buttonHandlers)) {
    if (customId.startsWith(prefix)) {
      return handler;
    }
  }

  return null;
}

/**
 * Get a select menu handler for the given customId
 * @param {string} customId - The select menu's customId
 * @returns {Function|null} The handler function or null if not found
 */
export function getSelectMenuHandler(customId) {
  if (selectMenuHandlers[customId]) return selectMenuHandlers[customId];
  for (const [prefix, handler] of Object.entries(selectMenuHandlers)) {
    if (customId.startsWith(prefix)) return handler;
  }
  return null;
}

/**
 * Get a modal handler for the given customId
 * @param {string} customId - The modal's customId
 * @returns {Function|null} The handler function or null if not found
 */
export function getModalHandler(customId) {
  // Check exact matches first
  if (modalHandlers[customId]) {
    return modalHandlers[customId];
  }

  // Check prefix matches
  for (const [prefix, handler] of Object.entries(modalHandlers)) {
    if (customId.startsWith(prefix)) {
      return handler;
    }
  }

  return null;
}

logger.info('[HandlerRegistry] Pre-loaded all interaction handlers');
