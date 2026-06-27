
const API_URL = 'https://script.google.com/macros/s/AKfycbw1lDOVpkmxmHbg71TQycQw4ZZBfxpNBuv5UDGK_vQ6-kiGco2XIMYjfye6WGBMdu7r2w/exec';
const FRONTEND_APP_URL = 'https://cmwillett.github.io/golf-scorecard/';
const FRONTEND_VERSION = '0.2.4';

function apiCall(action, args = []) {
  if (!API_URL || API_URL.includes('PASTE_APPS_SCRIPT')) {
    return Promise.reject(new Error('API_URL is not set in app.js. Paste your deployed Apps Script web app URL.'));
  }

  return new Promise((resolve, reject) => {
    const callbackName = 'golfApiCallback_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
    const script = document.createElement('script');
    const cleanup = () => {
      try { delete window[callbackName]; } catch (err) { window[callbackName] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('API request timed out.'));
    }, 30000);

    window[callbackName] = response => {
      clearTimeout(timer);
      cleanup();
      if (response && response.ok) {
        resolve(response.result);
      } else {
        reject(new Error((response && response.error) || 'API request failed.'));
      }
    };

    const url = new URL(API_URL);
    url.searchParams.set('action', action);
    url.searchParams.set('args', JSON.stringify(args));
    url.searchParams.set('callback', callbackName);
    url.searchParams.set('_', String(Date.now()));

    script.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('Could not reach the Apps Script API.'));
    };

    script.src = url.toString();
    document.body.appendChild(script);
  });
}

