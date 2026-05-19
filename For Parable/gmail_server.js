const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
// Serve the current directory's static files (including the HTML)
app.use(express.static(__dirname));

require('dotenv').config({ path: path.join(__dirname, '.env') });

// Use the credentials provided by the user via .env
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/userinfo.email'
];

const TOKEN_PATH = path.join(__dirname, 'tokens.json');

// Load saved tokens if they exist
if (fs.existsSync(TOKEN_PATH)) {
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(tokens);
    console.log('Loaded saved tokens from', TOKEN_PATH);
  } catch (err) {
    console.error('Error reading tokens.json:', err);
  }
}

// 1. Generate Auth URL and redirect user
app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // Force to get refresh token
    scope: SCOPES,
  });
  res.redirect(authUrl);
});

// 2. Handle Callback from Google
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('No code provided');
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    // Save tokens
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('Tokens saved successfully!');
    
    // Redirect back to the frontend with a success flag
    res.redirect('/parable-warm-intros-demo-v2.html?auth=success');
  } catch (err) {
    console.error('Error retrieving access token', err);
    res.status(500).send('Authentication failed');
  }
});

// 3. API endpoint to get the connected user info
app.get('/api/user', async (req, res) => {
  try {
    if (!oauth2Client.credentials || !oauth2Client.credentials.access_token) {
      return res.json({ connected: false });
    }
    const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
    const userInfo = await oauth2.userinfo.get();
    res.json({ connected: true, email: userInfo.data.email });
  } catch (error) {
    console.error('Error getting user info:', error);
    res.json({ connected: false });
  }
});

// 4. API endpoint to scan inbox and classify responses based on active batches
app.post('/api/scan-inbox', async (req, res) => {
  if (!oauth2Client.credentials || !oauth2Client.credentials.access_token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { activeBatches } = req.body;
  if (!activeBatches || activeBatches.length === 0) {
    return res.json({ success: true, updates: [] });
  }

  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    // Fetch recent emails (e.g. from the last 24 hours, or just recent 10 messages)
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'in:inbox', // In a real app, we'd filter by date or unread
      maxResults: 15,
    });

    const messages = listRes.data.messages || [];
    const updates = []; // Array of { batch_id, lead_id, decision: 'Approved' | 'Declined' }

    for (const msg of messages) {
      const msgData = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });
      
      const payload = msgData.data.payload;
      const headers = payload.headers;
      const fromHeader = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      
      let bodyText = '';
      if (payload.parts) {
        // Look for text/plain in parts or sub-parts
        const getText = (parts) => {
          for (let p of parts) {
            if (p.mimeType === 'text/plain' && p.body && p.body.data) return p.body.data;
            if (p.parts) {
              const res = getText(p.parts);
              if (res) return res;
            }
          }
          return null;
        };
        const raw = getText(payload.parts);
        if (raw) bodyText = Buffer.from(raw, 'base64').toString('utf-8');
      } else if (payload.body && payload.body.data) {
        bodyText = Buffer.from(payload.body.data, 'base64').toString('utf-8');
      } else {
        bodyText = msgData.data.snippet; // Fallback to snippet
      }

      // Strip quoted text from replies
      let cleanBody = bodyText.split(/On .*?wrote:/i)[0]
                              .split(/-----Original Message-----/i)[0]
                              .split(/\r?\n>/)[0];
                              
      const lowerBody = cleanBody.toLowerCase();
      console.log(`\n--- Email from ${fromHeader} ---`);
      console.log(`Cleaned Body: "${lowerBody.trim()}"`);

      // Check against active batches
      for (const batch of activeBatches) {
        // Simple check: does the From address or Subject match the batch's seed?
        // Since the user might be testing with their own email, we will rely heavily on checking if the lead names are in the body.
        
        for (const lead of batch.leads_info) {
          const firstName = lead.full_name.split(' ')[0].toLowerCase();
          
          if (lowerBody.includes(firstName)) {
            // Find the index of the name to check surrounding context
            const index = lowerBody.indexOf(firstName);
            // Grab a window of text around the name (e.g. 60 chars before and after)
            const start = Math.max(0, index - 60);
            const end = Math.min(lowerBody.length, index + firstName.length + 60);
            const contextWindow = lowerBody.substring(start, end);
            
            const negativeWords = ['not', 'no', 'cannot', "can't", 'pass', 'don\'t', 'dont', 'busy'];
            const hasNegative = negativeWords.some(w => contextWindow.includes(w));
            
            updates.push({
              batch_id: batch.id,
              lead_id: lead.id,
              decision: hasNegative ? 'Declined' : 'Approved'
            });
          }
        }
      }
    }

    // Deduplicate updates (in case multiple emails mention the same person, just take the first finding for the demo)
    const uniqueUpdates = [];
    const seen = new Set();
    for (const u of updates) {
      const key = `${u.batch_id}-${u.lead_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueUpdates.push(u);
      }
    }

    res.json({ success: true, updates: uniqueUpdates });
  } catch (error) {
    console.error('Error scanning inbox:', error);
    res.status(500).json({ error: 'Failed to scan inbox' });
  }
});

// 5. API endpoint to send an email (for sending drafts with CC)
app.post('/api/send-email', async (req, res) => {
  if (!oauth2Client.credentials || !oauth2Client.credentials.access_token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { to, cc, subject, body } = req.body;

  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Construct raw email
    const messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
    ];

    if (cc) {
      messageParts.splice(1, 0, `Cc: ${cc}`); // Insert Cc right after To
    }

    const message = messageParts.join('\r\n') + '\r\n\r\n' + body;
    
    // The raw string must be base64-encoded
    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const resData = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    res.json({ success: true, messageId: resData.data.id });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// 6. API endpoint to create a draft
app.post('/api/create-draft', async (req, res) => {
  if (!oauth2Client.credentials || !oauth2Client.credentials.access_token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { to, cc, subject, body } = req.body;

  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Construct raw email
    const messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
    ];

    if (cc) {
      messageParts.splice(1, 0, `Cc: ${cc}`); // Insert Cc right after To
    }

    const message = messageParts.join('\r\n') + '\r\n\r\n' + body;
    
    // The raw string must be base64-encoded
    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const resData = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: encodedMessage,
        }
      },
    });

    res.json({ success: true, draftId: resData.data.id });
  } catch (error) {
    console.error('Error creating draft:', error);
    res.status(500).json({ error: 'Failed to create draft' });
  }
});

app.listen(PORT, () => {
  console.log(`Gmail Server running on http://localhost:${PORT}`);
  console.log(`Please go to http://localhost:${PORT}/parable-warm-intros-demo-v2.html to view the app`);
});
