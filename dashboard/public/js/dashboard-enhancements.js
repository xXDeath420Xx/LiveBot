/**
 * CertiFried Dashboard Enhancements
 * Client-side validation, confirmations, search, and UX improvements
 */

// ==================== FORM VALIDATION ====================

/**
 * Validate all forms before submission
 */
document.addEventListener('DOMContentLoaded', () => {
    // Add validation to all forms
    document.querySelectorAll('form').forEach(form => {
        form.addEventListener('submit', function(e) {
            if (!validateForm(this)) {
                e.preventDefault();
                return false;
            }
        });
    });

    // Initialize search boxes
    initializeSearch();

    // Initialize pagination
    initializePagination();

    // Initialize confirmation dialogs
    initializeConfirmations();
});

/**
 * Validate a form
 */
function validateForm(form) {
    let isValid = true;
    const errors = [];

    // Clear previous errors
    form.querySelectorAll('.error-message').forEach(el => el.remove());
    form.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));

    // Validate required fields
    form.querySelectorAll('[required]').forEach(field => {
        if (!field.value || field.value.trim() === '') {
            isValid = false;
            errors.push(`${getFieldLabel(field)} is required`);
            markFieldInvalid(field, 'This field is required');
        }
    });

    // Validate numbers
    form.querySelectorAll('input[type="number"]').forEach(field => {
        const value = parseInt(field.value);
        const min = field.getAttribute('min');
        const max = field.getAttribute('max');

        if (field.value !== '' && isNaN(value)) {
            isValid = false;
            markFieldInvalid(field, 'Must be a valid number');
        } else if (min !== null && value < parseInt(min)) {
            isValid = false;
            markFieldInvalid(field, `Must be at least ${min}`);
        } else if (max !== null && value > parseInt(max)) {
            isValid = false;
            markFieldInvalid(field, `Must be at most ${max}`);
        }
    });

    // Validate URLs
    form.querySelectorAll('input[type="url"]').forEach(field => {
        if (field.value && !isValidUrl(field.value)) {
            isValid = false;
            markFieldInvalid(field, 'Must be a valid URL');
        }
    });

    // Validate Discord IDs (snowflakes)
    form.querySelectorAll('.discord-id').forEach(field => {
        if (field.value && !isValidDiscordId(field.value)) {
            isValid = false;
            markFieldInvalid(field, 'Must be a valid Discord ID (17-20 digits)');
        }
    });

    // Validate usernames
    form.querySelectorAll('.username-field').forEach(field => {
        if (field.value && !isValidUsername(field.value)) {
            isValid = false;
            markFieldInvalid(field, 'Invalid username format');
        }
    });

    return isValid;
}

function getFieldLabel(field) {
    const label = field.closest('.form-group')?.querySelector('label');
    return label ? label.textContent.replace('*', '').trim() : field.name;
}

function markFieldInvalid(field, message) {
    field.classList.add('is-invalid');
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message text-danger small mt-1';
    errorDiv.textContent = message;
    field.parentElement.appendChild(errorDiv);
}

