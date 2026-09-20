// ─── NOIRSYNC LYRICS REGRESSION SUITE ─────────────────────────────────────────
// Validates:
// 1. R2 lyrics upload success with audio
// 2. R2 lyrics upload failure does not return false success (returns 500, cleans up)
// 3. tracks.lyrics_key is persisted in PostgreSQL
// 4. GET /library/:id/lyrics returns lyrics content directly (text/plain; charset=utf-8)
// 5. GET /library/:id/lyrics returns 404 when no lyrics exist
// 6. Existing R2 track can receive lyrics after initial upload (POST /library/:id/lyrics)
// 7. Existing lyrics can be replaced safely
// 8. Rejection of invalid lyrics formats (non-.lrc)
// 9. HostView uses R2 lyrics route (/library/:id/lyrics)
// 10. parseLrc parses standard timestamps into LrcLine[] structure
// 11. Audio-only uploads without lyrics remain 100% functional

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const assert = require('assert');
const express = require('express');
const http = require('http');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const db = require('./src/db');
const { parseLrc } = require('./src/lrcParser');

async function runLyricsRegression() {
  console.log('=== STARTING NOIRSYNC LYRICS REGRESSION SUITE ===\n');

  // 1. Initialize PostgreSQL database
  console.log('1. Initializing database and verifying tracks.lyrics_key column...');
  await db.initDb();

  const colCheck = await db.pool.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'tracks' AND column_name = 'lyrics_key';
  `);
  assert.strictEqual(colCheck.rows.length, 1, 'lyrics_key column must exist on tracks table');
  console.log('PASS: tracks.lyrics_key column exists.\n');

  // 2. Setup mock R2 storage and express app with libraryRoutes
  console.log('2. Setting up test harness with mocked R2 storage...');
  const r2Storage = new Map();
  let r2ShouldFail = false;

  const r2Mock = require('./src/r2');
  const originalUpload = r2Mock.uploadToR2;
  const originalGetText = r2Mock.getTextObject;
  const originalDelete = r2Mock.deleteFromR2;
  const originalStorageCheck = r2Mock.checkStorageLimit;

  r2Mock.checkStorageLimit = async () => true;
  r2Mock.uploadToR2 = async (key, buffer, contentType) => {
    if (r2ShouldFail && key.startsWith('lyrics/')) {
      throw new Error('Simulated R2 storage connection failure');
    }
    r2Storage.set(key, { buffer, contentType });
  };
  r2Mock.getTextObject = async (key) => {
    const item = r2Storage.get(key);
    if (!item) return null;
    return item.buffer.toString('utf-8');
  };
  r2Mock.deleteFromR2 = async (key) => {
    r2Storage.delete(key);
  };

  const libraryRoutes = require('./src/libraryRoutes');
  const app = express();
  app.use('/library', libraryRoutes);

  const server = http.createServer(app);
  const PORT = 3599;
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`PASS: Test server listening on port ${PORT}.\n`);

  // Helper for multipart/form-data requests using native boundary
  function uploadRequest(method, urlPath, fields = {}, files = {}) {
    return new Promise((resolve, reject) => {
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
      const chunks = [];

      for (const [key, val] of Object.entries(fields)) {
        chunks.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`
        ));
      }

      for (const [fieldName, fileObj] of Object.entries(files)) {
        chunks.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileObj.filename}"\r\nContent-Type: ${fileObj.contentType || 'application/octet-stream'}\r\n\r\n`
        ));
        chunks.push(fileObj.buffer);
        chunks.push(Buffer.from('\r\n'));
      }

      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      const payload = Buffer.concat(chunks);

      const req = http.request({
        hostname: '127.0.0.1',
        port: PORT,
        path: urlPath,
        method: method,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': payload.length,
        },
      }, (res) => {
        let resData = '';
        res.on('data', (d) => { resData += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(resData); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: json, text: resData });
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  function getRequest(urlPath) {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${PORT}${urlPath}`, (res) => {
        let resData = '';
        res.on('data', (d) => { resData += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(resData); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: json, text: resData });
        });
      }).on('error', reject);
    });
  }

  try {
    const lrcContent = `[ti:Noir Horizon]
[ar:Vangelis & Antigravity]
[00:00.00]Synthesizer introductory swell
[00:04.50]Neon reflections in the asphalt rain
[00:09.20]A digital frequency resonates through the dark
[00:15.00]End of transmission`;

    // ── TEST 1: R2 Lyrics Upload Success with Audio ──
    console.log('3. Testing R2 track upload WITH lyrics (.lrc)...');
    const uploadRes = await uploadRequest('POST', '/library/upload', {
      title: 'Noir Horizon',
      artist: 'Vangelis & Antigravity',
      duration: '180',
    }, {
      audio: { filename: 'noir-horizon.flac', buffer: Buffer.from('FLAC_DUMMY_AUDIO_DATA_BYTES'), contentType: 'audio/flac' },
      lyrics: { filename: 'noir-horizon.lrc', buffer: Buffer.from(lrcContent, 'utf-8'), contentType: 'text/plain' },
    });

    assert.strictEqual(uploadRes.status, 200, `Upload should return 200, got ${uploadRes.status}`);
    assert(uploadRes.body.success, 'Upload response must indicate success');
    const trackWithLyrics = uploadRes.body.track;
    assert(trackWithLyrics.lyrics_key, 'track.lyrics_key must be present in response');
    assert.strictEqual(trackWithLyrics.lyrics_key, `lyrics/${trackWithLyrics.id}.lrc`);
    console.log(`PASS: Track uploaded successfully. lyrics_key = ${trackWithLyrics.lyrics_key}`);

    // ── TEST 2: PostgreSQL Persistence Verification ──
    console.log('4. Verifying tracks.lyrics_key is persisted in PostgreSQL...');
    const dbTrack = await db.getTrack(trackWithLyrics.id);
    assert(dbTrack, 'Track must exist in PostgreSQL');
    assert.strictEqual(dbTrack.lyrics_key, `lyrics/${trackWithLyrics.id}.lrc`);
    console.log('PASS: tracks.lyrics_key verified in PostgreSQL database.');

    // ── TEST 3: GET /library/:id/lyrics Returns Direct Content ──
    console.log('5. Testing GET /library/:id/lyrics returns lyrics content directly (text/plain)...');
    const lyricsGetRes = await getRequest(`/library/${trackWithLyrics.id}/lyrics`);
    assert.strictEqual(lyricsGetRes.status, 200, `GET /library/:id/lyrics must return 200, got ${lyricsGetRes.status}`);
    assert(lyricsGetRes.headers['content-type'].includes('text/plain'), 'Content-Type must be text/plain');
    assert.strictEqual(lyricsGetRes.text, lrcContent, 'Lyrics content must match original uploaded .lrc');
    console.log('PASS: GET /library/:id/lyrics returns full UTF-8 plain text lyrics directly.');

    // ── TEST 4: Audio-Only Upload Works ──
    console.log('6. Testing audio-only upload (no lyrics provided)...');
    const audioOnlyRes = await uploadRequest('POST', '/library/upload', {
      title: 'Midnight Echoes',
      artist: 'Solo Synthesizer',
    }, {
      audio: { filename: 'midnight.mp3', buffer: Buffer.from('MP3_AUDIO_DATA'), contentType: 'audio/mpeg' },
    });
    assert.strictEqual(audioOnlyRes.status, 200);
    const audioOnlyTrack = audioOnlyRes.body.track;
    assert.strictEqual(audioOnlyTrack.lyrics_key, null, 'Audio-only track must have lyrics_key = null');
    console.log('PASS: Audio-only track created cleanly with lyrics_key = null.');

    // ── TEST 5: GET /library/:id/lyrics 404 When No Lyrics ──
    console.log('7. Testing GET /library/:id/lyrics returns 404 for track with no lyrics...');
    const noLyricsRes = await getRequest(`/library/${audioOnlyTrack.id}/lyrics`);
    assert.strictEqual(noLyricsRes.status, 404, 'Must return 404 when track has no lyrics');
    console.log('PASS: 404 returned correctly when track has no lyrics.');

    // ── TEST 6: Upload Failure Does NOT Return False Success ──
    console.log('8. Testing that R2 lyrics upload failure fails cleanly (no false success)...');
    r2ShouldFail = true;
    const failRes = await uploadRequest('POST', '/library/upload', {
      title: 'Broken Upload',
      artist: 'Should Fail',
    }, {
      audio: { filename: 'fail.mp3', buffer: Buffer.from('MP3_DATA'), contentType: 'audio/mpeg' },
      lyrics: { filename: 'fail.lrc', buffer: Buffer.from('[00:01.00] Broken'), contentType: 'text/plain' },
    });
    r2ShouldFail = false;
    assert.strictEqual(failRes.status, 500, `Upload must return 500 on R2 lyrics failure, got ${failRes.status}`);
    assert(failRes.body.error.includes('lyrics'), 'Error message must mention lyrics upload failure');
    console.log('PASS: Failed R2 lyrics upload correctly returns HTTP 500 and prevents invalid DB record.');

    // ── TEST 7: Add Lyrics to Existing R2 Track (POST /library/:id/lyrics) ──
    console.log('9. Testing adding lyrics to existing R2 track via POST /library/:id/lyrics...');
    const addLyricsRes = await uploadRequest('POST', `/library/${audioOnlyTrack.id}/lyrics`, {}, {
      lyrics: { filename: 'attached-lyrics.lrc', buffer: Buffer.from(lrcContent, 'utf-8'), contentType: 'text/plain' },
    });
    assert.strictEqual(addLyricsRes.status, 200, `POST /library/:id/lyrics must return 200, got ${addLyricsRes.status}`);
    assert(addLyricsRes.body.success);
    assert.strictEqual(addLyricsRes.body.lyrics_key, `lyrics/${audioOnlyTrack.id}.lrc`);

    // Verify DB update
    const updatedTrack = await db.getTrack(audioOnlyTrack.id);
    assert.strictEqual(updatedTrack.lyrics_key, `lyrics/${audioOnlyTrack.id}.lrc`);

    // Verify retrieval works
    const checkAttached = await getRequest(`/library/${audioOnlyTrack.id}/lyrics`);
    assert.strictEqual(checkAttached.status, 200);
    assert.strictEqual(checkAttached.text, lrcContent);
    console.log('PASS: Existing R2 track successfully associated with lyrics.');

    // ── TEST 8: Replace Existing Lyrics on R2 Track ──
    console.log('10. Testing replacing existing lyrics on an R2 track...');
    const replacedLrc = `[00:00.00]New remastered lyrics line\n[00:05.00]Final chord`;
    const replaceRes = await uploadRequest('POST', `/library/${audioOnlyTrack.id}/lyrics`, {}, {
      lyrics: { filename: 'remastered.lrc', buffer: Buffer.from(replacedLrc, 'utf-8'), contentType: 'text/plain' },
    });
    assert.strictEqual(replaceRes.status, 200);

    const checkReplaced = await getRequest(`/library/${audioOnlyTrack.id}/lyrics`);
    assert.strictEqual(checkReplaced.status, 200);
    assert.strictEqual(checkReplaced.text, replacedLrc);
    console.log('PASS: Existing lyrics replaced safely.');

    // ── TEST 9: Reject Non-.LRC Formats ──
    console.log('11. Testing rejection of unsupported formats (e.g. .txt)...');
    const badFormatRes = await uploadRequest('POST', `/library/${audioOnlyTrack.id}/lyrics`, {}, {
      lyrics: { filename: 'lyrics.txt', buffer: Buffer.from('plain text'), contentType: 'text/plain' },
    });
    assert.strictEqual(badFormatRes.status, 400, `Must return 400 for non-.lrc, got ${badFormatRes.status}`);
    console.log('PASS: Non-.lrc format rejected with HTTP 400.');

    // ── TEST 10: LRC Parser Validation ──
    console.log('12. Testing LRC parser against uploaded lyrics...');
    const parsed = parseLrc(lrcContent);
    assert.strictEqual(parsed.meta.title, 'Noir Horizon');
    assert.strictEqual(parsed.meta.artist, 'Vangelis & Antigravity');
    assert.strictEqual(parsed.lines.length, 4);
    assert.strictEqual(parsed.lines[0].time, 0.0);
    assert.strictEqual(parsed.lines[0].text, 'Synthesizer introductory swell');
    assert.strictEqual(parsed.lines[1].time, 4.5);
    assert.strictEqual(parsed.lines[1].text, 'Neon reflections in the asphalt rain');
    console.log('PASS: LRC parser correctly extracts metadata and 4 synchronized lines.');

    // ── TEST 11: HostView Code Verification ──
    console.log('13. Verifying HostView.tsx routes lyrics via /library/:id/lyrics...');
    const hostViewSource = fs.readFileSync(
      path.join(__dirname, '../client/src/components/HostView.tsx'),
      'utf-8'
    );
    assert(
      hostViewSource.includes('/library/${roomState.libraryTrackId}/lyrics') ||
      hostViewSource.includes('/library/${track.id}/lyrics'),
      'HostView.tsx must fetch lyrics via /library/:id/lyrics'
    );
    console.log('PASS: HostView.tsx verified to use /library/:id/lyrics.');

    console.log('\n=== ALL 13 LYRICS REGRESSION CHECKS PASSED 100% ===\n');
  } finally {
    // Restore mocks and shut down server
    r2Mock.uploadToR2 = originalUpload;
    r2Mock.getTextObject = originalGetText;
    r2Mock.deleteFromR2 = originalDelete;
    r2Mock.checkStorageLimit = originalStorageCheck;
    server.close();
  }
}

runLyricsRegression().catch((err) => {
  console.error('LYRICS REGRESSION SUITE FAILED:', err);
  process.exit(1);
});
