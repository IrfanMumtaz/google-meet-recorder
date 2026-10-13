# MeetingAI Notes

A Chrome extension that records Google Meet calls and saves the audio along with a transcript that shows who said what.

When you join a Meet call, the extension starts recording on its own. When you leave, it saves these files to your Downloads folder:

- **an MP3** of the whole call, with your microphone and everyone else mixed together
- **a transcript** (`.txt` and `.json`) built from Meet's live captions, with a speaker name and timestamp on every line

Everything runs inside your browser. Nothing is uploaded to a server.

> **Get consent first.** Other people in the call are **not** told that you are recording. In many places it is against the law to record a conversation without everyone's consent. Tell the other participants before you record, and use the popup's **Don't record** button for any call you shouldn't record.

---

## Installation

The extension isn't on the Chrome Web Store. You load it from this folder instead:

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome. This also works in Edge, Brave and other Chromium browsers.
3. Turn on **Developer mode** (the switch in the top-right corner).
4. Click **Load unpacked** and select this project's folder (the one that contains `manifest.json`).
5. Pin **MeetingAI Notes** to the toolbar: click the puzzle-piece icon, then the pin next to the extension.

If a Meet tab was already open when you installed the extension, **reload that tab** so the recorder can attach to it.

### Updating

After you pull new code, open `chrome://extensions`, click the reload icon ↻ on the MeetingAI Notes card, and then reload any open Meet tabs.

---

## Usage guide

### 1. Join a meeting

Open any meeting link (`https://meet.google.com/abc-defg-hij`) and join it as usual. The extension:

- detects the meeting and shows a blue **GO** badge on its icon
- starts recording once meeting audio is flowing, and the badge changes to a red **REC**
- turns on Meet's captions (**CC**) if they're off, because the transcript is built from them

You don't need to click anything.

### 2. Check status in the popup

Click the extension icon to see what it is doing in the current tab:

| Popup shows | Meaning | Actions |
|---|---|---|
| *No active meeting* | No Meet call in this tab | — |
| *Meeting detected — waiting for audio* | You're in a call, but recording hasn't started yet | **Don't record**: skip this meeting |
| *Recording* + timer | Audio and captions are being captured | **Stop & save**: end and download now<br>**Discard**: click twice to delete the recording |
| *Not recording this meeting* | You stopped or skipped this meeting | **Record**: start a new recording |
| *Saving files...* | The files are being built and downloaded | — |

### 3. Leave the meeting

Hang up, close the tab, or navigate away. The extension waits a couple of seconds for the last audio, converts it to MP3, and downloads the files. A long meeting may take a little while to convert.

### Stopping, skipping and resuming

- **Stop & save** downloads what has been recorded so far. You stay in the call.
- **Discard** (click it twice to confirm) deletes the recording. Nothing is downloaded.
- After you stop or skip a meeting, the extension **won't record it again for 6 hours**, even if you reload or rejoin. Restarting the browser also clears this. The badge shows a grey **OFF**.
- **Record** starts a **new** recording in the same call. It is saved as a separate set of files.

### Badge reference

| Badge | Meaning |
|---|---|
| `GO` (blue) | Meeting detected, ready to record |
| `REC` (red) | Recording |
| `OFF` (grey) | You stopped or skipped recording for this meeting |

---

## Output files

Files are saved to `Downloads/<folder>/`. By default the folder is `MeetingNotes`, and you can change it in the popup under **Settings → Download folder name**.

Every file name starts with the meeting's date, start time and title:

```
Downloads/MeetingNotes/
├── 2026-10-13_14-30_Weekly-Sync.mp3
├── 2026-10-13_14-30_Weekly-Sync_transcript.txt
└── 2026-10-13_14-30_Weekly-Sync_transcript.json
```

### Audio

Mono MP3 at 128 kbps. If the MP3 conversion fails, the original recording is saved as `.webm` instead. VLC and most browsers can play it.

### Transcript (`.txt`)

```
Meeting: Weekly Sync
Date: October 13, 2026 at 02:30 PM
Duration: 32m 10s
Participants: Alice Chen, Bob Rivera

---

[00:00:04] Alice Chen: Morning everyone, let's get started.
[00:00:09] Bob Rivera: Sounds good. I'll go first.
```

### Transcript (`.json`)

```json
{
  "meeting": "Weekly Sync",
  "meetingCode": "abc-defg-hij",
  "date": "2026-10-13T14:30:00.000Z",
  "duration": "32m 10s",
  "participants": ["Alice Chen", "Bob Rivera"],
  "transcript": [
    { "time": "00:00:04", "timeMs": 4000, "speaker": "Alice Chen", "text": "Morning everyone, let's get started." }
  ]
}
```

