function showToast(message, type) {
  type = type || 'success';
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toastMessage');
  if (!toast || !toastMessage) return;
  toastMessage.textContent = message;
  toast.className = 'toast ' + type;
  toast.classList.add('show');
  setTimeout(function () {
    toast.classList.remove('show');
  }, 3000);
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getApiKey() {
  const el = document.getElementById('apiKeyInput');
  return el ? el.value.trim() : '';
}

let botApps = [];
let selectedApps = new Set();

const venomBtn = document.getElementById('venomBtn');
const managerBtn = document.getElementById('managerBtn');
const venomSection = document.getElementById('venomSection');
const managerSection = document.getElementById('managerSection');

function setActiveTab(active) {
  if (!venomBtn || !managerBtn || !venomSection || !managerSection) return;
  venomBtn.classList.remove('active');
  managerBtn.classList.remove('active');
  if (active === 'deploy') {
    venomBtn.classList.add('active');
    venomSection.style.display = 'block';
    managerSection.style.display = 'none';
  } else {
    managerBtn.classList.add('active');
    managerSection.style.display = 'block';
    venomSection.style.display = 'none';
  }
}

if (venomBtn && managerBtn) {
  setActiveTab('deploy');
  venomBtn.addEventListener('click', function (e) {
    e.preventDefault();
    setActiveTab('deploy');
  });
  managerBtn.addEventListener('click', function (e) {
    e.preventDefault();
    setActiveTab('manage');
  });
}

const loadAppsBtn = document.getElementById('loadAppsBtn');
if (loadAppsBtn) {
  loadAppsBtn.addEventListener('click', async function () {
    const apiKey = getApiKey();
    if (!apiKey) {
      showToast('Please enter Vercel token', 'error');
      return;
    }

    const loading = document.getElementById('loadingApps');
    const appsContainer = document.getElementById('appsContainer');
    loading.style.display = 'block';
    appsContainer.style.display = 'none';
    selectedApps.clear();

    try {
      const response = await axios.post('/api/manager/bot-apps', { vercelToken: apiKey });
      if (response.data.success) {
        botApps = response.data.apps;
        renderBotApps();
        showToast('Loaded ' + botApps.length + ' app(s)');
      } else {
        showToast(response.data.error || 'Failed to load apps', 'error');
      }
    } catch (error) {
      const msg = error.response && error.response.data && error.response.data.error
        ? error.response.data.error
        : 'Connection error';
      showToast(msg, 'error');
    } finally {
      loading.style.display = 'none';
    }
  });
}

function renderBotApps() {
  const grid = document.getElementById('appsGrid');
  const selectAllBar = document.getElementById('selectAllBar');
  const appsContainer = document.getElementById('appsContainer');

  if (botApps.length === 0) {
    grid.innerHTML = '<div class="empty-state"><i class="fas fa-globe"></i><p>No apps found</p></div>';
    selectAllBar.style.display = 'none';
  } else {
    grid.innerHTML = botApps.map(function (app) {
      const url = app.web_url || '';
      return (
        '<div class="app-card">' +
          '<div class="app-header">' +
            '<div class="app-info">' +
              '<div class="app-name">' + escapeHtml(app.name) + '</div>' +
              '<div class="app-url">' + (url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" style="color:#c8c8c8;">' + escapeHtml(url) + '</a>' : 'No URL') + '</div>' +
            '</div>' +
            '<input type="checkbox" class="app-checkbox" data-app="' + escapeHtml(app.name) + '" onchange="toggleAppSelection(this.dataset.app, this.checked)">' +
          '</div>' +
        '</div>'
      );
    }).join('');
    selectAllBar.style.display = 'flex';
  }

  appsContainer.style.display = 'block';
  const selectAll = document.getElementById('selectAllApps');
  if (selectAll) selectAll.checked = false;
}

function toggleAppSelection(appName, checked) {
  if (checked) selectedApps.add(appName);
  else selectedApps.delete(appName);

  const checkboxes = document.querySelectorAll('.app-checkbox');
  const allChecked = checkboxes.length > 0 && Array.from(checkboxes).every(function (cb) { return cb.checked; });
  const selectAll = document.getElementById('selectAllApps');
  if (selectAll) selectAll.checked = allChecked;
}

const selectAllApps = document.getElementById('selectAllApps');
if (selectAllApps) {
  selectAllApps.addEventListener('change', function () {
    const checkboxes = document.querySelectorAll('.app-checkbox');
    const self = this;
    checkboxes.forEach(function (cb) {
      cb.checked = self.checked;
      const appName = cb.dataset.app;
      if (self.checked) selectedApps.add(appName);
      else selectedApps.delete(appName);
    });
  });
}

function restartSelectedApps() {
  const apps = Array.from(selectedApps);
  if (apps.length === 0) {
    showToast('No apps selected', 'error');
    return;
  }
  document.getElementById('restartCount').textContent = apps.length;
  document.getElementById('restartModal').style.display = 'flex';
  window.pendingRestartApps = apps;
}

function closeRestartModal() {
  document.getElementById('restartModal').style.display = 'none';
  window.pendingRestartApps = null;
}

async function confirmRestart() {
  const apps = window.pendingRestartApps;
  if (!apps || apps.length === 0) {
    closeRestartModal();
    return;
  }

  const apiKey = getApiKey();
  closeRestartModal();
  showToast('Pushing latest code...', 'warning');

  try {
    const githubEl = document.getElementById('githubRepo');
    const githubRepo = githubEl ? githubEl.value.trim() : '';
    const response = await axios.post('/api/manager/restart-bot-apps', {
      vercelToken: apiKey,
      appNames: apps,
      githubRepo: githubRepo
    }, { timeout: 900000 });
    if (response.data.success) {
      showToast(response.data.message);
      setTimeout(function () { document.getElementById('loadAppsBtn').click(); }, 2000);
    } else {
      showToast(response.data.error || response.data.message || 'Failed to push', 'error');
    }
  } catch (error) {
    showToast('Failed to push GitHub changes', 'error');
  }
}

function deleteSelectedApps() {
  const apps = Array.from(selectedApps);
  if (apps.length === 0) {
    showToast('No apps selected', 'error');
    return;
  }
  document.getElementById('deleteCount').textContent = apps.length;
  document.getElementById('deleteModal').style.display = 'flex';
  window.pendingDeleteApps = apps;
}

function closeDeleteModal() {
  document.getElementById('deleteModal').style.display = 'none';
  window.pendingDeleteApps = null;
}

async function confirmDelete() {
  const apps = window.pendingDeleteApps;
  if (!apps || apps.length === 0) {
    closeDeleteModal();
    return;
  }

  const apiKey = getApiKey();
  closeDeleteModal();
  showToast('Deleting app(s)...', 'warning');

  try {
    const response = await axios.post('/api/manager/delete-bot-apps', {
      vercelToken: apiKey,
      appNames: apps
    });
    if (response.data.success) {
      showToast(response.data.message);
      setTimeout(function () { document.getElementById('loadAppsBtn').click(); }, 1000);
    } else {
      showToast(response.data.error || response.data.message || 'Failed to delete', 'error');
    }
  } catch (error) {
    showToast('Failed to delete apps', 'error');
  }
}

const venomForm = document.getElementById('venomForm');
if (venomForm) {
  const venomResults = document.getElementById('venomResults');
  const venomLoading = document.getElementById('venomLoading');
  const venomLoadingText = document.getElementById('venomLoadingText');
  const deployBtn = document.getElementById('deployBtn');

  venomForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    const githubRepo = document.getElementById('githubRepo').value.trim();
    const vercelToken = document.getElementById('venomApiKey').value.trim();
    const appName = document.getElementById('appName').value.trim();

    if (!githubRepo || !vercelToken || !appName) {
      showToast('GitHub repo, Vercel token and app name are required', 'error');
      return;
    }

    venomLoading.style.display = 'block';
    venomLoadingText.textContent = 'Deploying to Vercel...';
    deployBtn.disabled = true;
    venomResults.style.display = 'none';

    try {
      const response = await axios.post('/venom/deploy-apps', {
        githubRepo: githubRepo,
        vercelToken: vercelToken,
        appName: appName
      }, { timeout: 900000 });

      const data = response.data || {};
      if (!data.success) {
        showToast(data.error || 'Deployment failed', 'error');
        return;
      }

      showToast('Deployed successfully');
      const url = data.appUrl || '';
      venomResults.innerHTML =
        '<div style="font-weight:600;color:#c8c8c8;margin-bottom:10px;">Live URL</div>' +
        '<div class="result-item">' +
          '<strong>' + escapeHtml(data.appName || '') + '</strong><br>' +
          (url
            ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" style="color:#c8c8c8;">' + escapeHtml(url) + '</a>'
            : '') +
        '</div>';
      venomResults.className = 'result-box success';
      venomResults.style.display = 'block';
    } catch (error) {
      const msg = error.response && error.response.data && error.response.data.error
        ? error.response.data.error
        : 'Deployment failed';
      showToast(msg, 'error');
    } finally {
      venomLoading.style.display = 'none';
      deployBtn.disabled = false;
    }
  });
}

window.addEventListener('click', function (event) {
  if (event.target.classList.contains('modal')) {
    event.target.style.display = 'none';
  }
});

const apiKeyInput = document.getElementById('apiKeyInput');
if (apiKeyInput) {
  apiKeyInput.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') document.getElementById('loadAppsBtn').click();
  });
}
