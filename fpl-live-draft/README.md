# FPL Draft Live Tracker (static site)

This is a simple, static HTML/CSS/JS app that shows live team rosters during an FPL Draft. Enter your league id and it will:

- Load league info to list all managers/teams
- Poll draft choices to detect which FPL players are owned and by whom
- Map player ids to names and positions from the public bootstrap
- Render a grid of all teams at once, updating every few seconds

No server or database is required for this read-only viewer. All data comes directly from the public endpoints.

## APIs used

- League details (map owners to `entry_id`):
  - `https://draft.premierleague.com/api/league/{leagueId}/details`
- Draft choices (ownership via `element_status` with `status: "o"` and `owner`):
  - `https://draft.premierleague.com/api/draft/{leagueId}/choices`
- Player data and positions:
  - `https://fantasy.premierleague.com/api/bootstrap-static/`

For example data, see the official endpoints referenced in the app. The UI maps `owner` to `league_entries.entry_id` and `element` to `elements.id` → `web_name` and `element_type` → `element_types.plural_name_short`.

## Local development

Because this is a static site, you can open `index.html` directly, or serve it with a simple HTTP server to avoid any CORS/caching quirks.

- Option 1: open directly in the browser
- Option 2: use a basic local server

```bash
# from the project root
cd fpl-live-draft
# Python 3
python -m http.server 8123
# or Node
npx http-server -p 8123 --no-cache
```

Then browse to `http://localhost:8123` and enter your league id.

## Firebase (optional)

A database is not necessary for the live viewer. If you want persistence (e.g., historical snapshots, custom annotations, authentication), you can add Firebase as follows:

1. Create a Firebase project at `https://console.firebase.google.com`.
2. Enable Firestore (Native/In production mode) and Authentication (e.g., anonymous or Google).
3. Add a web app to get your config. It looks like:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

4. In `index.html`, before `app.js`, include the Firebase SDK scripts (v9+ modules) or a bundler. Example (module style):

```html
<script type="module">
  import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
  import { getFirestore, collection, addDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  // Example: persist each poll snapshot
  window.persistSnapshot = async (leagueId, payload) => {
    await addDoc(collection(db, `leagues/${leagueId}/snapshots`), {
      createdAt: Date.now(),
      data: payload,
    });
  };
</script>
```

5. In `app.js`, call `window.persistSnapshot?.(leagueId, { choices, timestamp: Date.now() })` where you want to record snapshots. Keep it optional.

Security note: If you deploy write access from the browser, configure Firestore security rules to restrict writes appropriately.

## Deployment

Any static hosting works:
- GitHub Pages, Netlify, Vercel, Firebase Hosting, Cloudflare Pages

For Firebase Hosting (optional):

```bash
npm i -g firebase-tools
firebase login
firebase init hosting  # choose existing project, set public dir to fpl-live-draft
firebase deploy
```

## Notes

- Poll frequency is set to ~4 seconds to be gentle on the API.
- The app uses `element_status` ownership as truth and orders picks by the `choices` list when available.
- If a league hasn't started drafting yet, you'll see empty rosters but still see league metadata.


