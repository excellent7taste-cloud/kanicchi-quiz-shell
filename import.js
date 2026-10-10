(() => {
  'use strict';

  const PACK_CACHE = 'kani-usb-private-pack-v1';
  const MARKER = new URL('pack-ready.json', location.href).href;
  const fileInput = document.getElementById('pack-file');
  const importButton = document.getElementById('import-button');
  const progress = document.getElementById('progress');
  const status = document.getElementById('status');
  const playLink = document.getElementById('play-link');
  const decoder = new TextDecoder('utf-8');
  const crcTable = Array.from({length:256}, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    return value >>> 0;
  });

  function message(text) { status.textContent = text; }

  function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function mimeType(name) {
    if (name.endsWith('.html')) return 'text/html; charset=utf-8';
    if (name.endsWith('.js')) return 'text/javascript; charset=utf-8';
    if (name.endsWith('.css')) return 'text/css; charset=utf-8';
    if (name.endsWith('.webmanifest')) return 'application/manifest+json';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.mp3')) return 'audio/mpeg';
    return 'application/octet-stream';
  }

  async function entriesIn(zipFile) {
    const tailStart = Math.max(0, zipFile.size - 65557);
    const tail = new DataView(await zipFile.slice(tailStart).arrayBuffer());
    let eocd = -1;
    for (let offset = tail.byteLength - 22; offset >= 0; offset--) {
      if (tail.getUint32(offset, true) === 0x06054b50 &&
          offset + 22 + tail.getUint16(offset + 20, true) === tail.byteLength) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) throw new Error('ZIPの終端を読めません。正しい教材ZIPを選んでください。');
    const count = tail.getUint16(eocd + 10, true);
    const centralSize = tail.getUint32(eocd + 12, true);
    const centralOffset = tail.getUint32(eocd + 16, true);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
        centralOffset + centralSize > zipFile.size) throw new Error('対応していないZIP形式です。');
    const directory = new DataView(await zipFile.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
    const result = [];
    let offset = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > directory.byteLength || directory.getUint32(offset, true) !== 0x02014b50) {
        throw new Error('ZIPのファイル一覧が破損しています。');
      }
      const flags = directory.getUint16(offset + 8, true);
      const method = directory.getUint16(offset + 10, true);
      const crc = directory.getUint32(offset + 16, true);
      const size = directory.getUint32(offset + 20, true);
      const originalSize = directory.getUint32(offset + 24, true);
      const nameLength = directory.getUint16(offset + 28, true);
      const extraLength = directory.getUint16(offset + 30, true);
      const commentLength = directory.getUint16(offset + 32, true);
      const localOffset = directory.getUint32(offset + 42, true);
      if (offset + 46 + nameLength + extraLength + commentLength > directory.byteLength) {
        throw new Error('ZIPのファイル名が破損しています。');
      }
      const name = decoder.decode(new Uint8Array(directory.buffer, offset + 46, nameLength));
      offset += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith('/')) continue;
      if (!name.startsWith('app/') || name.includes('..') || name.includes('\\') || name.includes('//')) {
        throw new Error('教材ZIPに不正なファイル名があります。');
      }
      if (flags & 1 || method !== 0 || size !== originalSize) {
        throw new Error('この教材ZIPは無圧縮形式で作成してください。');
      }
      result.push({name, size, crc, localOffset});
    }
    const names = new Set(result.map(entry => entry.name));
    for (const required of [
      'app/index.html', 'app/app.js', 'app/questions.js', 'app/questions-v2.js',
      'app/readings.js', 'app/readings-v2.js', 'app/questions-science.js',
      'app/readings-science.js', 'app/science-scans/q/science-g4-cpb-001.jpg',
      'app/science-scans/a/science-g4-cpb-001.jpg', 'app/assets/Quiz-問題.mp3',
      'app/social-scans-v2/q/v2-s3-001.jpg', 'app/social-scans/q/s3-001.jpg'
    ]) {
      if (!names.has(required)) throw new Error(`教材ZIPに ${required} がありません。`);
    }
    if (result.length < 3400) throw new Error('教材ZIPのファイル数が少なすぎます。');
    return result;
  }

  async function importEntry(zipFile, entry, cache) {
    const header = new DataView(await zipFile.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    if (header.byteLength !== 30 || header.getUint32(0, true) !== 0x04034b50) {
      throw new Error(`ZIP内のファイルが破損しています：${entry.name}`);
    }
    const start = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (start + entry.size > zipFile.size) throw new Error(`ZIPの長さが不正です：${entry.name}`);
    const bytes = new Uint8Array(await zipFile.slice(start, start + entry.size).arrayBuffer());
    if (crc32(bytes) !== entry.crc) throw new Error(`転送したファイルが破損しています：${entry.name}`);
    const target = new URL(entry.name, location.href);
    const type = mimeType(entry.name);
    await cache.put(target, new Response(new Blob([bytes], {type}), {headers:{'Content-Type':type}}));
  }

  async function showExistingPack() {
    const cache = await caches.open(PACK_CACHE);
    const ready = await cache.match(MARKER);
    if (!ready) {
      message('教材はまだ保存されていません。USBで転送した教材ZIPを選んでください。');
      return;
    }
    const info = await ready.json();
    playLink.hidden = false;
    message(`教材を保存済み（${info.count}ファイル）。圏外でもクイズを開けます。`);
  }

  async function waitForController() {
    if (navigator.serviceWorker.controller) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Webアプリの準備に時間がかかっています。画面を開き直してください。')), 15000);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timer);
        resolve();
      }, {once:true});
    });
  }

  async function importPack() {
    const zipFile = fileInput.files?.[0];
    if (!zipFile) return;
    importButton.disabled = true;
    fileInput.disabled = true;
    playLink.hidden = true;
    try {
      await navigator.serviceWorker.ready;
      await waitForController();
      message('ZIPの内容を確認しています…');
      const entries = await entriesIn(zipFile);
      await caches.delete(PACK_CACHE);
      const cache = await caches.open(PACK_CACHE);
      progress.hidden = false;
      progress.max = entries.length;
      progress.value = 0;
      for (let index = 0; index < entries.length; index += 6) {
        await Promise.all(entries.slice(index, index + 6).map(entry => importEntry(zipFile, entry, cache)));
        progress.value = Math.min(index + 6, entries.length);
        message(`iPhoneへ保存中：${progress.value}/${entries.length}ファイル。画面を閉じないでください。`);
      }
      const saved = await cache.keys();
      if (saved.length !== entries.length) throw new Error('保存したファイル数が一致しません。');
      await cache.put(MARKER, new Response(JSON.stringify({count:entries.length, savedAt:new Date().toISOString()}),
        {headers:{'Content-Type':'application/json'}}));
      if (navigator.storage?.persist) {
        try { await navigator.storage.persist(); } catch { /* The pack remains usable. */ }
      }
      playLink.hidden = false;
      message(`✅ ${entries.length}ファイルを保存しました。「クイズを始める」を押し、機内モードでも確認してください。`);
    } catch (error) {
      message(`保存に失敗しました：${error.message}。教材ZIPを選び直して、もう一度お試しください。`);
    } finally {
      importButton.disabled = !fileInput.files?.length;
      fileInput.disabled = false;
    }
  }

  fileInput.addEventListener('change', () => { importButton.disabled = !fileInput.files?.length; });
  importButton.addEventListener('click', importPack);
  if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    message('この画面はHTTPSで開く必要があります。');
    importButton.disabled = true;
  } else {
    navigator.serviceWorker.register('./sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then(showExistingPack)
      .catch(error => message(`保存機能を準備できません：${error.message}`));
  }
})();
