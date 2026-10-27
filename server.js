import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { GoogleGenAI, Type } from '@google/genai';
import { Alert, CropAnalysisReport, CropRecord, database } from './database.js';
import { sessionIsConfigured } from './sessions.js';
import { authRouter, csrfTokenValid, loadAuth, requireAuth, requireCsrf } from './auth.js';
import { weatherService } from './weather.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '0.0.0.0';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
function positiveEnvInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
const MAX_IMAGE_MB = Math.min(positiveEnvInt('MAX_IMAGE_MB', 10), 10);
const MAX_REQUEST_MB = Math.min(positiveEnvInt('MAX_REQUEST_MB', 12), 12);
const MAX_PROMPT_CHARS = Math.min(positiveEnvInt('MAX_PROMPT_CHARS', 2000), 2000);
const MIN_IMAGE_DIMENSION = Math.min(Math.max(positiveEnvInt('MIN_IMAGE_DIMENSION', 256), 256), 4096);
const MAX_IMAGE_DIMENSION = Math.max(MIN_IMAGE_DIMENSION, Math.min(positiveEnvInt('MAX_IMAGE_DIMENSION', 4096), 4096));
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_REQUEST_MB * 1024 * 1024;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = MAX_PROMPT_CHARS;
const MAX_HISTORY_MESSAGE_CHARS = 6000;
const MAX_CONTEXT_CHARS = 18000;
const SESSION_SECRET_READY = sessionIsConfigured();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 18;
const recentRequests = new Map();
const recentWeatherRequests = new Map();
const formatMimeTypes = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const allowedFrontendOrigins = new Set((process.env.FRONTEND_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean));
// Live Server may open the same local page as either localhost or 127.0.0.1.
// Treat these loopback aliases as equivalent for explicitly configured dev ports.
for (const origin of [...allowedFrontendOrigins]) {
  try {
    const url = new URL(origin);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !['5500', '5501'].includes(url.port)) continue;
    const alias = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    allowedFrontendOrigins.add(`${url.protocol}//${alias}:${url.port}`);
  } catch {}
}
let genaiClient;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function asPublicIntegrationError(error) {
  if (error instanceof HttpError) return error;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 && typeof error.message === 'string') {
    return new HttpError(error.status, error.message);
  }
  return error;
}
const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  const origin = req.get('Origin');
  if (!origin) return next();
  const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
  if (sameOrigin || allowedFrontendOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS' && req.path.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, X-CSRF-Token');
      return res.sendStatus(204);
    }
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(403).json({ success: false, error: 'This website origin is not allowed to use the API.' });
  next();
});
app.use(express.json({ limit: '64kb', strict: true }));
app.use(loadAuth);
app.use('/api/auth', authRouter);

const upload = multer({
  storage: multer.memoryStorage(),
  // Crop analysis sends up to seven form fields and one image (chat sends fewer).
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 8, fieldSize: 20 * 1024, fieldNameSize: 100, parts: 9 }
});

