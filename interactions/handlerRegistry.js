/**
 * Pre-loaded Interaction Handler Registry
 * Eliminates dynamic imports on each interaction for better performance
 */
import logger from '../utils/logger.js';

// Pre-load all button handlers
import { handleTicketCreate } from './buttons/ticket_create.js';
import { handleTicketClose } from './buttons/ticket_close.js';
import { handleTicketFeedback, handleTicketFeedbackModal } from './buttons/ticket_feedback.js';
import { handleSuggestionUpvote } from './buttons/suggestion_upvote.js';
import { handleSuggestionDownvote } from './buttons/suggestion_downvote.js';
import { handleButton as handleTriviaButton } from '../core/trivia-manager.js';
import { handleBattleAttack, handleBattleFlee } from './buttons/rpg_battle.js';
import { handleQuickAttack, handleQuickSearch, handleQuickTalk, handleQuickRest } from './buttons/rpg_quick_actions.js';
import { handleRequestAnnouncementButton } from './buttons/request_announcement.js';
import { handleApproveAnnouncement, handleDenyAnnouncement } from './buttons/announcement_approval.js';
import { handlePanelCreateBasic } from './buttons/panel_create_basic.js';
import { handlePollWriteIn } from './buttons/poll_write_in.js';
import { handleStaffIntroButton } from './buttons/staff_intro.js';
import { handleSuggestionFormButton, handleBugReportFormButton } from './buttons/forum_submit.js';

// Pre-load all select menu handlers
import { handlePanelSelectCategory, handlePanelSelectChannel, handlePanelSelectRole } from './select-menus/panel_select_handlers.js';

// Pre-load all modal handlers
import { handleTicketFormSubmit } from './modals/ticket_form_submit.js';
import { handleAnnouncementRequestForm } from './modals/announcement_request_form.js';
import { handlePanelCreateModal } from './modals/panel_create_modal.js';
import { handlePollWriteInSubmit } from './modals/poll_write_in_submit.js';
import { handleEmbedCreate, handleEmbedEdit } from './modals/embed_modal.js';
import { handleStaffIntroSubmit } from './modals/staff_intro_submit.js';
import { handleForumSuggestionSubmit, handleForumBugReportSubmit } from './modals/forum_submit_handlers.js';

/**
 * Button handler registry
 * Maps button customId prefixes to their handlers
 */
export const buttonHandlers = {
  // Ticket handlers
  'ticket_create': handleTicketCreate,
  'ticket_close_': handleTicketClose,
  'ticket_feedback_': handleTicketFeedback,

  // Suggestion handlers
  'suggestion_upvote_': handleSuggestionUpvote,
  'suggestion_downvote_': handleSuggestionDownvote,

  // Trivia handler
  'trivia_answer_': handleTriviaButton,

  // RPG battle handlers
  'rpg_battle_attack': handleBattleAttack,
  'rpg_battle_flee': handleBattleFlee,

  // RPG quick action handlers
  'rpg_quick_attack': handleQuickAttack,
  'rpg_quick_search': handleQuickSearch,
  'rpg_quick_talk': handleQuickTalk,
  'rpg_quick_rest': handleQuickRest,

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
  'forum_submit_bug_report': handleBugReportFormButton
};

/**
 * Select menu handler registry
 * Maps select menu customIds to their handlers
 */
export const selectMenuHandlers = {
  'panel_select_category': handlePanelSelectCategory,
  'panel_select_channel': handlePanelSelectChannel,
  'panel_select_role': handlePanelSelectRole
};

/**
 * Modal handler registry
 * Maps modal customId prefixes to their handlers
 */
export const modalHandlers = {
  'ticket_form_submit_': handleTicketFormSubmit,
  'ticket_feedback_comment_': handleTicketFeedbackModal,
  'announcement_request_form_': handleAnnouncementRequestForm,
  'panel_create_modal': handlePanelCreateModal,
  'poll_write_in_submit_': handlePollWriteInSubmit,
  'embed_create_': handleEmbedCreate,
  'embed_edit_': handleEmbedEdit,
  'staff_intro_submit': handleStaffIntroSubmit,
  'forum_suggestion_submit': handleForumSuggestionSubmit,
  'forum_bug_report_submit': handleForumBugReportSubmit
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
  return selectMenuHandlers[customId] || null;
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
