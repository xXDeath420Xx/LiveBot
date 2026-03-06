/**
 * Bot Switcher Component
 * Allows users to switch between different bot instances in a guild
 */

class BotSwitcher {
    constructor(container) {
        this.container = typeof container === 'string' ? document.querySelector(container) : container;
        if (!this.container) return;

        this.isOpen = false;
        this.currentBotId = this.container.dataset.currentBot || 'default';
        this.guildId = this.container.dataset.guildId;

        this.init();
    }

    init() {
        this.trigger = this.container.querySelector('[data-trigger]');
        this.dropdown = this.container.querySelector('[data-dropdown]');
        this.botList = this.container.querySelector('[data-bot-list]');

        if (!this.trigger || !this.dropdown) {
            console.error('[BotSwitcher] Missing required elements');
            return;
        }

        this.bindEvents();
    }

    bindEvents() {
        // Toggle dropdown
        this.trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!this.container.contains(e.target)) {
                this.close();
            }
        });

        // Bot selection
        if (this.botList) {
            this.botList.addEventListener('click', (e) => {
                const botItem = e.target.closest('[data-bot-id]');
                if (botItem) {
                    this.selectBot(botItem.dataset.botId);
                }
            });
        }

        // Keyboard navigation
        this.container.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.close();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                this.navigateOptions(e.key === 'ArrowDown' ? 1 : -1);
            } else if (e.key === 'Enter') {
                const focused = this.botList.querySelector('.focused');
                if (focused) {
                    this.selectBot(focused.dataset.botId);
                }
            }
        });
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }

    open() {
        this.isOpen = true;
        this.dropdown.classList.remove('hidden');
        this.dropdown.classList.add('animate-fade-in');
        this.trigger.setAttribute('aria-expanded', 'true');
    }

    close() {
        this.isOpen = false;
        this.dropdown.classList.add('hidden');
        this.trigger.setAttribute('aria-expanded', 'false');
    }

    async selectBot(botId) {
        if (botId === this.currentBotId) {
            this.close();
            return;
        }

        try {
            // Show loading state
            this.trigger.classList.add('opacity-50', 'pointer-events-none');

            const response = await fetch('/api/bot/switch', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: JSON.stringify({
                    botId,
                    guildId: this.guildId
                })
            });

            const result = await response.json();

            if (response.ok && result.success) {
                // Reload page to reflect new bot context
                window.location.reload();
            } else {
                throw new Error(result.error || 'Failed to switch bot');
            }
        } catch (error) {
            console.error('[BotSwitcher] Error:', error);
            showToast('error', error.message);
            this.trigger.classList.remove('opacity-50', 'pointer-events-none');
        }
    }

    navigateOptions(direction) {
        const items = Array.from(this.botList.querySelectorAll('[data-bot-id]'));
        if (!items.length) return;

        const currentFocused = items.findIndex(item => item.classList.contains('focused'));
        items.forEach(item => item.classList.remove('focused'));

        let newIndex = currentFocused + direction;
        if (newIndex < 0) newIndex = items.length - 1;
        if (newIndex >= items.length) newIndex = 0;

        items[newIndex].classList.add('focused');
        items[newIndex].scrollIntoView({ block: 'nearest' });
    }
}

/**
 * Create bot switcher HTML
 * @param {Object} options - Configuration
 * @returns {string} HTML string
 */
function createBotSwitcherHTML(options = {}) {
    const {
        currentBot = { id: 'default', name: 'Default Bot', avatar: '' },
        availableBots = [],
        guildId = ''
    } = options;

    return `
        <div class="bot-switcher relative" data-current-bot="${currentBot.id}" data-guild-id="${guildId}">
            <button data-trigger class="flex items-center gap-3 px-3 py-2 rounded-lg bg-dark-600 hover:bg-dark-500 border border-dark-400 transition-colors" aria-expanded="false" aria-haspopup="true">
                <img src="${currentBot.avatar}" alt="${currentBot.name}" class="w-8 h-8 rounded-full bg-dark-400">
                <div class="text-left">
                    <p class="text-sm font-medium text-white">${currentBot.name}</p>
                    <p class="text-xs text-gray-400">Current Bot</p>
                </div>
                <svg class="w-4 h-4 text-gray-400 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                </svg>
            </button>

            <div data-dropdown class="hidden absolute top-full left-0 mt-2 w-64 bg-dark-600 border border-dark-400 rounded-lg shadow-lg z-50">
                <div class="p-2 border-b border-dark-400">
                    <p class="text-xs text-gray-400 uppercase tracking-wider px-2">Switch Bot</p>
                </div>
                <div data-bot-list class="max-h-64 overflow-y-auto p-2">
                    ${availableBots.map(bot => `
                        <button data-bot-id="${bot.id}" class="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-dark-500 transition-colors ${bot.id === currentBot.id ? 'bg-primary-500/20' : ''}">
                            <img src="${bot.avatar}" alt="${bot.name}" class="w-8 h-8 rounded-full bg-dark-400">
                            <div class="text-left flex-1 min-w-0">
                                <p class="text-sm font-medium text-white truncate">${bot.name}</p>
                                <p class="text-xs text-gray-400">${bot.username}</p>
                            </div>
                            ${bot.id === currentBot.id ? `
                                <svg class="w-4 h-4 text-primary-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                                </svg>
                            ` : ''}
                            ${bot.isDefault ? '<span class="badge badge-info text-xs">Default</span>' : ''}
                        </button>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
}

// Auto-initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.bot-switcher').forEach(el => new BotSwitcher(el));
});

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { BotSwitcher, createBotSwitcherHTML };
}