function noStore(_req, res, next) { res.setHeader('Cache-Control', 'no-store'); next(); }
function limitRequestBody(req, res, next) {
  const declaredLength = Number(req.get('content-length') || 0);
  if (declaredLength > MAX_REQUEST_BYTES) return res.status(413).json({ success: false, error: `Request body must be ${MAX_REQUEST_MB} MB or smaller.` });
  req.uploadBodyBytes = 0;
  req.on('data', chunk => { req.uploadBodyBytes += chunk.length; });
  next();
}
function checkRateLimit(req) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const active = (recentRequests.get(ip) || []).filter(timestamp => now - timestamp < RATE_WINDOW_MS);
  if (active.length >= RATE_LIMIT) throw new HttpError(429, 'Too many chat requests. Please wait a few minutes and try again.');
  active.push(now);
  recentRequests.set(ip, active);
  if (recentRequests.size > 1000) for (const [key, timestamps] of recentRequests) if (!timestamps.some(timestamp => now - timestamp < RATE_WINDOW_MS)) recentRequests.delete(key);
}
function rateLimitMiddleware(req, res, next) {
  try { checkRateLimit(req); next(); } catch (error) { next(error); }
}
function weatherRateLimit(req, res, next) {
  const now = Date.now(), ip = req.ip || req.socket.remoteAddress || 'unknown';
  const active = (recentWeatherRequests.get(ip) || []).filter(timestamp => now - timestamp < 60_000);
  if (active.length >= 50) return next(new HttpError(429, 'Weather request limit reached. Please wait a minute and try again.'));
  active.push(now); recentWeatherRequests.set(ip, active);
  if (recentWeatherRequests.size > 1000) for (const [key, timestamps] of recentWeatherRequests) if (!timestamps.some(timestamp => now - timestamp < 60_000)) recentWeatherRequests.delete(key);
  next();
}
function requireReportStore() {
  if (!database.configured) throw new HttpError(503, 'Report storage is not configured. Set MONGODB_URI on the server.');
  if (!database.connected) throw new HttpError(503, 'Report storage is temporarily unavailable. No report was saved.');
  if (!SESSION_SECRET_READY) throw new HttpError(503, 'Private report storage needs a SESSION_SECRET of at least 32 characters.');
}
function ownerId(req, res) { requireReportStore(); if (!req.auth) throw new HttpError(401, 'Sign in to access your private records.'); return `user:${req.auth.user._id}`; }
function publicReport(report) {
  return {
    id: String(report._id), crop: report.crop, identifiedCrop: report.identifiedCrop,
    affectedPart: report.affectedPart, growthStage: report.growthStage, location: report.location,
    disease: report.disease, uncertain: report.uncertain, uncertaintyMessage: report.uncertaintyMessage, severity: report.severity,
    confidenceLevel: report.confidenceLevel, confidenceNote: report.confidenceNote, confidenceNoteHi: report.confidenceNoteHi,
    symptoms: report.symptoms,
    possibleCauses: report.possibleCauses, recommendations: report.recommendations,
    prevention: report.prevention, expertWhen: report.expertWhen,
    language: report.language, createdAt: report.createdAt
  };
}
async function verifyImage(file) {
  if (!file) return;
  if (!file.size) throw new HttpError(400, 'This image could not be processed. Please upload another photo.');
  let metadata;
  try {
    const image = sharp(file.buffer, { failOn: 'warning', limitInputPixels: 4096 * 4096 });
    metadata = await image.metadata();
    const mimeType = formatMimeTypes[metadata.format];
    if (!mimeType) throw new HttpError(415, 'Please upload a JPG, PNG, or WEBP image.');
    const rotated = metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    if (!width || !height) throw new HttpError(400, 'This image could not be processed. Please upload another photo.');
    if (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      throw new HttpError(400, `Image dimensions must be between ${MIN_IMAGE_DIMENSION} × ${MIN_IMAGE_DIMENSION} and ${MAX_IMAGE_DIMENSION} × ${MAX_IMAGE_DIMENSION} pixels.`);
    }
    await image.stats();
    file.detectedMimeType = mimeType;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'This image could not be processed. Please upload another photo.');
  }
}
function parseHistory(serialized, message) {
  if (typeof serialized !== 'string' || !serialized.trim()) return [{ role: 'user', content: message.trim() }];
  let history;
  try { history = JSON.parse(serialized || '[]'); }
  catch { throw new HttpError(400, 'Conversation history must be valid JSON.'); }
  if (!Array.isArray(history) || history.length > MAX_MESSAGES) throw new HttpError(400, 'Chat history is invalid. Clear the chat and try again.');
  const clean = history.map(item => {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length > MAX_HISTORY_MESSAGE_CHARS) throw new HttpError(400, 'Chat history contains an invalid message.');
    return { role: item.role, content: item.content.trim() };
  });
  if (clean[0]?.role === 'assistant') clean.shift();
  if (!clean.length) clean.push({ role: 'user', content: message.trim() });
  if (clean.at(-1)?.role !== 'user') throw new HttpError(400, 'The latest user message is missing.');
  const current = clean.at(-1);
  if (current.content !== message.trim()) current.content = message.trim();
  if (clean.reduce((sum, item) => sum + item.content.length, 0) > MAX_CONTEXT_CHARS) throw new HttpError(400, 'Chat context is too long. Clear the chat and try again.');
  return clean;
}
function instructions(language, hasImage) {
  const answerLanguage = language === 'hi' ? 'Use simple, conversational Hindi in Devanagari.' : 'Use simple, clear English.';
  return `You are KrishiMonitor, a cautious agriculture assistant for farmers. ${answerLanguage}
Return only the requested structured fields. Write reply as a short, friendly direct answer. Keep all lists concise and use plain language.
When an image is included, describe visible evidence and only give a possible crop problem if the photo supports it. If the image is unclear or signs are ambiguous, set uncertain=true, leave possibleDiagnosis empty, explain the limitation in reply, and recommend local expert verification. Never invent confidence percentages or claim lab confirmation. If no image is included, leave photo-specific diagnosis and symptom fields empty unless the user explicitly asks for general information about a named condition; still do not claim visual inspection.
Offer general crop care, soil, irrigation, nutrient, and IPM advice. Do not prescribe pesticide products, dosage, mixing, or spray schedules. For serious damage or chemical controls, recommend a local Krishi Vigyan Kendra, agriculture department, or qualified agronomist. Avoid unsupported claims of locally verified advice.
The chat assistant does not receive the website's weather feed or the farmer's selected location. Never state current weather, outbreak, or region-specific conditions. For current-weather requests, direct the farmer to the Weather section, which can show provider data when configured, or ask them to share a forecast.
Set needsExpert=true when symptoms are uncertain, crop damage appears serious, or expert verification is important. Do not fabricate sources, diagnoses, or certainty.`;
}
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    reply: { type: Type.STRING, description: 'Short farmer-friendly answer in the selected language.' },
    possibleDiagnosis: { type: Type.STRING, description: 'Tentative image-based crop issue, or empty string if not identifiable or no photo.' },
    symptoms: { type: Type.ARRAY, items: { type: Type.STRING } },
    possibleCauses: { type: Type.ARRAY, items: { type: Type.STRING } },
    preventiveMeasures: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
    needsExpert: { type: Type.BOOLEAN },
    uncertain: { type: Type.BOOLEAN }
  },
  required: ['reply', 'possibleDiagnosis', 'symptoms', 'possibleCauses', 'preventiveMeasures', 'recommendations', 'needsExpert', 'uncertain'],
  propertyOrdering: ['reply', 'possibleDiagnosis', 'symptoms', 'possibleCauses', 'preventiveMeasures', 'recommendations', 'needsExpert', 'uncertain']
};
const cropAnalysisSchema = {
  type: Type.OBJECT,
  properties: {
    identified_crop: { type: Type.STRING },
    identified_crop_hi: { type: Type.STRING },
    crop_identifiable: { type: Type.BOOLEAN },
    disease: { type: Type.STRING },
    disease_hi: { type: Type.STRING },
    uncertain: { type: Type.BOOLEAN },
    uncertainty_message: { type: Type.STRING },
    uncertainty_message_hi: { type: Type.STRING },
    severity: { type: Type.STRING, enum: ['mild', 'moderate', 'severe', 'unknown'] },
    severity_hi: { type: Type.STRING },
    confidence_level: { type: Type.STRING, enum: ['low', 'moderate', 'high'] },
    confidence_note: { type: Type.STRING },
    confidence_note_hi: { type: Type.STRING },
    symptoms: { type: Type.ARRAY, items: { type: Type.STRING } },
    symptoms_hi: { type: Type.ARRAY, items: { type: Type.STRING } },
    possible_causes: { type: Type.ARRAY, items: { type: Type.STRING } },
    possible_causes_hi: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommendations_hi: { type: Type.ARRAY, items: { type: Type.STRING } },
    prevention: { type: Type.ARRAY, items: { type: Type.STRING } },
    prevention_hi: { type: Type.ARRAY, items: { type: Type.STRING } },
    expert_when: { type: Type.STRING },
    expert_when_hi: { type: Type.STRING },
    needsExpert: { type: Type.BOOLEAN }
  },
  required: ['identified_crop', 'identified_crop_hi', 'crop_identifiable', 'disease', 'disease_hi', 'uncertain', 'uncertainty_message', 'uncertainty_message_hi', 'severity', 'severity_hi', 'confidence_level', 'confidence_note', 'confidence_note_hi', 'symptoms', 'symptoms_hi', 'possible_causes', 'possible_causes_hi', 'recommendations', 'recommendations_hi', 'prevention', 'prevention_hi', 'expert_when', 'expert_when_hi', 'needsExpert'],
  propertyOrdering: ['identified_crop', 'identified_crop_hi', 'crop_identifiable', 'disease', 'disease_hi', 'uncertain', 'uncertainty_message', 'uncertainty_message_hi', 'severity', 'severity_hi', 'confidence_level', 'confidence_note', 'confidence_note_hi', 'symptoms', 'symptoms_hi', 'possible_causes', 'possible_causes_hi', 'recommendations', 'recommendations_hi', 'prevention', 'prevention_hi', 'expert_when', 'expert_when_hi', 'needsExpert']
};
function normalizeModelResponse(value) {
  if (!value || typeof value !== 'object' || typeof value.reply !== 'string' || !value.reply.trim()) throw new HttpError(502, 'The AI returned an incomplete response. Please try again.');
  const asList = field => Array.isArray(value[field]) ? value[field].filter(item => typeof item === 'string' && item.trim()).slice(0, 8).map(item => item.trim()) : [];
  return {
    reply: value.reply.trim().slice(0, 5000),
    possibleDiagnosis: typeof value.possibleDiagnosis === 'string' ? value.possibleDiagnosis.trim().slice(0, 500) : '',
    symptoms: asList('symptoms'),
    possibleCauses: asList('possibleCauses'),
    preventiveMeasures: asList('preventiveMeasures'),
    recommendations: asList('recommendations'),
    needsExpert: value.needsExpert === true,
    uncertain: value.uncertain === true
  };
}
function getClient() {
  if (!process.env.GEMINI_API_KEY) throw new HttpError(503, 'Gemini is not configured. Set GEMINI_API_KEY in the server environment and restart the app.');
  genaiClient ||= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return genaiClient;
}
function isTransientGeminiFailure(error) {
  const status = Number(error?.status || error?.code);
  if ([400, 401, 402, 403, 404, 429].includes(status)) return false;
  if (status >= 500 && status <= 599) return true;
  if (error?.name === 'TimeoutError') return true;
  const networkCode = error?.cause?.code || error?.cause?.errors?.[0]?.code;
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(networkCode)
    || (error?.name === 'TypeError' && /fetch failed/i.test(String(error?.message || '')));
}
async function generateGeminiWithRetry(request) {
  const waits = [500];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await getClient().models.generateContent(request);
    } catch (error) {
      if (attempt >= waits.length || !isTransientGeminiFailure(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, waits[attempt]));
    }
  }
}
function isInvalidGeminiKey(status, detail) {
  return [400, 401].includes(status) && /API_KEY_INVALID|API key not valid|invalid API key/i.test(detail);
}
function safeGeminiErrorDetail(error) {
  let detail = String(error?.message || error?.statusText || '');
  const key = process.env.GEMINI_API_KEY;
  if (key) detail = detail.split(key).join('[redacted]');
  return detail.replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]').replace(/https?:\/\/[^\s]+/gi, '[provider URL]').slice(0, 300);
}

