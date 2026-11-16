// ==UserScript==
// @name         fakecrime – Music Import
// @namespace    fakecrime-music-import
// @version      1.0.0
// @author       eierman
// @license      MIT
// @homepageURL  https://github.com/e1erman/fakecrime-music-import
// @supportURL   https://github.com/e1erman/fakecrime-music-import/issues
// @downloadURL  https://github.com/e1erman/fakecrime-music-import/releases/latest/download/fakecrime-music-import.user.js
// @updateURL    https://github.com/e1erman/fakecrime-music-import/releases/latest/download/fakecrime-music-import.user.js
// @description  Unofficial helper for fakecrime.bio: add songs to your bio music player from a SoundCloud/YouTube link or search. Fills audio, cover, name ("Title - Artist") and URL, and adds image/audio search to the upload fields.
// @match        https://fakecrime.bio/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @connect      soundcloud.com
// @connect      sndcdn.com
// @connect      soundcloud.cloud
// @connect      youtube.com
// @connect      googlevideo.com
// @connect      ytimg.com
// @connect      google.com
// @connect      gstatic.com
// @connect      bing.com
// @connect      apple.com
// @connect      mzstatic.com
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Config
   * ------------------------------------------------------------------ */
  const SC_API = 'https://api-v2.soundcloud.com';
  const NAME_MAX = 100; // fakecrime "Name" limit
  const URL_MAX = 250; // fakecrime "URL" limit
  const AUDIO_MAX_BYTES = 100 * 1024 * 1024;
  const COVER_MAX_BYTES = 15 * 1024 * 1024;
  const BACKGROUND_MAX_BYTES = 100 * 1024 * 1024;
  const SEGMENT_CONCURRENCY = 6;
  const LOG = (...a) => console.log('[fakecrime-music-import]', ...a);

  /* ------------------------------------------------------------------ *
   * HTTP helpers (GM_xmlhttpRequest bypasses CORS)
   * ------------------------------------------------------------------ */
  function request(url, opts = {}) {
    const { responseType = 'text', method = 'GET', headers, data, anonymous = true, timeout = 60000 } = opts;
    const short = url.split('?')[0];
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        responseType,
        anonymous,
        timeout,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) resolve(r);
          else reject(Object.assign(new Error(`HTTP ${r.status} for ${short}`), { status: r.status }));
        },
        onerror: () => reject(new Error(`Network error for ${short}`)),
        ontimeout: () => reject(new Error(`Timeout for ${short}`)),
      });
    });
  }
  const getText = async (url, o) => (await request(url, { ...o, responseType: 'text' })).responseText;
  const getJSON = async (url, o) => JSON.parse(await getText(url, o));
  const getBuffer = async (url, o) => (await request(url, { ...o, responseType: 'arraybuffer' })).response;
  const postJSON = async (url, body, headers = {}) =>
    JSON.parse(await getText(url, { method: 'POST', data: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } }));

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fmtDuration = (ms) => {
    const s = Math.round((ms || 0) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };
  const parseDuration = (str) =>
    (str || '')
      .split(':')
      .map(Number)
      .reduce((a, n) => a * 60 + (n || 0), 0) * 1000;
  const safeFileName = (s) => s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'track';
  const songName = (title, artist) => {
    title = (title || '').trim();
    artist = (artist || '').trim();
    if (!artist) return title.slice(0, NAME_MAX);
    title = title.replace(new RegExp(`^${escRe(artist)}\\s*[-–—]\\s*`, 'i'), '').trim();
    if (new RegExp(`[-–—]\\s*${escRe(artist)}$`, 'i').test(title)) return title.slice(0, NAME_MAX);
    return `${title} - ${artist}`.slice(0, NAME_MAX);
  };

  /* ------------------------------------------------------------------ *
   * SoundCloud
   * ------------------------------------------------------------------ */
  let scClientIdPromise = null;

  async function scScrapeClientId() {
    const html = await getText('https://soundcloud.com/');
    const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/[^"]+\.js)"/g)].map((m) => m[1]);
    for (const src of scripts.reverse()) {
      try {
        const js = await getText(src);
        const m = js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
        if (m) return m[1];
      } catch (e) {
        /* try next bundle */
      }
    }
    throw new Error('Could not find a SoundCloud client_id.');
  }

  function scClientId(force = false) {
    if (!force) {
      const cached = GM_getValue('clientId', null);
      if (cached) return Promise.resolve(cached);
    }
    if (!scClientIdPromise || force) {
      scClientIdPromise = scScrapeClientId()
        .then((id) => {
          GM_setValue('clientId', id);
          return id;
        })
        .finally(() => {
          scClientIdPromise = null;
        });
    }
    return scClientIdPromise;
  }

  async function scApi(pathOrUrl, params = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cid = await scClientId(attempt > 0);
      const u = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : SC_API + pathOrUrl);
      for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
      u.searchParams.set('client_id', cid);
      try {
        return await getJSON(u.toString());
      } catch (e) {
        if (attempt === 0 && (e.status === 401 || e.status === 403)) {
          LOG('client_id rejected, refreshing…');
          continue;
        }
        throw e;
      }
    }
  }

  const isScUrl = (s) => /^(https?:\/\/)?([a-z0-9-]+\.)?(soundcloud\.com|snd\.sc)\//i.test(s.trim());

  async function scResolveUrl(url) {
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    url = url.replace('://m.soundcloud.com', '://soundcloud.com');
    if (/on\.soundcloud\.com|snd\.sc/i.test(url)) {
      const r = await request(url);
      url = r.finalUrl || url;
    }
    return scApi('/resolve', { url: url.split('?')[0] });
  }

  async function scFullTrack(track) {
    if (track.media && track.media.transcodings && track.media.transcodings.length && track.track_authorization) return track;
    return scApi(`/tracks/${track.id}`);
  }

  const scArtist = (t) => (t.publisher_metadata && t.publisher_metadata.artist) || (t.user && t.user.username) || '';
  const scArtwork = (art, size = 't500x500') =>
    art ? art.replace(/-(large|original|t\d+x\d+|crop|small|tiny|badge|mini)(?=\.\w+$)/, '-' + size) : null;

  function scItem(t) {
    const artist = scArtist(t);
    return {
      source: 'sc',
      id: t.id,
      title: t.title || '',
      artist,
      name: songName(t.title, artist),
      durationMs: t.full_duration || t.duration,
      thumb: t.artwork_url || (t.user && t.user.avatar_url) || null,
      pageUrl: t.permalink_url,
      previewOnly: !scPickTranscodings(t).some((x) => !x.snipped),
      raw: t,
    };
  }

  async function scSearchTracks(q) {
    const res = await scApi('/search/tracks', { q, limit: 15 });
    return (res.collection || []).filter((t) => t.kind === 'track');
  }

  /** Rank transcodings: progressive MP3 > HLS MP3 > HLS AAC (fMP4) > HLS Opus. Encrypted ones are skipped. */
  function scPickTranscodings(track) {
    const list = (track.media && track.media.transcodings) || [];
    const score = (t) => {
      const p = t.format.protocol;
      const mime = t.format.mime_type || '';
      if (p !== 'progressive' && p !== 'hls') return -1;
      let s;
      if (mime.includes('mpeg')) s = p === 'progressive' ? 100 : 90;
      else if (mime.includes('mp4')) s = 70;
      else if (mime.includes('ogg') || mime.includes('opus')) s = 50;
      else return -1;
      if (t.snipped) s -= 60;
      return s;
    };
    return list
      .map((t) => ({ t, s: score(t) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.t);
  }

  async function downloadHls(playlistUrl, onProgress) {
    const m3u8 = await getText(playlistUrl);
    const lines = m3u8.split(/\r?\n/).map((l) => l.trim());
    if (lines.some((l) => /^#EXT-X-KEY:.*METHOD=(?!NONE)/i.test(l))) throw new Error('Stream is encrypted.');
    const urls = [];
    for (const l of lines) {
      const map = l.match(/^#EXT-X-MAP:.*URI="([^"]+)"/i);
      if (map) urls.push(new URL(map[1], playlistUrl).toString());
      else if (l && !l.startsWith('#')) urls.push(new URL(l, playlistUrl).toString());
    }
    if (!urls.length) throw new Error('Empty HLS playlist.');
    let done = 0;
    return mapLimit(urls, SEGMENT_CONCURRENCY, async (u) => {
      const buf = await getBuffer(u);
      onProgress && onProgress(++done / urls.length);
      return buf;
    });
  }

  async function scDownloadAudio(track, onProgress) {
    track = await scFullTrack(track);
    const candidates = scPickTranscodings(track);
    if (!candidates.length) throw new Error('No downloadable stream (track may be Go+ only / encrypted).');
    let lastErr;
    for (const tc of candidates) {
      try {
        const { url } = await scApi(tc.url, { track_authorization: track.track_authorization });
        const mime = tc.format.mime_type || '';
        let parts;
        if (tc.format.protocol === 'progressive') {
          onProgress && onProgress(0.05);
          parts = [await getBuffer(url)];
          onProgress && onProgress(1);
        } else {
          parts = await downloadHls(url, onProgress);
        }
        let ext = 'mp3';
        if (mime.includes('mp4')) ext = 'mp4';
        else if (mime.includes('ogg') || mime.includes('opus')) ext = 'ogg';
        return { blob: new Blob(parts), ext, snipped: !!tc.snipped };
      } catch (e) {
        LOG('SoundCloud transcoding failed, trying next', tc.format, e);
        lastErr = e;
      }
    }
    throw lastErr || new Error('Download failed.');
  }

  /* ------------------------------------------------------------------ *
   * YouTube
   * ------------------------------------------------------------------ */
  const YT_WEB = { clientName: 'WEB', clientVersion: '2.20250312.04.00', hl: 'en', gl: 'US' };
  // Clients that usually return direct (unciphered) stream URLs. Tried in order.
  const YT_PLAYER_CLIENTS = [
    {
      id: 28,
      ua: 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      client: { clientName: 'ANDROID_VR', clientVersion: '1.62.27', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' },
    },
    {
      id: 5,
      ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
      client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
    },
    {
      id: 3,
      ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
      client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, osName: 'Android', osVersion: '14' },
    },
  ];

  function ytVideoId(s) {
    s = s.trim();
    if (!/^(https?:\/\/)?([a-z0-9-]+\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(s)) return null;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      if (/youtu\.be$/i.test(u.hostname)) return u.pathname.slice(1, 12) || null;
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }
  const isYtUrl = (s) => !!ytVideoId(s);

  function cleanYtTitle(t) {
    return (t || '')
      .replace(
        /\s*[([](?:official\s*)?(?:music\s*)?(?:video|audio|visuali[sz]er|lyrics?(?:\s*video)?|hd|hq|4k|m\/?v|video\s*clip|clip\s*officiel)[)\]]/gi,
        ''
      )
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** YouTube titles are usually "Artist - Title"; otherwise fall back to the channel name. */
  function ytArtistTitle(title, channel) {
    const t = cleanYtTitle(title);
    const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) return { artist: m[1].trim(), title: m[2].trim() };
    const artist = (channel || '')
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/VEVO$/i, '')
      .replace(/\s*official$/i, '')
      .trim();
    return { artist, title: t };
  }

  function ytItem({ id, title, channel, durationMs }) {
    const at = ytArtistTitle(title, channel);
    return {
      source: 'yt',
      id,
      title,
      artist: at.artist,
      name: songName(at.title, at.artist),
      durationMs,
      thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      pageUrl: `https://www.youtube.com/watch?v=${id}`,
      previewOnly: false,
    };
  }

  function collect(obj, key, out = []) {
    if (!obj || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) {
      for (const x of obj) collect(x, key, out);
      return out;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === key) out.push(v);
      else collect(v, key, out);
    }
    return out;
  }
  const ytText = (t) => (t ? t.simpleText || (t.runs || []).map((r) => r.text).join('') : '');

  async function ytSearch(q) {
    const res = await postJSON('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      context: { client: YT_WEB },
      query: q,
      params: 'EgIQAQ==', // videos only
    });
    return collect(res, 'videoRenderer')
      .filter((v) => v.videoId)
      .slice(0, 15)
      .map((v) =>
        ytItem({
          id: v.videoId,
          title: ytText(v.title),
          channel: ytText(v.ownerText || v.longBylineText),
          durationMs: parseDuration(ytText(v.lengthText)),
        })
      );
  }

  const ytPlayerCache = new Map();
  async function ytPlayer(id) {
    if (ytPlayerCache.has(id)) return ytPlayerCache.get(id);
    let lastErr;
    for (const c of YT_PLAYER_CLIENTS) {
      try {
        const res = await postJSON(
          'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
          { context: { client: { hl: 'en', gl: 'US', ...c.client } }, videoId: id, contentCheckOk: true, racyCheckOk: true },
          { 'User-Agent': c.ua, 'X-YouTube-Client-Name': String(c.id), 'X-YouTube-Client-Version': c.client.clientVersion }
        );
        const status = res.playabilityStatus && res.playabilityStatus.status;
        if (status !== 'OK') throw new Error(`YouTube: ${(res.playabilityStatus && res.playabilityStatus.reason) || status || 'unplayable'}`);
        const formats = [...((res.streamingData && res.streamingData.adaptiveFormats) || []), ...((res.streamingData && res.streamingData.formats) || [])];
        if (!formats.some((f) => f.url)) throw new Error('YouTube returned no direct stream URLs.');
        const out = { res, client: c };
        ytPlayerCache.set(id, out);
        return out;
      } catch (e) {
        LOG(`YouTube client ${c.client.clientName} failed`, e);
        lastErr = e;
      }
    }
    throw lastErr || new Error('YouTube player request failed.');
  }

  async function ytResolveUrl(url) {
    const id = ytVideoId(url);
    if (!id) throw new Error('Not a YouTube video link.');
    const { res } = await ytPlayer(id);
    const d = res.videoDetails || {};
    return ytItem({ id, title: d.title || id, channel: d.author || '', durationMs: (+d.lengthSeconds || 0) * 1000 });
  }

  async function ytDownloadFormat(f, ua, onProgress) {
    const total = +f.contentLength || 0;
    const headers = { 'User-Agent': ua };
    if (!total) {
      onProgress && onProgress(0.05);
      const buf = await getBuffer(f.url, { headers, timeout: 300000 });
      onProgress && onProgress(1);
      return [buf];
    }
    // Download in chunks via the "range" query param — whole-file requests get throttled.
    const CHUNK = 9 * 1024 * 1024;
    const ranges = [];
    for (let start = 0; start < total; start += CHUNK) ranges.push([start, Math.min(start + CHUNK, total) - 1]);
    let done = 0;
    return mapLimit(ranges, 3, async ([a, b]) => {
      const buf = await getBuffer(`${f.url}&range=${a}-${b}`, { headers, timeout: 120000 });
      done += b - a + 1;
      onProgress && onProgress(done / total);
      return buf;
    });
  }

  async function ytDownloadAudio(id, onProgress) {
    let lastErr;
    // Retry with every client: stream URLs from one client can 403 while another works.
    for (let i = 0; i < YT_PLAYER_CLIENTS.length; i++) {
      let player;
      try {
        player = await ytPlayer(id);
      } catch (e) {
        throw e;
      }
      const { res, client } = player;
      const sd = res.streamingData || {};
      const audioMp4 = (sd.adaptiveFormats || [])
        .filter((f) => f.url && /^audio\/mp4/.test(f.mimeType))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      // Fallback: muxed MP4 (video + audio) — fakecrime accepts MP4 audio files.
      const muxed = (sd.formats || []).filter((f) => f.url && /^video\/mp4/.test(f.mimeType)).sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
      const candidates = [...audioMp4.slice(0, 1), ...muxed.slice(0, 1)];
      if (!candidates.length) lastErr = new Error('No MP4 audio stream available for this video.');
      for (const f of candidates) {
        try {
          const parts = await ytDownloadFormat(f, client.ua, onProgress);
          return { blob: new Blob(parts), ext: 'mp4', snipped: false };
        } catch (e) {
          LOG(`YouTube download via ${client.client.clientName} itag ${f.itag} failed`, e);
          lastErr = e;
        }
      }
      // Drop this client and try the next one.
      ytPlayerCache.delete(id);
      const idx = YT_PLAYER_CLIENTS.indexOf(client);
      if (idx >= 0) YT_PLAYER_CLIENTS.push(...YT_PLAYER_CLIENTS.splice(idx, 1));
    }
    throw lastErr || new Error('YouTube download failed.');
  }

  const ytThumbUrls = (id) => ['maxresdefault', 'sddefault', 'hqdefault'].map((s) => `https://i.ytimg.com/vi/${id}/${s}.jpg`);

  /* ------------------------------------------------------------------ *
   * Images
   * ------------------------------------------------------------------ */
  function sniffImageType(buf) {
    const b = new Uint8Array(buf.slice(0, 12));
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
    return '';
  }
  const extOf = (type) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[type] || 'jpg';

  async function fetchFirstImage(urls) {
    let lastErr;
    for (const u of urls.filter(Boolean)) {
      try {
        const buf = await getBuffer(u, { anonymous: true });
        if (buf && buf.byteLength > 1000) return buf;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Could not download the image.');
  }

  /** Find black letterbox bars (e.g. 4:3 YouTube thumbnails of 16:9 videos). */
  function detectBars(bmp) {
    const w = 64;
    const h = Math.max(1, Math.round((w * bmp.height) / bmp.width));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const dark = (y) => {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (Math.max(data[i], data[i + 1], data[i + 2]) > 28) return false;
      }
      return true;
    };
    let top = 0;
    while (top < h && dark(top)) top++;
    let bottom = 0;
    while (bottom < h - top && dark(h - 1 - bottom)) bottom++;
    if (top + bottom > h * 0.6) return { sx: 0, sy: 0, sw: bmp.width, sh: bmp.height };
    const k = bmp.height / h;
    const sy = Math.round(top * k);
    return { sx: 0, sy, sw: bmp.width, sh: bmp.height - sy - Math.round(bottom * k) };
  }

  /**
   * Make an image fit an upload field: square-crop for covers, convert unknown
   * formats to JPEG and downscale if it's too big. GIFs are kept as they are.
   */
  async function prepareImage(buf, { square = false, maxBytes = COVER_MAX_BYTES, trimBars = false } = {}) {
    const type = sniffImageType(buf);
    if (type === 'image/gif' && buf.byteLength <= maxBytes) return { blob: new Blob([buf], { type }), ext: 'gif', type };
    if (!square && type && buf.byteLength <= maxBytes) return { blob: new Blob([buf], { type }), ext: extOf(type), type };

    const bmp = await createImageBitmap(new Blob([buf], { type: type || 'image/jpeg' }));
    let { sx, sy, sw, sh } = trimBars ? detectBars(bmp) : { sx: 0, sy: 0, sw: bmp.width, sh: bmp.height };
    if (square) {
      const side = Math.min(sw, sh);
      sx += (sw - side) / 2;
      sy += (sh - side) / 2;
      sw = sh = side;
    }
    let maxSide = square ? 1200 : 2560;
    for (;;) {
      const scale = Math.min(1, maxSide / Math.max(sw, sh));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(sw * scale));
      c.height = Math.max(1, Math.round(sh * scale));
      c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      if (blob.size <= maxBytes || maxSide < 300) return { blob, ext: 'jpg', type: 'image/jpeg' };
      maxSide = Math.round(maxSide * 0.7);
    }
  }

  // --- image search providers -------------------------------------------------
  const decodeJsStr = (s) => {
    try {
      return JSON.parse(`"${s}"`);
    } catch (e) {
      return s;
    }
  };

  async function googleImages(q) {
    const html = await getText(`https://www.google.com/search?q=${encodeURIComponent(q)}&udm=2&hl=en`, { anonymous: false });
    const out = [];
    const seen = new Set();
    const pair = /\["(https:\/\/encrypted-tbn\d\.gstatic\.com\/images\?[^"]+)",\d+,\d+\],\["(https?:\/\/[^"]+)",(\d+),(\d+)\]/g;
    for (const m of html.matchAll(pair)) {
      const full = decodeJsStr(m[2]);
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({ thumb: decodeJsStr(m[1]), full, w: +m[4], h: +m[3], label: hostOf(full) });
    }
    if (!out.length) {
      for (const m of html.matchAll(/\["(https?:\/\/(?!encrypted-tbn)[^"]+?)",(\d+),(\d+)\]/g)) {
        const full = decodeJsStr(m[1]);
        if (seen.has(full) || /gstatic\.com|google\.com/.test(full) || +m[2] < 150) continue;
        seen.add(full);
        out.push({ thumb: full, full, w: +m[3], h: +m[2], label: hostOf(full) });
      }
    }
    return out.slice(0, 40);
  }

  async function bingImages(q) {
    const html = await getText(`https://www.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2&first=1`, { anonymous: false });
    const out = [];
    for (const m of html.matchAll(/\sm="(\{[^"]+\})"/g)) {
      try {
        const j = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        if (j.murl) out.push({ thumb: j.turl || j.murl, full: j.murl, label: hostOf(j.murl) });
      } catch (e) {
        /* skip */
      }
    }
    return out.slice(0, 40);
  }

  function hostOf(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  async function webImages(q) {
    try {
      const g = await googleImages(q);
      if (g.length) return { items: g };
    } catch (e) {
      LOG('Google image search failed', e);
    }
    const b = await bingImages(q);
    return { items: b, note: 'Google returned nothing (consent page or captcha?) — showing Bing results.' };
  }

  async function scImages(q) {
    const [tracks, albums] = await Promise.all([
      scApi('/search/tracks', { q, limit: 20 }).catch(() => ({ collection: [] })),
      scApi('/search/albums', { q, limit: 12 }).catch(() => scApi('/search/playlists', { q, limit: 12 }).catch(() => ({ collection: [] }))),
    ]);
    const mk = (x, kind) =>
      x.artwork_url ? { thumb: scArtwork(x.artwork_url, 't300x300'), full: scArtwork(x.artwork_url, 'original'), alt: scArtwork(x.artwork_url, 't500x500'), label: `${kind} · ${x.title}` } : null;
    return [...(albums.collection || []).map((x) => mk(x, 'Album')), ...(tracks.collection || []).map((x) => mk(x, 'Track'))].filter(Boolean);
  }

  async function appleImages(q) {
    const res = await getJSON(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&limit=30`);
    return (res.results || [])
      .filter((r) => r.artworkUrl100)
      .map((r) => ({
        thumb: r.artworkUrl100.replace('100x100bb', '300x300bb'),
        full: r.artworkUrl100.replace('100x100bb', '1200x1200bb'),
        alt: r.artworkUrl100.replace('100x100bb', '600x600bb'),
        label: `${r.collectionName} · ${r.artistName}`,
      }));
  }

  async function ytImages(q) {
    const items = await ytSearch(q);
    return items.map((it) => ({ thumb: it.thumb, full: ytThumbUrls(it.id)[0], fallbacks: ytThumbUrls(it.id), label: it.title, trimBars: true }));
  }

  /* ------------------------------------------------------------------ *
   * Song sources (shared by the full import and the audio search)
   * ------------------------------------------------------------------ */
  const SONG_TABS = [
    { id: 'sc', label: 'SoundCloud' },
    { id: 'yt', label: 'YouTube' },
  ];

  async function songSearch(tab, q) {
    if (tab === 'yt') return ytSearch(q);
    return (await scSearchTracks(q)).map(scItem);
  }

  async function songFromLink(q) {
    if (isYtUrl(q)) return ytResolveUrl(q);
    if (isScUrl(q)) {
      const res = await scResolveUrl(q);
      if (!res || res.kind !== 'track') throw new Error('That link is not a single SoundCloud track.');
      return scItem(res);
    }
    return null;
  }

  /**
   * SoundCloud "preview only" tracks (Go+) only give a 30s clip. Find the full
   * song on YouTube instead: closest duration match among the top results.
   */
  async function ytMatchFor(item) {
    const results = await ytSearch(`${item.artist} ${item.title}`);
    if (!results.length) return null;
    const target = item.durationMs || 0;
    const scored = results.slice(0, 8).map((r, i) => ({ r, diff: target && r.durationMs ? Math.abs(r.durationMs - target) : Infinity, i }));
    const close = scored.filter((x) => x.diff <= 15000).sort((a, b) => a.diff - b.diff || a.i - b.i);
    return (close[0] || scored[0]).r;
  }

  async function songAudio(item, onProgress, onStatus) {
    let a = null;
    if (item.source === 'sc' && item.previewOnly) {
      try {
        onStatus && onStatus(`"${item.name}" is preview-only on SoundCloud — looking for the full song on YouTube…`);
        const match = await ytMatchFor(item);
        if (match) {
          LOG('preview-only SoundCloud track, using YouTube match', match.pageUrl);
          onStatus && onStatus(`Downloading full audio from YouTube ("${match.title}")…`);
          a = { ...(await ytDownloadAudio(match.id, onProgress)), viaYoutube: match };
        }
      } catch (e) {
        LOG('YouTube fallback for preview-only track failed', e);
      }
    }
    if (!a) a = item.source === 'yt' ? await ytDownloadAudio(item.id, onProgress) : await scDownloadAudio(item.raw, onProgress);
    if (a.blob.size > AUDIO_MAX_BYTES) throw new Error(`Audio is ${(a.blob.size / 1048576).toFixed(1)} MB (limit 100 MB).`);
    return a;
  }

  async function songCover(item) {
    if (item.source === 'yt') {
      const buf = await fetchFirstImage(ytThumbUrls(item.id));
      return prepareImage(buf, { square: true, trimBars: true });
    }
    const art = item.raw.artwork_url || (item.raw.user && item.raw.user.avatar_url);
    if (!art) return null;
    const buf = await fetchFirstImage([scArtwork(art, 'original'), scArtwork(art, 't500x500'), art]);
    return prepareImage(buf, { square: true });
  }

  /* ------------------------------------------------------------------ *
   * fakecrime form integration
   * ------------------------------------------------------------------ */
  function ownText(el) {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) s += n.textContent;
    return s.trim();
  }

  function findByOwnText(root, text) {
    return [...root.querySelectorAll('*')].filter((el) => !el.closest('.scfc-root') && ownText(el) === text);
  }

  function findCreateCard() {
    for (const h of findByOwnText(document.body, 'Create Song')) {
      let el = h.parentElement;
      while (el && el !== document.body) {
        if (el.querySelectorAll('input[type=file]').length >= 1 && el.querySelector('input:not([type=file])')) return el;
        el = el.parentElement;
      }
    }
    return null;
  }

  function closestWithSingle(start, boundary, selector) {
    let el = start;
    while (el && boundary.contains(el)) {
      const found = el.querySelectorAll(selector);
      if (found.length === 1) return found[0];
      if (found.length > 1) return null;
      el = el.parentElement;
    }
    return null;
  }

  function inputForLabel(card, label, selector) {
    for (const lbl of findByOwnText(card, label)) {
      const found = closestWithSingle(lbl.parentElement, card, selector);
      if (found) return found;
    }
    return null;
  }

  function getFields(card) {
    const fileInputs = [...card.querySelectorAll('input[type=file]')];
    const textSel = 'input:not([type=file]):not([type=hidden]):not([type=checkbox]), textarea';
    return {
      cover: inputForLabel(card, 'Cover', 'input[type=file]') || fileInputs[0] || null,
      background: inputForLabel(card, 'Background', 'input[type=file]') || fileInputs[1] || null,
      audio:
        inputForLabel(card, 'Audio', 'input[type=file]') ||
        fileInputs.find((i) => /audio|mp3|wav|flac/i.test(i.accept || '')) ||
        fileInputs[2] ||
        null,
      name: inputForLabel(card, 'Name', textSel),
      url: inputForLabel(card, 'URL', textSel),
    };
  }

  function requireFields() {
    const card = findCreateCard();
    if (!card) throw new Error('Could not find the "Create Song" form on this page.');
    return { card, fields: getFields(card) };
  }

  function setFile(input, file) {
    if (!input || !file) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /** Pick the MIME type the upload field actually accepts for this extension (fakecrime wants "video/mp4", not "audio/mp4"). */
  function acceptedType(input, ext) {
    const preferred = { mp3: ['audio/mpeg', 'audio/mp3'], mp4: ['video/mp4', 'audio/mp4'], ogg: ['audio/ogg', 'video/ogg'] }[ext] || ['application/octet-stream'];
    const accept = (input && input.accept ? input.accept : '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!accept.length) return preferred[0];
    for (const p of preferred) if (accept.includes(p)) return p;
    for (const a of accept) if (a.includes('/') && a.split('/')[1].replace(/^x-/, '') === ext) return a;
    for (const p of preferred) if (accept.includes(p.split('/')[0] + '/*')) return p;
    return preferred[0];
  }

  function setAudioFile(input, audio, base) {
    const type = acceptedType(input, audio.ext);
    LOG('audio', { ext: audio.ext, type, accept: input.accept, size: audio.blob.size, snipped: audio.snipped });
    return setFile(input, new File([audio.blob], `${base}.${audio.ext}`, { type }));
  }

  function setText(input, value) {
    if (!input) return false;
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  const OPEN_ID = 'scfc-open';
  const ICON_MUSIC =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  const ICON_IMAGE =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';
  const ICON_SEARCH =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const ICON_X =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  GM_addStyle(`
    #${OPEN_ID}{margin-left:auto;margin-right:10px;display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 16px;border-radius:999px;
      border:1px solid rgba(244,63,94,.35);background:rgba(244,63,94,.12);color:#fb7185;font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s,border-color .15s}
    #${OPEN_ID}:hover{background:rgba(244,63,94,.2);border-color:rgba(244,63,94,.6)}
    .scfc-search-link{cursor:pointer}
    .scfc-root{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;
      background:rgba(0,0,0,.65);backdrop-filter:blur(4px);animation:scfc-fade .15s ease-out}
    .scfc-root[hidden]{display:none}
    @keyframes scfc-fade{from{opacity:0}to{opacity:1}}
    @keyframes scfc-pop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
    .scfc-root .scfc-dialog{width:100%;max-width:680px;max-height:min(84vh,760px);display:flex;flex-direction:column;background:#121212;color:#ececec;
      border:1px solid rgba(255,255,255,.08);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.6);font:inherit;animation:scfc-pop .18s ease-out;overflow:hidden}
    .scfc-root .scfc-head{display:flex;align-items:flex-start;gap:12px;padding:20px 20px 0}
    .scfc-root .scfc-head h3{margin:0;font-size:17px;font-weight:700}
    .scfc-root .scfc-head p{margin:4px 0 0;color:#8f8f8f;font-size:13px}
    .scfc-root .scfc-x{margin-left:auto;flex:none;width:32px;height:32px;display:grid;place-items:center;border-radius:999px;border:1px solid rgba(255,255,255,.08);
      background:#1a1a1a;color:#aaa;cursor:pointer}
    .scfc-root .scfc-x:hover{color:#fff;border-color:rgba(255,255,255,.2)}
    .scfc-root .scfc-body{padding:16px 20px 20px;overflow:auto}
    .scfc-root .scfc-tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
    .scfc-root .scfc-tab{height:30px;padding:0 14px;border-radius:999px;border:1px solid rgba(255,255,255,.08);background:#181818;color:#a5a5a5;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
    .scfc-root .scfc-tab:hover{color:#eee}
    .scfc-root .scfc-tab.on{background:rgba(244,63,94,.12);border-color:rgba(244,63,94,.45);color:#fb7185}
    .scfc-root .scfc-field{display:flex;align-items:stretch;height:42px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:#181818;overflow:hidden}
    .scfc-root .scfc-field:focus-within{border-color:rgba(244,63,94,.6)}
    .scfc-root .scfc-field .scfc-ic{width:42px;flex:none;display:grid;place-items:center;color:#f43f5e;border-right:1px solid rgba(255,255,255,.08)}
    .scfc-root .scfc-field input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:#ececec;font:inherit;font-size:14px;padding:0 12px}
    .scfc-root .scfc-field input::placeholder{color:#6f6f6f}
    .scfc-root .scfc-row{display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap}
    .scfc-root label.scfc-opt{display:flex;align-items:center;gap:8px;color:#9a9a9a;font-size:13px;cursor:pointer;user-select:none}
    .scfc-root label.scfc-opt input{accent-color:#f43f5e;width:15px;height:15px;margin:0}
    .scfc-root .scfc-go{margin-left:auto;display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 18px;border-radius:999px;border:0;
      background:#f43f5e;color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
    .scfc-root .scfc-go:hover{background:#e11d48}
    .scfc-root .scfc-go:disabled{opacity:.5;cursor:default}
    .scfc-root .scfc-status{margin-top:12px;font-size:13px;color:#b5b5b5}
    .scfc-root .scfc-status:empty{display:none}
    .scfc-root .scfc-status.err{color:#fb7185}
    .scfc-root .scfc-status.ok{color:#4ade80}
    .scfc-root .scfc-bar{height:4px;border-radius:2px;background:#262626;margin-top:10px;overflow:hidden;display:none}
    .scfc-root .scfc-bar>div{height:100%;width:0;background:#f43f5e;transition:width .15s}
    .scfc-root .scfc-results{display:flex;flex-direction:column;gap:8px;margin-top:14px}
    .scfc-root .scfc-results.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
    .scfc-root .scfc-results:empty{display:none}
    .scfc-root .scfc-item{display:flex;gap:12px;align-items:center;padding:8px 10px;border-radius:12px;background:#181818;border:1px solid rgba(255,255,255,.06);
      cursor:pointer;text-align:left;color:inherit;font:inherit;width:100%}
    .scfc-root .scfc-item:hover{border-color:rgba(244,63,94,.5);background:#1c1c1c}
    .scfc-root .scfc-item:disabled{opacity:.5;cursor:default}
    .scfc-root .scfc-item img,.scfc-root .scfc-item .scfc-ph{width:42px;height:42px;border-radius:8px;object-fit:cover;flex:none;background:#2a2a2a}
    .scfc-root .scfc-meta{min-width:0;flex:1}
    .scfc-root .scfc-t{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .scfc-root .scfc-a{font-size:12px;color:#8f8f8f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
    .scfc-root .scfc-tag{font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;background:rgba(244,63,94,.12);color:#fb7185;margin-left:6px}
    .scfc-root .scfc-tile{display:flex;flex-direction:column;gap:6px;padding:6px;border-radius:12px;background:#181818;border:1px solid rgba(255,255,255,.06);cursor:pointer;color:inherit;font:inherit;text-align:left;min-width:0}
    .scfc-root .scfc-tile:hover{border-color:rgba(244,63,94,.5)}
    .scfc-root .scfc-tile:disabled{opacity:.5;cursor:default}
    .scfc-root .scfc-tile img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;background:#2a2a2a;display:block}
    .scfc-root .scfc-tile span{font-size:11px;color:#8f8f8f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px}
  `);

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  /** <img> that falls back to fetching through GM_xmlhttpRequest if the page blocks the direct load. */
  function remoteImg(src, cls) {
    const img = el('img', { src, loading: 'lazy', alt: '', referrerpolicy: 'no-referrer', class: cls });
    img.addEventListener(
      'error',
      () => {
        getBuffer(src)
          .then((buf) => (img.src = URL.createObjectURL(new Blob([buf]))))
          .catch(() => {});
      },
      { once: true }
    );
    return img;
  }

  /**
   * Generic search modal.
   * cfg: { title, subtitle, placeholder, icon, tabs, tabKey, grid, option:{label,key},
   *        search(tab, q) -> {items, note} | items, fromLink(q) -> item|null, render(item) -> button, pick(item, ctx) -> {close, message} }
   */
  function createModal(cfg) {
    const input = el('input', { type: 'text', placeholder: cfg.placeholder, spellcheck: 'false', autocomplete: 'off' });
    const status = el('div', { class: 'scfc-status' });
    const barFill = el('div');
    const bar = el('div', { class: 'scfc-bar' }, barFill);
    const results = el('div', { class: 'scfc-results' + (cfg.grid ? ' grid' : '') });
    const closeBtn = el('button', { class: 'scfc-x', type: 'button', title: 'Close', 'aria-label': 'Close', html: ICON_X });
    const titleEl = el('h3', {}, cfg.title);

    let tab = GM_getValue(cfg.tabKey, cfg.tabs[0].id);
    if (!cfg.tabs.some((t) => t.id === tab)) tab = cfg.tabs[0].id;
    const tabBtns = cfg.tabs.map((t) =>
      el('button', { type: 'button', class: 'scfc-tab' + (t.id === tab ? ' on' : ''), 'data-tab': t.id, onclick: () => switchTab(t.id) }, t.label)
    );

    let optionInput = null;
    let optionRow = null;
    if (cfg.option) {
      optionInput = el('input', { type: 'checkbox' });
      optionInput.checked = GM_getValue(cfg.option.key, false);
      optionInput.addEventListener('change', () => GM_setValue(cfg.option.key, optionInput.checked));
      optionRow = el('label', { class: 'scfc-opt' }, optionInput, cfg.option.label);
    }

    const root = el(
      'div',
      { class: 'scfc-root', hidden: '' },
      el(
        'div',
        { class: 'scfc-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': cfg.title },
        el('div', { class: 'scfc-head' }, el('div', {}, titleEl, el('p', {}, cfg.subtitle)), closeBtn),
        el(
          'div',
          { class: 'scfc-body' },
          el('div', { class: 'scfc-tabs' }, ...tabBtns),
          el('div', { class: 'scfc-field' }, el('div', { class: 'scfc-ic', html: cfg.icon }), input),
          optionRow ? el('div', { class: 'scfc-row' }, optionRow) : null,
          status,
          bar,
          results
        )
      )
    );

    let busy = false;
    let lastQuery = '';
    const ctx = {
      status(msg, kind = '') {
        status.textContent = msg;
        status.className = 'scfc-status' + (kind ? ' ' + kind : '');
      },
      progress(p) {
        bar.style.display = p == null ? 'none' : 'block';
        barFill.style.width = `${Math.round((p || 0) * 100)}%`;
      },
      get option() {
        return !!(optionInput && optionInput.checked);
      },
      target: null,
    };
    const setBusy = (b) => {
      busy = b;
      input.disabled = b;
      results.querySelectorAll('button').forEach((x) => (x.disabled = b));
    };

    const close = () => {
      if (busy) return;
      root.hidden = true;
      document.documentElement.style.overflow = '';
    };
    closeBtn.addEventListener('click', close);
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !root.hidden) close();
    });

    async function pick(item) {
      if (busy) return;
      setBusy(true);
      try {
        const r = (await cfg.pick(item, ctx)) || {};
        ctx.progress(null);
        setBusy(false);
        if (r.close !== false) {
          ctx.status('');
          close();
        } else if (r.message) ctx.status(r.message);
      } catch (e) {
        LOG(e);
        ctx.progress(null);
        ctx.status(e.message || String(e), 'err');
      } finally {
        setBusy(false);
      }
    }

    function switchTab(id) {
      tab = id;
      GM_setValue(cfg.tabKey, id);
      tabBtns.forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
      lastQuery = '';
      run();
    }

    // Search as you type: debounced, and stale responses are dropped.
    let seq = 0;
    let debounce = null;
    function schedule(delay = 400) {
      clearTimeout(debounce);
      debounce = setTimeout(run, delay);
    }

    async function run() {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (busy || q === lastQuery) return;
      lastQuery = q;
      const my = ++seq;
      ctx.progress(null);
      if (!q) {
        results.replaceChildren();
        ctx.status('');
        return;
      }
      try {
        ctx.status('Loading…');
        const linked = await cfg.fromLink(q);
        if (my !== seq) return;
        if (linked) {
          results.replaceChildren();
          await pick(linked);
          return;
        }
        ctx.status(`Searching for "${q}"…`);
        const res = await cfg.search(tab, q);
        if (my !== seq) return;
        const items = Array.isArray(res) ? res : res.items;
        const note = Array.isArray(res) ? '' : res.note || '';
        results.replaceChildren(...items.map((it) => cfg.render(it, () => pick(it))));
        ctx.status(items.length ? note || 'Pick one:' : 'No results.', items.length ? '' : 'err');
      } catch (e) {
        if (my !== seq) return;
        LOG(e);
        ctx.status(e.message || String(e), 'err');
      }
    }

    input.addEventListener('input', () => schedule(/^\s*https?:\/\//i.test(input.value) ? 150 : 400));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lastQuery = '';
        run();
      }
    });

    document.body.append(root);
    return {
      root,
      ctx,
      open({ title, query, target } = {}) {
        if (title) titleEl.textContent = title;
        ctx.target = target || null;
        root.hidden = false;
        document.documentElement.style.overflow = 'hidden';
        if (query && query !== input.value.trim()) input.value = query;
        if (input.value.trim() && input.value.trim() !== lastQuery) run();
        setTimeout(() => input.focus(), 0);
      },
    };
  }

  function renderSong(item, onPick) {
    return el(
      'button',
      { class: 'scfc-item', type: 'button', title: item.pageUrl, onclick: onPick },
      item.thumb ? remoteImg(item.thumb) : el('div', { class: 'scfc-ph' }),
      el(
        'div',
        { class: 'scfc-meta' },
        el('div', { class: 'scfc-t' }, item.title),
        el(
          'div',
          { class: 'scfc-a' },
          `${item.artist || 'Unknown'} · ${fmtDuration(item.durationMs)}`,
          item.previewOnly ? el('span', { class: 'scfc-tag', title: 'SoundCloud only has a 30s preview — the full audio is taken from YouTube' }, 'preview · via YouTube') : null
        )
      )
    );
  }

  function renderImage(item, onPick) {
    const size = item.w && item.h ? `${item.w}×${item.h} · ` : '';
    return el('button', { class: 'scfc-tile', type: 'button', title: item.label || item.full, onclick: onPick }, remoteImg(item.thumb), el('span', {}, size + (item.label || '')));
  }

  // --- the three modals ---------------------------------------------------------
  const modals = {};
  function getModal(kind) {
    if (modals[kind] && modals[kind].root.isConnected) return modals[kind];
    if (kind === 'song') {
      modals.song = createModal({
        title: 'Add from SoundCloud / YouTube',
        subtitle: 'Paste a SoundCloud or YouTube link, or search by name. Audio, cover, name and URL get filled in — review, then press Create.',
        placeholder: 'Link or song name…',
        icon: ICON_MUSIC,
        tabs: SONG_TABS,
        tabKey: 'songTab',
        option: { label: 'Also use the cover as background', key: 'coverAsBackground' },
        search: songSearch,
        fromLink: songFromLink,
        render: renderSong,
        async pick(item, ctx) {
          const { fields } = requireFields();
          if (!fields.audio) throw new Error('Could not find the Audio upload field.');
          const base = safeFileName(item.name);
          ctx.status(`Downloading cover for "${item.name}"…`);
          let cover = null;
          try {
            cover = await songCover(item);
          } catch (e) {
            LOG('cover failed', e);
          }
          ctx.status(`Downloading audio for "${item.name}"…`);
          ctx.progress(0);
          const audio = await songAudio(item, ctx.progress, ctx.status);
          ctx.progress(null);

          if (cover) {
            setFile(fields.cover, new File([cover.blob], `${base}.${cover.ext}`, { type: cover.type }));
            if (ctx.option) setFile(fields.background, new File([cover.blob], `${base}-bg.${cover.ext}`, { type: cover.type }));
          }
          setAudioFile(fields.audio, audio, base);
          setText(fields.name, item.name);
          setText(fields.url, (item.pageUrl || '').slice(0, URL_MAX));

          const warnings = [];
          if (audio.snipped) warnings.push('only a 30s preview was available');
          if (!cover) warnings.push('no cover found');
          const missing = ['name', 'url'].filter((k) => !fields[k]);
          if (missing.length) warnings.push(`couldn't find field: ${missing.join(', ')}`);
          if (warnings.length) return { close: false, message: `Filled "${item.name}" — but ${warnings.join('; ')}.` };
          return { close: true };
        },
      });
    } else if (kind === 'audio') {
      modals.audio = createModal({
        title: 'Search audio',
        subtitle: 'Paste a SoundCloud or YouTube link, or search by name. Only the audio file is filled in.',
        placeholder: 'Link or song name…',
        icon: ICON_MUSIC,
        tabs: SONG_TABS,
        tabKey: 'songTab',
        search: songSearch,
        fromLink: songFromLink,
        render: renderSong,
        async pick(item, ctx) {
          const { fields } = requireFields();
          if (!fields.audio) throw new Error('Could not find the Audio upload field.');
          ctx.status(`Downloading audio for "${item.name}"…`);
          ctx.progress(0);
          const audio = await songAudio(item, ctx.progress, ctx.status);
          setAudioFile(fields.audio, audio, safeFileName(item.name));
          if (audio.snipped) return { close: false, message: 'Audio set — but only a 30s preview was available.' };
          return { close: true };
        },
      });
    } else if (kind === 'image') {
      modals.image = createModal({
        title: 'Search image',
        subtitle: 'Search the web, SoundCloud, Apple Music album covers or YouTube thumbnails — or paste an image, SoundCloud or YouTube link.',
        placeholder: 'Search or paste a link…',
        icon: ICON_IMAGE,
        tabs: [
          { id: 'web', label: 'Google' },
          { id: 'sc', label: 'SoundCloud' },
          { id: 'apple', label: 'Apple Music' },
          { id: 'yt', label: 'YouTube' },
        ],
        tabKey: 'imageTab',
        grid: true,
        async search(tab, q) {
          if (tab === 'sc') return scImages(q);
          if (tab === 'apple') return appleImages(q);
          if (tab === 'yt') return ytImages(q);
          return webImages(q);
        },
        async fromLink(q) {
          const id = ytVideoId(q);
          if (id) return { full: ytThumbUrls(id)[0], fallbacks: ytThumbUrls(id), trimBars: true };
          if (isScUrl(q)) {
            const res = await scResolveUrl(q);
            const art = res && (res.artwork_url || (res.user && res.user.avatar_url) || res.avatar_url);
            if (!art) throw new Error('That SoundCloud link has no artwork.');
            return { full: scArtwork(art, 'original'), alt: scArtwork(art, 't500x500') };
          }
          if (/^https?:\/\/\S+$/i.test(q)) return { full: q };
          return null;
        },
        render: renderImage,
        async pick(item, ctx) {
          const { fields } = requireFields();
          const target = ctx.target === 'background' ? 'background' : 'cover';
          const input = fields[target];
          if (!input) throw new Error(`Could not find the ${target} upload field.`);
          ctx.status('Downloading image…');
          const buf = await fetchFirstImage([item.full, ...(item.fallbacks || []), item.alt, item.thumb]);
          const img = await prepareImage(buf, {
            square: target === 'cover',
            trimBars: !!item.trimBars,
            maxBytes: target === 'cover' ? COVER_MAX_BYTES : BACKGROUND_MAX_BYTES,
          });
          const base = safeFileName((fields.name && fields.name.value) || target);
          setFile(input, new File([img.blob], `${base}-${target}.${img.ext}`, { type: img.type }));
          return { close: true };
        },
      });
    }
    return modals[kind];
  }

  function currentName() {
    const card = findCreateCard();
    const f = card && getFields(card);
    return (f && f.name && f.name.value.trim()) || '';
  }

  /* ------------------------------------------------------------------ *
   * Mount (the site is a SPA, so keep watching for the form)
   * ------------------------------------------------------------------ */
  function findCreateButton(card) {
    return [...card.querySelectorAll('button')].find((b) => b.id !== OPEN_ID && b.textContent.trim() === 'Create') || null;
  }

  function buildOpenButton() {
    return el('button', {
      id: OPEN_ID,
      type: 'button',
      html: ICON_MUSIC + '<span>Add from SoundCloud / YouTube</span>',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        getModal('song').open();
      },
    });
  }

  /** Turn "Drag a file here or browse" into "Drag a file here, browse or search" in each upload field. */
  function augmentDropzones(card, fields) {
    for (const browse of findByOwnText(card, 'browse')) {
      if (browse.dataset.scfc) continue;
      const input = closestWithSingle(browse.parentElement, card, 'input[type=file]');
      const kind = input === fields.audio ? 'audio' : input === fields.cover ? 'cover' : input === fields.background ? 'background' : null;
      if (!kind) continue;
      browse.dataset.scfc = '1';
      const prev = browse.previousSibling;
      if (prev && prev.nodeType === Node.TEXT_NODE && /\s+or\s*$/.test(prev.nodeValue)) prev.nodeValue = prev.nodeValue.replace(/\s+or\s*$/, ', ');
      const link = document.createElement(browse.tagName === 'INPUT' ? 'span' : browse.tagName);
      link.className = browse.className + ' scfc-search-link';
      link.textContent = 'search';
      const stop = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      link.addEventListener('pointerdown', (e) => e.stopPropagation());
      link.addEventListener('keydown', (e) => e.stopPropagation());
      link.addEventListener('click', (e) => {
        stop(e);
        const query = currentName();
        if (kind === 'audio') getModal('audio').open({ query });
        else getModal('image').open({ title: kind === 'cover' ? 'Search cover' : 'Search background', query, target: kind });
      });
      browse.after(document.createTextNode(' or '), link);
    }
  }

  let openBtn = null;
  function mount() {
    if (!location.pathname.startsWith('/bio/music')) return;
    const card = findCreateCard();
    if (!card) return;
    const fields = getFields(card);
    augmentDropzones(card, fields);
    if (openBtn && openBtn.isConnected && openBtn.nextElementSibling && openBtn.nextElementSibling.textContent.trim() === 'Create') return;
    const create = findCreateButton(card);
    if (!create) return;
    openBtn = openBtn || buildOpenButton();
    create.parentElement.insertBefore(openBtn, create);
  }

  let scheduled = false;
  new MutationObserver((muts) => {
    if (scheduled) return;
    // Ignore mutations caused by our own modals.
    if (muts.every((m) => m.target.closest && m.target.closest('.scfc-root'))) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      mount();
    }, 150);
  }).observe(document.body, { childList: true, subtree: true, characterData: false });
  mount();
})();