Timestamps count from when the recording started. A transcript is only saved if at least one caption was captured.

### Recovered recordings

Recordings are saved to the browser's local storage every 10 seconds while the call runs. If Chrome crashes or closes mid-meeting, the extension finishes saving the files the next time Chrome starts. These files have `(recovered)` in the name.

---

## Troubleshooting

**Nothing is recorded / the badge never shows REC**
- Reload the Meet tab. The recorder has to load before Meet starts its call, so a tab that was opened before the extension was installed or reloaded won't be captured.
- Check that the URL looks like `meet.google.com/xxx-xxxx-xxx`. The lobby and home pages aren't recorded.
- Open the popup. If it says *Not recording this meeting*, click **Record**.

**The audio is there but the transcript is missing or empty**
- The transcript comes from Meet's captions. Make sure **CC** is on in the Meet toolbar. The extension tries to turn it on, but you can do it yourself.
- Set the caption language in Meet (**CC** settings) to the language being spoken.
- If Google changes Meet's page layout, caption scraping may stop working. Open DevTools on the Meet tab and look for `[MeetingAI]` lines in the console.

**Speaker names are wrong or show "Unknown"**
Names come from what Meet shows in its captions. When you're signed out or joined as a guest, Meet may not show names.

**Files didn't download**
- Check `chrome://downloads`. If Chrome asks where to save each file (a Chrome download setting), the dialogs may be waiting for you.
- Long meetings take time to convert. Wait for *Saving files...* to finish before you quit Chrome.

**Debugging**
- Meet page logs: DevTools on the Meet tab, filter by `[MeetingAI]`.
- Background logs: `chrome://extensions` → MeetingAI Notes → **Inspect views: service worker**.

---

## How it works

```
Meet tab                                   Extension
┌─────────────────────────────┐            ┌──────────────────────────────┐
│ audio-capture.js (MAIN)     │            │ background.js (service worker)│
│  hooks RTCPeerConnection &  │  10 s      │  tracks sessions per tab      │
│  getUserMedia, mixes all    │  chunks    │  stores chunks & captions in  │
│  audio, MediaRecorder→WebM  ├──────┐     │  IndexedDB (db.js)            │
├─────────────────────────────┤      │     │  saves files on leave/stop    │
│ content.js (ISOLATED)       │      └────►│  recovers unsaved sessions    │
│  detects join/leave, turns  ├───────────►│                               │
│  on CC, scrapes captions,   │ captions   └───────────────┬──────────────┘
│  relays audio chunks        │                            │ BUILD_AUDIO
└─────────────────────────────┘            ┌───────────────▼──────────────┐
                                           │ offscreen.js                  │
                                           │  WebM → MP3 (lamejs), a few   │
                                           │  minutes at a time            │
                                           └──────────────────────────────┘
```

### Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `audio-capture.js` | Runs in the page. Taps into WebRTC and the mic, mixes the audio and records it in 10-second WebM chunks |
| `content.js` | Detects joining and leaving, turns on captions, scrapes caption blocks by speaker, tracks participants, relays data to the background |
| `background.js` | Service worker. Manages sessions, IndexedDB storage, stop/skip/resume, downloads and crash recovery |
| `offscreen.html`, `offscreen.js` | Offscreen document that converts the recording to MP3 and serves it for download |
| `db.js` | IndexedDB helpers (`sessions`, `chunks`, `transcript` stores) |
| `utils.js` | File naming and transcript formatting (TXT / JSON) |
| `popup.html`, `popup.css`, `popup.js` | Toolbar popup: status, controls, settings |
| `lamejs.min.js` | Third-party MP3 encoder ([lamejs](https://github.com/zhuker/lamejs), LGPL) |
| `icons/` | Extension icons |

### Permissions

| Permission | Why |
|---|---|
| `https://meet.google.com/*` | Run the recorder and caption scraper on Meet pages |
| `offscreen` | Convert audio to MP3 outside the service worker |
| `storage` | Save your settings and the list of skipped meetings |
| `downloads` | Save the audio and transcript files |
| `tabs`, `activeTab`, `scripting` | Track Meet tabs, show the badge, and re-attach to open tabs after an update |

---

## Limitations

- Works only with Google Meet in the browser, not the mobile apps.
- The transcript is only as good as Meet's live captions, and it depends on Meet's page structure, which Google can change without notice.
- The audio is a single mixed track. Speakers are labeled in the transcript, not in the audio.
- Recordings are kept in the browser until they're downloaded, so very long meetings need enough free disk space.
