const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

// --- CORS: Whitelist specific origins instead of wildcard ---
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json());

// --- Rate limiting ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

// --- OAuth config from environment ---
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/auth/google/callback`
  : 'http://localhost:3000/auth/google/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('Warning: GOOGLE_CLIENT_ID and/or CLIENT_SECRET not set. OAuth will not work.');
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar'
];

// Token storage (in production, persist to a database or encrypted file)
let tokens = null;

// --- Auth middleware for protected routes ---
function requireAuth(req, res, next) {
  if (!tokens) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/google to connect.' });
  }
  oauth2Client.setCredentials(tokens);
  next();
}

// --- Routes ---
app.get('/', (req, res) => {
  res.json({
    status: 'NexusFlow Backend Running',
    authStatus: tokens ? 'Authenticated' : 'Not Authenticated'
  });
});

app.get('/auth/google', (req, res) => {
  if (!CLIENT_ID) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not configured.' });
  }
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Missing authorization code');
  }
  try {
    const { tokens: newTokens } = await oauth2Client.getToken(code);
    tokens = newTokens;
    oauth2Client.setCredentials(tokens);
    const redirectUrl = process.env.AUTH_SUCCESS_REDIRECT || '/';
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('OAuth callback error:', error.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

app.get('/api/emails', requireAuth, async (req, res) => {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 50,
      labelIds: ['INBOX']
    });
    const messages = await Promise.all(
      (response.data.messages || []).map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full'
        });
        const headers = detail.data.payload.headers;
        return {
          id: msg.id,
          subject: headers.find(h => h.name === 'Subject')?.value || '(No Subject)',
          sender: headers.find(h => h.name === 'From')?.value || '',
          date: headers.find(h => h.name === 'Date')?.value || '',
          body: detail.data.snippet,
          snippet: detail.data.snippet,
          timestamp: new Date(headers.find(h => h.name === 'Date')?.value).getTime()
        };
      })
    );
    res.json(messages);
  } catch (error) {
    console.error('Email fetch error:', error.message);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

app.get('/api/calendar-events', requireAuth, async (req, res) => {
  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 50,
      singleEvents: true,
      orderBy: 'startTime'
    });
    res.json(response.data.items || []);
  } catch (error) {
    console.error('Calendar fetch error:', error.message);
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
