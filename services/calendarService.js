const { google } = require('googleapis');

async function getCalendarEvents(auth) {
  const calendar = google.calendar({ version: 'v3', auth });
  
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  
  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: weekFromNow.toISOString(),
    maxResults: 50,
    singleEvents: true,
    orderBy: 'startTime'
  });
  
  return response.data.items || [];
}

async function createCalendarEvent(auth, event) {
  const calendar = google.calendar({ version: 'v3', auth });
  
  return await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event
  });
}

async function updateCalendarEvent(auth, eventId, event) {
  const calendar = google.calendar({ version: 'v3', auth });
  
  return await calendar.events.update({
    calendarId: 'primary',
    eventId: eventId,
    requestBody: event
  });
}

async function deleteCalendarEvent(auth, eventId) {
  const calendar = google.calendar({ version: 'v3', auth });
  
  return await calendar.events.delete({
    calendarId: 'primary',
    eventId: eventId
  });
}

module.exports = {
  getCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent
};
