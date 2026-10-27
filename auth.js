import { Router } from 'express';
import nodemailer from 'nodemailer';
import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import mongoose from 'mongoose';

const scrypt = promisify(scryptCallback);
const { Schema } = mongoose;
const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254, index: true },
  fullName: { type: String, required: true, trim: true, maxlength: 100 },
  passwordHash: { type: String, required: true, select: false }, emailVerified: { type: Boolean, default: false },
  verificationTokenHash: { type: String, select: false }, verificationExpiresAt: Date,
  resetTokenHash: { type: String, select: false }, resetExpiresAt: Date
}, { timestamps: true, versionKey: false });
const authSessionSchema = new Schema({ userId: { type: Schema.Types.ObjectId, required: true, index: true }, tokenHash: { type: String, required: true, unique: true }, expiresAt: { type: Date, required: true, index: { expires: 0 } } }, { timestamps: true, versionKey: false });
export const User = mongoose.models.User || mongoose.model('User', userSchema);
export const AuthSession = mongoose.models.AuthSession || mongoose.model('AuthSession', authSessionSchema);
const COOKIE = 'km_auth';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const attempts = new Map();
const hash = value => createHash('sha256').update(value).digest('hex');
const csrfFor = token => createHmac('sha256', process.env.SESSION_SECRET).update(`csrf:${token}`).digest('base64url');
const readCookie = (header, key) => String(header || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${key}=`))?.slice(key.length + 1) || '';
const databaseReady = () => mongoose.connection.readyState === 1;
const mailReady = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.EMAIL_FROM && process.env.PUBLIC_APP_URL);
function enforceOrigin(req) {
  const origin = req.get('origin');
  if (!origin || !(origin === `${req.protocol}://${req.get('host')}` || String(process.env.FRONTEND_ORIGIN || '').split(',').map(x => x.trim()).includes(origin))) {
    const err = new Error('Request origin is not allowed.'); err.status = 403; throw err;
  }
}
function rateLimit(req, bucket, max = 10) {
  const key = `${bucket}:${req.ip || req.socket.remoteAddress || 'unknown'}`; const now = Date.now();
  const recent = (attempts.get(key) || []).filter(t => now - t < 15 * 60_000);
  if (recent.length >= max) { const err = new Error('Too many attempts. Please wait and try again.'); err.status = 429; throw err; }
  recent.push(now); attempts.set(key, recent);
}
function publicUser(user) { return { id: String(user._id), email: user.email, fullName: user.fullName, emailVerified: user.emailVerified, createdAt: user.createdAt }; }
function requireAuthStorage() {
  if (!databaseReady()) throw Object.assign(new Error('Account database is unavailable. Configure MONGODB_URI and try again.'), { status: 503 });
  if (typeof process.env.SESSION_SECRET !== 'string' || Buffer.byteLength(process.env.SESSION_SECRET) < 32) throw Object.assign(new Error('Account sessions are not configured. Set SESSION_SECRET to at least 32 characters.'), { status: 503 });
}
function cookieOptions(req, maxAge) { return `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
async function issueSession(user, req, res) {
  const token = randomBytes(32).toString('base64url');
  await AuthSession.create({ userId: user._id, tokenHash: hash(token), expiresAt: new Date(Date.now() + SESSION_MS) });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieOptions(req, SESSION_MS / 1000)}`);
  return csrfFor(token);
}
export async function loadAuth(req, _res, next) {
  try {
    const needsAuth = req.path.startsWith('/api/auth/') || req.path === '/api/session' || ['/api/crops', '/api/reports', '/api/alerts'].some(prefix => req.path === prefix || req.path.startsWith(`${prefix}/`)) || req.path === '/api/crop/analyze';
    if (!needsAuth) return next();
    const token = readCookie(req.headers.cookie, COOKIE);
    if (token && databaseReady() && typeof process.env.SESSION_SECRET === 'string' && Buffer.byteLength(process.env.SESSION_SECRET) >= 32) {
      const session = await AuthSession.findOne({ tokenHash: hash(token), expiresAt: { $gt: new Date() } }).lean();
      if (session) { const user = await User.findById(session.userId).lean(); if (user) req.auth = { user, csrfToken: csrfFor(token) }; }
    }
    next();
  } catch (error) { next(error); }
}
export function requireAuth(req, _res, next) {
  if (typeof process.env.SESSION_SECRET !== 'string' || Buffer.byteLength(process.env.SESSION_SECRET) < 32) return next(Object.assign(new Error('Account sessions are not configured. Set SESSION_SECRET to at least 32 characters.'), { status: 503 }));
  if (!req.auth) return next(Object.assign(new Error(databaseReady() ? 'Sign in to access your private records.' : 'Account storage is unavailable. Configure MongoDB and restart the server.'), { status: databaseReady() ? 401 : 503 }));
  next();
}
export function requireCsrf(req, _res, next) {
  try { enforceOrigin(req); } catch (e) { return next(e); }
  if (csrfTokenValid(req)) return next();
  next(Object.assign(new Error('Security token expired. Refresh the page and try again.'), { status: 403 }));
}
export function csrfTokenValid(req) {
  const actual = req.get('x-csrf-token') || '', expected = req.auth?.csrfToken || '';
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return Boolean(a.length && a.length === b.length && timingSafeEqual(a, b));
}

