# Eye Tracker Web Runner (MVP)

This is a Next.js app you can deploy directly to Vercel.

## Included

- Route: `/test/[sessionToken]`
- Friendly session setup on `/`:
  - participant name
  - per-session target URL (website or Figma prototype)
  - auto-generated session token
- Camera permission prompt
- 9-point calibration overlay
- MediaPipe Face Mesh integration (auto-fallback to pointer mode)
- Calibration quality scoring (`0-100`) with per-point telemetry
- Live gaze indicator overlay
- Built-in mock API routes for server deployment:
  - `POST /api/v1/sessions/:sessionToken/events/batch`
  - `POST /api/v1/sessions/:sessionToken/complete`
  - `POST /api/v1/reports/email`

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
   - `NEXT_PUBLIC_FIGMA_EMBED_URL` = default target URL (website or Figma prototype)
   - `RESEND_API_KEY` = your Resend API key (for report emails)
   - `REPORT_EMAIL_TO` = `andre.goncalves@allhuman.com`
   - `REPORT_EMAIL_FROM` = verified sender, e.g. `Eye Tracker <reports@yourdomain.com>`
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
- `/test/<sessionToken>?targetUrl=https%3A%2F%2Fwww.figma.com%2Fproto%2F...`
- both can be combined.

For non-Figma websites, the app uses a same-origin proxy route (`/api/proxy-view`) so scroll telemetry can be captured for full-page heatmaps.

## Notes

- MediaPipe Face Mesh script is loaded from CDN at runtime.
- If MediaPipe fails to initialize, the app falls back to pointer tracking so the flow still works.
- Figma navigation events are expected through `window.postMessage` with `type: "figma_navigation"`.
- On test end, the app generates a local heatmap overlay and allows PNG/JPG download.
- On test end, the app also generates a downloadable PDF report (summary + heatmap + metadata).
- Email sending requires Resend env vars; without them, status will show as skipped.
