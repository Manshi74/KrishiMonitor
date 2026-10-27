# KrishiMonitor readiness audit

**Audit date:** 26 October 2026
**Scope:** the `KrishiMonitor` app folder. The unrelated workspace root package and temporary Edge profile were not treated as application code.

## Executive result

The app has real Gemini integration code and account/email flows implemented behind MongoDB and SMTP. Latest checks: 6/6 automated tests pass; syntax checks and the local build pass; npm audit reports zero advisories. Gemini 3.5 Flash-Lite text chat, contextual follow-up, and a synthetic crop-image request returned HTTP 200. Gemini 3.6 image processing returned a temporary provider 503, so the tested stable multimodal model is now configured locally. Visual Crossing rejected the configured key/account with an authorization error. Account persistence and email flows remain blocked because MongoDB, session, and SMTP credentials are not configured. Risk advisories and expert-request delivery are not implemented.

The site is **not production-ready as a fully integrated agriculture service**. Sample dashboard and proposed plans are labelled as examples, and unavailable weather/database/risk services do not return fabricated live data. Netlify cannot connect to a production API until the real backend HTTPS origin is configured as `KRISHI_API_PROXY_TARGET`.

## Feature audit

| Feature | Status | Evidence and limitation | Next action |
| --- | --- | --- | --- |
| Express website and API | **WORKING AND VERIFIED** | Local `/` and `/api/health` returned HTTP 200. API health reports external service configuration separately. | Deploy behind HTTPS and configure the production origin. |
| Ask Krishi AI text | **WORKING AND VERIFIED** | Current live English chat and contextual follow-up returned HTTP 200 and real Gemini output. Server retries temporary network/5xx failures once; quota and credential errors are not retried. | Keep the key server-side and monitor quota/billing. |
| Ask Krishi AI conversation | **WORKING AND VERIFIED** | Follow-up request included earlier user/assistant messages; the answer used the earlier wheat question. Chat history remains in page memory only. | Decide whether browser-session history should be persisted; currently it is intentionally not stored. |
| Chat photo upload | **WORKING AND VERIFIED** | Synthetic PNG image was sent to Gemini; the model described it as an illustration and marked the cause uncertain. One image, size and dimensions are validated; consent is required. Photos are held in memory and not saved. | Test with real farm photos before relying on crop-specific judgments. |
| Crop-photo analysis | **WORKING AND VERIFIED (synthetic image)** | The full `/api/crop/analyze` endpoint returned HTTP 200 using Gemini 3.5 Flash-Lite and correctly marked a synthetic solid-color PNG uncertain. No photo or report was saved. | Test with real farm photos; this does not validate diagnostic accuracy. |
| Weather search, current weather, forecast, history | **IMPLEMENTED; CURRENT REQUEST FAILED** | A live Visual Crossing current-weather request returned HTTP 502 because the provider rejected the key or account access. Geocode, forecast, and history were not tested with the same rejected key. | Confirm/regenerate the Visual Crossing key and confirm Timeline access; then retest. |
| Browser location selection | **PARTIALLY WORKING** | Manual search and browser geolocation flows exist in code. A browser permission prompt and successful location lookup were not exercised in this environment. | Browser-test on HTTPS or localhost after configuring weather. |
| Dashboard metrics and field rows | **USING DEMO OR MOCK DATA** | Static values and sample field rows are visibly marked “SAMPLE DATA” and “Illustrative only”; they are not connected to records. | Keep labelled as a preview, or connect them to real records before presenting as a live dashboard. |
| Crop catalog | **PARTIALLY WORKING** | Crop choices are available in the site; the `/api/crops` records endpoint now requires a signed-in account. Live account records are blocked by missing MongoDB credentials. | Configure MongoDB, session secret, and email before exercising saved account records. |
| Crop tracking | **PARTIALLY WORKING** | Browser-local add/edit/delete code exists. MongoDB-backed CRUD now requires a signed-in account and CSRF token, but is disabled without credentials. Browser UI interaction was not visually tested. | Configure MongoDB, session secret, and email delivery; then test account-scoped CRUD. |
| Reports | **PARTIALLY WORKING** | Analysis report create/read/delete routes are scoped to account IDs and require auth/CSRF for changes. MongoDB live use is blocked by missing credentials. Photos are not persisted. | Configure MongoDB and email, then test create/read/delete and cross-account isolation. |
| Conversation storage | **NOT IMPLEMENTED** | Chat history is held in browser memory and is not sent to a database except as context for each model request. | Keep this behavior unless durable history is explicitly required and disclosed. |
| Authentication and user profiles | **IMPLEMENTED; LIVE INTEGRATION BLOCKED** | Login/signup/profile, logout, forgot/reset, email verification/resend routes, scrypt hashes, persisted HttpOnly sessions, CSRF, origin checks, and rate limits are implemented. Isolated signed-out/configuration tests pass. MongoDB/SMTP credentials are missing, and browser flow testing was unavailable. | Configure Atlas, session secret, and SMTP; then exercise signup through reset and test two-account record isolation. |
| Expert consultation | **PARTIALLY WORKING** | The form saves a local browser draft; it does not send anything to an expert. The page labels this as a prototype. Attachments are not uploaded. | Connect a real service and obtain a confirmed recipient and privacy/consent flow before enabling delivery. |
| Alerts and notifications | **PARTIALLY WORKING** | The API can read stored MongoDB alerts, but the database is disabled and no live weather/disease alert generator is connected. “Mark all read” changes only the current rendered list. | Connect a verified alert source and persistence before displaying live alerts. |
| Interactive map and disease-risk advisories | **TILE SOURCES REACHABLE; BROWSER RENDER NOT CONFIRMED; RISK FEED MISSING** | `/api/map/config` returned HTTP 200; Leaflet, OSM, CARTO, and OSM embedded-map endpoints returned HTTP 200. Frontend now falls back from Leaflet/OSM to CARTO and then OSM embed. Browser state capture timed out, so visible tile rendering is still unverified. `/api/risk-map` is not implemented. | Reload the latest local page; satellite requires a restricted MapTiler key. No live risk markers exist. |
| Pest monitoring | **MISSING API OR BACKEND** | The page explicitly shows “SERVICE NOT CONNECTED”; no pest advisory endpoint exists. | Connect a trusted source or keep the unavailable state. |
| IPM checklist | **PARTIALLY WORKING** | Checklist values save in local browser storage; advice is general and not crop-specific. | No service needed unless syncing between devices is required. |
| Pricing and payment plans | **USING DEMO OR MOCK DATA** | Plans are labelled proposed/demo; click handlers say no payment has been taken. No payment processor or paid entitlements exist. | Do not advertise these as purchasable plans until a payment provider and terms exist. |
| Contact link | **CONFIGURED BUT NOT VERIFIED** | HTML contains `mailto:hello@rojtech.com`. This is a mail-client link only; ownership, delivery, and verification are unknown. | Confirm the intended support address before relying on it. |
| Language toggle | **PARTIALLY WORKING** | A local translation map exists, but it covers selected labels rather than the entire site. Chat separately supports `hi` and `en`. | Review untranslated UI text if a fully Hindi interface is required. |

