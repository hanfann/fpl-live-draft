// Minimal, dependency-free live FPL Draft tracker
// Fetches:
// - League details: /api/league/{leagueId}/details
// - Draft choices:  /api/draft/{leagueId}/choices  (owner mapping via owner -> entry_id)
// - Bootstrap:      /api/bootstrap-static (for player names and positions)

(function () {
  const form = document.getElementById('league-form');
  const input = document.getElementById('league-id-input');
  const statusEl = document.getElementById('status');
  const leagueMetaEl = document.getElementById('league-meta');
  // Note: Some elements may not exist in simplified layout
  const leagueNameEl = document.getElementById('league-name');
  const leagueDraftDtEl = document.getElementById('league-draft-dt');
  const leagueTeamCountEl = document.getElementById('league-team-count');
  const lastUpdatedEl = document.getElementById('last-updated');
  const teamsGridEl = document.getElementById('teams-grid');
  const recentPicksSection = document.getElementById('recent-picks');
  const recentPicksList = document.getElementById('recent-picks-list');
  const themeToggleBtn = document.getElementById('theme-toggle');
  const leagueInfoSection = document.getElementById('league-info-section');
  const displayedLeagueId = document.getElementById('displayed-league-id');
  const exportBtn = document.getElementById('export-btn');
  const exportAnonymousBtn = document.getElementById('export-anonymous-btn');
  const instructionsBtn = document.getElementById('instructions-btn');
  const instructionsPopup = document.getElementById('instructions-popup');
  const closePopupBtn = document.getElementById('close-popup');

  /**
   * Cache bootstrap data so we don't re-download per poll
   */
  let bootstrapCache = null; // { playersById, positionByType, fetchedAt }
  let pollAbortController = null;
  let currentLeagueData = null; // Store current league data for export

  // If served through the Worker, these relative URLs will be proxied with CORS enabled
  const USE_WORKER_PROXY = true;
  const ENDPOINTS = USE_WORKER_PROXY ? {
    details: (leagueId) => `/api/league/${leagueId}/details`,
    choices: (leagueId) => `/api/draft/${leagueId}/choices`,
    bootstrap: () => '/api/bootstrap-static'
  } : {
    details: (leagueId) => `https://draft.premierleague.com/api/league/${leagueId}/details`,
    choices: (leagueId) => `https://draft.premierleague.com/api/draft/${leagueId}/choices`,
    bootstrap: () => 'https://fantasy.premierleague.com/api/bootstrap-static/'
  };

  const CORS_PROXIES = [
    'https://cors.isomorphic-git.org/',             // append URL
    'https://corsproxy.io/?',                       // query param ?{url}
    'https://thingproxy.freeboard.io/fetch/'        // append URL
  ];

  function buildProxyUrl(proxyBase, url) {
    if (proxyBase.endsWith('/?') || proxyBase.endsWith('?')) {
      return proxyBase + encodeURIComponent(url);
    }
    if (proxyBase.endsWith('/')) return proxyBase + url;
    return proxyBase + '/' + url;
  }

  function setStatus(message, kind = 'info') {
    if (message.includes('<a')) {
      statusEl.innerHTML = message;
    } else {
      statusEl.textContent = message;
    }
    statusEl.style.color = kind === 'error' ? '#ff6b6b' : '#6b7280';
  }

  async function fetchJson(url, init) {
    const res = await fetch(url, {
      ...init,
      headers: {
        'accept': 'application/json',
        ...(init && init.headers ? init.headers : {})
      },
      cache: 'no-store',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${text}`);
    }
    return res.json();
  }

  function toUpstreamAbsolute(url) {
    if (url.startsWith('/api/bootstrap-static')) {
      return 'https://fantasy.premierleague.com/api/bootstrap-static/';
    }
    let m = url.match(/^\/api\/league\/(\d+)\/details/);
    if (m) return `https://draft.premierleague.com/api/league/${m[1]}/details`;
    m = url.match(/^\/api\/draft\/(\d+)\/choices/);
    if (m) return `https://draft.premierleague.com/api/draft/${m[1]}/choices`;
    return null;
  }

  async function fetchJsonWithFallback(url) {
    const urls = [];
    const isRelative = url.startsWith('/');
    if (isRelative) urls.push(url); // try same-origin Worker/Pages functions first
    const absolute = isRelative ? toUpstreamAbsolute(url) : url;
    if (absolute) {
      urls.push(absolute);
      for (const p of CORS_PROXIES) urls.push(buildProxyUrl(p, absolute));
      // r.jina.ai mirrors responses with permissive CORS; add both http/https path styles
      urls.push('https://r.jina.ai/http://' + absolute.replace(/^https?:\/\//, ''));
      urls.push('https://r.jina.ai/https://' + absolute.replace(/^https?:\/\//, ''));
    }

    let lastErr;
    for (const candidate of urls) {
      try {
        if (candidate.startsWith('https://r.jina.ai/')) {
          const res = await fetch(candidate, { cache: 'no-store', mode: 'cors' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          return JSON.parse(text);
        }
        return await fetchJson(candidate);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Failed to fetch with proxies');
  }

  async function getBootstrap() {
    if (bootstrapCache) return bootstrapCache;
    let data = await fetchJsonWithFallback(ENDPOINTS.bootstrap());
    const playersById = new Map(); // id -> {web_name, element_type, team_code}
    for (const e of data.elements || []) {
      playersById.set(e.id, { 
        id: e.id, 
        web_name: e.web_name, 
        element_type: e.element_type,
        team_code: e.team_code 
      });
    }
    const positionByType = new Map(); // type id -> plural_name_short
    for (const t of data.element_types || []) {
      positionByType.set(t.id, t.plural_name_short);
    }
    const teamsByCode = new Map(); // team_code -> {short_name, name}
    for (const team of data.teams || []) {
      teamsByCode.set(team.code, {
        short_name: team.short_name,
        name: team.name
      });
    }
    bootstrapCache = { playersById, positionByType, teamsByCode, fetchedAt: Date.now() };
    return bootstrapCache;
  }

  function buildLeagueEntryMaps(leagueDetails) {
    const entries = leagueDetails.league_entries || [];
    const byEntryId = new Map(); // entry_id -> entry
    for (const e of entries) byEntryId.set(e.entry_id, e);
    return { entries, byEntryId };
  }

  function renderLeagueMeta(leagueDetails) {
    // Update league name in the info section
    const leagueNameEl = document.getElementById('league-name');
    if (leagueNameEl) {
      leagueNameEl.textContent = leagueDetails.league?.name ?? 'Draft League';
    }
  }

  function groupPlayersByOwner(choices, ownerIdSet, pickOrderByElement) {
    // Return Map<ownerEntryId, Array<{element, order, choice_time}>> for status 'o'
    const picks = new Map();
    for (const ownerId of ownerIdSet) picks.set(ownerId, []);
    // The API can include a long element_status array plus explicit choices list.
    // We will use element_status as the truth for current ownership, and choices for recent order.

    if (Array.isArray(choices.element_status)) {
      for (const st of choices.element_status) {
        if (st.status === 'o' && st.owner != null) {
          if (!picks.has(st.owner)) picks.set(st.owner, []);
          const order = pickOrderByElement?.get(st.element) ?? Number.POSITIVE_INFINITY;
          picks.get(st.owner).push({ element: st.element, order, choice_time: null });
        }
      }
    }
    // Sort picks by order if available
    for (const [owner, arr] of picks.entries()) {
      arr.sort((a, b) => a.order - b.order);
    }
    return picks;
  }

  function buildRecentPicks(choices, entriesById, playersById, positionByType) {
    const recent = [];
    if (Array.isArray(choices.choices)) {
      for (const c of choices.choices) {
        // Only include if was picked (owner in element_status indicates ownership, but choices has sequence)
        const player = playersById.get(c.element);
        if (!player) continue;
        const entry = entriesById.get(c.entry);
        const pos = positionByType.get(player.element_type);
        if (!entry) continue;
        const round = Number.isFinite(c.index) ? c.index : null;
        recent.push({
          time: c.choice_time,
          round: round,
          entryName: entry.entry_name,
          manager: `${entry.player_first_name} ${entry.player_last_name}`.trim(),
          playerName: player.web_name,
          pos,
        });
      }
    }
    // Sort by round/index first, then by time
    recent.sort((a, b) => {
      if (a.round !== null && b.round !== null) {
        return a.round - b.round;
      }
      return (a.time || '').localeCompare(b.time || '');
    });
    return recent;
  }

  function renderRecentPicks(list) {
    if (!list.length) {
      recentPicksSection.classList.add('hidden');
      return;
    }
    recentPicksSection.classList.remove('hidden');
    recentPicksList.innerHTML = '';
    const latest = list.slice(-20).reverse(); // show last 20
    for (const item of latest) {
      const tr = document.createElement('tr');
      
      const managerCell = document.createElement('td');
      managerCell.textContent = `${item.entryName} (${item.manager})`;
      
      const playerCell = document.createElement('td');
      const roundText = item.round !== null ? ` - Round ${item.round}` : '';
      playerCell.textContent = `${item.playerName} (${item.pos})${roundText}`;
      
      tr.appendChild(managerCell);
      tr.appendChild(playerCell);
      recentPicksList.appendChild(tr);
    }
  }

  function renderTeamsGrid(picksByOwner, entriesById, playersById, positionByType, teamsByCode, pickOrderByElement) {
    teamsGridEl.innerHTML = '';
    const owners = [...entriesById.keys()];
    owners.sort((a, b) => a - b);
    
    for (const ownerId of owners) {
      const entry = entriesById.get(ownerId);
      if (!entry) continue;
      
      // Create team card
      const card = document.createElement('div');
      card.className = 'team-card';

      // Team header
      const header = document.createElement('div');
      header.className = 'team-header';
      
      const teamInfo = document.createElement('div');
      teamInfo.className = 'team-info';
      
      const teamName = document.createElement('h3');
      teamName.textContent = entry.entry_name;
      
      const managerName = document.createElement('p');
      managerName.textContent = `${entry.player_first_name} ${entry.player_last_name}`.trim();
      
      teamInfo.appendChild(teamName);
      teamInfo.appendChild(managerName);
      header.appendChild(teamInfo);
      card.appendChild(header);

      // Players list
      const playersList = document.createElement('div');
      playersList.className = 'players-list';
      
      const players = picksByOwner.get(ownerId) || [];
      const POS_ORDER = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };
      const enriched = [];
      
      // Add actual players
      for (const p of players) {
        const info = playersById.get(p.element);
        if (!info) continue;
        const pos = positionByType.get(info.element_type) || '';
        const posKey = String(pos).toUpperCase();
        const priority = POS_ORDER.hasOwnProperty(posKey) ? POS_ORDER[posKey] : 99;
        enriched.push({ info, pos, posKey, order: p.order, priority, isEmpty: false });
      }
      
      enriched.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.order - b.order;
      });

      // Create slots for each position (15 total: 2 GKP, 5 DEF, 5 MID, 3 FWD)
      const positionSlots = [
        { pos: 'GKP', count: 2 },
        { pos: 'DEF', count: 5 },
        { pos: 'MID', count: 5 },
        { pos: 'FWD', count: 3 }
      ];

      for (const posSlot of positionSlots) {
        const filledPlayers = enriched.filter(p => p.posKey === posSlot.pos);
        const emptySlots = posSlot.count - filledPlayers.length;

        // Add filled players
        for (const player of filledPlayers) {
          const playerRow = document.createElement('div');
          playerRow.className = 'player-row filled';

          const positionBadge = document.createElement('div');
          positionBadge.className = `position-badge ${posSlot.pos.toLowerCase()}`;
          positionBadge.textContent = posSlot.pos;

          const playerInfo = document.createElement('div');
          playerInfo.className = 'player-info';

          const playerName = document.createElement('span');
          playerName.className = 'player-name';
          const teamInfo = teamsByCode?.get(player.info.team_code);
          const teamAbbr = teamInfo?.short_name || '';
          const roundNumber = pickOrderByElement?.get(player.info.id);
          const roundText = (roundNumber && Number.isFinite(roundNumber)) ? ` (${roundNumber})` : '';
          playerName.textContent = `${player.info.web_name}${roundText}`;

          const teamBadge = document.createElement('span');
          teamBadge.className = 'team-badge';
          teamBadge.textContent = teamAbbr;

          playerInfo.appendChild(playerName);
          if (teamAbbr) playerInfo.appendChild(teamBadge);

          playerRow.appendChild(positionBadge);
          playerRow.appendChild(playerInfo);
          playersList.appendChild(playerRow);
        }

        // Add empty slots
        for (let i = 0; i < emptySlots; i++) {
          const playerRow = document.createElement('div');
          playerRow.className = 'player-row empty';

          const positionBadge = document.createElement('div');
          positionBadge.className = `position-badge ${posSlot.pos.toLowerCase()}`;
          positionBadge.textContent = posSlot.pos;

          const playerInfo = document.createElement('div');
          playerInfo.className = 'player-info';

          const emptySlot = document.createElement('span');
          emptySlot.className = 'empty-slot';
          emptySlot.textContent = 'Empty slot';

          playerInfo.appendChild(emptySlot);
          playerRow.appendChild(positionBadge);
          playerRow.appendChild(playerInfo);
          playersList.appendChild(playerRow);
        }
      }

      card.appendChild(playersList);
      teamsGridEl.appendChild(card);
    }
  }

  function formatTime(tsMs) {
    const d = new Date(tsMs);
    return d.toLocaleString();
  }

  async function loadAndRender(leagueId) {
    // Fetch choices and league details first
    const [leagueDetails, choices] = await Promise.all([
      fetchJsonWithFallback(ENDPOINTS.details(leagueId)),
      fetchJsonWithFallback(ENDPOINTS.choices(leagueId)),
    ]);

    const { byEntryId } = buildLeagueEntryMaps(leagueDetails);
    renderLeagueMeta(leagueDetails);
    
    // Show league info section with ID
    leagueInfoSection.classList.remove('hidden');
    displayedLeagueId.textContent = leagueId;

    // Ensure player directory is loaded, with fallbacks
    let playersById, positionByType, teamsByCode;
    try {
      ({ playersById, positionByType, teamsByCode } = await getBootstrap());
    } catch (e) {
      console.warn('Bootstrap failed, will retry next tick', e);
      setStatus('Waiting for FPL player directory...', 'info');
      return; // don't mark as error; next tick will retry
    }
    const pickOrderByElement = new Map();
    if (Array.isArray(choices.choices)) {
      for (const c of choices.choices) {
        // Prefer index if present; fallback to timestamp ordering by Date.parse
        const order = Number.isFinite(c.index) ? c.index : Date.parse(c.choice_time || '') || Number.POSITIVE_INFINITY;
        pickOrderByElement.set(c.element, order);
      }
    }
    const ownerIds = new Set(byEntryId.keys());
    const picksByOwner = groupPlayersByOwner(choices, ownerIds, pickOrderByElement);
    renderTeamsGrid(picksByOwner, byEntryId, playersById, positionByType, teamsByCode, pickOrderByElement);

    const recent = buildRecentPicks(choices, byEntryId, playersById, positionByType);
    renderRecentPicks(recent);

    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = formatTime(Date.now());
    }
    
    // Store current league data for export
    currentLeagueData = {
      leagueId,
      leagueDetails,
      choices,
      byEntryId,
      playersById,
      positionByType,
      teamsByCode,
      picksByOwner,
      pickOrderByElement
    };
  }

  function startPolling(leagueId) {
    if (pollAbortController) {
      pollAbortController.abort();
      pollAbortController = null;
    }
    const controller = new AbortController();
    pollAbortController = controller;

    const POLL_MS = 4000; // 4s

    async function tick() {
      if (controller.signal.aborted) return;
      try {
        await loadAndRender(leagueId);
        
        // Track successful league load
        if (typeof gtag !== 'undefined') {
          gtag('event', 'league_loaded', {
            event_category: 'engagement',
            event_label: 'successful_load',
            value: 1
          });
        }
        
        setStatus(''); // Hide status on success
      } catch (err) {
        console.error(err);
        if (err.message.includes('404') || err.message.includes('not found')) {
          setStatus('League not found. Did you enter the right League ID? <a href="#" id="status-help-link">Find your League ID here</a>', 'error');
          // Add event listener to the help link
          setTimeout(() => {
            const helpLink = document.getElementById('status-help-link');
            if (helpLink) {
              helpLink.addEventListener('click', (e) => {
                e.preventDefault();
                if (instructionsPopup) {
                  instructionsPopup.classList.remove('hidden');
                }
              });
            }
          }, 100);
        } else {
          setStatus('Error loading data. Will retry...', 'error');
        }
      } finally {
        if (!controller.signal.aborted) {
          setTimeout(tick, POLL_MS);
        }
      }
    }

    tick();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = String(input.value || '').trim();
    if (!value || !/^[0-9]+$/.test(value)) {
      setStatus('Please enter a valid numeric league id', 'error');
      return;
    }
    
    // Track league ID submission
    if (typeof gtag !== 'undefined') {
      gtag('event', 'league_search', {
        event_category: 'engagement',
        event_label: 'start_tracking_click',
        value: 1
      });
    }
    
    setStatus('Loading...');
    startPolling(value);
  });

  // Theme handling
  function applyTheme(theme) {
    const root = document.documentElement;
    const normalized = theme === 'dark' || theme === 'light' ? theme : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.setAttribute('data-theme', normalized);
    if (themeToggleBtn) themeToggleBtn.textContent = normalized === 'dark' ? '☀️' : '🌙';
  }

  function initTheme() {
    const saved = localStorage.getItem('theme');
    applyTheme(saved || 'auto');
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        localStorage.setItem('theme', next);
        applyTheme(next);
      });
    }
  }

  async function exportDraftResults(isAnonymous = false) {
    if (!currentLeagueData) {
      alert('No league data available for export');
      return;
    }

    const { leagueDetails, byEntryId, playersById, positionByType, teamsByCode, picksByOwner, pickOrderByElement } = currentLeagueData;
    
    // Check if user is in dark mode
    const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';

    // Create export container
    const exportContainer = document.createElement('div');
    const bgColor = isDarkMode ? '#0f0f0f' : 'white';
    const textColor = isDarkMode ? '#e5e5e5' : '#0b1020';
    exportContainer.style.cssText = `
      position: fixed;
      top: -10000px;
      left: -10000px;
      width: 1200px;
      background: ${bgColor};
      color: ${textColor};
      font-family: "Segoe UI", ui-sans-serif, system-ui, -apple-system, Roboto, Helvetica, Arial;
      padding: 40px;
      box-sizing: border-box;
    `;

    // Add title
    const title = document.createElement('h1');
    const titleColor = isDarkMode ? '#ffffff' : '#0b1020';
    title.style.cssText = `
      text-align: center;
      margin: 0 0 10px 0;
      font-size: 28px;
      font-weight: 700;
      color: ${titleColor};
    `;
    title.textContent = 'FPL Live Draft Room Tracker';

    // Add league name (skip for anonymous)
    let leagueName = null;
    if (!isAnonymous) {
      leagueName = document.createElement('h2');
      const subtitleColor = isDarkMode ? '#a0a0a0' : '#5b6b84';
      leagueName.style.cssText = `
        text-align: center;
        margin: 0 0 30px 0;
        font-size: 18px;
        color: ${subtitleColor};
        font-weight: 400;
      `;
      leagueName.textContent = leagueDetails.league?.name || 'Draft League';
    }

    // Create teams grid
    const teamsGrid = document.createElement('div');
    teamsGrid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 20px;
      margin-bottom: 40px;
    `;

    // Sort owners by entry ID to maintain consistent order
    const owners = [...byEntryId.keys()].sort((a, b) => a - b);

    for (let i = 0; i < owners.length; i++) {
      const ownerId = owners[i];
      const entry = byEntryId.get(ownerId);
      if (!entry) continue;

      const teamCard = document.createElement('div');
      const cardBg = isDarkMode ? '#1a1a1a' : '#f6f7fb';
      const cardBorder = isDarkMode ? '#333333' : '#dde3f0';
      teamCard.style.cssText = `
        background: ${cardBg};
        border: 1px solid ${cardBorder};
        border-radius: 12px;
        padding: 16px;
      `;

      // Team header
      const header = document.createElement('div');
      header.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid ${cardBorder};
      `;

      const teamInfo = document.createElement('div');
      const teamName = document.createElement('div');
      const teamNameColor = isDarkMode ? '#ffffff' : '#0b1020';
      teamName.style.cssText = `
        font-weight: 700;
        font-size: 14px;
        margin-bottom: 4px;
        color: ${teamNameColor};
      `;
      teamName.textContent = isAnonymous ? `Team ${i + 1}` : entry.entry_name;

      const managerName = document.createElement('div');
      const managerNameColor = isDarkMode ? '#a0a0a0' : '#5b6b84';
      managerName.style.cssText = `
        font-size: 12px;
        color: ${managerNameColor};
      `;
      managerName.textContent = isAnonymous ? `Manager ${i + 1}` : `${entry.player_first_name} ${entry.player_last_name}`.trim();

      teamInfo.appendChild(teamName);
      teamInfo.appendChild(managerName);
      header.appendChild(teamInfo);

      teamCard.appendChild(header);

      // Players list
      const players = picksByOwner.get(ownerId) || [];
      const POS_ORDER = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };
      const enriched = [];
      
      for (const p of players) {
        const info = playersById.get(p.element);
        if (!info) continue;
        const pos = positionByType.get(info.element_type) || '';
        const posKey = String(pos).toUpperCase();
        const priority = POS_ORDER.hasOwnProperty(posKey) ? POS_ORDER[posKey] : 99;
        enriched.push({ info, pos, posKey, order: p.order, priority });
      }
      
      enriched.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.order - b.order;
      });

      // Limit to 15 players as mentioned in requirements
      const displayPlayers = enriched.slice(0, 15);

      for (const item of displayPlayers) {
        const playerRow = document.createElement('div');
        const playerRowBg = isDarkMode ? '#262626' : '#fafafa';
        const playerRowBorder = isDarkMode ? '#404040' : '#e1e5e9';
        playerRow.style.cssText = `
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px;
          margin: 4px 0;
          background: ${playerRowBg};
          border: 1px solid ${playerRowBorder};
          border-radius: 6px;
          font-size: 12px;
        `;

        // Position badge (left)
        const positionBadge = document.createElement('span');
        positionBadge.textContent = item.pos;
        positionBadge.style.cssText = `
          padding: 4px 6px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          color: #061022;
          flex-shrink: 0;
          width: 2.5rem;
          text-align: center;
          ${item.posKey === 'GKP' ? 'background: #ffd166;' : ''}
          ${item.posKey === 'DEF' ? 'background: #4dd4a3;' : ''}
          ${item.posKey === 'MID' ? 'background: #6aa7ff;' : ''}
          ${item.posKey === 'FWD' ? 'background: #ff6a6a;' : ''}
        `;

        // Player info container
        const playerInfo = document.createElement('div');
        playerInfo.style.cssText = `
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex: 1;
          min-width: 0;
        `;

        // Player name with selection number
        const playerName = document.createElement('span');
        const roundNumber = pickOrderByElement?.get(item.info.id);
        const roundText = (roundNumber && Number.isFinite(roundNumber)) ? ` (${roundNumber})` : '';
        playerName.textContent = `${item.info.web_name}${roundText}`;
        const playerNameColor = isDarkMode ? '#e5e5e5' : '#1a1a1a';
        playerName.style.cssText = `
          color: ${playerNameColor};
          font-weight: 500;
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        `;

        // Team badge (right)
        const teamBadge = document.createElement('span');
        const teamInfo = teamsByCode?.get(item.info.team_code);
        const teamAbbr = teamInfo?.short_name || '';
        teamBadge.textContent = teamAbbr;
        const teamBadgeBg = isDarkMode ? '#404040' : '#f0f0f0';
        const teamBadgeColor = isDarkMode ? '#e0e0e0' : '#4a4a4a';
        const teamBadgeBorder = isDarkMode ? '#555555' : '#e1e5e9';
        teamBadge.style.cssText = `
          font-size: 10px;
          font-weight: 500;
          color: ${teamBadgeColor};
          background: ${teamBadgeBg};
          padding: 2px 6px;
          border-radius: 3px;
          border: 1px solid ${teamBadgeBorder};
          flex-shrink: 0;
          margin-left: 8px;
          min-width: 2.5rem;
          text-align: center;
        `;

        playerInfo.appendChild(playerName);
        if (teamAbbr) playerInfo.appendChild(teamBadge);

        playerRow.appendChild(positionBadge);
        playerRow.appendChild(playerInfo);
        teamCard.appendChild(playerRow);
      }

      teamsGrid.appendChild(teamCard);
    }

    // Add branding
    const branding = document.createElement('div');
    const brandingBg = isDarkMode ? '#1a1a1a' : '#f8f9fa';
    const brandingColor = isDarkMode ? '#ffffff' : '#1a1a1a';
    const brandingBorder = isDarkMode ? '#333333' : '#dde3f0';
    branding.style.cssText = `
      text-align: center;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 2px solid ${brandingBorder};
      font-size: 24px;
      color: ${brandingColor};
      font-weight: 600;
      font-family: "Segoe UI", sans-serif;
      background: ${brandingBg};
      padding: 20px;
      border-radius: 8px;
    `;
    branding.textContent = 'Generated from fpl-live-draft.pages.dev';

    exportContainer.appendChild(title);
    if (leagueName) {
      exportContainer.appendChild(leagueName);
    }
    exportContainer.appendChild(teamsGrid);
    exportContainer.appendChild(branding);
    document.body.appendChild(exportContainer);

    try {
      // Use html2canvas to capture the export container
      const canvas = await html2canvas(exportContainer, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        allowTaint: true,
        width: 1200,
        height: exportContainer.scrollHeight
      });

      // Convert to blob and download
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const suffix = isAnonymous ? 'anonymous' : 'results';
        a.download = `fpl-draft-${suffix}-${currentLeagueData.leagueId}-${new Date().toISOString().split('T')[0]}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 'image/png');

    } catch (error) {
      console.error('Export failed:', error);
      alert('Export failed. Please try again.');
    } finally {
      document.body.removeChild(exportContainer);
    }
  }

  // Export button event listeners
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      // Track export event
      if (typeof gtag !== 'undefined') {
        gtag('event', 'export_data', {
          event_category: 'engagement',
          event_label: 'export_regular',
          value: 1
        });
      }
      exportDraftResults(false);
    });
  }
  
  if (exportAnonymousBtn) {
    exportAnonymousBtn.addEventListener('click', () => {
      // Track anonymous export event
      if (typeof gtag !== 'undefined') {
        gtag('event', 'export_data', {
          event_category: 'engagement',
          event_label: 'export_anonymous',
          value: 1
        });
      }
      exportDraftResults(true);
    });
  }

  // Instructions popup event listeners
  if (instructionsBtn) {
    instructionsBtn.addEventListener('click', () => {
      // Track instructions popup open
      if (typeof gtag !== 'undefined') {
        gtag('event', 'instructions_opened', {
          event_category: 'engagement',
          event_label: 'find_league_id_click',
          value: 1
        });
      }
      instructionsPopup.classList.remove('hidden');
      // Populate with placeholder content for now
      const content = document.getElementById('instructions-content');
      content.innerHTML = `
        <div class="instruction-section">
          <h4>If your draft has not started but draft room is available:</h4>
          <div class="instruction-image">
            <img src="./image.png" alt="FPL Draft Network Tab Instructions" style="max-width: 100%; height: auto; border: 1px solid #ddd; border-radius: 8px; margin: 12px 0;">
          </div>
          <ol>
            <li>Enter draft room</li>
            <li>Click F12 (or right click > Inspect)</li>
            <li>Navigate to the Network tab and Refresh the page</li>
            <li>Look for 'details' in the left menu</li>
            <li>Find your 5 digit league ID in the Request URL</li>
          </ol>
        </div>
        
        <div class="instruction-section">
          <h4>If your draft has completed:</h4>
          <ol>
            <li>Go to your League</li>
            <li>Find your league ID in the browser URL</li>
          </ol>
          <p><em>Example:</em> If your URL is <code>https://draft.premierleague.com/league/12345/status</code>, then your League ID is <strong>12345</strong></p>
        </div>
      `;
    });
  }

  if (closePopupBtn) {
    closePopupBtn.addEventListener('click', () => {
      instructionsPopup.classList.add('hidden');
    });
  }

  // Close popup when clicking outside
  if (instructionsPopup) {
    instructionsPopup.addEventListener('click', (e) => {
      if (e.target === instructionsPopup) {
        instructionsPopup.classList.add('hidden');
      }
    });
  }

  initTheme();
})();