app.get('/api/chat/health', noStore, (_req, res) => res.json({
  configured: Boolean(process.env.GEMINI_API_KEY),
  model: MODEL,
  limits: {
    maxImageBytes: MAX_IMAGE_BYTES,
    maxRequestBytes: MAX_REQUEST_BYTES,
    maxPromptChars: MAX_PROMPT_CHARS,
    minImageDimension: MIN_IMAGE_DIMENSION,
    maxImageDimension: MAX_IMAGE_DIMENSION
  }
}));
app.get('/api/health', noStore, (_req, res) => res.json({
  status: 'ok',
  limits: {
    maxImageBytes: MAX_IMAGE_BYTES,
    maxRequestBytes: MAX_REQUEST_BYTES,
    maxPromptChars: MAX_PROMPT_CHARS,
    minImageDimension: MIN_IMAGE_DIMENSION,
    maxImageDimension: MAX_IMAGE_DIMENSION
  },
  services: {
    ai: { configured: Boolean(process.env.GEMINI_API_KEY), model: MODEL },
    weather: { configured: weatherService.configured, provider: 'visualcrossing' },
    database: { configured: database.configured, connected: database.connected, reportsEnabled: database.reportsEnabled && SESSION_SECRET_READY },
    auth: { configured: database.configured && SESSION_SECRET_READY, emailConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.EMAIL_FROM && process.env.PUBLIC_APP_URL) },
    map: { streetTiles: 'openstreetmap', satellite: { provider: 'MapTiler Satellite v4', configured: Boolean(process.env.MAPTILER_API_KEY) } },
    riskMap: { configured: false, message: 'No verified regional farm-location or advisory provider is connected.' }
  }
}));
app.get('/api/map/config', noStore, (_req, res) => res.json({
  streetProvider: 'OpenStreetMap',
  satelliteProvider: 'MapTiler Satellite v4',
  satelliteEnabled: Boolean(process.env.MAPTILER_API_KEY),
  // MapTiler client keys are public identifiers; restrict this key to the deployed website domain in MapTiler Cloud.
  satelliteApiKey: process.env.MAPTILER_API_KEY || null
}));
app.get('/api/session', noStore, (req, res) => res.json({ scope: req.auth ? 'account' : 'signed-out', user: req.auth ? { id: String(req.auth.user._id), fullName: req.auth.user.fullName, email: req.auth.user.email } : null, csrfToken: req.auth?.csrfToken || null }));
app.use('/api/crops', requireAuth, (req, res, next) => ['GET', 'HEAD'].includes(req.method) ? next() : requireCsrf(req, res, next));
app.use('/api/reports', requireAuth, (req, res, next) => ['GET', 'HEAD'].includes(req.method) ? next() : requireCsrf(req, res, next));
app.use('/api/alerts', requireAuth);
const cropCatalog = ['Wheat', 'Rice', 'Maize', 'Tomato', 'Potato', 'Cotton', 'Soybean', 'Onion', 'Chilli', 'Mango', 'Banana', 'Grapes', 'Other crops'];
function publicCrop(record) { return { id: String(record._id), name: record.name, variety: record.variety, area: record.area, stage: record.stage, date: record.date, updatedAt: record.updatedAt }; }
app.get('/api/crops', noStore, async (req, res) => {
  if (!database.reportsEnabled || !SESSION_SECRET_READY) return res.json({ source: 'KrishiMonitor crop selection catalog', crops: cropCatalog, recordsEnabled: false, records: null });
  const owner = ownerId(req, res);
  const records = await CropRecord.find({ ownerId: owner }).sort({ createdAt: -1 }).limit(200).lean();
  res.json({ source: 'KrishiMonitor crop selection catalog', crops: cropCatalog, recordsEnabled: true, records: records.map(publicCrop) });
});
app.post('/api/crops', noStore, async (req, res) => {
  const owner = ownerId(req, res);
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const area = Number(body.area);
  if (!name || name.length > 80 || !Number.isFinite(area) || area < 0 || area > 100000) throw new HttpError(400, 'Enter a crop name and valid area up to 100,000 acres.');
  if (typeof body.variety !== 'string' || body.variety.length > 80 || typeof body.stage !== 'string' || body.stage.length > 80 || typeof body.date !== 'string' || body.date.length > 10) throw new HttpError(400, 'Crop details are invalid.');
  const record = await CropRecord.create({ ownerId: owner, name, variety: body.variety.trim(), area, stage: body.stage.trim(), date: body.date.trim() });
  res.status(201).json({ crop: publicCrop(record) });
});
app.put('/api/crops/:id', noStore, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new HttpError(400, 'Crop record ID is invalid.');
  const owner = ownerId(req, res), body = req.body || {}, area = Number(body.area);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80 || !Number.isFinite(area) || area < 0 || area > 100000) throw new HttpError(400, 'Enter a crop name and valid area up to 100,000 acres.');
  const record = await CropRecord.findOneAndUpdate({ _id: req.params.id, ownerId: owner }, {
    name: body.name.trim(), variety: String(body.variety || '').slice(0, 80), area,
    stage: String(body.stage || '').slice(0, 80), date: String(body.date || '').slice(0, 10)
  }, { new: true, runValidators: true }).lean();
  if (!record) throw new HttpError(404, 'Crop record was not found.');
  res.json({ crop: publicCrop(record) });
});
app.delete('/api/crops/:id', noStore, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new HttpError(400, 'Crop record ID is invalid.');
  const owner = ownerId(req, res);
  const result = await CropRecord.deleteOne({ _id: req.params.id, ownerId: owner });
  if (!result.deletedCount) throw new HttpError(404, 'Crop record was not found.');
  res.status(204).end();
});