## External integration inventory

| Service | Purpose and environment variables | Code/configuration | Live result, credentials, and constraints |
| --- | --- | --- | --- |
| Google Gemini API | Chat and crop-photo analysis. `GEMINI_API_KEY`, `GEMINI_MODEL`. | Official `@google/genai` Node SDK; key read only by server; configured local model `gemini-3.5-flash-lite`. | **Live verified**: text, contextual follow-up, and full synthetic-image crop endpoint returned HTTP 200 with this model. Gemini 3.6 image requests returned temporary 503/high-demand. Model supports image input and structured output. See [Google model docs](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) and review pricing/data terms before production. |
| Visual Crossing | Place resolution, current weather, forecast, and historical daily data. `VISUAL_CROSSING_API_KEY`. | Server-only Timeline API key, metric data, 5-minute cache, 31-day history cap. | **Live FAIL**: provider rejected the configured key/account on current-weather request. Confirm/regenerate the key and Timeline access. |
| MongoDB Atlas | User accounts, persisted sessions, crop records, reports, alerts. `MONGODB_URI`, `SESSION_SECRET`. | Mongoose models, unique normalized email index, hashed session/token values, account-scoped record CRUD. | **Code implemented; live BLOCKED** because Mongo URI and session secret are missing. Atlas Free-cluster limits should be checked before deployment. [Free-cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/). |
| Leaflet / OpenStreetMap / MapTiler | Interactive map; optional `MAPTILER_API_KEY`. | Leaflet CDN, OSM tiles, CARTO fallback, then OSM embed fallback; local map config endpoint works; device location remains opt-in. | **Public endpoints HTTP 200; browser rendering unverified** due browser-state timeout. No crop-risk/farm-data layer is connected. Follow [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/) and [MapTiler key restrictions](https://docs.maptiler.com/guides/developer/credentials/api-key/). |
| Google Fonts | Visual fonts. No app secret. | External stylesheet in `index.html`. | **Not browser-verified** here; optional visual dependency. |
| Email provider | Verification and password-reset emails. | SMTP delivery through Nodemailer; URLs use `PUBLIC_APP_URL`; expiry and single-use tokens are stored hashed. | **Implemented; live BLOCKED** because sender and SMTP credentials are absent. No test email was sent. |
| Authentication provider | Registration, login, password reset, profile/logout. | First-party Express/Mongoose auth; scrypt password hashes, opaque DB-backed sessions, secure cookie attributes, CSRF protection. | **Implemented; live BLOCKED** because MongoDB/session/email settings are absent. |

## Email inventory

| Item | Code/configuration status | Verification and action |
| --- | --- | --- |
| `ADMIN_EMAIL` | Not present | No administrator email workflow exists; do not add unless one is required. |
| `SUPPORT_EMAIL` | No environment variable. A `mailto:hello@rojtech.com` link appears in HTML. | Address ownership and mailbox delivery are unverified. Confirm the intended support address. |
| `EMAIL_FROM` | Not present | No sender identity or email service exists. |
| `PUBLIC_APP_URL`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Not present | Required for verification and recovery mail; no credentials are configured and no email was sent. |
| Transactional email API key | Not present | No provider integration exists. |
| Authentication email settings | Not present | No registration or verification flow exists. |

No email was sent. Account verification and recovery flows exist in code but remain unavailable until MongoDB, session, and SMTP credentials are configured.

## Environment and secret checklist

Statuses are recorded without values for secrets.

| Variable | Current status | Use / next action |
| --- | --- | --- |
| `PORT`, `HOST` | Configured locally (`3101`) | Use the host-provided port in production. |
| `NODE_ENV` | Configured as local development | Set `production` in the deployment environment. |
| `GEMINI_API_KEY` | Configured and live-tested | Keep only on the server; do not copy into frontend files. |
| `GEMINI_MODEL` | Configured as `gemini-3.5-flash-lite`; real text and image endpoints returned HTTP 200 | The deployed backend must use the same tested model value. |
| `VISUAL_CROSSING_API_KEY` | Present in ignored local `.env`; provider rejected the key/account in live test | Confirm/regenerate the key and ensure Timeline access. |
| `MAPTILER_API_KEY` | Missing | Optional public client key required for satellite imagery; restrict HTTP origins to development and deployed hostnames. OSM street basemap works without it. |
| `MONGODB_URI` | Missing | Required for database persistence. |
| `SESSION_SECRET` | Missing | Set to a cryptographically random value of at least 32 characters before enabling database records. |
| `FRONTEND_ORIGIN` | Configured for local development origins | Use the exact production frontend origin(s); do not use a wildcard. |
| `TRUST_PROXY` | Configured locally | Enable only when the deployment is behind a trusted reverse proxy. |
| `MAX_IMAGE_MB`, `MAX_REQUEST_MB`, `MAX_PROMPT_CHARS`, `MIN_IMAGE_DIMENSION`, `MAX_IMAGE_DIMENSION` | Configured | Server caps remain 10 MB image, 12 MB request, 2,000 characters, and 256–4096 px. |
| `EMAIL_FROM`, SMTP variables | Not present | Required to deliver account verification and password reset emails. |

`.gitignore` excludes `.env` and `.env.*` while allowing `.env.example`. This workspace has no Git repository metadata, so tracked-file history and accidental prior commits could not be checked. No API-key value was found in the frontend source scan.

## Security and production notes

- Uploads are limited to one JPG/JPEG/PNG/WEBP image, up to 10 MB; Sharp decodes the image and validates dimensions. Chat and crop-photo uploads require consent and are not written to the database.
- Chat and weather have process-local IP rate limits (18 chat/photo requests per 10 minutes; 50 weather requests per minute). These limits reset on restart and are not shared between production instances; use shared rate-limit storage before horizontal scaling.
- New database records are partitioned by verified account ID. Auth sessions use HttpOnly, SameSite=Lax, Secure-in-production cookies and CSRF-protected writes. Legacy records stored under the former anonymous cookie are not automatically migrated to accounts.
- CORS is same-origin by default and uses configured exact origins for separate local/deployed frontends. `TRUST_PROXY` must reflect only a trusted deployment proxy.
- Basic security headers, input limits, safe text rendering, and server-side secrets are present. A Content Security Policy is not configured; production should add a policy compatible with the site's external fonts, Leaflet, and map tiles. HTTPS is a deployment requirement.
- Free Gemini API usage may allow submitted prompts and images to be used to improve Google products; the page discloses this. Confirm the account tier and privacy decision before inviting farmers to send sensitive images. Paid service data use is different; see Google's current terms.

## Functional tests run

| Test | Result | Details |
| --- | --- | --- |
| Backend health and CORS | **PASS** | Health returned 200; local `localhost:5500` origin returned an allowlisted response. |
| Real Gemini text | **PASS** | Current Gemini 3.5 Flash-Lite chat returned HTTP 200 and a real response. |
| Follow-up context | **PASS** | Real conversation-history request returned HTTP 200 with a non-empty contextual reply. |
| Hindi response | **PASS** | A Hindi wheat question returned a relevant Hindi response. |
| Chat image | **PASS** | A generated synthetic leaf illustration reached Gemini; model called out that it was an illustration and marked cause uncertain. |
| Crop-analysis image | **PASS (synthetic image)** | Full endpoint returned HTTP 200 with `uncertain: true` using Gemini 3.5 Flash-Lite. Earlier Gemini 3.6 image calls timed out/returned 503. |
| Empty/overlong/invalid-language chat inputs | **PASS** | Returned HTTP 400 with safe `success: false` errors. |
| Invalid image bytes | **PASS** | Returned HTTP 400 without invoking Gemini. |
| Missing/invalid Gemini key | **PASS** | Isolated test instances returned HTTP 503 / HTTP 502 with safe messages; real `.env` was not changed. |
| Invalid-key provider response | **PASS** | Temporary isolated fake-key server returned HTTP 502 and a clear safe key error; the real key was not used for this test. |
| Rate limit | **PASS** | Isolated no-key instance accepted the first 18 requests to validation/provider handling and returned 429 for request 19. |
| Timeout mapping | **PASS (simulated)** | Isolated test process used an already-aborted provider signal and returned HTTP 504. No slow provider request was held open. |
| Weather provider | **FAIL (credential/account)** | Live current-weather request returned HTTP 502 with provider authorization error. Forecast/history were not tried with this rejected key. |
| MongoDB persistence and account isolation | **BLOCKED** | No `MONGODB_URI` or `SESSION_SECRET`; live account records cannot be exercised. Isolated signed-out requests are rejected and do not save data. |
| Registration/login | **CODE CHECKED; LIVE BLOCKED** | Auth route configuration, invalid email, weak password, mismatch, and no-database signup behavior passed API tests. Real account creation and session persistence need Atlas credentials. |
| Email delivery and verification/recovery | **BLOCKED** | SMTP host/user/password/sender are not configured; no test email was sent. |
| Browser console, visual desktop/mobile flow | **BLOCKED** | Edge state capture timed out. Public map URLs were checked over HTTP, but desktop/mobile rendering and console errors were not captured. |
| Dependency audit | **PASS** | `npm audit --omit=dev` reported 0 vulnerabilities (137 production dependencies). | Re-run during deployment. |
| Automated API tests | **PASS** | `npm test` passed all 6 tests, including chat validation/missing-key, rate limiting, auth validation, signed-out records, static/map assets, and map config. | Add provider retry and crop timeout regression tests when an injectable model client is available. |
| Syntax checks | **PASS** | `node --check` passed for server, auth, frontend, weather, database, sessions, Earth animation, and build scripts. |
| Netlify production build guard | **PASS (simulated)** | Missing `KRISHI_API_PROXY_TARGET` correctly fails the Netlify build; a test-only HTTPS origin produced the `/api/*` redirect. Real backend URL and Netlify account are unavailable. |

## Required setup to enable remaining services

1. Keep `GEMINI_API_KEY` and `GEMINI_MODEL` in the backend environment. Review current Google pricing, quotas, data use, and photo-consent language before public use.
2. Obtain a Visual Crossing API key and set `VISUAL_CROSSING_API_KEY` on the backend; then test city search, current weather, forecast timestamps, history, and geolocation on HTTPS/localhost. Historical data availability depends on the provider account plan.
3. Create/configure MongoDB Atlas, set `MONGODB_URI`, generate a random 32+ character `SESSION_SECRET`, and test crop/report create-read-update-delete plus cross-account isolation.
4. Configure a verified SMTP sender and test email verification, resend, password recovery, expiration, and single-use tokens.
5. Expert requests are still local drafts. If delivery is needed, choose the intended recipient and service, verify the sender/domain, and implement that workflow separately.
6. Select a documented and licensed pest/risk advisory source before adding live regional alerts. Do not derive disease outbreaks from weather alone.
7. Deploy the `KrishiMonitor` folder as the service root; run `npm install` and `npm start` (PowerShell: `npm.cmd install`, `npm.cmd start`). Set `NODE_ENV=production`, HTTPS, the exact `FRONTEND_ORIGIN`, and trusted-proxy configuration only when applicable.