export const authRouter = Router();
authRouter.use((req, _res, next) => { if (['GET', 'HEAD'].includes(req.method)) return next(); try { enforceOrigin(req); next(); } catch (e) { next(e); } });
authRouter.get('/me', (req, res) => { requireAuthStorage(); res.set('Cache-Control', 'no-store').json({ user: req.auth ? publicUser(req.auth.user) : null, csrfToken: req.auth?.csrfToken || null }); });
authRouter.post('/signup', async (req, res) => {
  rateLimit(req, 'signup', 8);
  const { fullName, email, password, confirmPassword, acceptedTerms } = req.body || {};
  const cleanName = typeof fullName === 'string' ? fullName.trim() : '';
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (cleanName.length < 2 || cleanName.length > 100 || !emailPattern.test(normalizedEmail) || normalizedEmail.length > 254) throw Object.assign(new Error('Enter your full name and a valid email address.'), { status: 400 });
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw Object.assign(new Error('Password must be between 12 and 128 characters.'), { status: 400 });
  if (password !== confirmPassword) throw Object.assign(new Error('Passwords do not match.'), { status: 400 });
  if (acceptedTerms !== true) throw Object.assign(new Error('Accept the Terms and Privacy Policy to continue.'), { status: 400 });
  requireAuthStorage();
  if (!mailReady()) throw Object.assign(new Error('Email verification is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, and PUBLIC_APP_URL before creating accounts.'), { status: 503 });
  const salt = randomBytes(16).toString('base64url'); const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const token = randomBytes(32).toString('base64url');
  let user;
  try { user = await User.create({ email: normalizedEmail, fullName: cleanName, passwordHash: `scrypt$16384$8$1$${salt}$${Buffer.from(derived).toString('base64url')}`, verificationTokenHash: hash(token), verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60_000) }); }
  catch (error) { if (error.code === 11000) throw Object.assign(new Error('An account with this email already exists. Try signing in or use password recovery.'), { status: 409 }); throw error; }
  const link = `${process.env.PUBLIC_APP_URL.replace(/\/$/, '')}/#verify=${encodeURIComponent(token)}`;
  try { await mailer().sendMail({ from: process.env.EMAIL_FROM, to: normalizedEmail, subject: 'Verify your KrishiMonitor account', text: `Hello ${cleanName},\n\nVerify your email within 24 hours: ${link}\n\nIf you did not request this account, ignore this email.` }); }
  catch (error) { await User.deleteOne({ _id: user._id }); console.error(`Verification email failed: ${error.code || error.name}`); throw Object.assign(new Error('Verification email could not be delivered. No account was created; check the email provider configuration and try again.'), { status: 503 }); }
  res.status(201).json({ success: true, message: 'Account created. Check your email for the verification link.' });
});
authRouter.post('/login', async (req, res) => {
  rateLimit(req, 'login', 12);
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body?.password;
  if (!emailPattern.test(email) || typeof password !== 'string' || password.length > 128) throw Object.assign(new Error('Enter a valid email and password.'), { status: 400 });
  requireAuthStorage();
  const user = await User.findOne({ email }).select('+passwordHash');
  const parts = String(user?.passwordHash || '').split('$');
  let valid = false;
  if (parts.length === 6 && parts[0] === 'scrypt') {
    const derived = await scrypt(password, parts[4], 64, { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) });
    const expected = Buffer.from(parts[5], 'base64url'), actual = Buffer.from(derived);
    valid = expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  if (!valid) throw Object.assign(new Error('Email or password is incorrect.'), { status: 401 });
  if (!user.emailVerified) throw Object.assign(new Error('Verify your email before signing in. Use the resend verification option below.'), { status: 403 });
  const csrfToken = await issueSession(user, req, res);
  res.set('Cache-Control', 'no-store').json({ success: true, user: publicUser(user), csrfToken });
});
authRouter.post('/logout', async (req, res) => {
  if (req.auth && !csrfTokenValid(req)) throw Object.assign(new Error('Security token expired. Refresh the page and try again.'), { status: 403 });
  const token = readCookie(req.headers.cookie, COOKIE);
  if (token) await AuthSession.deleteOne({ tokenHash: hash(token) });
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieOptions(req, 0)}`); res.json({ success: true });
});
authRouter.post('/verify-email', async (req, res) => {
  rateLimit(req, 'verify', 20);
  const token = req.body?.token;
  if (typeof token !== 'string' || token.length < 30 || token.length > 200) throw Object.assign(new Error('Verification link is invalid or expired.'), { status: 400 });
  requireAuthStorage();
  const user = await User.findOneAndUpdate({ verificationTokenHash: hash(token), verificationExpiresAt: { $gt: new Date() } }, { $set: { emailVerified: true }, $unset: { verificationTokenHash: 1, verificationExpiresAt: 1 } }, { new: true });
  if (!user) throw Object.assign(new Error('Verification link is invalid or expired. Request a new verification email.'), { status: 400 });
  const csrfToken = await issueSession(user, req, res); res.json({ success: true, user: publicUser(user), csrfToken });
});
authRouter.post('/resend-verification', async (req, res) => {
  rateLimit(req, 'resend', 6);
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!emailPattern.test(email) || email.length > 254) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
  requireAuthStorage();
  if (!mailReady()) throw Object.assign(new Error('Email delivery is not configured; no email was sent.'), { status: 503 });
  {
    const user = await User.findOne({ email, emailVerified: false });
    if (user) { const token = randomBytes(32).toString('base64url'); user.verificationTokenHash = hash(token); user.verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60_000); await user.save(); try { await mailer().sendMail({ from: process.env.EMAIL_FROM, to: email, subject: 'Verify your KrishiMonitor account', text: `Verify your email within 24 hours: ${process.env.PUBLIC_APP_URL.replace(/\/$/, '')}/#verify=${encodeURIComponent(token)}` }); } catch (error) { console.error(`Verification email resend failed: ${error.code || error.name}`); throw Object.assign(new Error('Verification email could not be delivered. Check the email provider configuration and try again.'), { status: 503 }); } }
  }
  res.status(202).json({ success: true, message: 'If an unverified account exists, a new verification link has been sent.' });
});
authRouter.post('/forgot-password', async (req, res) => {
  rateLimit(req, 'forgot', 6);
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!emailPattern.test(email) || email.length > 254) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
  requireAuthStorage();
  if (!mailReady()) throw Object.assign(new Error('Email delivery is not configured; no reset email was sent.'), { status: 503 });
  {
    const user = await User.findOne({ email, emailVerified: true });
    if (user) { const token = randomBytes(32).toString('base64url'); user.resetTokenHash = hash(token); user.resetExpiresAt = new Date(Date.now() + 30 * 60_000); await user.save(); try { await mailer().sendMail({ from: process.env.EMAIL_FROM, to: email, subject: 'Reset your KrishiMonitor password', text: `Reset your password within 30 minutes: ${process.env.PUBLIC_APP_URL.replace(/\/$/, '')}/#reset=${encodeURIComponent(token)}\n\nIf you did not request this, ignore this email.` }); } catch (error) { user.resetTokenHash = undefined; user.resetExpiresAt = undefined; await user.save(); console.error(`Password reset email failed: ${error.code || error.name}`); throw Object.assign(new Error('Password reset email could not be delivered. Check the email provider configuration and try again.'), { status: 503 }); } }
  }
  res.status(202).json({ success: true, message: 'If a verified account matches that email, a reset link has been sent.' });
});
authRouter.post('/reset-password', async (req, res) => {
  rateLimit(req, 'reset', 10);
  const { token, password, confirmPassword } = req.body || {};
  if (typeof token !== 'string' || token.length < 30 || token.length > 200) throw Object.assign(new Error('Reset link is invalid or expired.'), { status: 400 });
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw Object.assign(new Error('Password must be between 12 and 128 characters.'), { status: 400 });
  if (password !== confirmPassword) throw Object.assign(new Error('Passwords do not match.'), { status: 400 });
  requireAuthStorage();
  const salt = randomBytes(16).toString('base64url'); const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const user = await User.findOneAndUpdate({ resetTokenHash: hash(token), resetExpiresAt: { $gt: new Date() } }, { $set: { passwordHash: `scrypt$16384$8$1$${salt}$${Buffer.from(derived).toString('base64url')}` }, $unset: { resetTokenHash: 1, resetExpiresAt: 1 } }, { new: true });
  if (!user) throw Object.assign(new Error('Reset link is invalid or expired.'), { status: 400 });
  await AuthSession.deleteMany({ userId: user._id }); res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
});

let transport;
function mailer() {
  if (!mailReady()) throw new Error('SMTP is not configured.');
  transport ||= nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  return transport;
}