app.get('/api/weather/geocode', noStore, weatherRateLimit, async (req, res) => {
  try { res.json({ locations: await weatherService.locations(req.query.q) }); }
  catch (error) { throw asPublicIntegrationError(error); }
});
app.get('/api/weather/history', noStore, weatherRateLimit, async (req, res) => {
  try {
    const result = await weatherService.history(req.query.lat, req.query.lon, req.query.from, req.query.to, req.query.language, req.query.label);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(result);
  } catch (error) { throw asPublicIntegrationError(error); }
});
for (const [pathName, operation] of [['current', 'current'], ['forecast', 'forecast']]) {
  app.get(`/api/weather/${pathName}`, noStore, weatherRateLimit, async (req, res) => {
    try {
      const result = await weatherService[operation](req.query.lat, req.query.lon, req.query.language, req.query.label);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json(result);
    } catch (error) { throw asPublicIntegrationError(error); }
  });
}

app.get('/api/reports', noStore, async (req, res) => {
  const owner = ownerId(req, res);
  const page = Math.max(1, Math.min(Number.parseInt(req.query.page, 10) || 1, 10000));
  const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 25, 100));
  const items = await CropAnalysisReport.find({ ownerId: owner }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit + 1).lean();
  const hasMore = items.length > limit;
  res.json({ reports: items.slice(0, limit).map(publicReport), page, hasMore });
});
app.get('/api/reports/:id', noStore, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new HttpError(400, 'Report ID is invalid.');
  const owner = ownerId(req, res);
  const report = await CropAnalysisReport.findOne({ _id: req.params.id, ownerId: owner }).lean();
  if (!report) throw new HttpError(404, 'Report was not found.');
  res.json({ report: publicReport(report) });
});
app.delete('/api/reports/:id', noStore, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new HttpError(400, 'Report ID is invalid.');
  const owner = ownerId(req, res);
  const result = await CropAnalysisReport.deleteOne({ _id: req.params.id, ownerId: owner });
  if (!result.deletedCount) throw new HttpError(404, 'Report was not found.');
  res.status(204).end();
});
app.post('/api/reports', noStore, async (req, res) => {
  const owner = ownerId(req, res);
  const body = req.body || {};
  if (typeof body.crop !== 'string' || !body.crop.trim() || body.crop.length > 80) throw new HttpError(400, 'Crop name is required and must be 80 characters or fewer.');
  if (body.uncertain !== undefined && typeof body.uncertain !== 'boolean') throw new HttpError(400, 'Report uncertainty value is invalid.');
  const strings = (field, max) => {
    if (body[field] === undefined) return [];
    if (!Array.isArray(body[field]) || body[field].length > 8 || body[field].some(item => typeof item !== 'string' || item.length > max)) throw new HttpError(400, `Report field ${field} is invalid.`);
    return body[field].map(item => item.trim()).filter(Boolean);
  };
  const report = await CropAnalysisReport.create({
    ownerId: owner, crop: body.crop.trim(), affectedPart: String(body.affectedPart || '').slice(0, 40),
    disease: String(body.disease || '').slice(0, 500), uncertain: body.uncertain === true,
    symptoms: strings('symptoms', 300), possibleCauses: strings('possibleCauses', 300),
    recommendations: strings('recommendations', 500), prevention: strings('prevention', 500),
    expertWhen: String(body.expertWhen || '').slice(0, 1000), language: body.language === 'hi' ? 'hi' : 'en'
  });
  res.status(201).json({ report: publicReport(report) });
});
app.get('/api/alerts', noStore, async (req, res) => {
  const owner = ownerId(req, res);
  const alerts = await Alert.find({ ownerId: owner, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ alerts: alerts.map(item => ({ id: String(item._id), type: item.type, title: item.title, message: item.message, source: item.source, createdAt: item.createdAt })) });
});

