# CableGuard-MVP

Maritime anomaly and dark-vessel risk dashboard for Korean waters.

This MVP extends the existing Leaflet submarine cable and bathymetry map into an explainable maritime risk prioritization dashboard. It combines preserved cable/depth layers, synthetic demo injections, rule-based scoring, commander-facing recommendations, and an optional AISStream.io live AIS background layer through a local backend proxy.

This MVP performs risk prioritization, not hostile-intent confirmation.

## What The MVP Does

- Preserves the existing Korean submarine cable and depth contour map.
- Renders synthetic suspicious behavior scenarios for repeatable demos.
- Computes risk scores from event fields instead of hard-coding final scores.
- Shows ranked events, filters, summary counts, selected-event evidence, and risk buffers.
- Exports the currently visible filtered events as a JSON threat report.
- Displays live AIS vessels as unassessed blue/gray contacts when AISStream is configured.
- Creates backend-authored live AIS anomaly reviews for cable risk, loitering, and close-proximity encounter behavior.
- Persists live AIS observations, latest vessel state, derived live anomaly events, and operator review history when Postgres is configured.

Synthetic injected tracks are used to demonstrate detection logic under controlled scenarios.

Dragging-compatible behavior means movement compatible with cable-risk behavior; it is not a confirmed anchor dragging event.

Live AIS vessels are not automatically treated as threats.

## Quick Start

1. Install dependencies.
2. Copy `.env.example` to `.env`.
3. Optionally set `AISSTREAM_API_KEY`.
4. Optionally set `DATABASE_URL` for persistence and review audit history.
5. Start the server.
6. Open `http://localhost:3000`.

Example:

```bash
npm install
cp .env.example .env
npm start
```

On Windows PowerShell, use:

```powershell
Copy-Item .env.example .env
npm start
```

## GitHub And Vercel Deployment

This repository is prepared to be imported into Vercel from GitHub.

Recommended Vercel settings:

- Framework Preset: Other
- Root Directory: project root
- Build Command: `npm run build`
- Output Directory: leave blank

The Vercel entrypoint is `api/server.js`, which exports the same HTTP server used by local `npm start`. `vercel.json` rewrites traffic to that server so the dashboard, API routes, and `/ws` WebSocket endpoint share the Express app.

Vercel WebSockets use Vercel Functions and Fluid Compute. WebSocket connections can close when a function reaches its maximum duration, and reconnects may land on another function instance. Durable review/event state should therefore use Postgres rather than process memory.

For Vercel environment variables, configure the same values from `.env.example` in Project Settings. Keep `ENABLE_VERCEL_AISSTREAM=false` for a static/API demo deployment. Set it to `true` only if you want the Vercel function instance to open the upstream AISStream connection; multiple warm instances may create multiple upstream AIS connections.

## Live AIS Without Persistence

If `AISSTREAM_API_KEY` is not set, the backend still starts and the dashboard remains usable in Demo Mode with synthetic scenarios only.

If `DATABASE_URL` is not set, the app still runs, but live AIS state and review actions stay in memory and are lost on restart.

## Live AIS With Persistence

Set `AISSTREAM_API_KEY` to enable the live AISStream feed.

Set `DATABASE_URL` to enable Postgres-backed persistence for:

- normalized AIS position history
- latest vessel state rehydration on restart
- backend-authored live anomaly events
- event evidence and recommendation snapshots
- operator review status and notes audit history

The backend connects to:

```text
wss://stream.aisstream.io/v0/stream
```

It subscribes to multiple Korean maritime watch AOIs:

```json
[
  [[32.0, 123.0], [38.9, 126.9]],
  [[31.5, 124.8], [34.8, 128.6]],
  [[33.6, 127.3], [35.9, 130.2]],
  [[36.0, 128.8], [39.6, 132.6]]
]
```

The API key is read only by `server.js` and is never exposed in frontend JavaScript.

## Database Setup

When `DATABASE_URL` is configured, the server automatically:

- opens a Postgres connection on startup
- runs SQL migrations from `db/migrations`
- rehydrates latest vessel state, recent track windows, and active live anomaly events
- prunes old AIS position rows using tiered retention

You can also run migrations manually:

```bash
npm run db:migrate
```

## Environment Variables