function isValidUrl(string) {
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function isValidDiscordId(id) {
    return /^\d{17,20}$/.test(id);
}

function isValidUsername(username) {
    // Allow alphanumeric, underscores, hyphens (most platforms)
    return /^[a-zA-Z0-9_-]{1,32}$/.test(username);
}

// ==================== CONFIRMATION DIALOGS ====================

function initializeConfirmations() {
    // Add confirmation to delete buttons
    document.querySelectorAll('[data-confirm]').forEach(button => {
        button.addEventListener('click', function(e) {
            const message = this.dataset.confirm || 'Are you sure?';
            if (!confirm(message)) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
    });

    // Special confirmation for restore backup (requires typing RESTORE)
    const restoreForm = document.querySelector('form[action*="restore-backup"]');
    if (restoreForm) {
        restoreForm.addEventListener('submit', function(e) {
            const password = prompt('Type RESTORE to confirm this destructive action:');
            if (password !== 'RESTORE') {
                e.preventDefault();
                alert('Restore cancelled. You must type RESTORE exactly.');
                return false;
            }

            // Add password to form
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'confirmPassword';
            input.value = password;
            this.appendChild(input);
        });
    }
}

// ==================== SEARCH FUNCTIONALITY ====================

function initializeSearch() {
    // Add search boxes to tables
    document.querySelectorAll('table.searchable').forEach(table => {
        const searchBox = createSearchBox(table);
        table.parentElement.insertBefore(searchBox, table);
    });

    // Auto-add searchable class to large tables
    document.querySelectorAll('table tbody').forEach(tbody => {
        if (tbody.querySelectorAll('tr').length > 10) {
            tbody.closest('table').classList.add('searchable');
        }
    });
}

function createSearchBox(table) {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-search mb-3';
    wrapper.innerHTML = `
        <input type="text" class="form-control" placeholder="🔍 Search..." aria-label="Search table">
    `;

    const input = wrapper.querySelector('input');
    input.addEventListener('input', function() {
        filterTable(table, this.value);
    });

    return wrapper;
}

function filterTable(table, query) {
    const rows = table.querySelectorAll('tbody tr');
    const searchTerm = query.toLowerCase();

    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        if (text.includes(searchTerm)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });

    // Update "no results" message
    const visibleRows = Array.from(rows).filter(r => r.style.display !== 'none');
    let noResultsRow = table.querySelector('.no-results-row');

    if (visibleRows.length === 0) {
        if (!noResultsRow) {
            noResultsRow = document.createElement('tr');
            noResultsRow.className = 'no-results-row';
            noResultsRow.innerHTML = `<td colspan="100" class="text-center text-muted py-4">No results found for "${query}"</td>`;
            table.querySelector('tbody').appendChild(noResultsRow);
        }
    } else if (noResultsRow) {
        noResultsRow.remove();
    }
}

// ==================== PAGINATION ====================

function initializePagination() {
    document.querySelectorAll('table.paginated').forEach(table => {
        paginateTable(table, 25); // 25 items per page
    });
}

function paginateTable(table, itemsPerPage) {
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    let currentPage = 1;
    const totalPages = Math.ceil(rows.length / itemsPerPage);

    if (totalPages <= 1) return; // No need for pagination

    // Create pagination controls
    const paginationControls = document.createElement('nav');
    paginationControls.className = 'pagination-controls mt-3';
    paginationControls.setAttribute('aria-label', 'Table pagination');

    const ul = document.createElement('ul');
    ul.className = 'pagination justify-content-center';

    function renderPage(page) {
        currentPage = page;
        const start = (page - 1) * itemsPerPage;
        const end = start + itemsPerPage;

        rows.forEach((row, index) => {
            row.style.display = (index >= start && index < end) ? '' : 'none';
        });

        // Update pagination buttons
        renderPagination();
    }

    function renderPagination() {
        ul.innerHTML = '';

        // Previous button
        const prevLi = document.createElement('li');
        prevLi.className = `page-item ${currentPage === 1 ? 'disabled' : ''}`;
        prevLi.innerHTML = `<a class="page-link" href="#">Previous</a>`;
        prevLi.addEventListener('click', (e) => {
            e.preventDefault();
            if (currentPage > 1) renderPage(currentPage - 1);
        });
        ul.appendChild(prevLi);

        // Page numbers
        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
                const li = document.createElement('li');
                li.className = `page-item ${i === currentPage ? 'active' : ''}`;
                li.innerHTML = `<a class="page-link" href="#">${i}</a>`;
                li.addEventListener('click', (e) => {
                    e.preventDefault();
                    renderPage(i);
                });
                ul.appendChild(li);
            } else if (i === currentPage - 3 || i === currentPage + 3) {
                const li = document.createElement('li');
                li.className = 'page-item disabled';
                li.innerHTML = `<a class="page-link" href="#">...</a>`;
                ul.appendChild(li);
            }
        }

        // Next button
        const nextLi = document.createElement('li');
        nextLi.className = `page-item ${currentPage === totalPages ? 'disabled' : ''}`;
        nextLi.innerHTML = `<a class="page-link" href="#">Next</a>`;
        nextLi.addEventListener('click', (e) => {
            e.preventDefault();
            if (currentPage < totalPages) renderPage(currentPage + 1);
        });
        ul.appendChild(nextLi);
    }

    paginationControls.appendChild(ul);
    table.parentElement.appendChild(paginationControls);

    // Initial render
    renderPage(1);
}

// ==================== REAL-TIME FEATURES ====================

/**
 * Auto-refresh status page every 30 seconds
 */
if (window.location.pathname.includes('/status')) {
    setInterval(() => {
        fetch('/api/status-data')
            .then(res => res.json())
            .then(data => updateStatusPage(data))
            .catch(err => console.error('Status update failed:', err));
    }, 30000);
}

function updateStatusPage(data) {
    // Update live streamer count
    const liveCountEl = document.querySelector('[data-live-count]');
    if (liveCountEl && data.liveStreamers) {
        liveCountEl.textContent = data.liveStreamers.length;
    }

    // Update bot uptime
    const uptimeEl = document.querySelector('[data-uptime]');
    if (uptimeEl && data.uptimeFormatted) {
        uptimeEl.textContent = data.uptimeFormatted;
    }
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Show toast notification
 */
function showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toast-container') || createToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast align-items-center text-white bg-${type} border-0`;
    toast.setAttribute('role', 'alert');
    toast.innerHTML = `
        <div class="d-flex">
            <div class="toast-body">${message}</div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>
    `;

    toastContainer.appendChild(toast);
    const bsToast = new bootstrap.Toast(toast);
    bsToast.show();

    // Remove after hidden
    toast.addEventListener('hidden.bs.toast', () => toast.remove());
}

function createToastContainer() {
    const container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container position-fixed top-0 end-0 p-3';
    document.body.appendChild(container);
    return container;
}

/**
 * Copy to clipboard
 */
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard!', 'success');
    }).catch(err => {
        showToast('Failed to copy', 'danger');
    });
}

// Make functions globally available
window.showToast = showToast;
window.copyToClipboard = copyToClipboard;

console.log('✅ Dashboard enhancements loaded');
