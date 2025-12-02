const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

const CLIENT_ID = '743025984522-bsvndhkhe4uoabqu9iq031pugd13afo4.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/auth/google/callback` : 'http://localhost:3000/auth/google/callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar'];
let tokens = null;

app.get('/', (req, res) => res.json({ status: 'NexusFlow Backend Running', authStatus: tokens ? 'Authenticated' : 'Not Authenticated' }));

app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens: newTokens } = await oauth2Client.getToken(code);
    tokens = newTokens;
    oauth2Client.setCredentials(tokens);
    console.log('✅ Auth successful');
    res.redirect('https://aistudio.google.com/apps/drive/1nBlKSRIlQkCfR6h6kdkk9Yo1UtOORhQR?showPreview=true&auth=success');
  } catch (error) {
    res.status(500).send('Auth failed');
  }
});

app.get('/api/emails', async (req, res) => {
  if (!tokens) return res.status(401).json({ error: 'Not authenticated' });
  try {
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const response = await gmail.users.messages.list({ userId: 'me', maxResults: 50, labelIds: ['INBOX'] });
    const messages = await Promise.all((response.data.messages || []).map(async (msg) => {
      const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
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
    }));
    res.json(messages);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/calendar-events', async (req, res) => {
  if (!tokens) return res.status(401).json({ error: 'Not authenticated' });
  try {
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const response = await calendar.events.list({ calendarId: 'primary', timeMin: new Date().toISOString(), maxResults: 50, singleEvents: true, orderBy: 'startTime' });
    res.json(response.data.items || []);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
