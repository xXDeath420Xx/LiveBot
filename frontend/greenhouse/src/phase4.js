// Phase 4 cards, put into the tabs' slots (slots.js). Five tabs stay five tabs:
//   Grow       grow.top       a reminder when quest rewards are waiting
//              grow.benches   the decorations the player shows, under the benches
//              grow.bottom    quests (today, this week) and the weekly challenge
//   Upgrades   upgrades.top   Replant
//              upgrades.decor the decoration shop (the tab's third section)
//   Profile    profile.season the season card, its reward tiers and the leaderboard
//              profile.achievements  achievements and badges
// The notifications bell is in the top bar (main.js), the review-save switch in main.js and Profile.
import { registerSlot } from './slots.js';
import { questsCard, questsReminder, seasonCard, achievementsCard } from './views/goals.js';
import { replantCard, decorSection, decorStrip } from './views/endgame.js';

registerSlot('grow.top', questsReminder);
registerSlot('grow.benches', decorStrip);
registerSlot('grow.bottom', questsCard);
registerSlot('upgrades.top', replantCard);
registerSlot('upgrades.decor', decorSection);
registerSlot('profile.season', seasonCard);
registerSlot('profile.achievements', achievementsCard);
