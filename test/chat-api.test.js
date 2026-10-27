import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import sharp from 'sharp';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let port;
let baseUrl;
let tempDirectory;
let child;
let childOutput = '';
let rateLimitRequestCount = 0;

async function reservePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port: availablePort } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return availablePort;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited early. ${childOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start. ${childOutput}`);
}

async function postChat({ message, language, conversationHistory } = {}) {
  const form = new FormData();
  if (message !== undefined) form.append('message', message);
  if (language !== undefined) form.append('language', language);
  if (conversationHistory !== undefined) {
    form.append('conversationHistory', typeof conversationHistory === 'string' ? conversationHistory : JSON.stringify(conversationHistory));
  }
  rateLimitRequestCount += 1;
  const response = await fetch(`${baseUrl}/api/chat`, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
  return { response, data: await response.json() };
}

async function postCrop({ photoConsent = 'true', image = true } = {}) {
  const form = new FormData();
  form.append('crop', 'Wheat'); form.append('affectedPart', 'Leaf');
  form.append('growthStage', 'Flowering'); form.append('location', 'Example district');
  form.append('language', 'hi'); form.append('photoConsent', photoConsent);
  if (image) {
    const png = await sharp({ create: { width: 320, height: 320, channels: 3, background: { r: 80, g: 130, b: 60 } } }).png().toBuffer();
    form.append('image', new Blob([png], { type: 'image/png' }), 'test-crop.png');
  }
  rateLimitRequestCount += 1;
  const response = await fetch(`${baseUrl}/api/crop/analyze`, { method: 'POST', body: form, signal: AbortSignal.timeout(10000) });
  return { response, data: await response.json() };
}

before(async () => {
  port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'krishimonitor-chat-test-'));
  const isolatedEnvPath = path.join(tempDirectory, 'empty.env');
  await writeFile(isolatedEnvPath, '', 'utf8');

  const env = { ...process.env };
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'VISUAL_CROSSING_API_KEY', 'MAPTILER_API_KEY', 'MONGODB_URI', 'SESSION_SECRET']) delete env[name];
  Object.assign(env, {
    DOTENV_CONFIG_PATH: isolatedEnvPath,
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    FRONTEND_ORIGIN: 'http://localhost:5500',
    TRUST_PROXY: '0'
  });
  child = spawn(process.execPath, ['server.js'], { cwd: projectRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { childOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { childOutput += chunk.toString(); });
  await waitForServer();
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
  }
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
});

test('chat API health, CORS, validation, and missing-key responses are truthful and safe', async () => {
  const healthResponse = await fetch(`${baseUrl}/api/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.services.ai.configured, false);
  assert.equal(JSON.stringify(health).toLowerCase().includes('api_key'), false);

  const corsResponse = await fetch(`${baseUrl}/api/chat/health`, { headers: { Origin: 'http://localhost:5500' } });
  assert.equal(corsResponse.status, 200);
  assert.equal(corsResponse.headers.get('access-control-allow-origin'), 'http://localhost:5500');

  for (const fields of [
    { message: '', language: 'en' },
    { message: 'x'.repeat(2001), language: 'en' },
    { message: 'hello', language: 'fr' },
    { message: 'hello', language: 'en', conversationHistory: '{' }
  ]) {
    const { response, data } = await postChat(fields);
    assert.equal(response.status, 400);
    assert.equal(data.success, false);
    assert.equal(typeof data.error, 'string');
  }

  const missingHistory = await postChat({ message: 'A new chat without history.' });
  assert.equal(missingHistory.response.status, 503);
  assert.equal(missingHistory.data.success, false);
  assert.match(missingHistory.data.error, /GEMINI_API_KEY/);
});

test('crop analysis requires an image and explicit photo consent, and never fakes an AI result without credentials', async () => {
  const missingImage = await postCrop({ image: false });
  assert.equal(missingImage.response.status, 400);
  assert.match(missingImage.data.error, /Choose a crop image/);

  const noConsent = await postCrop({ photoConsent: 'false' });
  assert.equal(noConsent.response.status, 400);
  assert.match(noConsent.data.error, /Confirm photo sharing/);

  const noCredentials = await postCrop();
  assert.equal(noCredentials.response.status, 503);
  assert.match(noCredentials.data.error, /Gemini is not configured/);
  assert.equal(noCredentials.data.success, false);
});