app.post('/api/crop/analyze', noStore, rateLimitMiddleware, limitRequestBody, upload.single('image'), async (req, res) => {
  if (req.uploadBodyBytes > MAX_REQUEST_BYTES) throw new HttpError(413, `Request body must be ${MAX_REQUEST_MB} MB or smaller.`);
  const crop = typeof req.body?.crop === 'string' ? req.body.crop.trim() : '';
  const affectedPart = typeof req.body?.affectedPart === 'string' ? req.body.affectedPart.trim() : '';
  const growthStage = typeof req.body?.growthStage === 'string' ? req.body.growthStage.trim() : '';
  const location = typeof req.body?.location === 'string' ? req.body.location.trim() : '';
  const language = req.body?.language === 'en' ? 'en' : 'hi';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!crop || crop.length > 80) throw new HttpError(400, 'Select a valid crop before analysis.');
  if (growthStage.length > 80 || location.length > 120) throw new HttpError(400, 'Location or growth-stage details are too long.');
  if (message.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `Message must be ${MAX_MESSAGE_CHARS} characters or fewer.`);
  if (!req.file) throw new HttpError(400, 'Choose a crop image before analysis.');
  if (req.body?.photoConsent !== 'true') throw new HttpError(400, 'Confirm photo sharing before sending an image for analysis.');
  await verifyImage(req.file);
  const prompt = `Assess this crop photo. Farmer selected: ${crop}; affected part: ${affectedPart || 'unknown'}; growth stage: ${growthStage || 'not provided'}; location: ${location || 'not provided'}. ${message}\n\nIdentify the crop from the image only if visually supported; distinguish it from the farmer-selected crop. Describe visible evidence and only tentative possible problems; never claim a confirmed disease. If evidence is unclear, set uncertain=true, leave disease fields empty, severity=unknown, confidence=low, explain what is missing and ask for useful details or clearer photos. Severity only when visibly supported. Confidence is qualitative, never a percentage. Give up to 3 concise alternatives, safe non-chemical next steps and prevention. Do not invent crop-specific treatment because no verified ICAR/local source is connected; no pesticide product, dosage, mix, or spray schedule. Recommend local expert confirmation for treatment. Return paired Hindi and English fields; preferred display language: ${language === 'hi' ? 'Hindi' : 'English'}.`;
  const answerLanguage = language === 'hi' ? 'Use simple Hindi as the primary field values and also provide English equivalents.' : 'Use simple English as the primary field values and also provide Hindi equivalents.';
  try {
    const response = await generateGeminiWithRetry({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: req.file.detectedMimeType, data: req.file.buffer.toString('base64') } }] }],
      config: {
        systemInstruction: `You are a cautious crop symptom assistant. ${answerLanguage} You have no verified ICAR or local agriculture knowledge base connected. Never claim confirmation, lab diagnosis, verified treatment, or guaranteed recovery. Return only the requested structured fields.`,
        responseMimeType: 'application/json', responseJsonSchema: cropAnalysisSchema,
        maxOutputTokens: 1800, thinkingConfig: { thinkingLevel: 'low' }, httpOptions: { timeout: 60000 }
      }
    });
    let parsed;
    try { parsed = JSON.parse(response.text || ''); }
    catch { throw new HttpError(502, 'The AI response was not valid structured data. Please try again.'); }
    if (typeof parsed.disease !== 'string' || typeof parsed.uncertain !== 'boolean' || !Array.isArray(parsed.symptoms)) throw new HttpError(502, 'The AI returned an incomplete crop assessment. Please try again.');
    const safeList = field => Array.isArray(parsed[field]) ? parsed[field].filter(item => typeof item === 'string').slice(0, 8).map(item => item.trim()).filter(Boolean) : [];
    const result = {
      crop, crop_hi: '', identified_crop: parsed.crop_identifiable === true ? String(parsed.identified_crop || '').slice(0, 100) : '', identified_crop_hi: parsed.crop_identifiable === true ? String(parsed.identified_crop_hi || '').slice(0, 100) : '',
      disease: parsed.uncertain ? '' : parsed.disease.trim().slice(0, 500), disease_hi: parsed.uncertain ? '' : String(parsed.disease_hi || '').slice(0, 500),
      uncertain: parsed.uncertain, uncertainty_message: String(parsed.uncertainty_message || '').slice(0, 1000), uncertainty_message_hi: String(parsed.uncertainty_message_hi || '').slice(0, 1000),
      severity: parsed.uncertain || !['mild', 'moderate', 'severe'].includes(parsed.severity) ? 'unknown' : parsed.severity,
      severity_hi: String(parsed.severity_hi || '').slice(0, 80),
      confidence_level: parsed.uncertain ? 'low' : (['low', 'moderate', 'high'].includes(parsed.confidence_level) ? parsed.confidence_level : 'low'),
      confidence_note: String(parsed.confidence_note || '').slice(0, 500), confidence_note_hi: String(parsed.confidence_note_hi || '').slice(0, 500),
      symptoms: safeList('symptoms'), symptoms_hi: safeList('symptoms_hi'),
      possible_causes: safeList('possible_causes'), possible_causes_hi: safeList('possible_causes_hi'),
      recommendations: safeList('recommendations'), recommendations_hi: safeList('recommendations_hi'),
      prevention: safeList('prevention'), prevention_hi: safeList('prevention_hi'),
      expert_when: String(parsed.expert_when || '').slice(0, 1000), expert_when_hi: String(parsed.expert_when_hi || '').slice(0, 1000), needsExpert: parsed.needsExpert === true,
      source: 'Gemini', createdAt: new Date().toISOString(), reportSaved: false
    };
    if (req.body?.saveReport === 'true') {
      try {
        if (!req.auth) throw new HttpError(401, 'Sign in to save this report.');
        if (!csrfTokenValid(req) || !req.get('origin')) throw new HttpError(403, 'Security token expired. Refresh the page and try again.');
        const owner = ownerId(req, res);
        const saved = await CropAnalysisReport.create({
          ownerId: owner, crop: result.crop, identifiedCrop: result.identified_crop, affectedPart, growthStage, location,
          disease: result.disease, uncertain: result.uncertain, uncertaintyMessage: result.uncertainty_message,
          severity: result.severity, confidenceLevel: result.confidence_level,
          confidenceNote: language === 'en' ? result.confidence_note : result.confidence_note_hi,
          confidenceNoteHi: result.confidence_note_hi, symptoms: result.symptoms, possibleCauses: result.possible_causes,
          recommendations: result.recommendations, prevention: result.prevention,
          expertWhen: result.expert_when, language
        });
        result.reportSaved = true; result.reportId = String(saved._id);
      } catch (error) {
        result.reportSaveError = [401, 403, 503].includes(error.status) ? error.message : 'The crop assessment completed, but the report could not be saved.';
      }
    }
    res.json(result);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new HttpError(504, 'Gemini took too long to respond. Please try again.');
    const status = Number(error.status || error.code);
    const detail = String(error.message || '');
    const providerCode = String(error.status || error.code || '').toUpperCase();
    const networkCode = error.cause?.code || error.cause?.errors?.[0]?.code || '';
    console.error(`Gemini crop analysis failed: status=${status || 'unknown'} code=${providerCode || 'unknown'} model=${MODEL} cause=${networkCode || error.name || 'unknown'} detail=${safeGeminiErrorDetail(error)}`);
    if (status === 429 && /exceeded your current quota|quota exceeded|generate_content_.*requests/i.test(detail)) throw new HttpError(503, 'This Google AI Studio project has exhausted its current Gemini API quota. Check the project quota and billing, or retry after the quota resets. Creating another key in the same project will not increase its quota.');
    if (status === 429 || detail.includes('RESOURCE_EXHAUSTED') || providerCode.includes('RESOURCE_EXHAUSTED')) throw new HttpError(503, 'Gemini rate limit reached. Wait briefly and retry, or check the project limits in Google AI Studio.');
    if (status === 402 || providerCode.includes('PAYMENT')) throw new HttpError(503, 'Gemini billing or available credits are required for this project. Check its Google AI Studio billing status.');
    if (isInvalidGeminiKey(status, detail) || detail.includes('API key')) throw new HttpError(502, 'Google Gemini rejected the API key. Verify GEMINI_API_KEY in the backend environment and make sure the key is enabled for the Gemini API.');
    if (status === 403 || providerCode.includes('PERMISSION_DENIED')) throw new HttpError(502, 'Google Gemini denied this project access. Check the API key restrictions, project eligibility, and billing status in Google AI Studio.');
    if (status === 404 || providerCode.includes('NOT_FOUND') || providerCode.includes('MODEL_NOT_FOUND')) throw new HttpError(502, `Gemini model "${MODEL}" was not found or is unavailable. Set GEMINI_MODEL to a model enabled for this API key.`);
    if (status === 400 || providerCode.includes('INVALID_ARGUMENT')) throw new HttpError(502, 'Gemini rejected the request format. Check the configured model and structured response settings.');
    if (error.name === 'TypeError' && /fetch failed/i.test(detail) || networkCode) throw new HttpError(503, 'The backend could not connect to Google Gemini. Check the backend internet connection and retry.');
    if (status >= 500) throw new HttpError(503, 'Google Gemini is temporarily unavailable. Please try again later.');
    throw new HttpError(502, 'Gemini could not complete the crop analysis. Check the backend log for the sanitized provider status and retry.');
  }
});

