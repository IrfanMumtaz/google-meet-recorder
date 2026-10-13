function formatFilename(title, startTime) {
  const d = new Date(startTime);
  const date = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
  const time = [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0')
  ].join('-');

  let cleanTitle = (title || 'Untitled-Meeting')
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);

  if (!cleanTitle) cleanTitle = 'Untitled-Meeting';

  return `${date}_${time}_${cleanTitle}`;
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTimestamp(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [
    String(h).padStart(2, '0'),
    String(m).padStart(2, '0'),
    String(s).padStart(2, '0')
  ].join(':');
}

function byTime(entries) {
  return [...entries].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function formatTranscriptTxt(session, entries) {
  entries = byTime(entries);
  const d = new Date(session.startTime);
  const dateStr = d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const duration = session.endTime
    ? formatDuration(session.endTime - session.startTime)
    : 'Unknown';
  const participants = [...new Set(entries.map(e => e.speaker))].filter(Boolean);

  let text = `Meeting: ${session.title || 'Untitled Meeting'}\n`;
  text += `Date: ${dateStr}\n`;
  text += `Duration: ${duration}\n`;
  if (participants.length) {
    text += `Participants: ${participants.join(', ')}\n`;
  }
  text += '\n---\n\n';

  for (const entry of entries) {
    const ts = formatTimestamp(entry.timestamp || 0);
    text += `[${ts}] ${entry.speaker || 'Unknown'}: ${entry.text}\n`;
  }

  return text;
}

function formatTranscriptJson(session, entries) {
  entries = byTime(entries);
  const duration = session.endTime
    ? formatDuration(session.endTime - session.startTime)
    : 'Unknown';
  const participants = [...new Set(entries.map(e => e.speaker))].filter(Boolean);

  return JSON.stringify({
    meeting: session.title || 'Untitled Meeting',
    meetingCode: session.meetingCode || '',
    date: new Date(session.startTime).toISOString(),
    duration,
    participants,
    transcript: entries.map(e => ({
      time: formatTimestamp(e.timestamp || 0),
      timeMs: e.timestamp || 0,
      speaker: e.speaker || 'Unknown',
      text: e.text
    }))
  }, null, 2);
}

if (typeof self !== 'undefined' && typeof module === 'undefined') {
  self.MeetingUtils = {
    formatFilename, formatDuration, formatTimestamp,
    formatTranscriptTxt, formatTranscriptJson
  };
}
