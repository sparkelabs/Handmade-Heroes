# FBA Dashboard Handoff

## Overview
This project is a local FBA Inventory dashboard (frontend) + SP-API Node backend (server).

## Run Locally
Frontend (static HTML):
```
cd /Users/aong48/Documents/Codex
python3 -m http.server 5173
```
Open: `http://localhost:5173/index.html`

Backend (Node/TS):
```
cd /Users/aong48/Documents/Codex/server
npm install
npm run dev
```
Backend: `http://localhost:4242`

## Key Files
- `/Users/aong48/Documents/Codex/index.html` (frontend UI + client logic)
- `/Users/aong48/Documents/Codex/server/src/index.ts` (API server)
- `/Users/aong48/Documents/Codex/server/src/spapi.ts` (LWA token + SP-API calls)
- `/Users/aong48/Documents/Codex/server/src/reports.ts` (Reports API helpers)
- `/Users/aong48/Documents/Codex/server/src/reviews.ts` (review request stub)
- `/Users/aong48/Documents/Codex/server/src/types.ts` (types)

## Environment (.env)
File: `/Users/aong48/Documents/Codex/server/.env`
```
PORT=4242
CORS_ORIGIN=http://localhost:5173
LWA_CLIENT_ID=...
LWA_CLIENT_SECRET=...
REFRESH_TOKEN_NA=...
REFRESH_TOKEN_EU=...
REFRESH_TOKEN_AU=...
APP_NAME=FBAInventoryDashboard
REPORT_AUTO_REFRESH=false
```

## Current State
- Frontend shows 4 marketplace cards and expandable panels.
- Inventory Snapshot is sorted by 7-day sales desc, shows top 20 with “Show more” expand.
- Review Requests is shown per marketplace (on panel).
- Transfer Opportunities removed.
- Reports refresh button triggers planning report refresh endpoint.

## Debug Endpoints
- `/api/stores` returns inventory + shipments.
- `/api/reports/planning/status` shows report cache/cooldown.
- `/api/reports/planning/refresh?store=US` triggers planning report refresh.
- `/api/debug/marketplaces` calls Sellers API (requires Sellers API scope).
- `/api/debug/inventory?store=US` returns raw FBA inventory summaries.

## Known Issues
1. Inventory quantities are empty (all zeros):
   - Likely due to tokens not tied to correct seller account or sandbox tokens.
   - `/api/debug/marketplaces` currently returns 403 (Sellers API scope missing from refresh token).
2. Inbound shipments are empty:
   - Implemented via `/fba/inbound/v0/shipments`, but may require role or data not present.
3. Reports API rate-limits with 429:
   - Cooldown logic is in place (15 min), auto-refresh can be disabled via `.env`.

## Recommended Next Steps
1. Re-authorize app in SP-API with Sellers role enabled.
2. Generate new refresh tokens and update `.env`.
3. Restart server and re-test:
   - `curl http://localhost:4242/api/debug/marketplaces`
   - `curl "http://localhost:4242/api/debug/inventory?store=US"`
4. If Sellers API still 403, verify tokens are from the same app as LWA credentials.