app.post('/api/chat', noStore, rateLimitMiddleware, limitRequestBody, upload.single('image'), async (req, res) => {
  if (req.uploadBodyBytes > MAX_REQUEST_BYTES) throw new HttpError(413, `Request body must be ${MAX_REQUEST_MB} MB or smaller.`);
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const requestedLanguage = req.body?.language || 'en';
  if (!['hi', 'en'].includes(requestedLanguage)) throw new HttpError(400, 'Language must be hi or en.');
  const language = requestedLanguage;
  if (!message || message.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `Message must be between 1 and ${MAX_MESSAGE_CHARS} characters.`);
  if (req.file && req.body?.photoConsent !== 'true') throw new HttpError(400, 'Confirm photo sharing before sending an image for analysis.');
  await verifyImage(req.file);
  const history = parseHistory(req.body?.conversationHistory, message);
  const contents = history.map((item, index) => {
    const parts = [{ text: item.content }];
    if (index === history.length - 1 && req.file) parts.push({ inlineData: { mimeType: req.file.detectedMimeType, data: req.file.buffer.toString('base64') } });
    return { role: item.role === 'assistant' ? 'model' : 'user', parts };
  });
  try {
    const response = await generateGeminiWithRetry({
      model: MODEL,
      contents,
      config: {
        systemInstruction: instructions(language, Boolean(req.file)),
        responseMimeType: 'application/json',
        responseJsonSchema: responseSchema,
        maxOutputTokens: 1000,
        thinkingConfig: { thinkingLevel: 'low' },
        httpOptions: { timeout: 60000 }
      }
    });
    let parsed;
    try { parsed = JSON.parse(response.text || ''); }
    catch { throw new HttpError(502, 'The AI response was not valid structured data. Please try again.'); }
    res.json({ success: true, ...normalizeModelResponse(parsed) });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const providerStatus = Number(error.status || error.code);
    const detail = String(error.message || '');
    const providerCode = String(error.status || error.code || '').toUpperCase();
    const networkCode = error.cause?.code || error.cause?.errors?.[0]?.code || '';
    console.error(`Gemini request failed: status=${providerStatus || 'unknown'} code=${providerCode || 'unknown'} model=${MODEL} cause=${networkCode || error.name || 'unknown'} detail=${safeGeminiErrorDetail(error)}`);
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new HttpError(504, 'Gemini took too long to respond. Please try again.');
    if (providerStatus === 429 && /exceeded your current quota|quota exceeded|generate_content_.*requests/i.test(detail)) throw new HttpError(503, 'This Google AI Studio project has exhausted its current Gemini API quota. Check the project quota and billing, or retry after the quota resets. Creating another key in the same project will not increase its quota.');
    if (providerStatus === 429 || detail.includes('RESOURCE_EXHAUSTED') || providerCode.includes('RESOURCE_EXHAUSTED')) throw new HttpError(503, 'Gemini rate limit reached. Wait briefly and retry, or check the project limits in Google AI Studio.');
    if (providerStatus === 402 || providerCode.includes('PAYMENT')) throw new HttpError(503, 'Gemini billing or available credits are required for this project. Check its Google AI Studio billing status.');
    if (isInvalidGeminiKey(providerStatus, detail) || detail.includes('API key')) throw new HttpError(502, 'Google Gemini rejected the API key. Verify GEMINI_API_KEY in the backend environment and make sure the key is enabled for the Gemini API.');
    if (providerStatus === 403 || providerCode.includes('PERMISSION_DENIED')) throw new HttpError(502, 'Google Gemini denied this project access. Check the API key restrictions, project eligibility, and billing status in Google AI Studio.');
    if (providerStatus === 404 || providerCode.includes('NOT_FOUND') || providerCode.includes('MODEL_NOT_FOUND')) throw new HttpError(502, `Gemini model "${MODEL}" was not found or is unavailable. Set GEMINI_MODEL to a model enabled for this API key.`);
    if (providerStatus === 400 || providerCode.includes('INVALID_ARGUMENT')) throw new HttpError(502, 'Gemini rejected the request format. Check the configured model and structured response settings.');
    if (error.name === 'TypeError' && /fetch failed/i.test(detail) || networkCode) throw new HttpError(503, 'The server could not connect to Gemini. Check the server internet connection and try again.');
    if (providerStatus >= 500) throw new HttpError(503, 'Google Gemini is temporarily unavailable. Please try again later.');
    throw new HttpError(502, 'Gemini could not complete the request. Check the backend log for the sanitized provider status and retry.');
  }
});

