/**
 * CertiFried Dashboard - Main Application JavaScript
 * Initializes components and handles global functionality
 */

(function() {
    'use strict';

    // Global namespace
    window.Dashboard = window.Dashboard || {};

    /**
     * Initialize dashboard when DOM is ready
     */
    document.addEventListener('DOMContentLoaded', () => {
        Dashboard.init();
    });

    /**
     * Main initialization
     */
    Dashboard.init = function() {
        console.log('[Dashboard] Initializing...');

        // Initialize components
        this.initSidebar();
        this.initMobileMenu();
        this.initDropdowns();
        this.initModals();
        this.initTabs();
        this.initConfirmButtons();
        this.initCopyButtons();
        this.initColorPickers();
        this.initDataTables();

        // Initialize forms with auto-save indicator
        this.initFormTracking();

        console.log('[Dashboard] Initialization complete');
    };

    /**
     * Sidebar functionality
     */
    Dashboard.initSidebar = function() {
        const sidebar = document.querySelector('.sidebar');
        const toggleBtn = document.querySelector('[data-sidebar-toggle]');
        const mainContent = document.querySelector('.main-content');

        if (!sidebar || !toggleBtn) return;

        // Load saved state
        const isCollapsed = localStorage.getItem('sidebar-collapsed') === 'true';
        if (isCollapsed) {
            sidebar.classList.add('sidebar-collapsed');
            mainContent?.classList.add('main-content-collapsed');
        }

        toggleBtn.addEventListener('click', () => {
            sidebar.classList.toggle('sidebar-collapsed');
            mainContent?.classList.toggle('main-content-collapsed');
            localStorage.setItem('sidebar-collapsed', sidebar.classList.contains('sidebar-collapsed'));
        });
    };

    /**
     * Mobile menu
     */
    Dashboard.initMobileMenu = function() {
        const menuBtn = document.querySelector('[data-mobile-menu-toggle]');
        const menu = document.querySelector('[data-mobile-menu]');

        if (!menuBtn || !menu) return;

        menuBtn.addEventListener('click', () => {
            menu.classList.toggle('hidden');
            menu.classList.toggle('animate-slide-down');
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!menu.contains(e.target) && !menuBtn.contains(e.target)) {
                menu.classList.add('hidden');
            }
        });
    };

    /**
     * Dropdown menus
     */
    Dashboard.initDropdowns = function() {
        document.querySelectorAll('[data-dropdown]').forEach(dropdown => {
            const trigger = dropdown.querySelector('[data-dropdown-trigger]');
            const menu = dropdown.querySelector('[data-dropdown-menu]');

            if (!trigger || !menu) return;

            trigger.addEventListener('click', (e) => {
                e.stopPropagation();

                // Close other dropdowns
                document.querySelectorAll('[data-dropdown-menu]:not(.hidden)').forEach(m => {
                    if (m !== menu) m.classList.add('hidden');
                });

                menu.classList.toggle('hidden');
            });
        });

        // Close all dropdowns on outside click
        document.addEventListener('click', () => {
            document.querySelectorAll('[data-dropdown-menu]').forEach(menu => {
                menu.classList.add('hidden');
            });
        });
    };

    /**
     * Modal dialogs
     */
    Dashboard.initModals = function() {
        // Open modal triggers
        document.querySelectorAll('[data-modal-open]').forEach(trigger => {
            trigger.addEventListener('click', () => {
                const modalId = trigger.dataset.modalOpen;
                this.openModal(modalId);
            });
        });

        // Close modal triggers
        document.querySelectorAll('[data-modal-close]').forEach(trigger => {
            trigger.addEventListener('click', () => {
                const modal = trigger.closest('.modal-overlay');
                if (modal) this.closeModal(modal);
            });
        });

        // Close on overlay click
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    this.closeModal(overlay);
                }
            });
        });

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const openModal = document.querySelector('.modal-overlay:not(.hidden)');
                if (openModal) this.closeModal(openModal);
            }
        });
    };

    Dashboard.openModal = function(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;

        modal.classList.remove('hidden');
        document.body.classList.add('overflow-hidden');

        // Focus first input
        const firstInput = modal.querySelector('input, select, textarea');
        if (firstInput) firstInput.focus();
    };

    Dashboard.closeModal = function(modal) {
        if (typeof modal === 'string') {
            modal = document.getElementById(modal);
        }
        if (!modal) return;

        modal.classList.add('hidden');
        document.body.classList.remove('overflow-hidden');
    };

    /**
     * Tab navigation
     */
    Dashboard.initTabs = function() {
        document.querySelectorAll('[data-tabs]').forEach(tabContainer => {
            const tabs = tabContainer.querySelectorAll('[data-tab]');
            const panels = tabContainer.querySelectorAll('[data-tab-panel]');

            tabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    const targetPanel = tab.dataset.tab;

                    // Update tab states
                    tabs.forEach(t => {
                        t.classList.remove('active', 'border-primary-500', 'text-white');
                        t.classList.add('border-transparent', 'text-gray-400');
                    });
                    tab.classList.add('active', 'border-primary-500', 'text-white');
                    tab.classList.remove('border-transparent', 'text-gray-400');

                    // Update panel visibility
                    panels.forEach(panel => {
                        panel.classList.add('hidden');
                        if (panel.dataset.tabPanel === targetPanel) {
                            panel.classList.remove('hidden');
                        }
                    });

                    // Update URL hash
                    history.replaceState(null, '', `#${targetPanel}`);
                });
            });

            // Check URL hash on load
            const hash = window.location.hash.slice(1);
            if (hash) {
                const targetTab = tabContainer.querySelector(`[data-tab="${hash}"]`);
                if (targetTab) targetTab.click();
            }
        });
    };

    /**
     * Confirmation buttons
     */
    Dashboard.initConfirmButtons = function() {
        document.querySelectorAll('[data-confirm]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const message = btn.dataset.confirm || 'Are you sure?';
                if (!confirm(message)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            });
        });
    };

    /**
     * Copy to clipboard buttons
     */
    Dashboard.initCopyButtons = function() {
        document.querySelectorAll('[data-copy]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const text = btn.dataset.copy || btn.textContent;

                try {
                    await navigator.clipboard.writeText(text);

                    // Show feedback
                    const originalHTML = btn.innerHTML;
                    btn.innerHTML = '<svg class="w-4 h-4 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';

                    setTimeout(() => {
                        btn.innerHTML = originalHTML;
                    }, 2000);

                    showToast('success', 'Copied to clipboard');
                } catch (err) {
                    showToast('error', 'Failed to copy');
                }
            });
        });
    };

    /**
     * Color picker enhancement
     */
    Dashboard.initColorPickers = function() {
        document.querySelectorAll('.color-picker-wrapper').forEach(wrapper => {
            const input = wrapper.querySelector('input[type="color"]');
            const textInput = wrapper.querySelector('input[type="text"]');

            if (!input || !textInput) return;

            // Sync color picker to text
            input.addEventListener('input', () => {
                textInput.value = input.value.toUpperCase();
            });

            // Sync text to color picker
            textInput.addEventListener('change', () => {
                const color = textInput.value;
                if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
                    input.value = color;
                }
            });
        });
    };

    /**
     * Data tables with sorting
     */
    Dashboard.initDataTables = function() {
        document.querySelectorAll('.data-table[data-sortable]').forEach(table => {
            const headers = table.querySelectorAll('th[data-sort]');

            headers.forEach(header => {
                header.classList.add('cursor-pointer', 'select-none');
                header.addEventListener('click', () => {
                    const column = header.dataset.sort;
                    const isAsc = header.dataset.sortDir !== 'asc';

                    // Reset other headers
                    headers.forEach(h => {
                        h.dataset.sortDir = '';
                        h.querySelector('.sort-icon')?.remove();
                    });

                    // Set current header
                    header.dataset.sortDir = isAsc ? 'asc' : 'desc';
                    header.innerHTML += `<span class="sort-icon ml-1">${isAsc ? '↑' : '↓'}</span>`;

                    // Sort table
                    this.sortTable(table, column, isAsc);
                });
            });
        });
    };

    Dashboard.sortTable = function(table, column, isAsc) {
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const columnIndex = Array.from(table.querySelectorAll('th')).findIndex(th => th.dataset.sort === column);

        rows.sort((a, b) => {
            const aValue = a.cells[columnIndex]?.textContent.trim() || '';
            const bValue = b.cells[columnIndex]?.textContent.trim() || '';

            // Try numeric sort
            const aNum = parseFloat(aValue);
            const bNum = parseFloat(bValue);
            if (!isNaN(aNum) && !isNaN(bNum)) {
                return isAsc ? aNum - bNum : bNum - aNum;
            }

            // String sort
            return isAsc ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
        });

        rows.forEach(row => tbody.appendChild(row));
    };

    /**
     * Form change tracking
     */
    Dashboard.initFormTracking = function() {
        document.querySelectorAll('form[data-track-changes]').forEach(form => {
            const indicator = form.querySelector('[data-unsaved-indicator]');

            const markUnsaved = () => {
                form.dataset.changed = 'true';
                if (indicator) indicator.classList.remove('hidden');
            };

            const markSaved = () => {
                form.dataset.changed = 'false';
                if (indicator) indicator.classList.add('hidden');
            };

            form.addEventListener('change', markUnsaved);
            form.addEventListener('submit', markSaved);
        });
    };

    /**
     * Utility: Debounce function
     */
    Dashboard.debounce = function(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    };

    /**
     * Utility: Format number
     */
    Dashboard.formatNumber = function(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    };

    /**
     * Utility: Format relative time
     */
    Dashboard.formatRelativeTime = function(date) {
        const now = new Date();
        const diff = now - new Date(date);
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ago`;
        if (hours > 0) return `${hours}h ago`;
        if (minutes > 0) return `${minutes}m ago`;
        return 'Just now';
    };

})();
