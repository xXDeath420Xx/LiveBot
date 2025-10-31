# Loading States - Code Examples

## Complete Examples for Common Use Cases

### Example 1: Server Settings Form

```html
<!-- HTML Form -->
<form id="settings-form" action="/api/guild/<%= guild.id %>/settings" method="POST">
    <div class="form-group mb-3">
        <label for="prefix" class="form-label">Command Prefix</label>
        <input type="text" id="prefix" name="prefix" class="form-control"
               value="<%= settings.prefix || '!' %>" required>
    </div>

    <div class="form-group mb-3">
        <label for="language" class="form-label">Language</label>
        <select id="language" name="language" class="form-select" required>
            <option value="en">English</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
        </select>
    </div>

    <button type="submit" class="btn btn-primary">Save Settings</button>
</form>

<script>
document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;

    try {
        // Show loading state
        loadingManager.showFormLoading(form);

        // Submit form
        const response = await fetch(form.action, {
            method: form.method,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prefix: form.querySelector('#prefix').value,
                language: form.querySelector('#language').value
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();

        // Hide loading state
        loadingManager.hideFormLoading(form);

        // Show success toast
        loadingManager.showToast('Settings saved successfully!', 'success');

    } catch (error) {
        // Hide loading state
        loadingManager.hideFormLoading(form);

        // Show error toast
        loadingManager.showToast(
            `Failed to save settings: ${error.message}`,
            'error'
        );

        console.error('Form submission error:', error);
    }
});
</script>
```

### Example 2: Dynamic Data Loading with Skeleton

```html
<!-- HTML Container -->
<div id="streamers-container"></div>

<script>
async function loadStreamers(guildId) {
    const container = document.getElementById('streamers-container');

    try {
        // Show skeleton loading
        loadingManager.showDataLoading(container, 'Loading streamers...');

        // Fetch data from API
        const response = await fetch(`/api/guild/${guildId}/streamers`);
        if (!response.ok) throw new Error('Failed to load streamers');

        const streamers = await response.json();

        // Hide loading state
        loadingManager.hideDataLoading(container);

        // Render streamers
        if (streamers.length === 0) {
            container.innerHTML = `
                <div class="alert alert-info">
                    No streamers configured yet.
                </div>
            `;
            return;
        }

        container.innerHTML = streamers.map(streamer => `
            <div class="card mb-2">
                <div class="card-body">
                    <h5 class="card-title">${streamer.name}</h5>
                    <p class="card-text">
                        Platform: ${streamer.platform}
                        <br>
                        Status: ${streamer.live ? '🔴 Live' : '⚪ Offline'}
                    </p>
                </div>
            </div>
        `).join('');

    } catch (error) {
        loadingManager.hideDataLoading(container);
        loadingManager.showToast('Failed to load streamers', 'error');
        console.error('Error loading streamers:', error);
    }
}

// Load on page ready
document.addEventListener('DOMContentLoaded', () => {
    const guildId = '<%= guild.id %>';
    loadStreamers(guildId);
});
</script>
```

### Example 3: Modal with Form Loading

```html
<!-- HTML Modal -->
<div class="modal fade" id="addStreamerModal" tabindex="-1">
    <div class="modal-dialog">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title">Add Streamer</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>

            <form id="add-streamer-form">
                <div class="modal-body">
                    <div class="form-group mb-3">
                        <label for="streamer-name" class="form-label">Username</label>
                        <input type="text" id="streamer-name" name="name"
                               class="form-control" required>
                    </div>

                    <div class="form-group mb-3">
                        <label for="streamer-platform" class="form-label">Platform</label>
                        <select id="streamer-platform" name="platform"
                                class="form-select" required>
                            <option value="twitch">Twitch</option>
                            <option value="youtube">YouTube</option>
                            <option value="kick">Kick</option>
                        </select>
                    </div>
                </div>

                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary"
                            data-bs-dismiss="modal">Cancel</button>
                    <button type="submit" class="btn btn-primary">Add Streamer</button>
                </div>
            </form>
        </div>
    </div>
</div>

<!-- Button to open modal -->
<button type="button" class="btn btn-success" data-bs-toggle="modal"
        data-bs-target="#addStreamerModal">
    <i class="fas fa-plus"></i> Add Streamer
</button>

<script>
document.getElementById('add-streamer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const guildId = '<%= guild.id %>';

    try {
        loadingManager.showFormLoading(form);

        const response = await fetch(`/api/guild/${guildId}/streamers`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: form.querySelector('#streamer-name').value,
                platform: form.querySelector('#streamer-platform').value
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Failed to add streamer');
        }

        // Success
        loadingManager.hideFormLoading(form);
        loadingManager.showToast('Streamer added successfully!', 'success');

        // Reset form and close modal
        form.reset();
        const modal = bootstrap.Modal.getInstance(
            document.getElementById('addStreamerModal')
        );
        modal.hide();

        // Reload streamers list
        setTimeout(() => loadStreamers(guildId), 500);

    } catch (error) {
        loadingManager.hideFormLoading(form);
        loadingManager.showToast(error.message, 'error');
        console.error('Error adding streamer:', error);
    }
});
</script>
```