```bash
AISSTREAM_API_KEY=
PORT=3000
DATABASE_URL=
DATABASE_SSL=false
BASELINE_AIS_POSITION_RETENTION_DAYS=7
SUSPICIOUS_AIS_POSITION_RETENTION_DAYS=30
SUSPICIOUS_RETENTION_LOOKBACK_HOURS=48
AISSTREAM_RATE_LIMIT_DELAY_MS=120000
ENABLE_VERCEL_AISSTREAM=false
STEALTHMOLE_ACCESS_KEY=
STEALTHMOLE_SECRET_KEY=
STEALTHMOLE_BASE_URL=https://hackathon.stealthmole.com
```

Notes:

- `DATABASE_URL` enables persistence and the review/audit API.
- `DATABASE_SSL=true` is useful for managed Postgres providers that require TLS.
- `BASELINE_AIS_POSITION_RETENTION_DAYS` controls how long broad raw AIS collection is kept. The default is 7 days.
- `SUSPICIOUS_AIS_POSITION_RETENTION_DAYS` controls how long suspicious AIS cases are kept after promotion. The default is 30 days.
- `SUSPICIOUS_RETENTION_LOOKBACK_HOURS` controls how far back a promoted event extends retention for related vessel tracks.
- `ENABLE_VERCEL_AISSTREAM=true` lets a Vercel function instance open the upstream AISStream connection. Leave it `false` unless you accept duplicate upstream connections across warm instances.
- `STEALTHMOLE_ACCESS_KEY` and `STEALTHMOLE_SECRET_KEY` enable the OSINT proxy endpoints.

## Persistence Model

Current persisted tables:

- `vessels`
- `ais_positions`
- `vessel_latest_state`
- `events`
- `event_evidence`
- `event_reviews`

Retention is intentionally tiered:

- baseline AIS observations are kept briefly for broad maritime awareness
- suspicious/event-linked tracks are promoted to longer retention
- derived anomaly events and operator reviews persist as the durable audit layer

The frontend still owns synthetic demo scenarios, but live AIS anomaly events now originate on the backend so they can be audited consistently across browser refreshes and server restarts.

## Review Workflow

For live AIS anomaly events, the detail panel now supports:

- setting review status to `Unverified`, `Reviewed`, `Verified`, or `Escalated`
- saving operator notes
- writing each save as an append-only audit entry in Postgres

If persistence is disabled, review saving is unavailable.

## Synthetic Injection Layer

The demo includes at least 12 synthetic events around Korea:

- Dark SAR detections near Jeju cable routes.
- AIS loitering near Busan/Geoje.
- AIS gaps near the West Sea/Gunsan planned cable route.
- Suspicious encounters near Korea Strait.
- Dragging-compatible slow movement near cable corridors.
- Lower-priority reference cases for comparison.

Each synthetic event is labeled as `Source: Synthetic Demo Injection` and `Purpose: Controlled detection scenario`.

## Data Assumptions

- Cable and contour data come from the original `korea_submarine_cable_map.html`.
- Cable proximity is still approximate and uses equirectangular/geodesic-style calculations suitable for MVP use.
- The backend currently loads cable reference geometry from the existing frontend map source so anomaly derivation can stay consistent with the map.
- Maritime anomaly coverage is broader than cable-only protection and uses multiple Korean watch areas rather than a single large Korea box.
- Synthetic event distances are scenario fields and are still passed through the same scoring function.
- Live AIS parsing is defensive because AISStream message shapes can vary by message type.

## Limitations

- This is a hackathon MVP, not an operational decision system.
- Risk scoring is rule-based and explainable, but not statistically validated.
- Cable proximity is approximate and not geodesically authoritative.
- Live AIS anomaly rules are intentionally conservative and produce unverified review events only.
- No claim is made that a vessel is hostile, illegal, or conducting confirmed sabotage.
- Persistence is Postgres-backed, but there is not yet a full authentication or role-based workflow around operator review actions.

## Future Integration Plan

- Replace approximate cable distance with a geodesic line-distance service or spatial database workflow.
- Integrate SAR, coastal radar, port-call, weather, and bathymetry context.
- Add authenticated operator identities and richer disposition workflow.
- Package deployment behind a secure reverse proxy with managed secrets.