function setStaticHeaders(res) {
  res.setHeader('Cache-Control', 'no-cache');
}
app.get('/', (_req, res) => { setStaticHeaders(res); res.sendFile(path.join(ROOT, 'index.html')); });
app.get('/index.html', (_req, res) => { setStaticHeaders(res); res.sendFile(path.join(ROOT, 'index.html')); });
for (const file of ['style.css', 'script.js', 'chatbot.js', 'earth-background.js', 'terms.html', 'privacy.html']) app.get(`/${file}`, (_req, res) => { setStaticHeaders(res); res.sendFile(path.join(ROOT, file)); });
app.use('/assets', express.static(path.join(ROOT, 'assets'), { dotfiles: 'deny', fallthrough: false, index: false, maxAge: '1d' }));
app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found.' }));
app.use((error, req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof multer.MulterError) {
    console.error(`Photo upload rejected: ${error.code || 'unknown'}`);
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: `Image must be ${MAX_IMAGE_MB} MB or smaller.` });
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_PART_COUNT') {
      return res.status(400).json({ success: false, error: 'Please upload one crop image at a time.' });
    }
    return res.status(400).json({ success: false, error: 'The photo upload was not accepted.' });
  }
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500 && !(error instanceof HttpError)) console.error(`Chat server error: ${error.name || 'Error'}`);
  const privateApiRoute = ['/api/auth/', '/api/crops', '/api/reports', '/api/alerts'].some(prefix => req.path.startsWith(prefix));
  const authPublicError = status < 500 && (privateApiRoute || [401, 403, 409, 429].includes(status)) || status === 503 && privateApiRoute;
  const message = status >= 500 && !(error instanceof HttpError) && !authPublicError
    ? 'The service could not complete the request. Please try again.'
    : error.message || 'The request could not be completed.';
  res.status(status).json({ success: false, error: message });
});

void database.connect();
if (database.configured && !SESSION_SECRET_READY) console.error('SESSION_SECRET is missing or shorter than 32 characters; private database records are disabled.');
const server = app.listen(PORT, HOST, () => console.log(`KrishiMonitor API listening on ${HOST}:${PORT} (Gemini ${process.env.GEMINI_API_KEY ? 'configured' : 'not configured'}, weather ${weatherService.configured ? 'configured' : 'not configured'}, MongoDB ${database.connected ? 'connected' : 'not connected'})`));
server.requestTimeout = 70_000;
server.headersTimeout = 75_000;
server.keepAliveTimeout = 5_000;
