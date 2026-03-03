# Eye Tracker Web Runner (MVP)

This is a Next.js app you can deploy directly to Vercel.

## Included

- Route: `/test/[sessionToken]`
- Friendly session setup on `/`:
  - participant name
  - per-session Figma prototype URL
  - auto-generated session token
- Camera permission prompt
- 9-point calibration overlay
- WebGazer integration (auto-fallback to pointer mode)
- Calibration quality scoring (`0-100`) with per-point telemetry
- Live gaze indicator overlay
- Built-in mock API routes for server deployment:
  - `POST /api/v1/sessions/:sessionToken/events/batch`
  - `POST /api/v1/sessions/:sessionToken/complete`

## Local setup

1. Install dependencies:
   `npm install`
2. Create env file:
   `cp .env.example .env.local`
3. Start dev server:
   `npm run dev`
4. Open:
   `http://localhost:3000/test/demo-token`

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel, click **New Project** and import that repo.
3. Framework preset should auto-detect as **Next.js**.
4. Add env var in Vercel project settings:
   - `NEXT_PUBLIC_FIGMA_EMBED_URL` = your Figma prototype URL
5. Deploy.
6. Open deployed URL:
   - `https://<your-app>.vercel.app/`

## Using a real backend later

By default, this app calls its internal mock API routes (`/api/v1/...`).

When your FastAPI backend is ready, set:
- `NEXT_PUBLIC_API_BASE_URL=https://your-backend.example.com`

Then the client will call:
- `https://your-backend.example.com/api/v1/sessions/...`

## Event notes

This client emits `calibration_result` events in addition to gaze/navigation/session events. Ensure your backend validation accepts this event type.

## URL overrides

You can pass setup values directly in the URL:

- `/test/<sessionToken>?participant=Participant%2001`
- `/test/<sessionToken>?figmaUrl=https%3A%2F%2Fwww.figma.com%2Fproto%2F...`
- both can be combined.

## Notes

- WebGazer script is loaded from CDN at runtime, with fallbacks.
- You can override script source with `NEXT_PUBLIC_WEBGAZER_SCRIPT_URL`.
- If WebGazer fails to load, the app falls back to pointer tracking so the full flow still works.
- Figma navigation events are expected through `window.postMessage` with `type: "figma_navigation"`.
