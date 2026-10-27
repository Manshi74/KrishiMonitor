# KrishiMonitor

A responsive HTML/CSS/Vanilla JavaScript agriculture application with an Express API. The Gemini chatbot and crop-photo analysis are real-model integrations when configured. Current and forecast weather plus historical daily weather use Visual Crossing when configured. Account sessions, crop records, and reports use MongoDB when configured. The site has no connected verified regional disease-risk provider.

The hero includes a lightweight canvas-drawn rotating Earth, and the sample dashboard has a faint satellite-style network sweep. These are decorative visualizations only; they do not show live farm locations, crop risk, or satellite data. They use no added graphics or 3D dependencies, reduce to a static frame for `prefers-reduced-motion`, pause when the page is hidden, and render only while their sections are near the viewport.

## Run locally

1. Install Node.js 20 or newer.
2. Open a terminal in `KrishiMonitor`.
3. Copy `.env.example` to `.env` and add the service credentials you want to enable.
4. Run `npm install`, then `npm start`.
5. Open `http://127.0.0.1:3101`.

PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
npm install
npm start
npm test
```

In Windows PowerShell, use `npm.cmd install`, `npm.cmd start`, and `npm.cmd test` if script execution policy blocks `npm.ps1`.

The Express server serves the website and API together. Camera access requires HTTPS or localhost. Keep provider keys and the Mongo URI in server environment settings; never put them in browser code.

## Provider setup

### Gemini

Create a Google AI Studio API key and set `GEMINI_API_KEY`. The backend defaults to `gemini-3.5-flash-lite`, a stable multimodal model with image input and structured output: [model details](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite). Review [current pricing and data terms](https://ai.google.dev/gemini-api/docs/pricing) before sending crop photos. Photos are held in memory for the request and are not stored by this application.

### Visual Crossing

Create a Visual Crossing account and set `VISUAL_CROSSING_API_KEY` on the backend. The server calls the [Timeline Weather API](https://www.visualcrossing.com/resources/documentation/weather-api/timeline-weather-api/) for place-name resolution, current conditions, a five-day forecast, and date-range historical daily observations. Historical requests are limited by this app to 31 days per request; historical data availability and API credits depend on the Visual Crossing account plan. The backend caches successful responses for five minutes and never returns the API key to the browser.

Weather is requested only after a city search, an explicit location-button press with browser permission, or a historical-weather form submission. Coordinates and city searches are sent to Visual Crossing through the backend. Current values older than three hours are hidden. Weather rules do not generate disease scores or outbreak claims.

### MongoDB Atlas

Set `MONGODB_URI` to an Atlas connection string and set `SESSION_SECRET` to at least 32 random characters. Example generation command: `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. Reports, crops, and alerts use Mongoose schemas and indexes. Only report details and crop records are stored; uploaded images and chat messages are not stored.

Users sign up with a verified email address. Passwords use Node.js scrypt hashes; authentication sessions and one-use email tokens are stored in MongoDB, with only token hashes stored for verification and password reset. Session cookies are HttpOnly, SameSite=Lax, and Secure in production. Authenticated record APIs require a CSRF token and allowed Origin. Crop and report records are scoped to the MongoDB user ID. Legacy records saved under the old anonymous browser cookie are not automatically assigned to accounts.

To enable accounts, set `MONGODB_URI`, a random `SESSION_SECRET` of at least 32 characters, `PUBLIC_APP_URL`, and valid `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS` values. The sender domain/address must be accepted by your SMTP provider. Use an HTTPS `PUBLIC_APP_URL` in production and make it the canonical public website origin (for example `https://farm.example.com`). `FRONTEND_ORIGIN` must contain the exact origin when hosting the frontend separately. If mail settings are absent, signup and email recovery return a clear configuration error and do not claim mail was sent.

For local use with Live Server, set `PUBLIC_APP_URL=http://127.0.0.1:5500`, and include that origin in `FRONTEND_ORIGIN` (or open the Express-served page at `http://127.0.0.1:3101`). Create and verify a mailbox/app password with your SMTP provider. Never commit `.env` or paste credentials into frontend code.

## Image upload rules

The frontend and backend enforce one JPG/JPEG, PNG, or WEBP image per request, at most 10 MB, 256-4096 pixels per dimension, and a 2,000-character prompt. 1024 pixels or higher is recommended. The frontend checks signatures and decodes the preview; the backend uses Sharp to inspect and fully decode the actual image before Gemini receives it. Client MIME type and filename are not trusted. The request body limit is 12 MB. Uploads use memory storage and no temporary files are created.

These upload limits can only be tightened using `MAX_IMAGE_MB`, `MAX_REQUEST_MB`, `MAX_PROMPT_CHARS`, `MIN_IMAGE_DIMENSION`, and `MAX_IMAGE_DIMENSION`; the server will not permit settings above the documented limits.

## API routes

