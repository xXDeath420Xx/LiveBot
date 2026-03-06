/**
 * CertiFried Extension - App Container Component
 * Handles view switching between tabs with VIEW CACHING
 * Components are kept in memory and shown/hidden for fast switching
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';

// Import all view components to ensure they're registered
// Main tabs
import './cf-garden.js';
import './cf-shop.js';
import './cf-inventory.js';
import './cf-market.js';
import './cf-breeding.js';
import './cf-quests.js';
import './cf-more.js';

// Sub-views accessed from "More" menu - MUST be imported to register custom elements
import './cf-dashboard.js';
import './cf-timers.js';
import './cf-ai-assistant.js';
import './cf-daily-rewards.js';
import './cf-facilities.js';
import './cf-expansions.js';
import './cf-training.js';
import './cf-breeding-history.js';
import './cf-upgrades.js';
import './cf-permanent-unlocks.js';
import './cf-favorites.js';
import './cf-market-alerts.js';
import './cf-vault.js';
import './cf-raids.js';
import './cf-contracts.js';
import './cf-extraction.js';
import './cf-black-market.js';
import './cf-mutations.js';
import './cf-research.js';
import './cf-equipment.js';
import './cf-locations.js';
import './cf-cartel.js';
import './cf-territories.js';
import './cf-tournaments.js';
import './cf-reputation.js';
import './cf-dispensary.js';
import './cf-minigames.js';
import './cf-bosses.js';
import './cf-random-events.js';
import './cf-events.js';
import './cf-stats.js';
import './cf-quality-info.js';
import './cf-bonuses.js';
import './cf-trading.js';
import './cf-workers.js';
import './cf-strains.js';
import './cf-notifications.js';
import './cf-skills.js';
import './cf-prestige.js';
import './cf-leaderboard.js';
import './cf-achievements.js';
import './cf-settings.js';

// UI components
import './cf-strain-selector.js';
import './cf-header.js';
import './cf-nav.js';
import './cf-toast.js';
import './cf-modal.js';
import './cf-tutorial.js';
import './cf-offline-progress.js';
import './cf-heat-indicator.js';

class CFAppContainer extends CFBaseComponent {
    constructor() {
        super();
        // Cache for view components - keeps them alive between tab switches
        this._viewCache = new Map();
        this._currentTab = null;
    }

    _setupSubscriptions() {
        this.subscribe('ui.activeTab');
        this.subscribe('auth.isAuthenticated');
    }

    onMount() {
        // Listen for tab changes from nav
        document.addEventListener('tab-change', (e) => {
            this.render();
        });
    }

    onUnmount() {
        // Clear cache when container is removed
        this._viewCache.clear();
    }

    render() {
        const activeTab = this.getState('ui.activeTab') || 'garden';
        const isAuthenticated = this.getState('auth.isAuthenticated');

        this.className = 'cf-main';

        // If not authenticated, show login prompt and clear cache
        if (!isAuthenticated) {
            this._viewCache.clear();
            this._currentTab = null;
            this.setContent(
                h('div', { class: 'cf-empty' },
                    h('p', { class: 'cf-empty__title' }, 'Welcome to CertiFried'),
                    h('p', { class: 'cf-empty__description' }, 'Connect your account to start growing!')
                )
            );
            return;
        }

        // If tab hasn't changed, do nothing
        if (this._currentTab === activeTab && this._viewCache.has(activeTab)) {
            return;
        }

        // Hide current view (don't remove - keep in DOM for caching)
        if (this._currentTab && this._viewCache.has(this._currentTab)) {
            const oldView = this._viewCache.get(this._currentTab);
            oldView.style.display = 'none';
            oldView.classList.remove('cf-view--active');
        }

        // Get or create the view
        let viewElement = this._viewCache.get(activeTab);
        if (!viewElement) {
            viewElement = this._createViewElement(activeTab);
            viewElement.classList.add('cf-view');
            this._viewCache.set(activeTab, viewElement);
            this.appendChild(viewElement);
        }

        // Show the view
        viewElement.style.display = '';
        viewElement.classList.add('cf-view--active');
        this._currentTab = activeTab;
    }

    _createViewElement(tab) {
        const views = {
            garden: 'cf-garden',
            shop: 'cf-shop',
            inventory: 'cf-inventory',
            market: 'cf-market',
            breeding: 'cf-breeding',
            quests: 'cf-quests',
            more: 'cf-more'
        };

        const tagName = views[tab] || views.garden;
        return document.createElement(tagName);
    }
}

registerComponent('cf-app-container', CFAppContainer);
export default CFAppContainer;