### Example 4: Multi-Step Form with Progress

```html
<!-- HTML Multi-Step Form -->
<form id="setup-wizard" action="/api/guild/<%= guild.id %>/setup" method="POST">
    <!-- Step 1: Basic Settings -->
    <div class="step" data-step="1">
        <h3>Basic Settings</h3>
        <div class="form-group mb-3">
            <label for="guild-name" class="form-label">Guild Name</label>
            <input type="text" id="guild-name" name="guildName"
                   class="form-control" required>
        </div>
    </div>

    <!-- Step 2: Roles -->
    <div class="step" data-step="2" style="display:none;">
        <h3>Role Configuration</h3>
        <div class="form-group mb-3">
            <label for="moderator-role" class="form-label">Moderator Role</label>
            <select id="moderator-role" name="moderatorRole" class="form-select">
                <% roles.forEach(role => { %>
                    <option value="<%= role.id %>"><%= role.name %></option>
                <% }); %>
            </select>
        </div>
    </div>

    <!-- Step 3: Channels -->
    <div class="step" data-step="3" style="display:none;">
        <h3>Channel Configuration</h3>
        <div class="form-group mb-3">
            <label for="announcement-channel" class="form-label">Announcement Channel</label>
            <select id="announcement-channel" name="announcementChannel"
                    class="form-select">
                <% channels.forEach(channel => { %>
                    <option value="<%= channel.id %>"><%= channel.name %></option>
                <% }); %>
            </select>
        </div>
    </div>

    <!-- Navigation -->
    <div class="mt-4 d-flex justify-content-between">
        <button type="button" id="prev-step" class="btn btn-secondary">Previous</button>
        <button type="button" id="next-step" class="btn btn-primary">Next</button>
        <button type="submit" id="finish-btn" class="btn btn-success"
                style="display:none;">Finish Setup</button>
    </div>
</form>

<script>
let currentStep = 1;
const totalSteps = 3;
const form = document.getElementById('setup-wizard');

function showStep(step) {
    document.querySelectorAll('.step').forEach(el => {
        el.style.display = el.dataset.step == step ? 'block' : 'none';
    });

    document.getElementById('prev-step').style.display = step === 1 ? 'none' : 'block';
    document.getElementById('next-step').style.display = step === totalSteps ? 'none' : 'block';
    document.getElementById('finish-btn').style.display = step === totalSteps ? 'block' : 'none';

    currentStep = step;
}

document.getElementById('prev-step').addEventListener('click', () => {
    if (currentStep > 1) showStep(currentStep - 1);
});

document.getElementById('next-step').addEventListener('click', () => {
    if (currentStep < totalSteps) showStep(currentStep + 1);
});

form.addEventListener('submit', async (e) => {
    e.preventDefault();

    try {
        loadingManager.showFormLoading(form);

        const response = await fetch(form.action, {
            method: form.method,
            body: new FormData(form)
        });

        if (!response.ok) throw new Error('Setup failed');

        loadingManager.hideFormLoading(form);
        loadingManager.showToast('Setup completed successfully!', 'success');

        // Redirect after 2 seconds
        setTimeout(() => {
            location.href = '/servers';
        }, 2000);

    } catch (error) {
        loadingManager.hideFormLoading(form);
        loadingManager.showToast('Setup failed: ' + error.message, 'error');
    }
});

// Initialize
showStep(1);
</script>
```

### Example 5: Bulk Action with Progress

```html
<!-- HTML for bulk actions -->
<div class="card">
    <div class="card-header">
        <h5>Bulk Actions</h5>
    </div>
    <div class="card-body">
        <div class="form-group mb-3">
            <label for="action" class="form-label">Select Action</label>
            <select id="action" class="form-select">
                <option value="">-- Select Action --</option>
                <option value="delete">Delete Selected</option>
                <option value="enable">Enable All</option>
                <option value="disable">Disable All</option>
            </select>
        </div>

        <button type="button" id="execute-action" class="btn btn-warning">
            Execute Action
        </button>
    </div>

    <!-- Progress indicator -->
    <div id="progress-container" style="display:none;" class="card-footer">
        <div class="progress">
            <div id="progress-bar" class="progress-bar" role="progressbar"
                 style="width: 0%"></div>
        </div>
        <p class="mt-2 mb-0">
            <span id="progress-text">Processing: 0/0</span>
        </p>
    </div>
</div>

<script>
document.getElementById('execute-action').addEventListener('click', async () => {
    const action = document.getElementById('action').value;
    if (!action) {
        loadingManager.showToast('Please select an action', 'warning');
        return;
    }

    const selected = document.querySelectorAll('input[name="selected"]:checked');
    if (selected.length === 0) {
        loadingManager.showToast('Please select items', 'warning');
        return;
    }

    try {
        const progressContainer = document.getElementById('progress-container');
        const progressBar = document.getElementById('progress-bar');
        const progressText = document.getElementById('progress-text');

        progressContainer.style.display = 'block';

        let completed = 0;
        const total = selected.length;

        // Process each item
        for (const checkbox of selected) {
            const itemId = checkbox.value;

            try {
                const response = await fetch(`/api/item/${itemId}/${action}`, {
                    method: 'POST'
                });

                if (!response.ok) throw new Error('Failed');

                completed++;
                const percentage = (completed / total) * 100;

                // Update progress
                progressBar.style.width = percentage + '%';
                progressText.textContent = `Processing: ${completed}/${total}`;

            } catch (error) {
                console.error(`Failed to process ${itemId}:`, error);
            }
        }

        progressContainer.style.display = 'none';
        loadingManager.showToast(
            `Action completed! (${completed}/${total} successful)`,
            'success'
        );

        // Reload list
        location.reload();

    } catch (error) {
        loadingManager.showToast('Bulk action failed', 'error');
        console.error('Bulk action error:', error);
    }
});
</script>
```