function createGoogleScriptRunShim() {
  function makeRunner(successHandler, failureHandler) {
    return new Proxy({}, {
      get(target, prop) {
        if (prop === 'withSuccessHandler') {
          return cb => makeRunner(cb, failureHandler);
        }
        if (prop === 'withFailureHandler') {
          return cb => makeRunner(successHandler, cb);
        }
        return (...args) => {
          apiCall(String(prop), args)
            .then(result => {
              if (typeof successHandler === 'function') successHandler(result);
            })
            .catch(err => {
              if (typeof failureHandler === 'function') failureHandler(err);
              else console.error(err);
            });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  Object.defineProperty(window.google.script, 'run', {
    configurable: true,
    get() {
      return makeRunner(null, null);
    }
  });
}

createGoogleScriptRunShim();


  function updateDisplayedVersion() {
    const el = document.getElementById('appVersionLabel');
    if (el) el.textContent = `Frontend v${FRONTEND_VERSION}`;
  }

  let hostPinValue = '';
  let adminPinValue = '';
  let currentRound = null;
  let selectedEntryId = null;
  let selectedEntryName = '';
  let selectedEntryPin = '';
  let pendingEntryId = null;
  let pendingEntryName = '';
  let currentHole = 1;
  let leaderboardTimer = null;
  let scoreSaveToken = 0;
  let lastAdminRound = null;
  let deferredInstallPrompt = null;
  let installReminderShown = false;

  const SCORING_SESSION_KEY = 'golfScorecardScoringSessionV1';
  const APP_STATE_KEY = 'golfScorecardLastStateV1';

  document.addEventListener('DOMContentLoaded', () => {
    updateDisplayedVersion();
    renderHostFields();
    updateResumeButton();
    validateSavedScoringSession();
    wireButtonPressFeedback();
    registerPwaServiceWorker();
    wireInstallPrompt();
    scheduleInstallReminder();

    if (!handleInitialJoinLink()) {
      restoreLastAppState();
    }
  });



  function registerPwaServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.register('service-worker.js').catch(err => {
        console.log('Service worker registration skipped:', err);
      });
    } catch (err) {
      console.log('Service worker unavailable:', err);
    }
  }

  function isPwaInstalledMode() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true;
  }

  function wireInstallPrompt() {
    const installButton = document.getElementById('installAppButton');
    if (isPwaInstalledMode()) {
      if (installButton) installButton.classList.add('hidden');
      return;
    }

    if (installButton) installButton.classList.remove('hidden');

    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      deferredInstallPrompt = event;
      if (installButton) installButton.classList.remove('hidden');
      showInstallReminder();
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      installReminderShown = true;
      if (installButton) installButton.classList.add('hidden');
      showModal('The app was installed successfully.', 'Installed');
    });
  }

  function scheduleInstallReminder() {
    if (isPwaInstalledMode()) return;
    setTimeout(() => {
      if (!isPwaInstalledMode()) showInstallReminder();
    }, 900);
  }

  function showInstallReminder() {
    if (isPwaInstalledMode() || installReminderShown) return;
    installReminderShown = true;

    const message = deferredInstallPrompt
      ? 'For the best golf scoring experience, install this app on your device. It will open like a regular app and work better during the round.'
      : 'For the best golf scoring experience, install this app on your device. If the Install button does not appear, use your browser menu and choose “Install app” or “Add to Home screen.”';

    showModal(message, 'Install Golf Scorecard');
    const okButton = document.getElementById('modalOkButton');
    if (okButton) {
      okButton.textContent = deferredInstallPrompt ? 'Install App' : 'Got it';
      okButton.onclick = () => {
        closeModal();
        if (deferredInstallPrompt) installApp();
      };
    }

    let cancelButton = document.getElementById('modalCancelButton');
    if (!cancelButton) {
      cancelButton = document.createElement('button');
      cancelButton.id = 'modalCancelButton';
      cancelButton.className = 'secondary';
      cancelButton.textContent = 'Not now';
      okButton && okButton.parentNode.insertBefore(cancelButton, okButton);
    }
    cancelButton.onclick = closeModal;
  }

  async function installApp() {
    if (isPwaInstalledMode()) {
      showModal('The app is already installed.', 'Installed');
      return;
    }

    if (!deferredInstallPrompt) {
      showModal('Use your browser menu and choose “Add to Home screen” or “Install app.”', 'Install App');
      return;
    }

    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    const installButton = document.getElementById('installAppButton');
    if (installButton) installButton.classList.add('hidden');
  }


  function showModal(message, title = 'Notice') {
    const modal = document.getElementById('appModal');
    const titleEl = document.getElementById('modalTitle');
    const messageEl = document.getElementById('modalMessage');
    const okButton = document.getElementById('modalOkButton');

    if (!modal || !titleEl || !messageEl) {
      console.log(title + ': ' + message);
      return;
    }

    titleEl.textContent = title;
    messageEl.textContent = message;
    modal.classList.remove('hidden');
    setTimeout(() => okButton && okButton.focus(), 0);
  }

  function closeModal() {
    const modal = document.getElementById('appModal');
    if (modal) modal.classList.add('hidden');
    const okButton = document.getElementById('modalOkButton');
    if (okButton) {
      okButton.textContent = 'OK';
      okButton.onclick = closeModal;
    }
    const cancelButton = document.getElementById('modalCancelButton');
    if (cancelButton) cancelButton.remove();
  }

  function showConfirmModal(message, onConfirm, title = 'Confirm') {
    showModal(message, title);
    const okButton = document.getElementById('modalOkButton');
    if (!okButton) return;

    let cancelButton = document.getElementById('modalCancelButton');
    if (!cancelButton) {
      cancelButton = document.createElement('button');
      cancelButton.id = 'modalCancelButton';
      cancelButton.className = 'secondary';
      cancelButton.textContent = 'Cancel';
      okButton.parentNode.insertBefore(cancelButton, okButton);
    }

    okButton.textContent = 'Confirm';
    okButton.onclick = () => {
      closeModal();
      if (typeof onConfirm === 'function') onConfirm();
    };
    cancelButton.onclick = closeModal;
  }


  function setButtonLoading(button, label = 'Working...') {
    if (!button) return;
    button.dataset.originalText = button.textContent;
    button.textContent = label;
    button.disabled = true;
    button.classList.add('is-loading');
  }

  function clearButtonLoading(button) {
    if (!button) return;
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.classList.remove('is-loading');
    delete button.dataset.originalText;
  }

  function wireButtonPressFeedback() {
    document.addEventListener('pointerdown', event => {
      const button = event.target.closest('button');
      if (button && !button.disabled) button.classList.add('is-pressed');
    });

    ['pointerup', 'pointercancel', 'pointerleave'].forEach(eventName => {
      document.addEventListener(eventName, event => {
        const button = event.target.closest('button');
        if (button) button.classList.remove('is-pressed');
      });
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeModal();
    });

    const modal = document.getElementById('appModal');
    if (modal) {
      modal.addEventListener('click', event => {
        if (event.target === modal) closeModal();
      });
    }
  }

  function showView(id) {
    document.body.setAttribute('data-view', id);
    document.querySelectorAll('.view').forEach(view => view.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');

    const showNav = currentRound && ['scoreView', 'leaderboardView'].includes(id);
    document.getElementById('bottomNav').classList.toggle('hidden', !showNav);
    updateRoundBadge();
    saveLastAppState(id);
  }

  function saveLastAppState(viewId) {
    const persistedViews = new Set(['homeView', 'scoreView', 'leaderboardView']);
    if (!persistedViews.has(viewId)) return;

    const state = {
      viewId,
      joinCode: currentRound ? currentRound.joinCode : '',
      roundId: currentRound ? currentRound.roundId : '',
      selectedEntryId: selectedEntryId || '',
      selectedEntryName: selectedEntryName || '',
      currentHole: currentHole || 1,
      savedAt: Date.now()
    };

    try {
      localStorage.setItem(APP_STATE_KEY, JSON.stringify(state));
    } catch (err) {
      console.log('Could not save app state', err);
    }
  }

  function getLastAppState() {
    try {
      const raw = localStorage.getItem(APP_STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      localStorage.removeItem(APP_STATE_KEY);
      return null;
    }
  }

  function clearLastAppState() {
    localStorage.removeItem(APP_STATE_KEY);
  }

  function restoreLastAppState() {
    const state = getLastAppState();
    if (!state) return;

    if (state.viewId === 'scoreView') {
      resumeSavedScoring(Number(state.currentHole) || 1, true);
      return;
    }

    if (state.viewId === 'leaderboardView' && state.joinCode) {
      google.script.run
        .withSuccessHandler(round => {
          if (!round) {
            clearLastAppState();
            return;
          }
          currentRound = round;
          selectedEntryId = '';
          selectedEntryName = '';
          selectedEntryPin = '';
          showLeaderboard();
        })
        .withFailureHandler(() => {
          // Stay on Home if the round cannot be restored temporarily.
        })
        .getRoundByJoinCode(state.joinCode);
    }
  }

  function showHome() {
    stopLeaderboardAutoRefresh();
    updateResumeButton();
    showView('homeView');
  }

  function showHostPin() {
    showView('hostPinView');
  }

  function showJoinRound() {
    stopLeaderboardAutoRefresh();
    showView('joinRoundView');
  }

  function showLeaderboardLookup() {
    stopLeaderboardAutoRefresh();
    showView('leaderboardLookupView');
  }

  function showAdminPin() {
    showView('adminPinView');
  }

  function updateRoundBadge() {
    const badge = document.getElementById('roundBadge');
    if (!currentRound) {
      badge.classList.add('hidden');
      return;
    }

    badge.textContent = `Code ${currentRound.joinCode}`;
    badge.classList.remove('hidden');
  }

  function updateResumeButton() {
    const btn = document.getElementById('resumeScoringButton');
    const session = getSavedScoringSession();
    btn.classList.toggle('hidden', !session);
    if (session) btn.textContent = `Resume ${session.entryName || 'Scoring'}`;
  }

  function validateSavedScoringSession() {
    const session = getSavedScoringSession();
    if (!session) return;

    google.script.run
      .withSuccessHandler(result => {
        if (!result || !result.ok) {
          localStorage.removeItem(SCORING_SESSION_KEY);
          updateResumeButton();
        }
      })
      .withFailureHandler(() => {
        // Keep the saved session if validation fails due to a temporary Apps Script issue.
      })
      .verifyEntryPin({
        joinCode: session.joinCode,
        entryId: session.entryId,
        pin: session.scoringPin
      });
  }

  function getSavedScoringSession() {
    try {
      const raw = localStorage.getItem(SCORING_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function saveScoringSession() {
    localStorage.setItem(SCORING_SESSION_KEY, JSON.stringify({
      joinCode: currentRound.joinCode,
      entryId: selectedEntryId,
      entryName: selectedEntryName,
      scoringPin: selectedEntryPin,
      currentHole
    }));
    updateResumeButton();
  }

  function resumeSavedScoring(targetHole = 1, silent = false) {
    const session = getSavedScoringSession();
    if (!session) {
      if (!silent) showModal('No saved scoring session found.');
      clearLastAppState();
      return;
    }

    google.script.run
      .withSuccessHandler(result => {
        if (!result || !result.ok) {
          if (!silent) showModal(result?.message || 'Could not resume scoring. Please join again.');
          localStorage.removeItem(SCORING_SESSION_KEY);
          clearLastAppState();
          updateResumeButton();
          return;
        }

        currentRound = result.round;
        selectedEntryId = session.entryId;
        selectedEntryName = session.entryName;
        selectedEntryPin = session.scoringPin;
        currentHole = Math.min(Math.max(Number(targetHole) || 1, 1), Number(currentRound.holes || 18));

        if (currentRound.status !== 'Active') {
          if (!silent) showModal('This round is finished, so scoring is locked. Showing the leaderboard instead.', 'Scoring Locked');
          showLeaderboard();
          return;
        }

        showScore();
      })
      .withFailureHandler(err => {
        if (!silent) showModal(err.message || err);
      })
      .verifyEntryPin({
        joinCode: session.joinCode,
        entryId: session.entryId,
        pin: session.scoringPin
      });
  }

  function verifyHostPinAndContinue(evt) {
    const pinInput = document.getElementById('hostPin');
    const pin = (pinInput?.value || '').trim();
    const button = evt?.target || document.getElementById('hostPinContinueButton');

    if (!pin) {
      showModal('Enter the host PIN.', 'Host PIN Required');
      if (pinInput) pinInput.focus();
      return;
    }

    setButtonLoading(button, 'Checking...');

    google.script.run
      .withSuccessHandler(ok => {
        clearButtonLoading(button);

        if (!ok) {
          showModal('Incorrect host PIN. Check the HostPin value in AppSettings.', 'Incorrect PIN');
          if (pinInput) pinInput.focus();
          return;
        }

        hostPinValue = pin;
        renderHostFields();
        showView('hostSetupView');
      })
      .withFailureHandler(err => {
        clearButtonLoading(button);
        showModal(err.message || err || 'Host PIN check failed.', 'Error');
      })
      .verifyHostPin(pin);
  }

  function verifyAdminPin() {
    const pin = document.getElementById('adminPin').value.trim();

    google.script.run
      .withSuccessHandler(ok => {
        if (!ok) {
          showModal('Incorrect admin PIN.', 'Incorrect PIN');
          return;
        }

        adminPinValue = pin;
        showView('adminView');
        loadAdminRoundList();
      })
      .withFailureHandler(err => showModal(err.message || err))
      .verifyAdminPin(pin);
  }

  function renderHostFields() {
    const gameStyleEl = document.getElementById('gameStyle');
    const box = document.getElementById('hostFields');
    if (!gameStyleEl || !box) return;

    const gameStyle = gameStyleEl.value;
    if (gameStyle === 'standard') {
      box.innerHTML = `
        <label>Number of Players</label>
        <select id="standardCount" onchange="renderStandardPlayers()">
          <option value="2">2 players</option>
          <option value="3">3 players</option>
          <option value="4" selected>4 players</option>
          <option value="5">5 players</option>
          <option value="6">6 players</option>
          <option value="7">7 players</option>
          <option value="8">8 players</option>
        </select>
        <div id="standardPlayersBox"></div>
      `;
      renderStandardPlayers();
    }

    if (gameStyle === 'scramble') {
      box.innerHTML = `
        <label>Team Size</label>
        <select id="teamSize" onchange="renderScrambleTeams()">
          <option value="2" selected>2-man teams</option>
          <option value="4">4-man teams</option>
        </select>

        <label>Number of Teams</label>
        <select id="teamCount" onchange="renderScrambleTeams()">
          <option value="2">2 teams</option>
          <option value="3">3 teams</option>
          <option value="4">4 teams</option>
          <option value="5">5 teams</option>
          <option value="6" selected>6 teams</option>
          <option value="7">7 teams</option>
          <option value="8">8 teams</option>
        </select>
        <div id="scrambleTeamsBox"></div>
      `;
      renderScrambleTeams();
    }
  }

  function renderStandardPlayers() {
    const count = Number(document.getElementById('standardCount').value);
    const box = document.getElementById('standardPlayersBox');

    let html = '';
    for (let i = 1; i <= count; i++) {
      html += `
        <label>Player ${i}</label>
        <input class="standard-player" placeholder="Player ${i}">
      `;
    }
    box.innerHTML = html;
  }

  function renderScrambleTeams() {
    const teamSize = Number(document.getElementById('teamSize').value);
    const teamCount = Number(document.getElementById('teamCount').value);
    const box = document.getElementById('scrambleTeamsBox');

    let html = '';
    for (let team = 1; team <= teamCount; team++) {
      html += `
        <div class="setup-card scramble-team-card">
          <label>Team ${team} Name</label>
          <input class="team-name" placeholder="Team ${team}">
          ${Array.from({ length: teamSize }).map((_, index) => `
            <label>Player ${index + 1}</label>
            <input class="team-player" placeholder="Player ${index + 1}">
          `).join('')}
        </div>
      `;
    }
    box.innerHTML = html;
  }

  function createHostedRoundFromSetup(evt) {
    const createButton = evt && evt.target ? evt.target : null;
    if (createButton) {
      createButton.disabled = true;
      createButton.textContent = 'Creating Round...';
    }

    const gameStyle = document.getElementById('gameStyle').value;
    const payload = {
      hostPin: hostPinValue || document.getElementById('hostPin')?.value?.trim() || '',
      roundName: document.getElementById('roundName').value.trim(),
      course: document.getElementById('course').value.trim(),
      holes: Number(document.getElementById('holes').value),
      gameStyle,
      entries: []
    };

    if (gameStyle === 'standard') {
      payload.entries = Array.from(document.querySelectorAll('.standard-player'))
        .map(input => input.value.trim())
        .filter(Boolean)
        .map(name => ({ name, players: [name] }));

      if (!payload.entries.length) {
        showModal('Enter at least one player.');
        resetCreateButton_(createButton);
        return;
      }
    }

    if (gameStyle === 'scramble') {
      payload.teamSize = Number(document.getElementById('teamSize').value);
      payload.entries = Array.from(document.querySelectorAll('.scramble-team-card')).map((card, index) => {
        const teamName = card.querySelector('.team-name').value.trim() || `Team ${index + 1}`;
        const players = Array.from(card.querySelectorAll('.team-player'))
          .map(input => input.value.trim())
          .filter(Boolean);
        return { name: teamName, players };
      });

      if (!payload.entries.length) {
        showModal('Enter at least one team.');
        resetCreateButton_(createButton);
        return;
      }
    }

    google.script.run
      .withSuccessHandler(round => {
        resetCreateButton_(createButton);

        if (!round || !round.joinCode) {
          showModal('Round was created, but the app did not receive a join code.');
          return;
        }

        currentRound = round;
        selectedEntryId = null;
        selectedEntryName = '';
        selectedEntryPin = '';
        currentHole = 1;
        document.getElementById('createdJoinCode').textContent = round.joinCode;
        renderCreatedPinList(round);
        showView('roundCreatedView');
      })
      .withFailureHandler(err => {
        resetCreateButton_(createButton);
        showModal('Create round failed: ' + (err.message || err));
      })
      .createHostedRound(payload);
  }

  function resetCreateButton_(button) {
    if (!button) return;
    button.disabled = false;
    button.textContent = 'Create Round';
  }

  function renderCreatedPinList(round) {
    const box = document.getElementById('createdPinList');
    box.innerHTML = `
      <h3>Team / Player PINs</h3>
      ${(round.entries || []).map(entry => `
        <div class="pin-row">
          <div>
            <strong>${escapeHtml(entry.entryName)}</strong>
            <div class="entry-sub">${escapeHtml((entry.players || []).join(', '))}</div>
          </div>
          <div class="pin-actions">
            <div class="pin-code">${escapeHtml(entry.scoringPin || '')}</div>
            <button class="small secondary share-button" onclick="shareCurrentRoundEntry('${entry.entryId}')">Share</button>
          </div>
        </div>
      `).join('')}
    `;
  }

  function showJoinRoundWithCode() {
    document.getElementById('joinCode').value = currentRound ? currentRound.joinCode : '';
    showJoinRound();
  }

  function loadRoundForJoin() {
    const code = document.getElementById('joinCode').value.trim();
    loadRoundByCode(code, round => {
      currentRound = round;
      renderTeamChoices();
      showView('chooseTeamView');
    });
  }

  function loadRoundForLeaderboard() {
    const code = document.getElementById('leaderboardJoinCode').value.trim();
    loadRoundByCode(code, round => {
      currentRound = round;
      selectedEntryId = null;
      selectedEntryName = '';
      selectedEntryPin = '';
      showLeaderboard();
    });
  }

  function loadRoundByCode(code, callback) {
    google.script.run
      .withSuccessHandler(round => {
        if (!round) {
          showModal('No round found with that code.');
          return;
        }
        callback(round);
      })
      .withFailureHandler(err => showModal(err.message || err))
      .getRoundByJoinCode(code);
  }

  function renderTeamChoices() {
    const box = document.getElementById('teamChoices');
    box.innerHTML = currentRound.entries.map(entry => `
      <button class="choice-card" onclick="selectEntryForPin('${entry.entryId}', '${escapeAttr(entry.entryName)}')">
        <div class="choice-name">${escapeHtml(entry.entryName)}</div>
        <div class="choice-sub">${escapeHtml((entry.players || []).join(', '))}</div>
      </button>
    `).join('');
  }

  function selectEntryForPin(entryId, entryName) {
    pendingEntryId = entryId;
    pendingEntryName = entryName;
    document.getElementById('teamPinTitle').textContent = `${entryName} PIN`;
    document.getElementById('teamPin').value = '';
    showView('teamPinView');
  }

  function verifySelectedTeamPin() {
    const pin = document.getElementById('teamPin').value.trim();
    if (!pin) {
      showModal('Enter the team PIN.');
      return;
    }

    google.script.run
      .withSuccessHandler(result => {
        if (!result || !result.ok) {
          showModal(result?.message || 'Incorrect team PIN.', 'Incorrect PIN');
          return;
        }

        currentRound = result.round;
        selectedEntryId = result.entryId;
        selectedEntryName = result.entryName || pendingEntryName;
        selectedEntryPin = pin;
        currentHole = 1;
        saveScoringSession();
        showScore();
      })
      .withFailureHandler(err => showModal(err.message || err))
      .verifyEntryPin({
        joinCode: currentRound.joinCode,
        entryId: pendingEntryId,
        pin
      });
  }

  function showScore() {
    if (!currentRound || !selectedEntryId) {
      showJoinRound();
      return;
    }
    stopLeaderboardAutoRefresh();
    renderScoreHole();
    showView('scoreView');
  }

  function renderScoreHole() {
    const entry = currentRound.entries.find(e => e.entryId === selectedEntryId);
    if (!entry) {
      showModal('Selected team/player not found.');
      showHome();
      return;
    }

    document.getElementById('holeTitle').textContent = `Hole ${currentHole}`;
    const score = getScore(entry.entryId, currentHole);

    const locked = currentRound.status !== 'Active';
    const chipValues = [1,2,3,4,5,6,7,8,9,10];

    document.getElementById('scoreInputs').innerHTML = `
      <div class="card score-card">
        <div class="entry-name">${escapeHtml(entry.entryName)}</div>
        <div class="entry-sub">${escapeHtml((entry.players || []).join(', '))}</div>
        ${locked ? '<div class="lock-banner">Scoring is locked for this round.</div>' : ''}
        <div class="score-control">
          <button ${locked ? 'disabled' : ''} onclick="changeScore(-1)">−</button>
          <div class="score-value">${score || '-'}</div>
          <button ${locked ? 'disabled' : ''} onclick="changeScore(1)">+</button>
        </div>
        <div class="score-chips">
          ${chipValues.map(value => `
            <button ${locked ? 'disabled' : ''} class="score-chip ${Number(score) === value ? 'selected' : ''}" onclick="setScore(${value})">${value}</button>
          `).join('')}
        </div>
      </div>
    `;
  }

  function getScore(entryId, hole) {
    return currentRound.scores?.[entryId]?.[String(hole)] || '';
  }

  function setScore(score) {
    if (currentRound.status !== 'Active') {
      showModal('Scoring is locked for this round.');
      return;
    }
    if (!currentRound.scores[selectedEntryId]) currentRound.scores[selectedEntryId] = {};

    const entryId = selectedEntryId;
    const hole = currentHole;
    const saveToken = ++scoreSaveToken;

    currentRound.scores[entryId][String(hole)] = score;
    renderScoreHole();
    saveScoringSession();
    saveLastAppState('scoreView');

    google.script.run
      .withSuccessHandler(() => {
        if (saveToken === scoreSaveToken) {
          console.log('Score saved', { entryId, hole, score });
        }
      })
      .withFailureHandler(err => {
        showModal('Score save failed: ' + (err.message || err));
      })
      .updateScore({
        roundId: currentRound.roundId,
        entryId,
        hole,
        score,
        scoringPin: selectedEntryPin,
        updatedBy: selectedEntryName || entryId
      });
  }

  function changeScore(delta) {
    const current = Number(getScore(selectedEntryId, currentHole)) || 0;
    const next = Math.max(1, current + delta);
    setScore(next);
  }

  function previousHole() {
    if (currentHole > 1) {
      currentHole--;
      renderScoreHole();
      saveLastAppState('scoreView');
    }
  }

  function nextHole() {
    if (currentHole < Number(currentRound.holes)) {
      currentHole++;
      renderScoreHole();
      saveLastAppState('scoreView');
    } else {
      showLeaderboard();
    }
  }

  function showLeaderboard() {
    if (!currentRound) {
      showLeaderboardLookup();
      return;
    }

    renderLeaderboard();
    showView('leaderboardView');
    startLeaderboardAutoRefresh();
  }

  function renderLeaderboard() {
    const meta = document.getElementById('leaderboardMeta');
    meta.textContent = `${currentRound.roundName || 'Round'} • Code ${currentRound.joinCode} • ${currentRound.status}`;

    const rows = currentRound.entries.map(entry => {
      const scoreMap = currentRound.scores[entry.entryId] || {};
      const total = Object.values(scoreMap).reduce((sum, value) => sum + (Number(value) || 0), 0);
      const through = Object.values(scoreMap).filter(value => value !== '' && value !== null && typeof value !== 'undefined').length;
      return { entry, total, through };
    }).sort((a, b) => {
      if (a.through === 0 && b.through !== 0) return 1;
      if (b.through === 0 && a.through !== 0) return -1;
      return a.total - b.total;
    });

    document.getElementById('leaderboard').innerHTML = rows.map((row, index) => `
      <div class="card">
        <div class="leader-row">
          <div>
            <div class="leader-rank">${index + 1}. <span class="leader-name">${escapeHtml(row.entry.entryName)}</span></div>
            <div class="entry-sub">${escapeHtml((row.entry.players || []).join(', '))}</div>
            <div class="entry-sub">Through ${row.through}</div>
          </div>
          <div class="leader-score">${row.through ? row.total : '-'}</div>
        </div>
      </div>
    `).join('');
  }

  function refreshCurrentRound() {
    if (!currentRound) return;
    google.script.run
      .withSuccessHandler(round => {
        if (round) {
          currentRound = round;
          if (document.getElementById('leaderboardView').classList.contains('hidden')) return;
          renderLeaderboard();
        }
      })
      .withFailureHandler(err => console.log(err))
      .getRoundByJoinCode(currentRound.joinCode);
  }

  function startLeaderboardAutoRefresh() {
    stopLeaderboardAutoRefresh();
    leaderboardTimer = setInterval(refreshCurrentRound, 20000);
  }

  function stopLeaderboardAutoRefresh() {
    if (leaderboardTimer) {
      clearInterval(leaderboardTimer);
      leaderboardTimer = null;
    }
  }

  function loadAdminRoundList() {
    const select = document.getElementById('adminRoundSelect');
    if (select) {
      select.innerHTML = '<option value="">Loading rounds...</option>';
    }

    google.script.run
      .withSuccessHandler(rounds => {
        renderAdminRoundSelect(rounds || []);
      })
      .withFailureHandler(err => {
        if (select) select.innerHTML = '<option value="">Could not load rounds</option>';
        showModal(err.message || err);
      })
      .getAdminRounds(adminPinValue);
  }

  function renderAdminRoundSelect(rounds) {
    const select = document.getElementById('adminRoundSelect');
    if (!select) return;

    if (!rounds.length) {
      select.innerHTML = '<option value="">No rounds found</option>';
      document.getElementById('adminContent').innerHTML = '';
      lastAdminRound = null;
      return;
    }

    select.innerHTML = '<option value="">Choose a round...</option>' + rounds.map(round => {
      const name = round.roundName || 'Unnamed Round';
      const label = `${name} • Join ${round.joinCode} • ${round.status}`;
      return `<option value="${escapeAttr(round.roundId)}">${escapeHtml(label)}</option>`;
    }).join('');
  }

  function loadSelectedAdminRound() {
    const select = document.getElementById('adminRoundSelect');
    const roundId = select ? select.value : '';

    if (!roundId) {
      document.getElementById('adminContent').innerHTML = '';
      lastAdminRound = null;
      return;
    }

    google.script.run
      .withSuccessHandler(round => {
        if (!round) {
          showModal('No round found. Refresh the round list and try again.');
          return;
        }
        lastAdminRound = round;
        renderAdminRound(round);
      })
      .withFailureHandler(err => showModal(err.message || err))
      .getAdminRound(roundId, adminPinValue);
  }

  function loadAdminRound() {
    loadSelectedAdminRound();
  }

  function renderAdminRound(round) {
    lastAdminRound = round;
    const isActive = round.status === 'Active';

    document.getElementById('adminContent').innerHTML = `
      <div class="card">
        <h3>${escapeHtml(round.roundName || 'Round')}</h3>
        <p class="muted">Code ${escapeHtml(round.joinCode)} • ${escapeHtml(round.gameStyle)} • ${round.holes} holes • ${escapeHtml(round.status)}</p>
        <div class="share-action-row">
          <button class="small secondary share-inline" onclick="adminViewLeaderboard()">View Leaderboard</button>
          <button class="small secondary share-inline" onclick="shareAdminRoundJoin()">Share Join Code</button>
          <button class="small secondary share-inline" onclick="shareAdminResults()">Share Results</button>
        </div>
        <div class="admin-actions">
          ${isActive
            ? '<button onclick="adminFinishRound()">Finish / Lock Scoring</button>'
            : '<button onclick="adminReopenRound()">Reopen Scoring</button>'}
          <button class="danger" onclick="adminDeleteRound()">Delete Round</button>
        </div>
      </div>
      <h3>Team / Player PINs</h3>
      ${(round.entries || []).map(entry => `
        <div class="pin-row">
          <div>
            <strong>${escapeHtml(entry.entryName)}</strong>
            <div class="entry-sub">${escapeHtml((entry.players || []).join(', '))}</div>
          </div>
          <div class="pin-actions">
            <div class="pin-code">${escapeHtml(entry.scoringPin || '')}</div>
            <button class="small secondary" onclick="adminScoreAsEntry('${entry.entryId}')">Score</button>
            <button class="small secondary share-button" onclick="shareAdminEntry('${entry.entryId}')">Share</button>
            <button class="small secondary" onclick="adminResetPin('${entry.entryId}')">Reset PIN</button>
          </div>
        </div>
      `).join('')}
    `;
  }


  function adminViewLeaderboard() {
    if (!lastAdminRound) {
      showModal('Choose a round first.');
      return;
    }

    currentRound = lastAdminRound;
    selectedEntryId = '';
    selectedEntryName = '';
    selectedEntryPin = '';
    showLeaderboard();
  }

  function adminScoreAsEntry(entryId) {
    if (!lastAdminRound) {
      showModal('Choose a round first.');
      return;
    }

    const entry = (lastAdminRound.entries || []).find(e => e.entryId === entryId);
    if (!entry) {
      showModal('Team/player not found.');
      return;
    }

    currentRound = lastAdminRound;
    selectedEntryId = entry.entryId;
    selectedEntryName = entry.entryName;
    selectedEntryPin = entry.scoringPin || '';
    currentHole = 1;
    saveLastAppState('scoreView');
    showScore();
  }

  function adminFinishRound() {
    if (!lastAdminRound) return;
    showConfirmModal('Lock scoring for this round? Teams will still be able to view the leaderboard.', () => {
      google.script.run
        .withSuccessHandler(round => {
          currentRound = currentRound && currentRound.roundId === round.roundId ? round : currentRound;
          renderAdminRound(round);
          showModal('Scoring is now locked.', 'Round Finished');
        })
        .withFailureHandler(err => showModal(err.message || err))
        .finishRound(lastAdminRound.roundId, adminPinValue);
    }, 'Finish Round');
  }

  function adminReopenRound() {
    if (!lastAdminRound) return;
    showConfirmModal('Reopen scoring for this round?', () => {
      google.script.run
        .withSuccessHandler(round => {
          currentRound = currentRound && currentRound.roundId === round.roundId ? round : currentRound;
          renderAdminRound(round);
          showModal('Scoring is open again.', 'Round Reopened');
        })
        .withFailureHandler(err => showModal(err.message || err))
        .reopenRound(lastAdminRound.roundId, adminPinValue);
    }, 'Reopen Round');
  }

  function adminResetPin(entryId) {
    if (!lastAdminRound) return;
    showConfirmModal('Reset this team/player PIN? The old PIN will stop working.', () => {
      google.script.run
        .withSuccessHandler(round => {
          renderAdminRound(round);
          showModal('PIN reset. Share the new PIN with that team/player.', 'PIN Reset');
        })
        .withFailureHandler(err => showModal(err.message || err))
        .resetEntryPin({
          adminPin: adminPinValue,
          roundId: lastAdminRound.roundId,
          entryId
        });
    }, 'Reset PIN');
  }

  function adminDeleteRound() {
    if (!lastAdminRound) return;
    showConfirmModal('Delete this round and all scores? This cannot be undone.', () => {
      google.script.run
        .withSuccessHandler(() => {
          const deletedJoinCode = lastAdminRound ? lastAdminRound.joinCode : '';
          const savedSession = getSavedScoringSession();
          if (savedSession && savedSession.joinCode === deletedJoinCode) {
            localStorage.removeItem(SCORING_SESSION_KEY);
          }
          clearLastAppState();
          updateResumeButton();
          document.getElementById('adminContent').innerHTML = '';
          lastAdminRound = null;
          currentRound = null;
          loadAdminRoundList();
          showModal('Round deleted.', 'Deleted');
        })
        .withFailureHandler(err => showModal(err.message || err))
        .deleteRound({
          adminPin: adminPinValue,
          roundId: lastAdminRound.roundId
        });
    }, 'Delete Round');
  }


  function adminResetAllData() {
    showConfirmModal('Clear ALL rounds, teams/players, and scores? AppSettings will be kept. This cannot be undone.', () => {
      google.script.run
        .withSuccessHandler(() => {
          localStorage.removeItem(SCORING_SESSION_KEY);
          clearLastAppState();
          currentRound = null;
          lastAdminRound = null;
          updateResumeButton();
          const content = document.getElementById('adminContent');
          if (content) content.innerHTML = '';
          loadAdminRoundList();
          showModal('All rounds, teams/players, and scores have been cleared.', 'Reset Complete');
        })
        .withFailureHandler(err => showModal(err.message || err, 'Reset Failed'))
        .resetAllData(adminPinValue);
    }, 'Reset All Data');
  }


  function getShareAppUrl(round) {
    const configuredUrl = String(round?.appUrl || '').trim();
    if (configuredUrl) return configuredUrl;

    const frontendUrl = String(typeof FRONTEND_APP_URL !== 'undefined' ? FRONTEND_APP_URL : '').trim();
    if (frontendUrl) return frontendUrl;

    try {
      return window.location.href.split('?')[0];
    } catch (err) {
      return '';
    }
  }

  function getJoinUrl(round) {
    const code = String(round?.joinCode || '').trim();
    const base = getShareAppUrl(round) || FRONTEND_APP_URL || window.location.href.split('?')[0];

    try {
      const url = new URL(base, window.location.href);
      url.searchParams.set('join', code);
      return url.toString();
    } catch (err) {
      const separator = base.includes('?') ? '&' : '?';
      return `${base}${separator}join=${encodeURIComponent(code)}`;
    }
  }

  function handleInitialJoinLink() {
    let joinCode = '';
    try {
      const params = new URLSearchParams(window.location.search || '');
      joinCode = (params.get('join') || params.get('code') || '').trim();
    } catch (err) {
      joinCode = '';
    }

    if (!joinCode) return false;

    const joinInput = document.getElementById('joinCode');
    if (joinInput) joinInput.value = joinCode;
    showJoinRound();

    loadRoundByCode(joinCode, round => {
      currentRound = round;
      renderTeamChoices();
      showView('chooseTeamView');
    });

    return true;
  }

  let qrRoundForShare = null;

  function openQrModal(round) {
    if (!round || !round.joinCode) {
      showModal('No round is loaded yet.', 'QR Code');
      return;
    }

    qrRoundForShare = round;
    const joinUrl = getJoinUrl(round);
    const modal = document.getElementById('qrModal');
    const img = document.getElementById('qrImage');
    const link = document.getElementById('qrJoinLink');
    const title = document.getElementById('qrModalTitle');

    if (title) title.textContent = `${round.roundName || 'Round'} QR Code`;
    if (img) img.src = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=10&data=${encodeURIComponent(joinUrl)}`;
    if (link) link.textContent = joinUrl;
    if (modal) modal.classList.remove('hidden');
  }

  function closeQrModal() {
    const modal = document.getElementById('qrModal');
    if (modal) modal.classList.add('hidden');
  }

  function showCurrentRoundQr() {
    openQrModal(currentRound);
  }

  function showAdminRoundQr() {
    openQrModal(lastAdminRound);
  }

  function shareQrJoinLink() {
    if (!qrRoundForShare) return;
    shareText(qrRoundForShare.roundName || 'Golf Round', getRoundShareMessage(qrRoundForShare));
  }

  function copyQrJoinLink() {
    if (!qrRoundForShare) return;
    copyShareText(getJoinUrl(qrRoundForShare));
  }


  function getResultsShareMessage(round) {
    if (!round) return '';

    const appUrl = getJoinUrl(round) || getShareAppUrl(round) || FRONTEND_APP_URL;
    const rows = (round.entries || []).map(entry => {
      const scoreMap = round.scores?.[entry.entryId] || {};
      const total = Object.values(scoreMap).reduce((sum, value) => sum + (Number(value) || 0), 0);
      const through = Object.values(scoreMap).filter(value => value !== '' && value !== null && typeof value !== 'undefined').length;
      return { entry, total, through };
    }).sort((a, b) => {
      if (a.through === 0 && b.through !== 0) return 1;
      if (b.through === 0 && a.through !== 0) return -1;
      return a.total - b.total;
    });

    const title = round.status === 'Final' ? 'Final Results' : 'Live Results';
    const resultLines = rows.map((row, index) => {
      const score = row.through ? row.total : '-';
      return `${index + 1}. ${row.entry.entryName} — ${score} (Through ${row.through})`;
    }).join('\n');

    return `🏌️ ${round.roundName || 'Golf Round'} ${title}\n\nJoin Code: ${round.joinCode}\nStatus: ${round.status || ''}\n\n${resultLines}\n\nView the leaderboard:\n${appUrl}`;
  }

  function getRoundShareMessage(round) {
    const name = round?.roundName || 'Golf Round';
    const code = round?.joinCode || '';
    const joinUrl = getJoinUrl(round);
    return `🏌️ ${name}

Join our live golf round!

Join Link:
${joinUrl}

Join Code:
${code}

Open the link and the join code will be filled in automatically. Tap "Install App" if you see it. If you do not see Install App, use your browser menu and choose Install app or Add to Home screen.`;
  }

  function getEntryShareMessage(round, entry) {
    const name = round?.roundName || 'Golf Round';
    const code = round?.joinCode || '';
    const joinUrl = getJoinUrl(round);
    const entryName = entry?.entryName || 'Your Team';
    const pin = entry?.scoringPin || '';
    return `🏌️ ${name}

You're scoring for:
${entryName}

Join Link:
${joinUrl}

Join Code:
${code}

Team PIN:
${pin}

Open the link, choose your team, and enter your Team PIN. Tap "Install App" if you see it. If you do not see Install App, use your browser menu and choose Install app or Add to Home screen.`;
  }

  function isProbablyMobileDevice() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  }

  function copyTextFallback(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.left = '-1000px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (err) {
      copied = false;
    }

    document.body.removeChild(textarea);
    return copied;
  }

  async function copyShareText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        showModal('Copied to clipboard. Paste it into a text or email.', 'Copied');
        return;
      }
    } catch (err) {
      // Apps Script runs inside an iframe, so Chrome desktop can block the modern Clipboard API.
    }

    if (copyTextFallback(text)) {
      showModal('Copied to clipboard. Paste it into a text or email.', 'Copied');
      return;
    }

    showModal(`<div class="copy-box">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`, 'Copy This');
  }

  async function shareText(title, text) {
    // Chrome desktop can expose navigator.share but not actually behave well inside Apps Script's iframe.
    // Use native share only on mobile; desktop gets a reliable clipboard fallback.
    if (isProbablyMobileDevice() && navigator.share) {
      try {
        await navigator.share({ title, text });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }

    await copyShareText(text);
  }


  function shareCurrentResults() {
    if (!currentRound) {
      showModal('No round is loaded yet.', 'Share Results');
      return;
    }
    shareText(`${currentRound.roundName || 'Golf Round'} Results`, getResultsShareMessage(currentRound));
  }

  function shareAdminResults() {
    if (!lastAdminRound) {
      showModal('Choose a round first.', 'Share Results');
      return;
    }
    shareText(`${lastAdminRound.roundName || 'Golf Round'} Results`, getResultsShareMessage(lastAdminRound));
  }

  function shareCurrentRoundJoin() {
    if (!currentRound) {
      showModal('No round is loaded yet.', 'Share');
      return;
    }
    shareText(currentRound.roundName || 'Golf Round', getRoundShareMessage(currentRound));
  }

  function shareCurrentRoundEntry(entryId) {
    if (!currentRound) {
      showModal('No round is loaded yet.', 'Share');
      return;
    }
    const entry = (currentRound.entries || []).find(e => e.entryId === entryId);
    if (!entry) {
      showModal('That team/player could not be found.', 'Share');
      return;
    }
    shareText(`${currentRound.roundName || 'Golf Round'} - ${entry.entryName}`, getEntryShareMessage(currentRound, entry));
  }

  function shareAdminRoundJoin() {
    if (!lastAdminRound) {
      showModal('Choose a round first.', 'Share');
      return;
    }
    shareText(lastAdminRound.roundName || 'Golf Round', getRoundShareMessage(lastAdminRound));
  }

  function shareAdminEntry(entryId) {
    if (!lastAdminRound) {
      showModal('Choose a round first.', 'Share');
      return;
    }
    const entry = (lastAdminRound.entries || []).find(e => e.entryId === entryId);
    if (!entry) {
      showModal('That team/player could not be found.', 'Share');
      return;
    }
    shareText(`${lastAdminRound.roundName || 'Golf Round'} - ${entry.entryName}`, getEntryShareMessage(lastAdminRound, entry));
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#096;');
  }
