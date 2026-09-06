const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use(globalLimiter);
app.use('/api/', apiLimiter);

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/auth/google/callback`
  : 'http://localhost:3000/auth/google/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('Warning: GOOGLE_CLIENT_ID and/or CLIENT_SECRET not set. OAuth will not work.');
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly'
];

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();
const oauthStates = new Map();

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function secureCookieSuffix() {
  return process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

function setCookie(res, name, value, maxAgeSeconds) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureCookieSuffix()}`);
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieSuffix()}`);
}

function getSession(req) {
  const sid = parseCookies(req).nexusflow_session;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return session;
}

function createSession(res, tokens) {
  const sid = crypto.randomBytes(32).toString('base64url');
  sessions.set(sid, { tokens, expiresAt: Date.now() + SESSION_TTL_MS });
  setCookie(res, 'nexusflow_session', sid, Math.floor(SESSION_TTL_MS / 1000));
  return sid;
}

function oauthClientFor(tokens) {
  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  if (tokens) client.setCredentials(tokens);
  return client;
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated. Visit /auth/google to connect.' });
  req.oauth2Client = oauthClientFor(session.tokens);
  return next();
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions) if (session.expiresAt <= now) sessions.delete(sid);
  for (const [state, expiresAt] of oauthStates) if (expiresAt <= now) oauthStates.delete(state);
}, 5 * 60 * 1000).unref();

app.get('/', (req, res) => {
  res.json({
    status: 'NexusFlow Backend Running',
    authStatus: getSession(req) ? 'Authenticated' : 'Not Authenticated'
  });
});

app.get('/auth/google', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Google OAuth is not configured.' });
  }

  const state = crypto.randomBytes(32).toString('base64url');
  oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  setCookie(res, 'nexusflow_oauth_state', state, Math.floor(OAUTH_STATE_TTL_MS / 1000));

  const authUrl = oauthClientFor().generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state
  });
  return res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const cookieState = parseCookies(req).nexusflow_oauth_state;
  const expiresAt = typeof state === 'string' ? oauthStates.get(state) : null;

  if (!code || !state || !cookieState || state !== cookieState || !expiresAt || expiresAt <= Date.now()) {
    if (typeof state === 'string') oauthStates.delete(state);
    clearCookie(res, 'nexusflow_oauth_state');
    return res.status(400).send('Invalid or expired OAuth state');
  }

  oauthStates.delete(state);
  clearCookie(res, 'nexusflow_oauth_state');

  try {
    const oauth2Client = oauthClientFor();
    const { tokens } = await oauth2Client.getToken(code);
    createSession(res, tokens);
    const redirectUrl = process.env.AUTH_SUCCESS_REDIRECT || '/';
    return res.redirect(redirectUrl);
  } catch (error) {
    console.error('OAuth callback error:', error.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
});

app.post('/auth/logout', (req, res) => {
  const sid = parseCookies(req).nexusflow_session;
  if (sid) sessions.delete(sid);
  clearCookie(res, 'nexusflow_session');
  res.status(204).end();
});

app.get('/api/emails', requireAuth, async (req, res) => {
  try {
    const gmail = google.gmail({ version: 'v1', auth: req.oauth2Client });
    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 50,
      labelIds: ['INBOX']
    });
    const messages = await Promise.all(
      (response.data.messages || []).map(async (msg) => {
        const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
        const headers = detail.data.payload?.headers || [];
        return {
          id: msg.id,
          subject: headers.find(h => h.name === 'Subject')?.value || '(No Subject)',
          sender: headers.find(h => h.name === 'From')?.value || '',
          date: headers.find(h => h.name === 'Date')?.value || '',
          snippet: detail.data.snippet || '',
          timestamp: new Date(headers.find(h => h.name === 'Date')?.value || 0).getTime()
        };
      })
    );
    return res.json(messages);
  } catch (error) {
    console.error('Email fetch error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

app.get('/api/calendar-events', requireAuth, async (req, res) => {
  try {
    const calendar = google.calendar({ version: 'v3', auth: req.oauth2Client });
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 50,
      singleEvents: true,
      orderBy: 'startTime'
    });
    return res.json(response.data.items || []);
  } catch (error) {
    console.error('Calendar fetch error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`Server running on ${HOST}:${PORT}`));