### Example 6: Real-Time Data with Auto-Refresh

```html
<!-- HTML Live Data Display -->
<div id="live-data-container" class="card">
    <div class="card-header d-flex justify-content-between align-items-center">
        <h5>Live Streamers</h5>
        <button type="button" id="refresh-btn" class="btn btn-sm btn-secondary">
            <i class="fas fa-sync-alt"></i> Refresh
        </button>
    </div>
    <div id="live-data" class="card-body"></div>
</div>

<script>
let refreshInterval;

async function refreshLiveData() {
    const container = document.getElementById('live-data');
    const guildId = '<%= guild.id %>';

    try {
        loadingManager.showLoadingBar();

        const response = await fetch(`/api/guild/${guildId}/live-status`);
        if (!response.ok) throw new Error('Failed to load');

        const data = await response.json();
        loadingManager.hideLoadingBar();

        // Render data
        if (data.streamers.length === 0) {
            container.innerHTML = '<p class="text-muted">No streamers currently live</p>';
        } else {
            container.innerHTML = data.streamers.map(streamer => `
                <div class="d-flex justify-content-between align-items-center mb-2 p-2
                            rounded" style="background-color: rgba(114, 137, 218, 0.1);">
                    <div>
                        <strong>${streamer.name}</strong>
                        <br>
                        <small class="text-muted">${streamer.platform}</small>
                    </div>
                    <span class="badge bg-danger">LIVE</span>
                </div>
            `).join('');
        }

        // Update last refresh time
        const now = new Date();
        console.log('Data refreshed at', now.toLocaleTimeString());

    } catch (error) {
        loadingManager.hideLoadingBar();
        console.error('Refresh error:', error);
        loadingManager.showToast('Failed to refresh data', 'error');
    }
}

// Manual refresh button
document.getElementById('refresh-btn').addEventListener('click', () => {
    refreshLiveData();
});

// Auto-refresh every 30 seconds
document.addEventListener('DOMContentLoaded', () => {
    // Initial load
    refreshLiveData();

    // Set up auto-refresh
    refreshInterval = setInterval(refreshLiveData, 30000);

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        clearInterval(refreshInterval);
    });
});
</script>
```

### Example 7: Delete with Confirmation

```html
<!-- HTML Delete Button -->
<button type="button" class="btn btn-danger" onclick="deleteItem('<%= item.id %>')">
    <i class="fas fa-trash"></i> Delete
</button>

<script>
function deleteItem(itemId) {
    // Confirmation dialog
    if (!confirm('Are you sure you want to delete this item? This action cannot be undone.')) {
        return;
    }

    deleteItemConfirmed(itemId);
}

async function deleteItemConfirmed(itemId) {
    try {
        // Show loading overlay
        loadingManager.showPageLoading('Deleting item...');

        const response = await fetch(`/api/item/${itemId}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        loadingManager.hidePageLoading();
        loadingManager.showToast('Item deleted successfully', 'success');

        // Reload after 1 second
        setTimeout(() => {
            location.reload();
        }, 1000);

    } catch (error) {
        loadingManager.hidePageLoading();
        loadingManager.showToast('Failed to delete item', 'error');
        console.error('Delete error:', error);
    }
}
</script>
```

## Testing the Loading States

To test the loading states in your browser console:

```javascript
// Test page loading
loadingManager.showPageLoading('Testing page loading...');
setTimeout(() => loadingManager.hidePageLoading(), 3000);

// Test toast notifications
loadingManager.showToast('Success!', 'success', 3000);
loadingManager.showToast('Error occurred', 'error', 3000);
loadingManager.showToast('Warning!', 'warning', 3000);
loadingManager.showToast('Information', 'info', 3000);

// Test form loading
const form = document.querySelector('form');
loadingManager.showFormLoading(form);
setTimeout(() => loadingManager.hideFormLoading(form), 3000);

// Test data loading
const container = document.getElementById('data-container');
loadingManager.showDataLoading(container, 'Custom loading message...');
setTimeout(() => loadingManager.hideDataLoading(container), 3000);

// Check loading state
console.log('Is loading:', loadingManager.getLoadingState());

// Clear all
loadingManager.clearAll();
```

---

For more details, see the main documentation in `LOADING_STATES_GUIDE.md`
