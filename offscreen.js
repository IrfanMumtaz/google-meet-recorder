// Offscreen document: builds a meeting's audio file straight from IndexedDB
// and hands the background a blob: URL to download, so large recordings never
// pass through extension messages (which cap at 64 MiB).
//
// MP3 conversion decodes a few minutes at a time: decoding a long meeting in
// one go needs gigabytes of PCM. If conversion fails, the original WebM is
// returned instead.

const MP3_KBPS = 128;
const SAMPLE_RATE = 48000;
const SEGMENT_BYTES = 4 * 1024 * 1024; // ~4 min of 128 kbps Opus per decode
const MP3_INDEX = 999999;              // legacy: where older versions stored MP3

const ID_SEGMENT = 0x18538067;
const ID_CLUSTER = 0x1F43B675;

const objectUrls = new Set();

if (self.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'BUILD_AUDIO') {
      buildAudio(msg.meetingId)
        .then(sendResponse)
        .catch(err => {
          console.error('Audio build failed:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }

    if (msg.type === 'PING_OFFSCREEN') {
      sendResponse({ ready: true });
      return true;
    }
  });

  chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});
}

async function buildAudio(meetingId) {
  const chunks = (await MeetingDB.getChunks(meetingId)).filter(c => c.index !== MP3_INDEX);
  if (chunks.length === 0) return { success: true, url: null };

  const webm = new Blob(chunks.map(c => c.blob), { type: 'audio/webm' });
  let file = webm;
  let ext = 'webm';
  let error = null;
  try {
    // Progress messages also keep the background service worker awake.
    file = await webmToMp3(webm, progress =>
      chrome.runtime.sendMessage({ type: 'CONVERT_PROGRESS', meetingId, progress }).catch(() => {}));
    ext = 'mp3';
  } catch (e) {
    error = e.message;
    console.warn('MP3 conversion failed, keeping WebM:', e);
  }

  const url = URL.createObjectURL(file);
  objectUrls.add(url);
  return { success: true, url, ext, bytes: file.size, error };
}

// ── WebM → MP3 ─────────────────────────────────────────

async function webmToMp3(webm, onProgress = () => {}) {
  const bytes = new Uint8Array(await webm.arrayBuffer());
  const { headerEnd, clusters } = findClusters(bytes);
  const header = bytes.subarray(0, headerEnd);

  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const encoder = new lamejs.Mp3Encoder(1, SAMPLE_RATE, MP3_KBPS);
  const parts = [];

  for (let i = 0; i < clusters.length;) {
    let j = i + 1;
    while (j < clusters.length && clusters[j] - clusters[i] < SEGMENT_BYTES) j++;
    const start = clusters[i];
    const end = j < clusters.length ? clusters[j] : bytes.length;

    // Each segment is decoded as its own file: the stream header + clusters.
    const segment = new Uint8Array(header.length + end - start);
    segment.set(header);
    segment.set(bytes.subarray(start, end), header.length);
    const audio = await ctx.decodeAudioData(segment.buffer);

    encodePcm(encoder, toMonoInt16(audio), parts);
    onProgress(end / bytes.length);
    i = j;
  }

  const flush = encoder.flush();
  if (flush.length > 0) parts.push(new Uint8Array(flush));
  return new Blob(parts, { type: 'audio/mpeg' });
}

function toMonoInt16(audio) {
  const channels = [];
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
  const out = new Int16Array(audio.length);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    const s = Math.max(-1, Math.min(1, sum / channels.length));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

function encodePcm(encoder, samples, parts) {
  const blockSize = 1152;
  for (let i = 0; i < samples.length; i += blockSize) {
    const mp3buf = encoder.encodeBuffer(samples.subarray(i, i + blockSize));
    if (mp3buf.length > 0) parts.push(new Uint8Array(mp3buf));
  }
}

// ── Minimal EBML walk ──────────────────────────────────
// MediaRecorder writes a Segment and Clusters of unknown size, and splits its
// chunks at arbitrary bytes, so cluster boundaries have to be found by parsing.

function findClusters(b) {
  const clusters = [];
  let pos = 0;
  while (pos < b.length) {
    const id = readVint(b, pos, true);
    const size = id && readVint(b, pos + id.len, false);
    if (!size) break;
    const dataStart = pos + id.len + size.len;

    if (id.value === ID_CLUSTER) clusters.push(pos);
    // Step into the containers; skip every other element whole.
    pos = (id.value === ID_SEGMENT || id.value === ID_CLUSTER || size.unknown)
      ? dataStart
      : dataStart + size.value;
  }
  if (clusters.length === 0) throw new Error('no audio clusters found in recording');
  return { headerEnd: clusters[0], clusters };
}

function readVint(b, pos, isId) {
  if (pos >= b.length) return null;
  const first = b[pos];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || pos + len > b.length) return null;

  let value = isId ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let k = 1; k < len; k++) {
    value = value * 256 + b[pos + k];
    if (b[pos + k] !== 0xFF) allOnes = false;
  }
  return { value, len, unknown: !isId && allOnes };
}
