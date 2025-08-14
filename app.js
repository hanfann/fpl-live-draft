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
  const leagueNameEl = document.getElementById('league-name');
  const leagueDraftDtEl = document.getElementById('league-draft-dt');
  const leagueTeamCountEl = document.getElementById('league-team-count');
  const lastUpdatedEl = document.getElementById('last-updated');
  const teamsGridEl = document.getElementById('teams-grid');
  const recentPicksSection = document.getElementById('recent-picks');
  const recentPicksList = document.getElementById('recent-picks-list');
  const themeToggleBtn = document.getElementById('theme-toggle');

  /**
   * Cache bootstrap data so we don't re-download per poll
   */
  let bootstrapCache = null; // { playersById, positionByType, fetchedAt }
  let pollAbortController = null;

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
    statusEl.textContent = message;
    statusEl.style.color = kind === 'error' ? '#ff8a8a' : '#8ea0c0';
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
    const playersById = new Map(); // id -> {web_name, element_type}
    for (const e of data.elements || []) {
      playersById.set(e.id, { id: e.id, web_name: e.web_name, element_type: e.element_type });
    }
    const positionByType = new Map(); // type id -> plural_name_short
    for (const t of data.element_types || []) {
      positionByType.set(t.id, t.plural_name_short);
    }
    bootstrapCache = { playersById, positionByType, fetchedAt: Date.now() };
    return bootstrapCache;
  }

  function buildLeagueEntryMaps(leagueDetails) {
    const entries = leagueDetails.league_entries || [];
    const byEntryId = new Map(); // entry_id -> entry
    for (const e of entries) byEntryId.set(e.entry_id, e);
    return { entries, byEntryId };
  }

  function renderLeagueMeta(leagueDetails) {
    leagueMetaEl.classList.remove('hidden');
    leagueNameEl.textContent = leagueDetails.league?.name ?? '';
    leagueDraftDtEl.textContent = (leagueDetails.league?.draft_dt || '').replace('T', ' ').replace('Z', ' UTC');
    leagueTeamCountEl.textContent = String((leagueDetails.league_entries || []).length);
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
        recent.push({
          time: c.choice_time,
          entryName: entry.entry_name,
          manager: `${entry.player_first_name} ${entry.player_last_name}`.trim(),
          playerName: player.web_name,
          pos,
        });
      }
    }
    // Latest first
    recent.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
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
      const li = document.createElement('li');
      li.textContent = `${item.entryName} (${item.manager}) → ${item.playerName} (${item.pos})`;
      recentPicksList.appendChild(li);
    }
  }

  function renderTeamsGrid(picksByOwner, entriesById, playersById, positionByType) {
    teamsGridEl.innerHTML = '';
    const owners = [...entriesById.keys()];
    owners.sort((a, b) => a - b);
    for (const ownerId of owners) {
      const entry = entriesById.get(ownerId);
      if (!entry) continue;
      const card = document.createElement('div');
      card.className = 'team-card';

      const header = document.createElement('div');
      header.className = 'team-title';
      const names = document.createElement('div');
      names.className = 'names';
      const entryName = document.createElement('div');
      entryName.className = 'entry-name';
      entryName.textContent = entry.entry_name;
      const managerName = document.createElement('div');
      managerName.className = 'manager-name';
      managerName.textContent = `${entry.player_first_name} ${entry.player_last_name}`.trim();
      names.appendChild(entryName);
      names.appendChild(managerName);
      header.appendChild(names);

      const count = document.createElement('div');
      const players = picksByOwner.get(ownerId) || [];
      count.textContent = `${players.length}`;
      header.appendChild(count);
      card.appendChild(header);

      const list = document.createElement('div');
      list.className = 'players';
      // Sort players by position: GKP, DEF, MID, FWD, and keep pick order within each position
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
      for (const item of enriched) {
        const pill = document.createElement('div');
        pill.className = 'player-pill';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = item.info.web_name;
        const posSpan = document.createElement('span');
        posSpan.className = `pos-badge pos-${item.posKey}`;
        posSpan.textContent = item.pos;
        pill.appendChild(nameSpan);
        pill.appendChild(posSpan);
        list.appendChild(pill);
      }
      card.appendChild(list);

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

    // Ensure player directory is loaded, with fallbacks
    let playersById, positionByType;
    try {
      ({ playersById, positionByType } = await getBootstrap());
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
    renderTeamsGrid(picksByOwner, byEntryId, playersById, positionByType);

    const recent = buildRecentPicks(choices, byEntryId, playersById, positionByType);
    renderRecentPicks(recent);

    lastUpdatedEl.textContent = formatTime(Date.now());
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
        setStatus('Live');
      } catch (err) {
        console.error(err);
        setStatus('Error updating. Will retry...', 'error');
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

  initTheme();
})();