test('chat API rate limit returns HTTP 429 with the standard error shape', async () => {
  while (rateLimitRequestCount < 18) {
    const { response, data } = await postChat({ message: 'Rate-limit test request.' });
    assert.equal(response.status, 503);
    assert.equal(data.success, false);
  }

  const { response, data } = await postChat({ message: 'One request over the limit.' });
  assert.equal(response.status, 429);
  assert.equal(data.success, false);
  assert.match(data.error, /Too many chat requests/);
});

test('account routes report missing database configuration and do not claim signup succeeded', async () => {
  const healthResponse = await fetch(`${baseUrl}/api/health`);
  const health = await healthResponse.json();
  assert.equal(health.services.auth.configured, false);
  assert.equal(health.services.auth.emailConfigured, false);

  async function signup(payload) {
    const response = await fetch(`${baseUrl}/api/auth/signup`, { method: 'POST', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { response, data: await response.json() };
  }
  for (const [payload, expected] of [
    [{ fullName: 'Test Farmer', email: 'not-an-email', password: 'a-secure-password', confirmPassword: 'a-secure-password', acceptedTerms: true }, /valid email/],
    [{ fullName: 'Test Farmer', email: 'farmer@example.com', password: 'weak', confirmPassword: 'weak', acceptedTerms: true }, /12 and 128/],
    [{ fullName: 'Test Farmer', email: 'farmer@example.com', password: 'a-secure-password', confirmPassword: 'a-different-password', acceptedTerms: true }, /do not match/]
  ]) {
    const { response, data } = await signup(payload);
    assert.equal(response.status, 400); assert.match(data.error, expected);
  }
  const { response, data } = await signup({ fullName: 'Test Farmer', email: 'farmer@example.com', password: 'a-secure-password', confirmPassword: 'a-secure-password', acceptedTerms: true });
  assert.equal(response.status, 503);
  assert.equal(data.success, false);
  assert.match(data.error, /MONGODB_URI/);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('cookie-authenticated private crop records reject signed-out requests', async () => {
  const response = await fetch(`${baseUrl}/api/crops`, { headers: { Origin: baseUrl } });
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.match(data.error, /SESSION_SECRET|Sign in/);
});

test('decorative and agriculture-map assets are served by the existing Express site', async () => {
  const [pageResponse, scriptResponse, appScriptResponse, styleResponse] = await Promise.all([
    fetch(`${baseUrl}/`), fetch(`${baseUrl}/earth-background.js`), fetch(`${baseUrl}/script.js`), fetch(`${baseUrl}/style.css`)
  ]);
  assert.equal(pageResponse.status, 200);
  assert.equal(scriptResponse.status, 200);
  assert.equal(appScriptResponse.status, 200);
  assert.equal(styleResponse.status, 200);
  const page = await pageResponse.text();
  const script = await scriptResponse.text();
  const appScript = await appScriptResponse.text();
  const styles = await styleResponse.text();
  assert.match(page, /id="hero-earth-canvas"/);
  assert.match(page, /id="dashboard-data-canvas"/);
  assert.match(page, /decorative, not live farm monitoring/);
  assert.match(page, /id="map-basemap"/);
  assert.match(page, /id="map-locate"/);
  assert.match(page, /no live crop-risk layer/);
  assert.match(script, /prefers-reduced-motion/);
  assert.match(script, /visibilitychange/);
  assert.match(appScript, /https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/);
  assert.match(appScript, /showEmbeddedOpenStreetMap/);
  assert.match(appScript, /openstreetmap\.org\/export\/embed\.html/);
  assert.match(appScript, /maps\/satellite-v4/);
  assert.match(appScript, /getCurrentPosition/);
  assert.match(styles, /pointer-events:none/);
  assert.match(styles, /km-page-edge/);
  assert.match(styles, /prefers-reduced-motion:reduce\)\{body::after/);
});

test('map config keeps the OSM basemap available without exposing an absent satellite key', async () => {
  const response = await fetch(`${baseUrl}/api/map/config`);
  const config = await response.json();
  assert.equal(response.status, 200);
  assert.equal(config.streetProvider, 'OpenStreetMap');
  assert.equal(config.satelliteProvider, 'MapTiler Satellite v4');
  assert.equal(config.satelliteEnabled, false);
  assert.equal(config.satelliteApiKey, null);
});

