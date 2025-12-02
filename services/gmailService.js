const { google } = require('googleapis');

async function getEmails(auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  
  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 50,
    labelIds: ['INBOX']
  });
  
  const messages = await Promise.all(
    response.data.messages?.map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });
      return parseEmail(detail.data);
    }) || []
  );
  
  return messages;
}

function parseEmail(data) {
  const headers = data.payload?.headers || [];
  return {
    id: data.id,
    from: headers.find(h => h.name === 'From')?.value || '',
    subject: headers.find(h => h.name === 'Subject')?.value || '',
    date: headers.find(h => h.name === 'Date')?.value || '',
    body: data.snippet || '',
    snippet: data.snippet,
    timestamp: new Date(headers.find(h => h.name === 'Date')?.value).getTime(),
    labels: data.labelIds || []
  };
}

async function markAsSpam(auth, messageId) {
  const gmail = google.gmail({ version: 'v1', auth });
  return await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: ['SPAM']
    }
  });
}

async function deleteEmail(auth, messageId) {
  const gmail = google.gmail({ version: 'v1', auth });
  return await gmail.users.messages.trash({
    userId: 'me',
    id: messageId
  });
}

module.exports = {
  getEmails,
  markAsSpam,
  deleteEmail
};