- `GET /api/health` - backend and integration configuration status; does not expose secrets.
- `GET /api/map/config` - basemap providers and optional public satellite client key for configured MapTiler tiles.
- `POST /api/auth/signup`, `/login`, `/logout`, `/forgot-password`, `/reset-password`, `/verify-email`, `/resend-verification`; `GET /api/auth/me`.
- `GET /api/chat/health` - chatbot setup and effective image limits.
- `POST /api/chat` - multipart chat request with optional image and conversation history. A new chat may omit history; successful JSON responses include `success: true` and the real Gemini `reply`, while errors return `success: false` and a safe `error` message.
- `POST /api/crop/analyze` - multipart crop photo analysis, optional save-report consent.
- `GET /api/weather/geocode?q=...` - city search.
- `GET /api/weather/current?lat=...&lon=...` - current conditions.
- `GET /api/weather/forecast?lat=...&lon=...` - five-day forecast.
- `GET /api/weather/history?lat=...&lon=...&from=YYYY-MM-DD&to=YYYY-MM-DD` - historical daily summaries for up to 31 prior days; provider plan access applies.
- `GET /api/crops` - crop catalog and the signed-in account's records.
- `POST /api/crops`, `PUT /api/crops/:id`, `DELETE /api/crops/:id` - authenticated, CSRF-protected crop records.
- `GET /api/reports`, `GET /api/reports/:id`, `POST /api/reports` - authenticated, CSRF-protected crop-analysis reports.
- `GET /api/alerts` - stored alerts for the signed-in account; returns an empty list when there are none.

The risk map has no verified location/advisory source connected. The dashboard values remain explicitly labeled illustrative sample data. The expert form is a local request draft and does not send a request to an agricultural expert. There is no connected ICAR knowledge base or live disease-risk model, so advice stays cautious and no chemical dosage is prescribed.

The interactive agriculture map uses Leaflet with OpenStreetMap standard map tiles by default. If Leaflet or the first tile providers fail, it falls back to the OpenStreetMap embedded map. It can switch to MapTiler Satellite v4 when `MAPTILER_API_KEY` is configured. The key is intentionally sent to the browser for tile requests, so it is a public client key: restrict Allowed HTTP origins to the exact local-development and production domains in MapTiler Cloud, and never leave `localhost` allowed in a production key. The map includes a user-triggered device-location marker; coordinates stay in the browser and are not saved/sent by this map. No farm markers, crop-risk, or weather overlay is connected. Map panning and zooming are interactive, with a low-opacity decorative scan sweep.

## Environment variables

See `.env.example`. Required only for the relevant feature:

- `GEMINI_API_KEY` and optional `GEMINI_MODEL` for AI.
- `VISUAL_CROSSING_API_KEY` for current weather, forecasts, location resolution, and historical weather.
- `MAPTILER_API_KEY` for optional MapTiler Satellite imagery. Without it, the real OpenStreetMap street basemap remains available.
- `MONGODB_URI` and `SESSION_SECRET` (32+ characters) for private crop/report/alert records.
- `PUBLIC_APP_URL`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS` for account verification and password recovery email.
- `FRONTEND_ORIGIN` when the frontend is hosted on a different origin. Use the exact HTTPS origin.
- `TRUST_PROXY=1` only when a trusted reverse proxy sits in front of the Node service.
- `NODE_ENV=production` for production cookie settings.

For separate static hosting, set `window.KRISHI_API_BASE_URL` in `index.html` to the backend HTTPS origin and set `FRONTEND_ORIGIN` on the backend. Keep frontend and backend same-site where possible so the HttpOnly browser-session cookie works reliably.

## Deployment

On Render or another Node host, use the `KrishiMonitor` folder as the service root, `npm install` as the build command, and `npm start` as the start command. Add keys and database values in the host's environment settings; do not upload `.env`. Set `NODE_ENV=production`, a 32+ character `SESSION_SECRET`, and `TRUST_PROXY=1` only if the host's reverse proxy is trusted. Serve the site and API over HTTPS. Configure `FRONTEND_ORIGIN` for a separate frontend origin.

### Netlify

This workspace keeps the website in `KrishiMonitor/` beside an unrelated workspace-level `package.json`. The workspace root `netlify.toml` points Netlify at `KrishiMonitor/`; if the Git repository contains only this project folder, its own `netlify.toml` works with `.` as the base. The build command is `npm run build` and the publish directory is `dist/`. No secrets are copied into the published files.

The Express API still needs a Node host such as Render. A Netlify build now fails unless `KRISHI_API_PROXY_TARGET` is set, because publishing without an API proxy leaves all `/api/*` calls disconnected. Deploy the Express server first, then set `KRISHI_API_PROXY_TARGET` in Netlify's **Build environment variables** to the HTTPS origin assigned by that backend host. The build creates a same-origin `/api/*` proxy; no backend URL is hardcoded in browser JavaScript. On the backend, set `FRONTEND_ORIGIN` to the exact deployed Netlify site origin and set `PUBLIC_APP_URL` to the canonical public site URL. Configure backend secrets in the backend host, never in Netlify's frontend bundle.

For local Live Server on `localhost:5500` or `127.0.0.1:5501`, the browser points to the local Express server on port 3101. When the page is served directly by Express or through Netlify's proxy, both AI clients use same-origin `/api/*` paths. In production the backend URL is configured only as Netlify's build-time `KRISHI_API_PROXY_TARGET`, not as a browser-visible base URL.

## Verification and current limits

Syntax checks: `node --check script.js`, `node --check chatbot.js`, `node --check server.js`, `node --check auth.js`, `node --check weather.js`, `node --check database.js`, and `node --check sessions.js`.

The app can report which integrations are configured via `/api/health` without exposing credential values. Real signup, email verification, recovery, account session persistence, and account-scoped record tests require working MongoDB and SMTP credentials. Do not report those live provider workflows as passed until exercised against the configured services.

Map imagery references: [MapTiler Satellite with Leaflet](https://docs.maptiler.com/leaflet/examples/detect-retina/), [MapTiler API key origin restrictions](https://docs.maptiler.com/guides/developer/credentials/api-key/), and the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
