# Travel Time

A shared group trip planner. Friends sign in with just their first and last name (checked against a private allowlist), pitch 2–3 destinations with cost estimates, see everything on a map, compare total cost per person, discuss, and vote.

- **Frontend:** `public/index.html`, a single file. It uses Leaflet and OpenStreetMap tiles (no API key) and Nominatim for place search.
- **API:** a Cloudflare Worker (`src/index.js` routes `/api/*` to `src/api.js`, and serves everything else from `public/` as static assets).
- **Database:** Cloudflare D1 (`travel-time-db`). The schema is in `migrations/`.

## How it works

| Concern | Approach |
| --- | --- |
| Identity | No accounts. The browser remembers the name and sends it on every API call. The server checks it, case-insensitively, against the `travelers` table on **every** request, reads included. |
| Allowlist | Lives only in D1. It is seeded from a local, gitignored `allowlist.txt`. It is never committed. |
| Limits | Up to 3 destinations per person (enforced atomically in SQL). One vote per person per destination. |
| Validation | All input is validated server-side: lengths, number ranges, whole-number nights, lat/lng bounds, JSON-only bodies, 16 KB max. |
| Permissions | Only the owner can edit or delete a destination. Only the author can delete a comment. |
| Rate limiting | Per-IP fixed windows stored in D1: login 10/min, reads 120/min, writes 30/min. |
| Security headers | `public/_headers` sets the CSP, nosniff, and referrer policy. All user content is HTML-escaped. |

The cost per person is `flight + hotel_per_night × nights + food_activities`.

## Managing the allowlist

Create `allowlist.txt` in the repo root. It is gitignored. Put one person per line:

```
# Lines starting with # are ignored
Jane Smith
Mary Ann, Van Buren     # use a comma when a first or last name has spaces
```

Then run:

```sh
npm install
npx wrangler login       # one time; opens a browser
npm run seed             # adds or updates the names in the live database
npm run seed -- --prune  # also removes anyone not in the file (deletes their posts and votes)
npm run seed -- --preview # seeds the separate database used by branch previews
```

## Local development

```sh
npm install
npm run db:migrate:local
npm run seed -- --local
npm run dev              # http://localhost:8787
```

## Deploying

The `travel-time` Worker is connected to this repo through Workers Builds, so every push to `main` runs `npx wrangler deploy`. Pushes to other branches run `npx wrangler preview`, which uses a separate `travel-time-db-preview` database (see the `previews` block in `wrangler.toml`). Bindings come from `wrangler.toml`, and there is no build step.

For a schema change, add `migrations/000N_*.sql` and run `npm run db:migrate`.
