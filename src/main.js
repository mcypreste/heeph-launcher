const { app, BrowserWindow, ipcMain, shell, net, Tray, Menu, dialog, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const { Authflow, Titles } = require('prismarine-auth');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const crypto = require('crypto');
const http  = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const { path7za } = require('7zip-bin');
const unrar = require('node-unrar-js');
let WebSocket = null;
let ByteBuffer = null;

function ensureCosmeticsDeps() {
  try {
    if (!WebSocket) WebSocket = require('ws');
    if (!ByteBuffer) ByteBuffer = require('bytebuffer');
    return true;
  } catch (_) {
    return false;
  }
}

let win;
 
let heephProc = null;
let heephStartedAt = 0;
let heephPid = 0;
let tray = null;
let isQuitting = false;
let msLoginInProgress = false;

function getSecretKeyMaterial() {
  try {
    const user = String(os.userInfo?.().username || '').toLowerCase();
    const host = String(os.hostname?.() || '').toLowerCase();
    const ud = String(app.getPath('userData') || '').toLowerCase();
    return `${user}|${host}|${ud}`;
  } catch (_) {
    return String(app.getPath('userData') || '');
  }
}

const _csDec = (s) => Buffer.from(s, 'base64').toString('utf8');
const _csWs = 'd3M6Ly81MS4yMjIuMjA3LjE4Njo2Nzk4';
const _csHttp = 'aHR0cDovLzUxLjIyMi4yMDcuMTg2OjMwMTE=';
const _csKp = ['aGVlcGg=','bGF1bmNoZXI=','djE=','MjAyNQ=='];
function _csGetKey() {
  const parts = _csKp.map(s => _csDec(s));
  const base = parts.join('-') + '-' + String(app.getName() || '').slice(0, 6);
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 32);
}

function getCosmeticsServerCfg(cfg) {
  try {
    const cs = (cfg && typeof cfg === 'object' && cfg.cosmeticsServer && typeof cfg.cosmeticsServer === 'object')
      ? cfg.cosmeticsServer
      : {};
    const wsUrl = String(cs.wsUrl || '').trim() || _csDec(_csWs);
    const httpBase = String(cs.httpBase || '').trim() || _csDec(_csHttp);
    return { wsUrl, httpBase };
  } catch (_) {
    return { wsUrl: _csDec(_csWs), httpBase: _csDec(_csHttp) };
  }
}

function generateWsAuth(username, uuid) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const key = _csGetKey();
  const payload = `${username}:${uuid}:${ts}:${nonce}`;
  const sig = crypto.createHmac('sha256', key).update(payload).digest('hex');
  return { 'X-Auth-Token': sig, 'X-Auth-Timestamp': ts, 'X-Auth-Nonce': nonce, 'X-Client-Id': 'heeph-launcher' };
}

function getActivePlayerIdentity() {
  bootstrapClientFiles();
  const cfgPath = path.join(getClientDir(), 'config.json');
  const cfg = normalizeAccountsConfig(readJson(cfgPath, null) || {});
  const active = getActiveAccount(cfg);
  const name = String(active?.name || cfg.username || '').trim();
  const uuid = String(active?.uuid || '').trim() || (name ? createOfflineUuid(name) : '');
  return { name, uuid, cfg };
}

function parseCosmeticsPacket(buf) {
  if (!ensureCosmeticsDeps()) return null;
  const b = ByteBuffer.wrap(buf);
  const packetId = b.readVarint32();
  if (packetId !== 8) return null;
  const uuid = b.readVString();
  const count = b.readInt();
  const cosmetics = [];
  for (let i = 0; i < count; i++) {
    try {
      b.readLong();
      const scale = b.readFloat();
      const equipped = String(b.readByte()) === '1';
      const resourceLocation = b.readVString();
      const name = b.readVString();
      const type = b.readVString();
      cosmetics.push({ name, type, scale, equipped, resourceLocation });
    } catch (_) {
      break;
    }
  }
  // trailing fields
  try {
    const username = b.readVString();
    b.readByte();
    b.readInt();
    b.readInt();
    const physics = String(b.readByte()) === '1';
    return { uuid, username, physics, cosmetics };
  } catch (_) {
    return { uuid, username: '', physics: false, cosmetics };
  }
}

function buildEquipPacket(selected) {
  if (!ensureCosmeticsDeps()) return Buffer.alloc(0);
  const items = Array.isArray(selected) ? selected.filter(Boolean) : [];
  const bb = new ByteBuffer();
  bb.writeVarint32(20);
  bb.writeInt(items.length);
  for (const it of items) {
    bb.writeLong(1);
    bb.writeByte(1);
    bb.writeVString(String(it.name || ''));
    bb.writeVString(String(it.type || ''));
    bb.writeFloat(Number(it.scale || 0) || 0);
    bb.writeVString(String(it.resourceLocation || ''));
  }
  bb.flip();
  return Buffer.from(bb.toBuffer());
}

async function cosmeticsFetchForActivePlayer() {
  if (!ensureCosmeticsDeps()) return { ok: false, msg: 'Cosmetics deps missing. Run npm install.' };
  const { name, uuid, cfg } = getActivePlayerIdentity();
  if (!name || !uuid) return { ok: false, msg: 'Conta não configurada.' };
  const { wsUrl, httpBase } = getCosmeticsServerCfg(cfg);
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let ws;
    try {
      ws = new WebSocket(wsUrl, {
        headers: {
          username: name,
          playerid: uuid,
          version: 'launcher',
          ...generateWsAuth(name, uuid),
        }
      });
    } catch (e) {
      return finish({ ok: false, msg: e?.message || String(e) });
    }

    const timer = setTimeout(() => {
      try { ws?.close?.(); } catch (_) {}
      finish({ ok: false, msg: 'Timeout ao conectar no cosmetics server.' });
    }, 6500);

    ws.on('message', (message) => {
      try {
        const parsed = parseCosmeticsPacket(message);
        if (!parsed) return;
        clearTimeout(timer);
        try { ws.close(); } catch (_) {}

        const capes = [];
        const wings = [];
        for (const c of (parsed.cosmetics || [])) {
          const t = String(c.type || '').toLowerCase();
          const rl = String(c.resourceLocation || '');
          const file = rl.split('/').pop() || '';
          if (!file) continue;
          const base = httpBase.replace(/\/$/, '');
          if (t === 'cape' || t === 'capes' || t === 'capa' || t === 'capas') {
            capes.push({ ...c,
              textureUrl: `${base}/api/capes/${encodeURIComponent(file)}`,
              previewUrl: `${base}/api/previews/capes/${encodeURIComponent(file)}`,
            });
          } else {
            wings.push({ ...c,
              textureUrl: `${base}/api/wings/${encodeURIComponent(file)}`,
              previewUrl: `${base}/api/previews/wings/${encodeURIComponent(file)}`,
            });
          }
        }
        finish({ ok: true, player: { username: parsed.username || name, uuid }, capes, wings });
      } catch (_) {}
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, msg: err?.message || String(err) });
    });
    ws.on('close', () => {
      // if closed before any packet
      clearTimeout(timer);
      if (!done) finish({ ok: false, msg: 'Conexão fechada.' });
    });
  });
}

async function cosmeticsEquipForActivePlayer({ cape, wing } = {}) {
  if (!ensureCosmeticsDeps()) return { ok: false, msg: 'Cosmetics deps missing. Run npm install.' };
  const { name, uuid, cfg } = getActivePlayerIdentity();
  if (!name || !uuid) return { ok: false, msg: 'Conta não configurada.' };
  const { wsUrl } = getCosmeticsServerCfg(cfg);
  const selected = [];
  if (cape && typeof cape === 'object') selected.push(cape);
  if (wing && typeof wing === 'object') selected.push(wing);
  const payload = buildEquipPacket(selected);

  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let ws;
    try {
      ws = new WebSocket(wsUrl, {
        headers: {
          username: name,
          playerid: uuid,
          version: 'launcher',
          ...generateWsAuth(name, uuid),
        }
      });
    } catch (e) {
      return finish({ ok: false, msg: e?.message || String(e) });
    }

    const timer = setTimeout(() => {
      try { ws?.close?.(); } catch (_) {}
      finish({ ok: false, msg: 'Timeout ao equipar cosmetics.' });
    }, 6500);

    ws.on('open', () => {
      try { ws.send(payload); } catch (e) {}
      // We don't need to wait for a response packet; server persists equipped.
      setTimeout(() => {
        try { ws.close(); } catch (_) {}
        clearTimeout(timer);
        finish({ ok: true });
      }, 250);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, msg: err?.message || String(err) });
    });
  });
}

function encryptLocalSecret(plain) {
  try {
    const txt = String(plain || '').trim();
    if (!txt) return '';
    const iv = crypto.randomBytes(12);
    const key = crypto.createHash('sha256').update(getSecretKeyMaterial(), 'utf8').digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(txt, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  } catch (_) {
    return '';
  }
}

function decryptLocalSecret(enc) {
  try {
    const raw = String(enc || '').trim();
    if (!raw) return '';
    if (!raw.startsWith('v1:')) return raw;
    const parts = raw.split(':');
    if (parts.length !== 4) return '';
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');
    const key = crypto.createHash('sha256').update(getSecretKeyMaterial(), 'utf8').digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch (_) {
    return '';
  }
}

function isSafeExternalUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:') return false;
    // allow localhost for dev
    const host = String(u.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return true;
    // Default allowlist for external links we intentionally open
    const allow = new Set([
      'modrinth.com',
      'www.modrinth.com',
      'minecraft.net',
      'www.minecraft.net',
      'microsoft.com',
      'www.microsoft.com',
      'login.live.com',
      'account.live.com',
      'github.com',
      'discord.com',
      'heeph.com',
      'www.heeph.com',
    ]);
    return allow.has(host);
  } catch (_) {
    return false;
  }
}

function importServersDatFromMinecraft(gameDir, mcDir) {
  try {
    const src = path.join(mcDir, 'servers.dat');
    const dest = path.join(gameDir, 'servers.dat');
    if (!fs.existsSync(src)) return;
    if (fs.existsSync(dest)) return;
    ensureDir(gameDir);
    fs.copyFileSync(src, dest);
  } catch (_) {}
}

function sendLauncherUpdate(payload) {
  try { win?.webContents?.send?.('launcher-update', payload); } catch (_) {}
}

function getAppSettings() {
  bootstrapClientFiles();
  const cfgPath = path.join(getClientDir(), 'config.json');
  const cfg = readJson(cfgPath, null) || {};
  const notifications = cfg.notifications && typeof cfg.notifications === 'object' ? cfg.notifications : {};
  const discordNews = cfg.discordNews && typeof cfg.discordNews === 'object' ? cfg.discordNews : {};
  const security = cfg.security && typeof cfg.security === 'object' ? cfg.security : {};
  return {
    notifications: {
      enabled: (notifications.enabled !== false),
    },
    discordNews: {
      botToken: (() => { const t = String(discordNews.botToken || ''); return t.startsWith('v1:') ? (decryptLocalSecret(t) || '') : t; })(),
      guildId: String(discordNews.guildId || ''),
      newsChannelId: String(discordNews.newsChannelId || ''),
      changelogChannelId: String(discordNews.changelogChannelId || ''),
      limit: Number(discordNews.limit || 8) || 8,
    },
    security: {
      allowInsecureHttp: !!security.allowInsecureHttp,
      allowedUpdateHosts: Array.isArray(security.allowedUpdateHosts) ? security.allowedUpdateHosts.map(String) : [],
    }
  };
}

function setAppSettings(patch) {
  bootstrapClientFiles();
  const cfgPath = path.join(getClientDir(), 'config.json');
  const cfg = readJson(cfgPath, null) || {};
  if (patch && typeof patch === 'object') {
    if (patch.notifications && typeof patch.notifications === 'object') {
      cfg.notifications = cfg.notifications && typeof cfg.notifications === 'object' ? cfg.notifications : {};
      if (typeof patch.notifications.enabled === 'boolean') cfg.notifications.enabled = patch.notifications.enabled;
    }
    if (patch.discordNews && typeof patch.discordNews === 'object') {
      cfg.discordNews = cfg.discordNews && typeof cfg.discordNews === 'object' ? cfg.discordNews : {};
      if (typeof patch.discordNews.botToken === 'string') {
        const raw = patch.discordNews.botToken.trim();
        cfg.discordNews.botToken = raw ? (encryptLocalSecret(raw) || raw) : '';
      }
      if (typeof patch.discordNews.guildId === 'string') cfg.discordNews.guildId = patch.discordNews.guildId;
      if (typeof patch.discordNews.newsChannelId === 'string') cfg.discordNews.newsChannelId = patch.discordNews.newsChannelId;
      if (typeof patch.discordNews.changelogChannelId === 'string') cfg.discordNews.changelogChannelId = patch.discordNews.changelogChannelId;
      if (typeof patch.discordNews.limit === 'number') cfg.discordNews.limit = patch.discordNews.limit;
    }
    if (patch.security && typeof patch.security === 'object') {
      cfg.security = cfg.security && typeof cfg.security === 'object' ? cfg.security : {};
      if (typeof patch.security.allowInsecureHttp === 'boolean') cfg.security.allowInsecureHttp = patch.security.allowInsecureHttp;
      if (typeof patch.security.allowedUpdateHosts === 'string') {
        const list = patch.security.allowedUpdateHosts
          .split(',')
          .map(s => String(s || '').trim())
          .filter(Boolean);
        cfg.security.allowedUpdateHosts = list;
      }
    }
  }
  writeJson(cfgPath, cfg);
  return getAppSettings();
}

function safeEmptyDir(dir) {
  try {
    if (!dir) return;
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
    }
  } catch (_) {}
}

async function fetchBuffer(url, { headers = {}, allowInsecureHttp = false, allowedUpdateHosts = [], maxRedirects = 5 } = {}) {
  let curUrl = url;
  let redirectsLeft = Math.max(0, Number(maxRedirects || 0));
  while (true) {
    validateHttpUrlOrThrow(curUrl, { allowInsecureHttp, allowedUpdateHosts });
    const res = await new Promise((resolve) => {
      try {
        const req = net.request({ method: 'GET', url: curUrl, headers });
        const chunks = [];
        req.on('response', (r) => {
          const code = Number(r.statusCode || 0);
          if (isRedirectStatus(code)) {
            const loc = String(r.headers?.location || '').trim();
            return resolve({ status: code, redirect: resolveRedirectUrl(curUrl, loc) });
          }
          r.on('data', (c) => { chunks.push(Buffer.from(c)); });
          r.on('end', () => resolve({ status: code, data: Buffer.concat(chunks) }));
        });
        req.on('error', (e) => resolve({ status: 0, error: e.message }));
        req.end();
      } catch (e) {
        resolve({ status: 0, error: e.message });
      }
    });
    if (!res) throw new Error('HTTP ERR');
    if (res.error) throw new Error(res.error);
    if (isRedirectStatus(res.status)) {
      if (redirectsLeft <= 0) throw new Error('Redirect infinito (maxRedirects atingido)');
      if (!res.redirect) throw new Error('Redirect sem Location válido');
      redirectsLeft -= 1;
      curUrl = res.redirect;
      continue;
    }
    if (res.status >= 400) throw new Error(`HTTP ${res.status || 'ERR'}`);
    return { status: res.status, data: res.data, finalUrl: curUrl };
  }
}


function getMsAuthCacheDir() {
  return path.join(getClientDir(), 'cache', 'ms-auth');
}

function normalizeAccountsConfig(cfg) {
  const next = cfg && typeof cfg === 'object' ? cfg : {};
  if (!Array.isArray(next.accounts)) next.accounts = [];
  if (next.microsoftAccount && next.accounts.length === 0) {
    const ms = next.microsoftAccount;
    const name = String(ms?.name || '').trim();
    const uuid = String(ms?.uuid || '').trim();
    const accessToken = String(ms?.accessToken || '').trim();
    if (name && uuid) {
      next.accounts.push({
        id: `ms:${uuid}`,
        type: 'microsoft',
        name,
        uuid,
        accessToken,
        cacheKey: `ms:${uuid}`,
        updatedAt: Number(ms?.updatedAt || 0) || Date.now(),
      });
      if (!next.activeAccountId) next.activeAccountId = `ms:${uuid}`;
    }
  }
  // Ensure cacheKey exists for microsoft accounts
  if (Array.isArray(next.accounts)) {
    next.accounts = next.accounts.map(a => {
      if (!a || typeof a !== 'object') return a;
      if (String(a.type || '') !== 'microsoft') return a;
      if (a.cacheKey) return a;
      const fallback = String(a.id || a.uuid || 'heeph-client');
      return { ...a, cacheKey: fallback };
    });
  }
  return next;
}

function getActiveAccount(cfg) {
  const c = normalizeAccountsConfig(cfg);
  const id = String(c.activeAccountId || '').trim();
  const list = Array.isArray(c.accounts) ? c.accounts : [];
  let acct = null;
  if (id) acct = list.find(a => String(a?.id || '') === id) || null;
  if (!acct) acct = list.find(a => a?.type === 'microsoft') || null;
  if (acct && acct.accessToken) {
    const raw = String(acct.accessToken || '');
    if (raw.startsWith('v1:')) {
      try { acct = { ...acct, accessToken: decryptLocalSecret(raw) }; } catch (_) {}
    }
  }
  return acct;
}

function upsertOfflineAccount(cfg, username) {
  const c = normalizeAccountsConfig(cfg);
  const name = String(username || '').trim();
  if (!name || name.length > 16 || !/^[a-zA-Z0-9_]+$/.test(name)) return { cfg: c, account: null };

  const list = Array.isArray(c.accounts) ? c.accounts : [];
  const existing = list.find(a => String(a?.type || '') === 'offline' && String(a?.name || '').trim().toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.updatedAt = Date.now();
    c.activeAccountId = String(existing.id || '') || c.activeAccountId;
    c.username = String(existing.name || c.username || '');
    return { cfg: c, account: existing };
  }

  const baseId = `offline:${name.replace(/\s+/g, ' ').trim()}`;
  let id = baseId;
  let i = 2;
  while (list.some(a => String(a?.id || '') === id)) {
    id = `${baseId}#${i++}`;
  }

  const acc = { id, type: 'offline', name, uuid: '', updatedAt: Date.now() };
  c.accounts.push(acc);
  c.activeAccountId = id;
  c.username = name;
  return { cfg: c, account: acc };
}

function getOfflineSkinForUsername(cfg, username) {
  const u = String(username || '').trim();
  if (!u) return '';
  const map = (cfg && typeof cfg === 'object') ? cfg.offlineSkins : null;
  if (!map || typeof map !== 'object') return '';
  const key = u.toLowerCase();
  const f = map[key];
  return String(f || '').trim();
}

async function ensureMicrosoftAccountLogin() {
  bootstrapClientFiles();
  const root = getClientDir();
  const cfgPath = path.join(root, 'config.json');
  const cfg = normalizeAccountsConfig(readJson(cfgPath, null) || {});

  // Create a new cache key for this login so multiple accounts can coexist.
  const pendingCacheKey = `ms:pending:${crypto.randomBytes(8).toString('hex')}`;

  const cacheDir = getMsAuthCacheDir();
  ensureDir(cacheDir);

  const codeCallback = (resp) => {
    try {
      win?.webContents?.send?.('ms-device-code', {
        verificationUri: String(resp?.verification_uri || resp?.verificationUri || ''),
        userCode: String(resp?.user_code || resp?.userCode || ''),
        message: String(resp?.message || ''),
        expiresIn: Number(resp?.expires_in || resp?.expiresIn || 0) || 0,
      });
    } catch (_) {}
  };

  const tryFlow = async (flowName) => {
    const opts = {
      flow: flowName,
      forceRefresh: true,
      authTitle: Titles.MinecraftJava,
      deviceType: 'Win32',
    };
    // Use per-account cache key (uuid) so multiple accounts can coexist.
    const flow = new Authflow(pendingCacheKey, cacheDir, opts, codeCallback);
    return await flow.getMinecraftJavaToken({ fetchProfile: true, fetchEntitlements: true });
  };

  // Request a Minecraft access token + profile
  let mcToken;
  let lastErr = null;
  try {
    mcToken = await tryFlow('live');
  } catch (e) {
    lastErr = e;
    const msg = String(e?.message || e || '');
    if (/\b403\b/.test(msg) || /forbidden/i.test(msg)) {
      // Some accounts are blocked on live flow - try sisu flow as fallback
      try {
        mcToken = await tryFlow('sisu');
        lastErr = null;
      } catch (e2) {
        lastErr = e2;
      }
    }
  }

  if (!mcToken) {
    const msg = String(lastErr?.message || lastErr || '');
    if (/invalid_grant/i.test(msg)) {
      throw new Error('Microsoft login expired/was denied. Please try again and confirm the code in your browser.');
    }
    if (/\b403\b/.test(msg) || /forbidden/i.test(msg)) {
      throw new Error('Microsoft blocked authentication (403). Sometimes the Java API blocks certain accounts. Try again; if it persists, try another account.');
    }
    throw new Error(msg || 'Microsoft login failed');
  }

  const ent = mcToken?.entitlements || null;
  const items = Array.isArray(ent?.items) ? ent.items : [];
  if (ent && items.length === 0) {
    throw new Error('This account does not own Minecraft: Java Edition (no entitlement).');
  }
  const accessToken = String(mcToken?.token || '').trim();
  const profile = mcToken?.profile || null;
  const uuid = String(profile?.id || '').trim();
  const name = String(profile?.name || '').trim();
  if (!accessToken || !uuid || !name) throw new Error('Microsoft login failed (empty token/profile)');

  const id = `ms:${uuid}`;
  const encToken = encryptLocalSecret(accessToken) || accessToken;
  const acct = {
    id,
    type: 'microsoft',
    name,
    uuid,
    accessToken: encToken,
    cacheKey: pendingCacheKey,
    updatedAt: Date.now(),
  };
  cfg.accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const idx = cfg.accounts.findIndex(a => String(a?.id || '') === id);
  if (idx >= 0) cfg.accounts[idx] = { ...cfg.accounts[idx], ...acct };
  else cfg.accounts.push(acct);
  cfg.activeAccountId = id;

  // Keep legacy field for compatibility with older renderer builds.
  cfg.microsoftAccount = { name, uuid, accessToken: encToken, updatedAt: Date.now() };
  if (!cfg.username) cfg.username = name;
  writeJson(cfgPath, cfg);

  return { ok: true, id, name, uuid };
}

function configureLauncherAutoUpdate() {
  try {
    if (!app.isPackaged) return;
    const cfg = readJson(path.join(getClientDir(), 'config.json'), null) || {};
    const customUrl = String(cfg?.launcherUpdateUrl || '').trim().replace(/\/+$/, '');

    autoUpdater.autoDownload = true;
    if (customUrl) {
      autoUpdater.setFeedURL({ provider: 'generic', url: customUrl.endsWith('/') ? customUrl : (customUrl + '/') });
    } else {
      autoUpdater.setFeedURL({ provider: 'github', owner: 'mcypreste', repo: 'heeph-launcher' });
    }

    autoUpdater.on('checking-for-update', () => sendLauncherUpdate({ stage: 'checking' }));
    autoUpdater.on('update-available', (info) => sendLauncherUpdate({ stage: 'available', info }));
    autoUpdater.on('update-not-available', (info) => sendLauncherUpdate({ stage: 'none', info }));
    autoUpdater.on('error', (err) => sendLauncherUpdate({ stage: 'error', msg: err?.message || String(err) }));
    autoUpdater.on('download-progress', (p) => {
      sendLauncherUpdate({
        stage: 'downloading',
        percent: Number(p?.percent || 0),
        transferred: Number(p?.transferred || 0),
        total: Number(p?.total || 0),
        bytesPerSecond: Number(p?.bytesPerSecond || 0),
      });
    });
    autoUpdater.on('update-downloaded', (info) => sendLauncherUpdate({ stage: 'downloaded', info }));

    // Trigger on launch
    autoUpdater.checkForUpdates().catch(() => {});
  } catch (_) {}
}

function getLogsDir() {
  const d = path.join(getClientDir(), 'logs');
  ensureDir(d);
  return d;
}

function openLaunchLog(kind) {
  const safeKind = String(kind || 'launch').replace(/[^a-z0-9_-]/gi, '');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(getLogsDir(), `${safeKind}-${stamp}.log`);
  // Write a small header so it's easier to spot the file
  try { fs.writeFileSync(file, `[${new Date().toISOString()}] ${safeKind}\n`); } catch (_) {}
  const fd = fs.openSync(file, 'a');
  return { file, fd };
}

function resolveJavaCmd(cfg) {
  try {
    const raw = String(cfg?.javaPath || '').trim();
    if (raw) {
      const expanded = raw.replace(/%([^%]+)%/g, (_m, k) => process.env[String(k)] || _m);
      if (fs.existsSync(expanded)) return expanded;
      // If the user provided a command name (e.g. javaw), allow it.
      return raw;
    }
  } catch (_) {}

  // Default Java for Heeph (Windows): Amazon Corretto 21
  try {
    if (process.platform === 'win32') {
      const p = 'C:\\Program Files\\Amazon Corretto\\jdk21.0.10_7\\bin\\javaw.exe';
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return process.platform === 'win32' ? 'javaw' : 'java';
}

function tryRestoreWindowForPid(pid) {
  try {
    if (process.platform !== 'win32') return;
    const procId = Number(pid || 0);
    if (!procId) return;

    const script = `$src = @'\nusing System;\nusing System.Text;\nusing System.Runtime.InteropServices;\npublic static class Win32 {\n  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);\n  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);\n  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);\n  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);\n  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);\n  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n  [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\n  [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);\n}\n'@;\nAdd-Type -TypeDefinition $src -ErrorAction SilentlyContinue | Out-Null;\n$procId = [uint32]${procId};\n$best = $null;\n$fallback = $null;\n [Win32]::EnumWindows({ param([IntPtr]$hWnd, [IntPtr]$lParam) $wpid = 0; [Win32]::GetWindowThreadProcessId($hWnd, [ref]$wpid) | Out-Null; if($wpid -eq $procId){ $sb = New-Object System.Text.StringBuilder 512; [Win32]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null; $t = $sb.ToString(); if($t -and $t.Trim().Length -gt 0){ if($t -match 'Minecraft'){ $script:best = $hWnd } if($null -eq $script:fallback){ $script:fallback = $hWnd } } } return $true }, [IntPtr]::Zero) | Out-Null;\n$target = $best; if($null -eq $target){ $target = $fallback }\nif($null -ne $target){\n  # Restore + show + bring to front (topmost toggle helps when focus stealing is blocked)\n  [Win32]::ShowWindow([IntPtr]$target, 9) | Out-Null;\n  [Win32]::ShowWindow([IntPtr]$target, 5) | Out-Null;\n  [Win32]::SetForegroundWindow([IntPtr]$target) | Out-Null;\n  $HWND_TOPMOST = [IntPtr](-1); $HWND_NOTOPMOST = [IntPtr](-2);\n  $SWP_NOMOVE = 0x0002; $SWP_NOSIZE = 0x0001; $SWP_SHOWWINDOW = 0x0040;\n  [Win32]::SetWindowPos([IntPtr]$target, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW) | Out-Null;\n  [Win32]::SetWindowPos([IntPtr]$target, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW) | Out-Null;\n  [Win32]::SetForegroundWindow([IntPtr]$target) | Out-Null;\n}`;

    spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch (_) {}
}

function restoreMinecraftWindows(pid) {
  try {
    if (process.platform !== 'win32') return;
    const p = Number(pid || 0);
    if (!p) return;
    // Minecraft sometimes creates the window a bit later; retry a few times.
    tryRestoreWindowForPid(p);
    setTimeout(() => tryRestoreWindowForPid(p), 1000);
    setTimeout(() => tryRestoreWindowForPid(p), 3000);
    setTimeout(() => tryRestoreWindowForPid(p), 6000);
  } catch (_) {}
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

function atomicWriteFile(targetPath, buf) {
  ensureDir(path.dirname(targetPath));
  const tmpPath = `${targetPath}.tmp`;
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, targetPath);
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function stopHeephGame() {
  const pid = heephPid || heephProc?.pid || 0;
  if (!pid) return;

  try {
    if (heephProc && !heephProc.killed) {
      try { heephProc.kill(); } catch (_) {}
    }

    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch (_) {}
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    }
  } finally {
    heephProc = null;
    heephStartedAt = 0;
    heephPid = 0;
  }
}

function getClientDir() {
  return path.join(app.getPath('appData'), '.heephclient');
}

function getLegacyClientDir() {
  return path.join(os.homedir(), '.heephclient');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function stableStringify(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  if (typeof obj !== 'object') return JSON.stringify(obj);
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function isHttpUrl(u) {
  return /^https?:\/\//i.test(u || '');
}

function isHttpsUrl(u) {
  return /^https:\/\//i.test(u || '');
}

function getUrlHost(u) {
  try {
    return new URL(u).host;
  } catch (_) {
    return '';
  }
}

function isAllowedHost(url, allowedHosts) {
  if (!isHttpUrl(url)) return true;
  const host = getUrlHost(url);
  if (!host) return false;
  const list = Array.isArray(allowedHosts) ? allowedHosts.filter(Boolean).map(String) : [];
  if (list.length === 0) return true; // default: allow all (config optional)
  return list.includes(host);
}

function verifyManifestSignature(manifest, publicKeyPem) {
  if (!publicKeyPem) return { ok: true };
  const sigB64 = String(manifest?.sig || manifest?.signature || '').trim();
  if (!sigB64) return { ok: false, msg: 'Manifest has no signature (sig)' };

  const clone = { ...manifest };
  delete clone.sig;
  delete clone.signature;

  const data = Buffer.from(stableStringify(clone), 'utf8');
  let sig;
  try {
    sig = Buffer.from(sigB64, 'base64');
  } catch (_) {
    return { ok: false, msg: 'Invalid signature (base64)' };
  }

  try {
    const ok = crypto.verify(null, data, publicKeyPem, sig);
    return ok ? { ok: true } : { ok: false, msg: 'Invalid manifest signature' };
  } catch (e) {
    return { ok: false, msg: `Signature verification failed: ${e.message}` };
  }
}

function ensureJsonFile(filePath, defaultValue) {
  if (fs.existsSync(filePath)) return;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
}

function ensureTextFile(filePath, defaultValue = '') {
  if (fs.existsSync(filePath)) return;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, defaultValue, 'utf8');
}

function bootstrapClientFiles() {
  const root = getClientDir();
  const legacyRoot = getLegacyClientDir();

  const hadRootBefore = fs.existsSync(root);
  const canMigrateLegacy = (!hadRootBefore && fs.existsSync(legacyRoot));

  if (!fs.existsSync(root) && fs.existsSync(legacyRoot)) {
    try {
      fs.cpSync(legacyRoot, root, { recursive: true });
    } catch (_) {}
  }

  ensureDir(root);
  ensureDir(path.join(root, 'logs'));
  ensureDir(path.join(root, 'cache'));

  const defaultUpdateManifestUrl = 'https://github.com/mcypreste/heeph-launcher-updates/releases/latest/download/manifest.json';

  const bundledManifestPath = (() => {
    try {
      const candidates = [
        path.join(app.getAppPath(), 'updates-vercel', 'manifest.json'),
        path.join(process.resourcesPath || '', 'updates-vercel', 'manifest.json'),
      ];
      for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
      }
    } catch (_) {}
    return '';
  })();

  ensureJsonFile(path.join(root, 'config.json'), {
    version: 1,
    createdAt: new Date().toISOString(),
    username: '',
    ram: 2048,
    launcherSettings: {
      hardwareAcceleration: true,
      exitToTray: true,
      language: 'auto',
      lowEndMode: false,
    },
    notifications: {
      enabled: true,
    },
    updateManifestUrl: defaultUpdateManifestUrl || bundledManifestPath || '',
    discordNews: {
      botToken: '',
      guildId: '',
      newsChannelId: '',
      changelogChannelId: '',
      limit: 8
    },
    security: {
      allowInsecureHttp: false,
      allowedUpdateHosts: [],
      manifestPublicKeyPem: ''
    },
    authlibInjector: {
      enabled: false,
      apiRoot: 'https://authserver.ely.by/',
      injectorUrl: 'bundled',
      injectorSha256: '',
      noShowServerName: true,
      noLogFile: true
    },
    installedHeeph: {
      versionId: 'heeph-1.8.9',
      installedVersion: ''
    },
    heephSkinServer: {
      url: 'https://heeph-skin-server.onrender.com',
      uploadSecret: 'f+nGP6GVozScAqP1xrTxMUwsPqqdHhKl5RPA0Jhgn7Q='
    }
  });
  ensureJsonFile(path.join(root, 'accounts.json'), { version: 1, active: null, accounts: {} });
  ensureJsonFile(path.join(root, 'profiles.json'), { version: 1, profiles: {} });
  ensureTextFile(path.join(root, 'notes.txt'), '');

  seedDefaultSkins(root);
  migrateSkinServerConfig(root);

  // If the user removed/uninstalled the client data directory, force Microsoft logout on next boot.
  // (We only do this on a true fresh recreation; if we migrated legacy data, we keep accounts.)
  if (!hadRootBefore && !canMigrateLegacy) {
    try {
      // Remove cached authflow tokens
      fs.rmSync(getMsAuthCacheDir(), { recursive: true, force: true });
    } catch (_) {}

    try {
      const cfgPath = path.join(root, 'config.json');
      const cfg = normalizeAccountsConfig(readJson(cfgPath, null) || {});
      const activeId = String(cfg.activeAccountId || '').trim();
      cfg.microsoftAccount = null;
      cfg.accounts = Array.isArray(cfg.accounts) ? cfg.accounts.filter(a => String(a?.type || '') !== 'microsoft') : [];
      if (activeId && /^ms:/i.test(activeId)) {
        cfg.activeAccountId = '';
      }
      writeJson(cfgPath, cfg);
    } catch (_) {}
  }
}

function getLauncherSettings() {
  bootstrapClientFiles();
  const cfgPath = path.join(getClientDir(), 'config.json');
  const cfg = readJson(cfgPath, null) || {};
  const s = cfg.launcherSettings && typeof cfg.launcherSettings === 'object' ? cfg.launcherSettings : {};
  const hardwareAcceleration = (s.hardwareAcceleration !== false);
  const exitToTray = (s.exitToTray !== false);
  const language = String(s.language || 'auto');
  const lowEndMode = !!s.lowEndMode;
  return { hardwareAcceleration, exitToTray, language, lowEndMode };
}

function setLauncherSettings(patch) {
  bootstrapClientFiles();
  const cfgPath = path.join(getClientDir(), 'config.json');
  const cfg = readJson(cfgPath, null) || {};
  if (!cfg.launcherSettings || typeof cfg.launcherSettings !== 'object') cfg.launcherSettings = {};
  if (patch && typeof patch === 'object') {
    if (typeof patch.hardwareAcceleration === 'boolean') cfg.launcherSettings.hardwareAcceleration = patch.hardwareAcceleration;
    if (typeof patch.exitToTray === 'boolean') cfg.launcherSettings.exitToTray = patch.exitToTray;
    if (typeof patch.language === 'string') cfg.launcherSettings.language = patch.language;
    if (typeof patch.lowEndMode === 'boolean') cfg.launcherSettings.lowEndMode = patch.lowEndMode;
  }
  writeJson(cfgPath, cfg);
  const next = getLauncherSettings();
  return next;
}

function migrateSkinServerConfig(root) {
  const cfgPath = path.join(root, 'config.json');
  try {
    const cfg = readJson(cfgPath, null);
    if (!cfg) return;

    let changed = false;
    const defaultUrl = 'https://heeph-skin-server.onrender.com';

    if (!cfg.heephSkinServer) cfg.heephSkinServer = {};

    if (cfg.heephSkinServer.url && typeof cfg.heephSkinServer.url === 'string') {
      const normalized = cfg.heephSkinServer.url
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/api\/news$/i, '')
        .replace(/\/api$/i, '')
        .replace(/\/+$/, '');
      if (normalized !== cfg.heephSkinServer.url) {
        cfg.heephSkinServer.url = normalized;
        changed = true;
      }
    }

    if (cfg.heephSkinServer.url && typeof cfg.heephSkinServer.url === 'string') {
      const u = cfg.heephSkinServer.url.trim();
      if (/^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?$/i.test(u)) {
        cfg.heephSkinServer.url = defaultUrl;
        changed = true;
      }
    }

    if (!cfg.heephSkinServer.url || cfg.heephSkinServer.url.trim() === '') {
      cfg.heephSkinServer.url = defaultUrl;
      changed = true;
    }

    // Ensure uploadSecret has a default value
    const defaultSecret = 'f+nGP6GVozScAqP1xrTxMUwsPqqdHhKl5RPA0Jhgn7Q=';
    if (!cfg.heephSkinServer.uploadSecret || String(cfg.heephSkinServer.uploadSecret).trim() === '') {
      cfg.heephSkinServer.uploadSecret = defaultSecret;
      changed = true;
    }

    // Encrypt uploadSecret at rest (if user previously saved it in plaintext)
    try {
      if (typeof cfg.heephSkinServer.uploadSecret === 'string') {
        const raw = cfg.heephSkinServer.uploadSecret.trim();
        if (raw && !raw.startsWith('v1:')) {
          const enc = encryptLocalSecret(raw);
          if (enc) {
            cfg.heephSkinServer.uploadSecret = enc;
            changed = true;
          }
        }
      }
    } catch (_) {}

    // Encrypt Discord botToken at rest
    try {
      if (cfg.discordNews && typeof cfg.discordNews === 'object') {
        const bt = String(cfg.discordNews.botToken || '').trim();
        if (bt && !bt.startsWith('v1:')) {
          const enc = encryptLocalSecret(bt);
          if (enc) { cfg.discordNews.botToken = enc; changed = true; }
        }
      }
    } catch (_) {}

    // Encrypt accessTokens at rest (migrate plaintext tokens)
    try {
      const accts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
      for (let i = 0; i < accts.length; i++) {
        const tk = String(accts[i]?.accessToken || '').trim();
        if (tk && !tk.startsWith('v1:')) {
          const enc = encryptLocalSecret(tk);
          if (enc) { accts[i].accessToken = enc; changed = true; }
        }
      }
      if (cfg.microsoftAccount && typeof cfg.microsoftAccount === 'object') {
        const msTk = String(cfg.microsoftAccount.accessToken || '').trim();
        if (msTk && !msTk.startsWith('v1:')) {
          const enc = encryptLocalSecret(msTk);
          if (enc) { cfg.microsoftAccount.accessToken = enc; changed = true; }
        }
      }
    } catch (_) {}
    
    if (changed) {
      writeJson(cfgPath, cfg);
    }
  } catch (_) {}
}

function getBundledDefaultSkinsDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'default-skins');
  return path.join(__dirname, '..', 'resources', 'default-skins');
}

function seedDefaultSkins(root) {
  const skinsDir = path.join(root, 'skins');
  ensureDir(skinsDir);
  const srcDir = getBundledDefaultSkinsDir();
  if (!fs.existsSync(srcDir)) return;
  try {
    const files = fs.readdirSync(srcDir).filter(f => /\.png$/i.test(f));
    for (const f of files) {
      const dest = path.join(skinsDir, f);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(srcDir, f), dest);
      }
    }
  } catch (_) {}
}

function readJson(filePath, fallback) {
  try {
    let txt = fs.readFileSync(filePath, 'utf8');
    // Be resilient to UTF-8 BOM / odd encodings (common when edited by PowerShell)
    if (txt && txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
    txt = String(txt).replace(/^\uFEFF/, '').replace(/\u0000/g, '');
    return JSON.parse(txt);
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getGameDir() {
  return path.join(getClientDir(), 'minecraft');
}

function ensureSharedResourcepacks(gameDir, mcDir) {
  try {
    const src = path.join(mcDir, 'resourcepacks');
    const dest = path.join(gameDir, 'resourcepacks');
    if (!fs.existsSync(src)) return;
    if (fs.existsSync(dest)) return;

    // Prefer directory junction on Windows so resource packs are shared.
    // If it fails (permissions), just create the folder (user can copy manually).
    try {
      if (process.platform === 'win32') {
        fs.symlinkSync(src, dest, 'junction');
        return;
      }
      fs.symlinkSync(src, dest);
    } catch (_) {
      ensureDir(dest);
    }
  } catch (_) {}
}

function syncMcOptionsFromMinecraft(gameDir, mcDir) {
  const files = ['options.txt', 'optionsof.txt'];
  for (const f of files) {
    try {
      const src = path.join(mcDir, f);
      const dest = path.join(gameDir, f);
      if (!fs.existsSync(src)) continue;
      ensureDir(gameDir);
      fs.copyFileSync(src, dest);
    } catch (_) {}
  }
}

function syncMcOptionsToMinecraft(gameDir, mcDir) {
  const files = ['options.txt', 'optionsof.txt'];
  for (const f of files) {
    try {
      const src = path.join(gameDir, f);
      const dest = path.join(mcDir, f);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, dest);
    } catch (_) {}
  }
}

function forceWindowedOptions(gameDir) {
  try {
    const p = path.join(gameDir, 'options.txt');
    let raw = '';
    try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { raw = ''; }

    const lines = String(raw || '').split(/\r?\n/).filter(l => l.length);
    const map = new Map();
    for (const l of lines) {
      const i = l.indexOf(':');
      if (i <= 0) continue;
      const k = l.slice(0, i);
      const v = l.slice(i + 1);
      map.set(k, v);
    }

    // Common causes for "game runs but window doesn't appear": stuck fullscreen on an invalid monitor/res.
    map.set('fullscreen', 'false');
    map.delete('fullscreenResolution');

    const out = Array.from(map.entries()).map(([k, v]) => `${k}:${v}`).join('\n') + '\n';
    ensureDir(gameDir);
    fs.writeFileSync(p, out, 'utf8');
  } catch (_) {}
}

function getHeephVersionId() {
  return 'heeph-1.8.9';
}

function getHeephVersionDir() {
  const id = getHeephVersionId();
  return path.join(getGameDir(), 'versions', id);
}

function ensureRuntimeDirs() {
  ensureDir(getGameDir());
  ensureDir(path.join(getGameDir(), 'versions'));
  ensureDir(path.join(getClientDir(), 'cache'));
  ensureDir(getHeephVersionDir());
}

function isRedirectStatus(code) {
  return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}

function resolveRedirectUrl(currentUrl, location) {
  try {
    return new URL(location, currentUrl).toString();
  } catch (_) {
    return '';
  }
}

function validateHttpUrlOrThrow(url, { allowInsecureHttp, allowedUpdateHosts } = {}) {
  if (!isHttpUrl(url)) return;
  if (!allowInsecureHttp && !isHttpsUrl(url)) throw new Error('HTTP is blocked. Use HTTPS (or allowInsecureHttp=true)');
  if (!isAllowedHost(url, allowedUpdateHosts)) throw new Error(`Host not allowed: ${getUrlHost(url)}`);
}

function downloadToFile(url, filePath, { allowInsecureHttp = false, allowedUpdateHosts = [], maxRedirects = 5, onProgress = null } = {}) {
  return new Promise((resolve) => {
    try {
      ensureDir(path.dirname(filePath));
      let curUrl = url;
      let redirectsLeft = Math.max(0, Number(maxRedirects || 0));
      let out = null;
      let received = 0;
      let total = 0;

      const cleanup = () => {
        try { out?.close?.(); } catch (_) {}
        try { out?.destroy?.(); } catch (_) {}
        out = null;
      };

      const fail = (msg) => {
        cleanup();
        try { fs.unlinkSync(filePath); } catch (_) {}
        resolve({ ok: false, error: msg });
      };

      const start = () => {
        try {
          validateHttpUrlOrThrow(curUrl, { allowInsecureHttp, allowedUpdateHosts });
        } catch (e) {
          return fail(e.message);
        }

        cleanup();
        out = fs.createWriteStream(filePath);
        const req = net.request({ method: 'GET', url: curUrl });
        req.on('response', (res) => {
          const code = Number(res.statusCode || 0);
          if (isRedirectStatus(code)) {
            if (redirectsLeft <= 0) return fail('Redirect infinito (maxRedirects atingido)');
            const loc = String(res.headers?.location || '').trim();
            const nextUrl = resolveRedirectUrl(curUrl, loc);
            if (!nextUrl) return fail('Redirect sem Location válido');
            redirectsLeft -= 1;
            curUrl = nextUrl;
            cleanup();
            try { fs.unlinkSync(filePath); } catch (_) {}
            return start();
          }

          if (code >= 400) return fail(`HTTP ${code}`);

          received = 0;
          total = Number(res.headers?.['content-length'] || res.headers?.['Content-Length'] || 0) || 0;
          try { if (typeof onProgress === 'function') onProgress({ received, total, url: curUrl }); } catch (_) {}

          res.on('data', (chunk) => {
            try {
              received += chunk?.length || 0;
              if (typeof onProgress === 'function') onProgress({ received, total, url: curUrl });
            } catch (_) {}
            out.write(chunk);
          });
          res.on('end', () => {
            out.end();
            resolve({ ok: true, finalUrl: curUrl });
          });
        });
        req.on('error', (e) => fail(e.message));
        req.end();
      };

      start();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function getBundledAuthlibInjectorPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'authlib-injector.jar');
  }
  return path.join(__dirname, '..', 'resources', 'authlib-injector.jar');
}

async function ensureAuthlibInjectorJar(cfg) {
  const ai = cfg?.authlibInjector || {};
  if (!ai.enabled) return { ok: true, enabled: false };

  const injectorUrl = String(ai.injectorUrl || 'bundled').trim();
  const heephServer = String(cfg?.heephSkinServer?.url || '').trim();
  const apiRoot = (heephServer || String(ai.apiRoot || '').trim());
  if (!apiRoot) return { ok: false, msg: 'authlibInjector.apiRoot is not configured' };

  const sec = cfg.security || {};
  const allowInsecureHttp = !!sec.allowInsecureHttp;
  const allowedUpdateHosts = Array.isArray(sec.allowedUpdateHosts) ? sec.allowedUpdateHosts : [];

  const root = getClientDir();
  const jarPath = path.join(root, 'cache', 'authlib-injector.jar');
  const expected = String(ai.injectorSha256 || '').trim().toLowerCase();

  // Bundled jar (shipped with installer via extraResources)
  if (injectorUrl === 'bundled' || injectorUrl === '') {
    const bundled = getBundledAuthlibInjectorPath();
    if (!fs.existsSync(bundled)) {
      return { ok: false, msg: 'authlib-injector.jar was not found in the installer. Put the file in resources/ before building.' };
    }
    try {
      if (path.resolve(bundled) !== path.resolve(jarPath)) {
        ensureDir(path.dirname(jarPath));
        fs.copyFileSync(bundled, jarPath);
      }
      if (expected) {
        const got = sha256Hex(fs.readFileSync(jarPath)).toLowerCase();
        if (got !== expected) return { ok: false, msg: 'Integrity check failed: injectorSha256 does not match' };
      }
      return { ok: true, enabled: true, jarPath, apiRoot };
    } catch (e) {
      return { ok: false, msg: `Failed to copy bundled injector: ${e.message}` };
    }
  }

  // Local path support (custom path on user's PC)
  if (!isHttpUrl(injectorUrl)) {
    const local = normalizeLocalPath(injectorUrl);
    if (!local || !fs.existsSync(local)) return { ok: false, msg: `File not found: ${local}` };

    try {
      if (path.resolve(local) !== path.resolve(jarPath)) {
        ensureDir(path.dirname(jarPath));
        fs.copyFileSync(local, jarPath);
      }
      if (expected) {
        const got = sha256Hex(fs.readFileSync(jarPath)).toLowerCase();
        if (got !== expected) return { ok: false, msg: 'Integrity check failed: injectorSha256 does not match' };
      }
      return { ok: true, enabled: true, jarPath, apiRoot };
    } catch (e) {
      return { ok: false, msg: `Failed to copy injector: ${e.message}` };
    }
  }

  if (!allowInsecureHttp && !isHttpsUrl(injectorUrl)) return { ok: false, msg: 'HTTP is blocked for injectorUrl. Use HTTPS (or allowInsecureHttp=true)' };
  if (!isAllowedHost(injectorUrl, allowedUpdateHosts)) return { ok: false, msg: `Host not allowed: ${getUrlHost(injectorUrl)}` };

  let needDownload = true;
  if (fs.existsSync(jarPath)) {
    if (!expected) {
      needDownload = false;
    } else {
      try {
        const got = sha256Hex(fs.readFileSync(jarPath)).toLowerCase();
        needDownload = got !== expected;
      } catch (_) {
        needDownload = true;
      }
    }
  }

  if (needDownload) {
    const dl = await downloadToFile(injectorUrl, jarPath, { allowInsecureHttp, allowedUpdateHosts });
    if (!dl.ok) return { ok: false, msg: `Failed to download authlib-injector: ${dl.error}` };
    if (expected) {
      const got = sha256Hex(fs.readFileSync(jarPath)).toLowerCase();
      if (got !== expected) {
        try { fs.unlinkSync(jarPath); } catch (_) {}
        return { ok: false, msg: 'Integrity check failed: injectorSha256 does not match' };
      }
    }
  }

  return { ok: true, enabled: true, jarPath, apiRoot };
}

async function fetchJson(url, { allowInsecureHttp = false, allowedUpdateHosts = [], maxRedirects = 5 } = {}) {
  if (/^file:\/\//i.test(url)) {
    const filePath = url.replace(/^file:\/\//i, '');
    return readJson(filePath, null);
  }
  if (!/^https?:\/\//i.test(url)) {
    return readJson(url, null);
  }
  const res = await fetchText(url, { headers: { 'Accept': 'application/json' }, allowInsecureHttp, allowedUpdateHosts, maxRedirects });
  return JSON.parse(res.data);
}

async function fetchText(url, { headers = {}, allowInsecureHttp = false, allowedUpdateHosts = [], maxRedirects = 5 } = {}) {
  let curUrl = url;
  let redirectsLeft = Math.max(0, Number(maxRedirects || 0));
  while (true) {
    validateHttpUrlOrThrow(curUrl, { allowInsecureHttp, allowedUpdateHosts });
    const res = await new Promise((resolve) => {
      try {
        const req = net.request({ method: 'GET', url: curUrl, headers });
        let data = '';
        req.on('response', (r) => {
          const code = Number(r.statusCode || 0);
          if (isRedirectStatus(code)) {
            const loc = String(r.headers?.location || '').trim();
            return resolve({ status: code, redirect: resolveRedirectUrl(curUrl, loc) });
          }
          r.on('data', (c) => { data += c; });
          r.on('end', () => resolve({ status: code, data }));
        });
        req.on('error', (e) => resolve({ status: 0, error: e.message }));
        req.end();
      } catch (e) {
        resolve({ status: 0, error: e.message });
      }
    });
    if (!res) throw new Error('HTTP ERR');
    if (res.error) throw new Error(res.error);
    if (isRedirectStatus(res.status)) {
      if (redirectsLeft <= 0) throw new Error('Redirect infinito (maxRedirects atingido)');
      if (!res.redirect) throw new Error('Redirect sem Location válido');
      redirectsLeft -= 1;
      curUrl = res.redirect;
      continue;
    }
    if (res.status >= 400) throw new Error(`HTTP ${res.status || 'ERR'}`);
    return { status: res.status, data: res.data, finalUrl: curUrl };
  }
}

function normalizeLocalPath(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^file:\/\//i.test(s)) return s.replace(/^file:\/\//i, '');
  return s;
}

function listFilesRecursive(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { items = []; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

function extractFromLocalZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const jarEntry = findEntry(zip, (n) => n.toLowerCase().endsWith('.jar'));
  const jsonEntry = findEntry(zip, (n) => n.toLowerCase().endsWith('.json'));
  if (!jarEntry || !jsonEntry) return { ok: false, msg: 'ZIP inválido: precisa conter .jar e .json' };
  return { ok: true, jarBuf: jarEntry.getData(), jsonBuf: jsonEntry.getData() };
}

function detectArchiveType(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);

    // ZIP: 50 4B 03 04 / 50 4B 05 06 / 50 4B 07 08
    if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';

    // RAR4: 52 61 72 21 1A 07 00
    // RAR5: 52 61 72 21 1A 07 01 00
    if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21 && buf[4] === 0x1a && buf[5] === 0x07) return 'rar';

    return 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

async function extractFromLocalRarWithUnrar(rarPath) {
  // node-unrar-js (WASM) supports RAR5 reliably.
  try {
    const buf = Uint8Array.from(fs.readFileSync(rarPath)).buffer;
    const extractor = await unrar.createExtractorFromData({ data: buf });
    const list = extractor.getFileList();
    const headers = [...list.fileHeaders];
    const jarHeader = headers.find(h => !h.flags?.directory && String(h.name || '').toLowerCase().endsWith('.jar'));
    const jsonHeader = headers.find(h => !h.flags?.directory && String(h.name || '').toLowerCase().endsWith('.json'));
    if (!jarHeader || !jsonHeader) return { ok: false, msg: 'RAR inválido: precisa conter .jar e .json' };

    const extracted = extractor.extract({ files: [jarHeader.name, jsonHeader.name] });
    const files = [...extracted.files];
    const jarFile = files.find(f => String(f.fileHeader?.name || '').toLowerCase().endsWith('.jar'));
    const jsonFile = files.find(f => String(f.fileHeader?.name || '').toLowerCase().endsWith('.json'));
    if (!jarFile?.extraction || !jsonFile?.extraction) return { ok: false, msg: 'Falha ao extrair arquivos do RAR' };

    return {
      ok: true,
      jarBuf: Buffer.from(jarFile.extraction),
      jsonBuf: Buffer.from(jsonFile.extraction),
    };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

function extractFromLocalRarWith7za(rarPath, workDir) {
  // 7za x <archive> -o<dir> -y
  ensureDir(workDir);
  const args = ['x', rarPath, `-o${workDir}`, '-y'];
  const res = spawn(path7za, args, { windowsHide: true });

  return new Promise((resolve) => {
    let stderr = '';
    res.stderr?.on('data', (d) => { stderr += String(d); });
    res.on('error', (e) => resolve({ ok: false, msg: e.message }));
    res.on('close', (code) => {
      if (code !== 0) {
        return resolve({
          ok: false,
          msg: `Não foi possível abrir/extrair o RAR (7za exit ${code}). O arquivo pode estar corrompido, ser RAR com senha, ou estar em um formato que o 7zip não suporta. Detalhe: ${stderr}`
        });
      }
      const files = listFilesRecursive(workDir);
      const jar = files.find(f => f.toLowerCase().endsWith('.jar'));
      const json = files.find(f => f.toLowerCase().endsWith('.json'));
      if (!jar || !json) return resolve({ ok: false, msg: 'RAR inválido: precisa conter .jar e .json' });
      try {
        resolve({ ok: true, jarBuf: fs.readFileSync(jar), jsonBuf: fs.readFileSync(json) });
      } catch (e) {
        resolve({ ok: false, msg: e.message });
      }
    });
  });
}

function findEntry(zip, predicate) {
  const entries = zip.getEntries();
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (predicate(e.entryName)) return e;
  }
  return null;
}

function getOsKey() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

function getArchKey() {
  return process.arch === 'x64' ? '64' : '32';
}

function isLibraryAllowedByRules(lib) {
  if (!lib || !Array.isArray(lib.rules) || lib.rules.length === 0) return true;

  const osKey = getOsKey();
  let allowed = false;
  for (const r of lib.rules) {
    const action = r.action;
    const osName = r.os?.name;
    const matchesOs = !osName || osName === osKey;
    if (!matchesOs) continue;
    if (action === 'disallow') return false;
    if (action === 'allow') allowed = true;
  }
  return allowed;
}

function mavenCoordsToPath(name) {
  // group:artifact:version
  const parts = String(name || '').split(':');
  if (parts.length < 3) return null;
  const group = parts[0];
  const artifact = parts[1];
  const version = parts[2];
  return { group, artifact, version };
}

function getNativeClassifier(lib) {
  const osKey = getOsKey();
  const archKey = getArchKey();
  const raw = lib?.natives?.[osKey];
  if (!raw) return null;
  return String(raw).replace('${arch}', archKey);
}

function resolveLibraryJarPath(librariesDir, name, classifier) {
  const coords = mavenCoordsToPath(name);
  if (!coords) return null;
  const groupPath = coords.group.replace(/\./g, path.sep);
  const base = path.join(librariesDir, groupPath, coords.artifact, coords.version);
  const fileName = classifier
    ? `${coords.artifact}-${coords.version}-${classifier}.jar`
    : `${coords.artifact}-${coords.version}.jar`;
  return path.join(base, fileName);
}

function resolveLibraryArtifactJarPath(librariesDir, lib) {
  const p = lib?.downloads?.artifact?.path;
  if (p) return path.join(librariesDir, p);
  if (!lib?.name) return null;
  return resolveLibraryJarPath(librariesDir, lib.name, null);
}

function buildClasspath(librariesDir, libraries, versionJarPath) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const parts = [];

  for (const lib of libraries) {
    if (!lib?.name) continue;
    if (!isLibraryAllowedByRules(lib)) continue;

    const jarPath = resolveLibraryArtifactJarPath(librariesDir, lib);
    if (jarPath && fs.existsSync(jarPath)) parts.push(jarPath);
  }

  parts.push(versionJarPath);
  return parts.join(sep);
}

function substituteArgs(template, vars) {
  return String(template).replace(/\$\{([^}]+)\}/g, (_, k) => {
    if (Object.prototype.hasOwnProperty.call(vars, k)) return String(vars[k]);
    return `\${${k}}`;
  });
}

function normalizeGameArgs(versionJson) {
  // 1.8.x: minecraftArguments (string)
  if (typeof versionJson?.minecraftArguments === 'string' && versionJson.minecraftArguments.trim()) {
    return versionJson.minecraftArguments.trim().split(/\s+/g);
  }

  // Newer: arguments.game (array of strings or objects with rules)
  const game = versionJson?.arguments?.game;
  if (Array.isArray(game)) {
    const out = [];
    for (const a of game) {
      if (typeof a === 'string') { out.push(a); continue; }
      if (a && typeof a === 'object' && Array.isArray(a.value)) {
        if (!isLibraryAllowedByRules(a)) continue;
        out.push(...a.value.filter(v => typeof v === 'string'));
      }
    }
    return out;
  }
  return [];
}

function normalizeJvmArgs(versionJson, nativesDir, classpath) {
  const out = [];

  // Newer: arguments.jvm
  const jvm = versionJson?.arguments?.jvm;
  if (Array.isArray(jvm)) {
    for (const a of jvm) {
      if (typeof a === 'string') { out.push(a); continue; }
      if (a && typeof a === 'object' && Array.isArray(a.value)) {
        if (!isLibraryAllowedByRules(a)) continue;
        out.push(...a.value.filter(v => typeof v === 'string'));
      }
    }
  }

  // Ensure required flags
  if (!out.some(s => String(s).startsWith('-Djava.library.path='))) out.push(`-Djava.library.path=${nativesDir}`);

  // Some templates include these placeholders
  out.push('-cp', classpath);
  return out;
}

function ensureAssetsDir() {
  const mcDir = getMcDir();
  const assetsDir = path.join(mcDir, 'assets');
  return assetsDir;
}

function createOfflineUuid(username) {
  // Standard offline UUID used by many launchers/servers:
  // MD5("OfflinePlayer:<name>") with RFC-4122 version/variant bits.
  const b = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

function launchHeephMinecraft({ username, ram, elyToken, elyUuid }) {
  const versionId = getHeephVersionId();
  const verDir = getHeephVersionDir();
  const versionJarPath = path.join(verDir, `${versionId}.jar`);
  const versionJsonPath = path.join(verDir, `${versionId}.json`);
  if (!fs.existsSync(versionJarPath) || !fs.existsSync(versionJsonPath)) {
    return { ok:false, msg:'Versão não instalada (jar/json ausente)' };
  }

  const versionJson = readJson(versionJsonPath, null);
  if (!versionJson) return { ok:false, msg:'Falha ao ler version json' };

  const nativesRes = extractHeephNatives();
  if (!nativesRes.ok) return { ok:false, msg:nativesRes.msg };

  const nativesDir = nativesRes.nativesDir;
  const mcDir = getMcDir();
  const librariesDir = path.join(mcDir, 'libraries');
  if (!fs.existsSync(librariesDir)) return { ok:false, msg:'libraries não encontrado na .minecraft' };

  const gameDir = getGameDir();
  ensureDir(gameDir);
  ensureSharedResourcepacks(gameDir, mcDir);
  importServersDatFromMinecraft(gameDir, mcDir);
  syncMcOptionsFromMinecraft(gameDir, mcDir);

  const assetsRoot = ensureAssetsDir();
  const assetsIndexName = String(versionJson?.assets || 'legacy');
  const cfgForAuth = normalizeAccountsConfig(readJson(path.join(getClientDir(), 'config.json'), null) || {});
  const ms = getActiveAccount(cfgForAuth);
  const msToken = String(ms?.accessToken || '').trim();
  const msUuid = String(ms?.uuid || '').trim();
  const msName = String(ms?.name || '').trim();

  const token = (msToken || String(elyToken || '').trim());
  const uuid = (msUuid || String(elyUuid || '').trim() || createOfflineUuid(username));
  const effectiveName = msName || username;
  const mainClass = String(versionJson?.mainClass || 'net.minecraft.client.main.Main');
  const libraries = Array.isArray(versionJson?.libraries) ? versionJson.libraries : [];
  const classpath = buildClasspath(librariesDir, libraries, versionJarPath);

  const vars = {
    auth_player_name: effectiveName,
    version_name: versionId,
    game_directory: gameDir,
    assets_root: assetsRoot,
    assets_index_name: assetsIndexName,
    auth_uuid: uuid,
    auth_access_token: token || '0',
    user_type: token ? 'mojang' : 'legacy',
    user_properties: '{}',
  };

  let gameArgsRaw = normalizeGameArgs(versionJson).map(a => substituteArgs(a, vars));

  // Force visible window (some setups end up "running" but with no visible window)
  // Minecraft 1.8.9 supports width/height args.
  // We explicitly remove any --fullscreen arg here because it behaves inconsistently on 1.8.9
  // (and can result in ignored arguments or unexpected fullscreen).
  const next = [];
  for (let i = 0; i < gameArgsRaw.length; i++) {
    const v = String(gameArgsRaw[i]);
    if (v === '--fullscreen') {
      const maybeVal = gameArgsRaw[i + 1];
      if (maybeVal === 'true' || maybeVal === 'false') i++; // drop optional value
      continue;
    }
    next.push(gameArgsRaw[i]);
  }
  gameArgsRaw = next;

  const hasArg = (arr, name) => arr.some((v) => String(v) === name);
  if (!hasArg(gameArgsRaw, '--width')) gameArgsRaw.push('--width', '1280');
  if (!hasArg(gameArgsRaw, '--height')) gameArgsRaw.push('--height', '720');
  const jvmArgsRaw = normalizeJvmArgs(versionJson, nativesDir, classpath).map(a => substituteArgs(a, vars));

  const args = [
    `-Xmx${ram}M`, `-Xms512M`,
    '-noverify',
    ...jvmArgsRaw,
    mainClass,
    ...gameArgsRaw,
  ];

  try {
    const cfg = readJson(path.join(getClientDir(), 'config.json'), null) || {};

    // If authlib injector is enabled, we need to resolve it before spawning java.
    // (This function is sync today; we keep it sync by only allowing cached jar here.)
    // If you enable it, make sure the jar is already downloaded (e.g. by running heeph-update once).
    const ai = cfg?.authlibInjector || {};
    if (ai.enabled) {
      const jarPath = path.join(getClientDir(), 'cache', 'authlib-injector.jar');
      if (!fs.existsSync(jarPath)) {
        return { ok:false, msg:'Authlib Injector habilitado, mas o jar ainda não foi baixado. Rode START GAME novamente ou use heeph-update para baixar.' };
      }
      const heephServer = String(cfg?.heephSkinServer?.url || '').trim().replace(/\/$/, '');
      const apiRoot = (heephServer || String(ai.apiRoot || '').trim());
      if (!apiRoot) return { ok:false, msg:'Authlib Injector: apiRoot vazio' };
      args.unshift(`-javaagent:${jarPath}=${apiRoot}`);
      if (ai.noShowServerName) args.unshift('-Dauthlibinjector.noShowServerName');
      if (ai.noLogFile) args.unshift('-Dauthlibinjector.noLogFile');
      if (apiRoot.startsWith('http://')) args.unshift('-Dauthlibinjector.disableHttpCheck=true');
    }

    if (isPidAlive(heephPid) || (heephProc && !heephProc.killed)) {
      return { ok:true, alreadyRunning: true, pid: heephPid || heephProc?.pid || null, startedAt: heephStartedAt };
    }

    // Spawn java and confirm it actually started (otherwise START looks like it worked but nothing opens)
    const log = openLaunchLog('minecraft');
    const javaCmd = resolveJavaCmd(cfg);

    try {
      const ai = cfg?.authlibInjector || {};
      const javaagents = args.filter(a => typeof a === 'string' && a.startsWith('-javaagent:'));
      fs.writeSync(log.fd, `[launcher] javaCmd=${javaCmd}\n`);
      fs.writeSync(log.fd, `[launcher] authlibInjector.enabled=${!!ai.enabled}\n`);
      fs.writeSync(log.fd, `[launcher] javaagents=${javaagents.join(' | ') || 'none'}\n`);
    } catch (_) {}

    const p = spawn(javaCmd, args, {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      cwd: gameDir,
      windowsHide: false,
    });
    const startedAt = Date.now();

    let earlyError = null;
    let earlyExit = null;
    p.once('error', (e) => { earlyError = e; });
    p.once('exit', (code, signal) => { earlyExit = { code, signal }; });

    // Wait a bit to catch common failures: java missing, permission, immediate crash
    const waitMs = 2500;
    const endAt = Date.now() + waitMs;
    while (Date.now() < endAt) {
      if (earlyError) break;
      if (earlyExit) break;
      // busy-wait in small chunks; this code path is very rare and keeps the IPC simple
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }

    if (earlyError) {
      try { fs.closeSync(log.fd); } catch (_) {}
      return { ok:false, msg:`Falha ao iniciar Java: ${earlyError.message || String(earlyError)} (log: ${log.file}). Dica: instale Java 21 (Amazon Corretto 21) e/ou configure javaPath (ex.: C:\\Program Files\\Amazon Corretto\\jdk21.0.10_7\\bin\\javaw.exe).` };
    }
    if (earlyExit) {
      try { fs.closeSync(log.fd); } catch (_) {}
      return { ok:false, msg:`Minecraft fechou imediatamente (code=${earlyExit.code}, signal=${earlyExit.signal || 'none'}). Veja o log: ${log.file}` };
    }

    // On Windows, java can exit quickly after spawning (crash) — check if pid is still alive.
    if (!isPidAlive(p.pid || 0)) {
      try { fs.closeSync(log.fd); } catch (_) {}
      return { ok:false, msg:`Minecraft não permaneceu em execução. Veja o log: ${log.file}` };
    }

    heephProc = p;
    heephStartedAt = startedAt;
    heephPid = p.pid || 0;
    p.unref();

    restoreMinecraftWindows(heephPid);

    try { fs.closeSync(log.fd); } catch (_) {}

    p.on('exit', () => {
      try { syncMcOptionsToMinecraft(gameDir, mcDir); } catch (_) {}
      heephProc = null;
      heephStartedAt = 0;
      heephPid = 0;
    });
    p.on('error', () => {
      heephProc = null;
      heephStartedAt = 0;
      heephPid = 0;
    });

    return { ok:true, nativesExtracted: nativesRes.extracted, pid: p.pid, startedAt: heephStartedAt };
  } catch (e) {
    return { ok:false, msg:e.message };
  }
}

function extractNativesFromJar(jarPath, nativesDir, extractCfg) {
  const zip = new AdmZip(jarPath);
  const entries = zip.getEntries();
  const excludes = extractCfg?.exclude || [];
  const baseDir = path.resolve(nativesDir);

  for (const e of entries) {
    if (e.isDirectory) continue;
    const name = e.entryName;
    if (name.startsWith('META-INF/')) continue;
    if (excludes.some(ex => name.startsWith(ex))) continue;

    const outPath = path.join(nativesDir, name);
    const resolved = path.resolve(outPath);
    if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) continue;
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, e.getData());
  }
}

function extractHeephNatives() {
  const versionId = getHeephVersionId();
  const verDir = getHeephVersionDir();
  const verJsonPath = path.join(verDir, `${versionId}.json`);
  if (!fs.existsSync(verJsonPath)) return { ok: false, msg: 'Version JSON não encontrado para extrair natives' };

  const ver = readJson(verJsonPath, null);
  if (!ver) return { ok: false, msg: 'Falha ao ler version JSON' };

  const mcDir = getMcDir();
  const librariesDir = path.join(mcDir, 'libraries');
  if (!fs.existsSync(librariesDir)) return { ok: false, msg: 'libraries não encontrado na .minecraft (instale pelo launcher oficial)' };

  const nativesDir = path.join(verDir, 'natives');
  try { fs.rmSync(nativesDir, { recursive: true, force: true }); } catch (_) {}
  ensureDir(nativesDir);

  const libs = Array.isArray(ver.libraries) ? ver.libraries : [];
  let extracted = 0;

  for (const lib of libs) {
    if (!lib?.name) continue;
    if (!lib.natives) continue;
    if (!isLibraryAllowedByRules(lib)) continue;

    const classifier = getNativeClassifier(lib);
    if (!classifier) continue;
    const jarPath = resolveLibraryJarPath(librariesDir, lib.name, classifier);
    if (!jarPath || !fs.existsSync(jarPath)) continue;

    try {
      extractNativesFromJar(jarPath, nativesDir, lib.extract);
      extracted++;
    } catch (_) {}
  }

  if (extracted === 0) return { ok: false, msg: 'Nenhuma native encontrada/extraída (verifique libraries e version json)' };
  return { ok: true, nativesDir, extracted };
}

async function ensureHeephUpdated() {
  bootstrapClientFiles();
  ensureRuntimeDirs();

  const root = getClientDir();
  const cfgPath = path.join(root, 'config.json');
  const cfg = readJson(cfgPath, null);
  if (!cfg) return { ok: false, msg: 'Falha ao ler config.json' };

  const sec = cfg.security || {};
  const allowInsecureHttp = !!sec.allowInsecureHttp;
  const allowedUpdateHosts = Array.isArray(sec.allowedUpdateHosts) ? sec.allowedUpdateHosts : [];
  const manifestPublicKeyPem = String(sec.manifestPublicKeyPem || '').trim();

  const defaultUpdateManifestUrl = 'https://github.com/mcypreste/heeph-launcher-updates/releases/latest/download/manifest.json';
  let manifestUrl = (cfg.updateManifestUrl || '').trim();
  if (!manifestUrl) {
    manifestUrl = defaultUpdateManifestUrl;
  }
  if (!manifestUrl) {
    try {
      const bundled = [
        path.join(app.getAppPath(), 'updates-vercel', 'manifest.json'),
        path.join(process.resourcesPath || '', 'updates-vercel', 'manifest.json'),
      ].find(p => p && fs.existsSync(p));
      if (bundled) manifestUrl = bundled;
    } catch (_) {}
  }
  if (!manifestUrl) return { ok: false, msg: 'updateManifestUrl não configurado em .heephclient/config.json' };

  if (isHttpUrl(manifestUrl)) {
    if (!allowInsecureHttp && !isHttpsUrl(manifestUrl)) return { ok: false, msg: 'HTTP bloqueado. Use HTTPS (ou allowInsecureHttp=true)' };
    if (!isAllowedHost(manifestUrl, allowedUpdateHosts)) return { ok: false, msg: `Host não permitido: ${getUrlHost(manifestUrl)}` };
  }

  // Permite usar updateManifestUrl apontando direto para um pacote local (.zip/.rar)
  // para testes antes da hospedagem.
  let manifest;
  const normalized = normalizeLocalPath(manifestUrl);
  if (/\.(zip|rar)$/i.test(normalized) && fs.existsSync(normalized)) {
    const st = fs.statSync(normalized);
    manifest = { version: `local-${st.mtimeMs}`, zipUrl: normalized };
  } else {
    try {
      manifest = await fetchJson(manifestUrl, { allowInsecureHttp, allowedUpdateHosts });
    } catch (e) {
      return { ok: false, msg: `Erro ao buscar manifest: ${e.message}` };
    }
  }

  if (manifest && isHttpUrl(manifestUrl)) {
    const sigOk = verifyManifestSignature(manifest, manifestPublicKeyPem);
    if (!sigOk.ok) return { ok: false, msg: sigOk.msg };
  }

  if (isHttpUrl(manifestUrl)) {
    const hasIntegrity = !!String(manifest?.jarSha256 || '').trim() || !!String(manifest?.jsonSha256 || '').trim();
    const hasSigKey = !!String(manifestPublicKeyPem || '').trim();
    if (!hasIntegrity && !hasSigKey) {
      return { ok: false, msg: 'Manifest remoto sem integridade (jarSha256/jsonSha256) e sem chave de assinatura configurada.' };
    }
  }

  const versionId = getHeephVersionId();
  const remoteVersion = String(manifest.version || '').trim();
  let zipUrl = String(manifest.zipUrl || manifest.url || '').trim();
  if (!remoteVersion || !zipUrl) {
    return { ok: false, msg: 'Manifest inválido. Esperado: { version, zipUrl }' };
  }

  // Allow relative zipUrl when manifest is hosted remotely (e.g. Vercel static hosting)
  // Example: manifestUrl=https://foo.vercel.app/manifest.json and zipUrl=heeph.zip
  if (isHttpUrl(manifestUrl) && zipUrl && !isHttpUrl(zipUrl) && !/^file:\/\//i.test(zipUrl)) {
    const maybeLocal = normalizeLocalPath(zipUrl);
    if (!maybeLocal || !fs.existsSync(maybeLocal)) {
      try {
        zipUrl = new URL(zipUrl, manifestUrl).toString();
      } catch (_) {}
    }
  }

  if (isHttpUrl(zipUrl)) {
    if (!allowInsecureHttp && !isHttpsUrl(zipUrl)) return { ok: false, msg: 'HTTP bloqueado para zipUrl. Use HTTPS (ou allowInsecureHttp=true)' };
    if (!isAllowedHost(zipUrl, allowedUpdateHosts)) return { ok: false, msg: `Host não permitido: ${getUrlHost(zipUrl)}` };
  }

  const installed = cfg.installedHeeph?.installedVersion || '';
  if (installed === remoteVersion) {
    // If the release was re-uploaded with the same version string, validate the local files
    // against manifest hashes before skipping. This ensures we still fetch the latest build.
    let okToSkip = true;
    try {
      const expectedJar = String(manifest.jarSha256 || '').trim().toLowerCase();
      const expectedJson = String(manifest.jsonSha256 || '').trim().toLowerCase();
      const verDir = getHeephVersionDir();
      const jarPath = path.join(verDir, `${versionId}.jar`);
      const jsonPath = path.join(verDir, `${versionId}.json`);
      if (!fs.existsSync(jarPath) || !fs.existsSync(jsonPath)) okToSkip = false;
      if (okToSkip && expectedJar) {
        const got = sha256Hex(fs.readFileSync(jarPath)).toLowerCase();
        if (got !== expectedJar) okToSkip = false;
      }
      if (okToSkip && expectedJson) {
        const got = sha256Hex(fs.readFileSync(jsonPath)).toLowerCase();
        if (got !== expectedJson) okToSkip = false;
      }
    } catch (_) {
      okToSkip = false;
    }
    if (okToSkip) return { ok: true, updated: false, version: installed };
  }

  let jarBuf;
  let jsonBuf;
  try {
    if (isHttpUrl(zipUrl)) {
      const zipPath = path.join(root, 'cache', `${versionId}-${remoteVersion}.zip`);
      const dl = await downloadToFile(zipUrl, zipPath, {
        allowInsecureHttp,
        allowedUpdateHosts,
        onProgress: ({ received, total }) => {
          try {
            win?.webContents?.send?.('update-progress', {
              stage: 'downloading',
              version: remoteVersion,
              received: Number(received || 0),
              total: Number(total || 0),
            });
          } catch (_) {}
        }
      });
      if (!dl.ok) return { ok: false, msg: `Erro ao baixar ZIP: ${dl.error}` };
      const ext = extractFromLocalZip(zipPath);
      if (!ext.ok) return { ok: false, msg: ext.msg };
      jarBuf = ext.jarBuf;
      jsonBuf = ext.jsonBuf;
    } else {
      const localPath = normalizeLocalPath(zipUrl);
      if (!fs.existsSync(localPath)) return { ok: false, msg: `Arquivo não encontrado: ${localPath}` };

      const detected = detectArchiveType(localPath);
      if (detected === 'zip' || /\.zip$/i.test(localPath)) {
        const ext = extractFromLocalZip(localPath);
        if (!ext.ok) return { ok: false, msg: ext.msg };
        jarBuf = ext.jarBuf;
        jsonBuf = ext.jsonBuf;
      } else if (detected === 'rar' || /\.rar$/i.test(localPath)) {
        let ext = await extractFromLocalRarWithUnrar(localPath);
        if (!ext.ok) {
          // Fallback: alguns arquivos com extensão .rar são na verdade .zip
          try {
            const z = extractFromLocalZip(localPath);
            if (z.ok) ext = z;
          } catch (_) {}
        }
        if (!ext.ok) return { ok: false, msg: ext.msg };
        jarBuf = ext.jarBuf;
        jsonBuf = ext.jsonBuf;
      } else {
        return { ok: false, msg: 'Formato não suportado. Use .zip ou .rar' };
      }
    }

    const expectedJar = String(manifest.jarSha256 || '').trim().toLowerCase();
    const expectedJson = String(manifest.jsonSha256 || '').trim().toLowerCase();
    if (expectedJar) {
      const got = sha256Hex(jarBuf).toLowerCase();
      if (got !== expectedJar) return { ok: false, msg: 'Falha de integridade: jarSha256 não confere' };
    }
    if (expectedJson) {
      const got = sha256Hex(jsonBuf).toLowerCase();
      if (got !== expectedJson) return { ok: false, msg: 'Falha de integridade: jsonSha256 não confere' };
    }

    const verDir = getHeephVersionDir();
    ensureDir(verDir);
    atomicWriteFile(path.join(verDir, `${versionId}.jar`), jarBuf);
    atomicWriteFile(path.join(verDir, `${versionId}.json`), jsonBuf);

    cfg.installedHeeph = cfg.installedHeeph || { versionId, installedVersion: '' };
    cfg.installedHeeph.versionId = versionId;
    cfg.installedHeeph.installedVersion = remoteVersion;
    writeJson(cfgPath, cfg);

    try {
      win?.webContents?.send?.('update-progress', {
        stage: 'done',
        version: remoteVersion,
      });
    } catch (_) {}
  } catch (e) {
    try {
      win?.webContents?.send?.('update-progress', {
        stage: 'error',
        version: remoteVersion,
        msg: e?.message || String(e),
      });
    } catch (_) {}
    return { ok: false, msg: `Erro ao extrair/instalar: ${e.message}` };
  }

  return { ok: true, updated: true, version: remoteVersion };
}

function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'src', 'assets', 'logo_108.png')
    : path.join(__dirname, 'assets', 'logo_108.png');
  win = new BrowserWindow({
    width: 1024,
    height: 680,
    minWidth: 1024, minHeight: 680,
    maxWidth: 1024, maxHeight: 680,
    frame: false, resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    backgroundColor: '#3a3a3a',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  } catch (_) {}
  try {
    win.webContents.on('will-navigate', (e, url) => {
      // Only allow file:// navigation inside the packaged app
      try {
        const u = new URL(String(url || ''));
        if (u.protocol === 'file:') return;
      } catch (_) {}
      e.preventDefault();
    });
  } catch (_) {}
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  } catch (_) {}
  try {
    win.webContents.session.setPermissionCheckHandler(() => false);
  } catch (_) {}
  try {
    win.webContents.on('devtools-opened', () => {
      try { win.webContents.closeDevTools(); } catch (_) {}
    });
  } catch (_) {}
  try {
    win.webContents.on('before-input-event', (event, input) => {
      const key = String(input?.key || '').toLowerCase();
      const ctrlOrMeta = !!(input?.control || input?.meta);
      const shift = !!input?.shift;
      if (key === 'f12' || (ctrlOrMeta && shift && key === 'i')) {
        try { event.preventDefault(); } catch (_) {}
        try { win.webContents.closeDevTools(); } catch (_) {}
      }
    });
  } catch (_) {}
  win.on('maximize', () => win?.unmaximize());
  win.on('enter-full-screen', () => win?.setFullScreen(false));
  win.loadFile(path.join(__dirname, 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.on('close', (e) => {
    if (isQuitting) return;
    const s = getLauncherSettings();
    if (s.exitToTray) {
      e.preventDefault();
      win.hide();
      return;
    }
  });
}



function ensureTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'assets', 'logo_108.png');
  tray = new Tray(iconPath);
  tray.setToolTip('HEEPH Launcher');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open',
      click: () => {
        if (!win) return;
        win.show();
        win.focus();
      },
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        stopHeephGame();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  tray.on('double-click', () => {
    if (!win) return;
    win.show();
    win.focus();
  });
}

app.whenReady().then(() => {
  bootstrapClientFiles();
  try {
    const s = getLauncherSettings();
    if (!s.hardwareAcceleration) {
      app.disableHardwareAcceleration();
    }
  } catch (_) {}
  createWindow();
  ensureTray();
  configureLauncherAutoUpdate();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopHeephGame();
});

app.on('window-all-closed', () => {
  // Mantém rodando em segundo plano (tray).
  // O usuário encerra via menu "Sair" da tray.
  if (process.platform === 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  if (win) {
    win.show();
    win.focus();
  }
});

ipcMain.handle('skin-remove', async (_evt, { file } = {}) => {
  try {
    bootstrapClientFiles();
    const target = String(file || '').trim();
    if (!target || !/\.png$/i.test(target)) return { ok: false, msg: 'Arquivo inválido.' };
    if (target.includes('..') || target.includes('/') || target.includes('\\') || path.isAbsolute(target)) return { ok: false, msg: 'Caminho inválido.' };

    const cfgPath = path.join(getClientDir(), 'config.json');
    const cfg = readJson(cfgPath, null) || {};
    const active = String(cfg.activeSkin || '').trim();
    if (active && active === target) return { ok: false, msg: 'Não é possível remover a skin ativa.' };

    const skinsDir = getSkinsDir();
    const full = path.join(skinsDir, target);
    if (!fs.existsSync(full)) return { ok: false, msg: 'Skin não encontrada.' };

    // Only allow deleting user-added skins: disallow deleting bundled defaults.
    const defaultsDir = getBundledDefaultSkinsDir();
    try {
      const defaults = fs.existsSync(defaultsDir) ? fs.readdirSync(defaultsDir).filter(f => /\.png$/i.test(f)) : [];
      if (defaults.some(f => String(f).toLowerCase() === target.toLowerCase())) {
        return { ok: false, msg: 'Não é possível remover uma skin padrão.' };
      }
    } catch (_) {}

    fs.unlinkSync(full);
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

// ── Window controls ──
ipcMain.on('win-min',   () => win?.minimize());
ipcMain.on('win-max',   () => {});
ipcMain.on('win-close', () => win?.hide());

ipcMain.handle('launcher-settings-get', async () => {
  try {
    const s = getLauncherSettings();
    return { ok: true, settings: s, locale: String(app.getLocale?.() || '') };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('launcher-settings-set', async (_evt, patch) => {
  try {
    const next = setLauncherSettings(patch);
    return { ok: true, settings: next };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('app-settings-get', async () => {
  try {
    const s = getAppSettings();
    return { ok: true, settings: s };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('app-settings-set', async (_evt, patch) => {
  try {
    const s = setAppSettings(patch);
    return { ok: true, settings: s };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('open-launcher-data-folder', async () => {
  try {
    bootstrapClientFiles();
    shell.openPath(getClientDir());
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('clear-launcher-cache', async () => {
  try {
    bootstrapClientFiles();
    const root = getClientDir();
    safeEmptyDir(path.join(root, 'cache'));
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('clear-launcher-logs', async () => {
  try {
    bootstrapClientFiles();
    const root = getClientDir();
    safeEmptyDir(path.join(root, 'logs'));
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

// ── Helpers ──
function getMcDir() {
  if (process.platform === 'win32')  return path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
  return path.join(os.homedir(), '.minecraft');
}

// ── Modrinth API proxy (avoids CORS in renderer) ──
ipcMain.handle('modrinth-fetch', async (_, { url }) => {
  const target = String(url || '').trim();
  try {
    const u = new URL(target);
    if (u.protocol !== 'https:') return { ok: false, error: 'Only HTTPS URLs allowed.' };
    const host = u.hostname.toLowerCase();
    const allowed = ['api.modrinth.com', 'modrinth.com', 'cdn.modrinth.com', 'staging-api.modrinth.com'];
    if (!allowed.some(d => host === d || host.endsWith('.' + d))) return { ok: false, error: 'Domain not allowed.' };
  } catch (_) { return { ok: false, error: 'Invalid URL.' }; }
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url: target,
      headers: {
        'User-Agent': 'heeph-client/1.0.0 (minecraft-launcher)',
        'Accept': 'application/json'
      }
    });
    let data = '';
    request.on('response', (res) => {
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ ok: true, data: JSON.parse(data), status: res.statusCode }); }
        catch(e) { resolve({ ok: false, error: 'Parse error', raw: data }); }
      });
    });
    request.on('error', (e) => resolve({ ok: false, error: e.message }));
    request.end();
  });
});

// ── System info ──
ipcMain.handle('get-info', async () => {
  bootstrapClientFiles();
  const clientDir = getClientDir();
  const mcDir  = getMcDir();
  let versions = [];
  const verDir = path.join(mcDir, 'versions');
  if (fs.existsSync(verDir)) {
    versions = fs.readdirSync(verDir)
      .filter(v => fs.existsSync(path.join(verDir, v, `${v}.jar`)))
      .reverse();
  }
  return {
    platform: process.platform,
    totalMem: Math.floor(os.totalmem()/1024/1024),
    mcDir,
    versions,
    clientDir,
  };
});

// ── Launch vanilla ──
ipcMain.handle('launch-vanilla', async (_, { username, version, ram }) => {
  const mcDir  = getMcDir();
  const jar    = path.join(mcDir, 'versions', version, `${version}.jar`);
  const natives= path.join(mcDir, 'versions', version, 'natives');
  if (!fs.existsSync(jar)) return { ok:false, msg:`Versão "${version}" não encontrada em ${mcDir}` };
  try {
    const javaCmd = process.platform === 'win32' ? 'javaw' : 'java';
    const p = spawn(javaCmd, [
      `-Xmx${ram}M`, `-Xms512M`,
      `-Djava.library.path=${natives}`,
      '-cp', jar, 'net.minecraft.client.main.Main',
      '--username', username, '--version', version,
      '--gameDir', mcDir, '--assetsDir', path.join(mcDir,'assets'),
      '--accessToken', '0', '--userType', 'legacy'
    ], { detached:true, stdio:'ignore', cwd:mcDir });
    p.unref();
    return { ok:true };
  } catch(e) { return { ok:false, msg:e.message }; }
});

ipcMain.handle('heeph-update', async () => {
  return await ensureHeephUpdated();
});

ipcMain.handle('heeph-preflight', async (_evt, { username, ram, elyToken, elyUuid } = {}) => {
  try {
    bootstrapClientFiles();
    ensureRuntimeDirs();

    const errors = [];
    const warnings = [];

    const root = getClientDir();
    const cfgPath = path.join(root, 'config.json');
    const cfg = readJson(cfgPath, null) || {};

    const name = String(username || cfg.username || '').trim() || 'Player';
    const ramMb = Number(ram || cfg.ram || 0);
    if (!Number.isFinite(ramMb) || ramMb < 512) errors.push('RAM inválida (mínimo 512 MB).');
    const totalMb = Math.floor((os.totalmem() || 0) / 1024 / 1024);
    if (totalMb > 0 && ramMb > Math.floor(totalMb * 0.8)) warnings.push(`RAM muito alta (${ramMb} MB). Seu PC tem ~${totalMb} MB.`);

    if (!name) errors.push('Username inválido.');
    const token = String(elyToken || '').trim();
    const uuid = String(elyUuid || '').trim();
    if ((token && !uuid) || (!token && uuid)) warnings.push('Ely token/uuid incompleto (pode causar login inválido).');

    const mcDir = getMcDir();
    const librariesDir = path.join(mcDir, 'libraries');
    if (!fs.existsSync(librariesDir)) {
      errors.push('Pasta libraries não encontrada na .minecraft. Instale pelo launcher oficial (Abra o jogo uma vez).');
    }

    const javaCmd = resolveJavaCmd(cfg);
    const javaCheck = (() => {
      try {
        const r = spawnSync(javaCmd, ['-version'], {
          timeout: 4000,
          windowsHide: true,
          encoding: 'utf8',
        });
        if (r.error) return { ok: false, msg: r.error.message || String(r.error) };
        if (typeof r.status === 'number' && r.status !== 0) {
          const out = String(r.stderr || r.stdout || '').trim();
          return { ok: false, msg: out || `exit=${r.status}` };
        }
        const text = String(r.stderr || r.stdout || '');
        return { ok: true, text };
      } catch (e) {
        return { ok: false, msg: e?.message || String(e) };
      }
    })();

    if (!javaCheck.ok) {
      errors.push(`Java não encontrado/invalid: ${javaCheck.msg}`);
    } else {
      const v = javaCheck.text;
      if (!/version\s+"21\.|openjdk\s+version\s+"21\./i.test(v)) {
        errors.push('Java incorreto. Essa versão do Heeph precisa de Java 21 (Amazon Corretto 21). Instale e/ou configure javaPath para: C:\\Program Files\\Amazon Corretto\\jdk21.0.10_7\\bin\\javaw.exe');
      }
    }

    const ai = cfg?.authlibInjector || {};
    if (ai.enabled) {
      const jarPath = path.join(root, 'cache', 'authlib-injector.jar');
      if (!fs.existsSync(jarPath)) warnings.push('Authlib Injector habilitado, mas o jar ainda não foi baixado (vai baixar ao dar Play).');
      const heephServer = String(cfg?.heephSkinServer?.url || '').trim();
      if (!heephServer) warnings.push('Authlib Injector habilitado, mas heephSkinServer.url está vazio.');
      if (/^http:\/\//i.test(heephServer)) warnings.push('Skin server está em HTTP (menos seguro).');
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
    };
  } catch (e) {
    return { ok: false, errors: [e?.message || String(e)], warnings: [] };
  }
});

ipcMain.handle('heeph-repair', async (_evt, { clearCache = true, clearLogs = false, forceReinstall = false } = {}) => {
  try {
    bootstrapClientFiles();
    ensureRuntimeDirs();

    const steps = [];
    const root = getClientDir();

    if (clearCache) {
      safeEmptyDir(path.join(root, 'cache'));
      steps.push('cache');
    }
    if (clearLogs) {
      safeEmptyDir(path.join(root, 'logs'));
      steps.push('logs');
    }

    if (forceReinstall) {
      try {
        const cfgPath = path.join(root, 'config.json');
        const cfg = readJson(cfgPath, null) || {};
        if (cfg.installedHeeph && typeof cfg.installedHeeph === 'object') {
          cfg.installedHeeph.installedVersion = '';
          writeJson(cfgPath, cfg);
        }
      } catch (_) {}

      try {
        const verDir = getHeephVersionDir();
        const versionId = getHeephVersionId();
        try { fs.rmSync(path.join(verDir, 'natives'), { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(path.join(verDir, `${versionId}.jar`), { force: true }); } catch (_) {}
        try { fs.rmSync(path.join(verDir, `${versionId}.json`), { force: true }); } catch (_) {}
      } catch (_) {}
      steps.push('forceReinstall');
    }

    const up = await ensureHeephUpdated();
    if (!up.ok) return { ok: false, msg: up.msg, steps, updated: false };
    steps.push('update');

    return { ok: true, steps, updated: !!up.updated, version: up.version };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('heeph-play', async (_, { username, ram, elyToken, elyUuid }) => {
  const up = await ensureHeephUpdated();
  if (!up.ok) return up;

  // Prepare Authlib Injector (Ely.by) if enabled (download+cache before spawning java)
  const cfg = readJson(path.join(getClientDir(), 'config.json'), null) || {};
  const ai = cfg?.authlibInjector || {};
  if (ai.enabled) {
    const prep = await ensureAuthlibInjectorJar(cfg);
    if (!prep.ok) return { ok:false, msg: prep.msg };
  }

  const res = launchHeephMinecraft({ username, ram, elyToken, elyUuid });
  if (!res.ok) return res;
  return { ok:true, updated: up.updated, version: up.version, nativesExtracted: res.nativesExtracted, pid: res.pid, startedAt: res.startedAt, alreadyRunning: !!res.alreadyRunning };
});

ipcMain.handle('heeph-status', async () => {
  const running = isPidAlive(heephPid) || !!(heephProc && !heephProc.killed);
  const elapsedMs = running ? Math.max(0, Date.now() - heephStartedAt) : 0;
  return {
    ok: true,
    running,
    pid: running ? (heephPid || heephProc?.pid || null) : null,
    startedAt: running ? heephStartedAt : 0,
    elapsedMs,
  };
});

// ── Launcher auto-update (Electron app) ─────────────
ipcMain.handle('launcher-check-updates', async () => {
  try {
    if (!app.isPackaged) return { ok: false, msg: 'Auto-update do launcher só funciona na versão instalada (packaged).' };
    const res = await autoUpdater.checkForUpdates();
    return { ok: true, result: !!res };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('launcher-install-update', async () => {
  try {
    if (!app.isPackaged) return { ok: false, msg: 'Auto-update do launcher só funciona na versão instalada (packaged).' };
    isQuitting = true;
    setTimeout(() => {
      try { autoUpdater.quitAndInstall(true, true); } catch (_) {}
    }, 50);
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

// ── Microsoft account (official) ────────────────────
ipcMain.handle('ms-status', async () => {
  try {
    bootstrapClientFiles();
    const cfg = normalizeAccountsConfig(readJson(path.join(getClientDir(), 'config.json'), null) || {});
    const acc = getActiveAccount(cfg);
    if (!acc || String(acc.type || '') !== 'microsoft') return { ok: true, loggedIn: false };
    return { ok: true, loggedIn: true, id: String(acc.id || ''), name: String(acc.name || ''), uuid: String(acc.uuid || '') };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('ms-login', async () => {
  try {
    if (msLoginInProgress) return { ok: true, started: true, alreadyRunning: true };
    msLoginInProgress = true;
    setTimeout(async () => {
      try {
        const res = await ensureMicrosoftAccountLogin();
        try { win?.webContents?.send?.('ms-auth', { ok: true, name: res?.name, uuid: res?.uuid }); } catch (_) {}
      } catch (e) {
        try { win?.webContents?.send?.('ms-auth', { ok: false, msg: e?.message || String(e) }); } catch (_) {}
      } finally {
        msLoginInProgress = false;
      }
    }, 50);
    return { ok: true, started: true };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('ms-logout', async () => {
  try {
    bootstrapClientFiles();
    const cfgPath = path.join(getClientDir(), 'config.json');
    const cfg = normalizeAccountsConfig(readJson(cfgPath, null) || {});
    const activeId = String(cfg.activeAccountId || '').trim();
    if (activeId) {
      cfg.accounts = Array.isArray(cfg.accounts) ? cfg.accounts.filter(a => String(a?.id || '') !== activeId) : [];
      if (cfg.activeAccountId === activeId) cfg.activeAccountId = '';
    }
    cfg.microsoftAccount = null;
    const active = getActiveAccount(cfg);
    if (active) {
      cfg.activeAccountId = String(active.id || '') || cfg.activeAccountId;
      const tk = String(active.accessToken || '');
      cfg.microsoftAccount = {
        name: String(active.name || ''),
        uuid: String(active.uuid || ''),
        accessToken: tk ? (encryptLocalSecret(tk) || tk) : '',
        updatedAt: Number(active.updatedAt || 0) || Date.now(),
      };
    }
    writeJson(cfgPath, cfg);
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('accounts-list', async () => {
  try {
    bootstrapClientFiles();
    const cfgPath = path.join(getClientDir(), 'config.json');
    const cfg = normalizeAccountsConfig(readJson(cfgPath, null) || {});
    const active = getActiveAccount(cfg);
    // Persist migration if needed
    writeJson(cfgPath, cfg);
    return {
      ok: true,
      activeAccountId: String(cfg.activeAccountId || ''),
      accounts: (Array.isArray(cfg.accounts) ? cfg.accounts : []).map(a => ({
        id: String(a?.id || ''),
        type: String(a?.type || ''),
        name: String(a?.name || ''),
        uuid: String(a?.uuid || ''),
        updatedAt: Number(a?.updatedAt || 0) || 0,
      })),
      active: active ? { id: String(active.id || ''), type: String(active.type || ''), name: String(active.name || ''), uuid: String(active.uuid || '') } : null,
    };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('accounts-set-active', async (_evt, { id }) => {
  try {
    bootstrapClientFiles();
    const cfgPath = path.join(getClientDir(), 'config.json');
    const cfg = normalizeAccountsConfig(readJson(cfgPath, null) || {});
    const nextId = String(id || '').trim();
    const found = (Array.isArray(cfg.accounts) ? cfg.accounts : []).find(a => String(a?.id || '') === nextId);
    if (!found) return { ok: false, msg: 'Conta não encontrada.' };
    cfg.activeAccountId = nextId;
    if (found.type === 'microsoft') {
      cfg.microsoftAccount = {
        name: String(found.name || ''),
        uuid: String(found.uuid || ''),
        accessToken: String(found.accessToken || ''),
        updatedAt: Number(found.updatedAt || 0) || Date.now(),
      };
      cfg.username = String(found.name || cfg.username || '');
    } else {
      cfg.username = String(found.name || cfg.username || '');
      const restored = getOfflineSkinForUsername(cfg, cfg.username);
      if (restored) cfg.activeSkin = restored;
    }
    writeJson(cfgPath, cfg);
    return { ok: true, activeAccountId: nextId, active: { id: String(found.id || ''), type: String(found.type || ''), name: String(found.name || ''), uuid: String(found.uuid || '') } };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('accounts-upsert-offline', async (_evt, { username }) => {
  try {
    bootstrapClientFiles();
    const cfgPath = path.join(getClientDir(), 'config.json');
    const cfg0 = readJson(cfgPath, null) || {};
    const { cfg, account } = upsertOfflineAccount(cfg0, username);
    if (!account) return { ok: false, msg: 'Username inválido.' };
    const restored = getOfflineSkinForUsername(cfg, account.name);
    if (restored) cfg.activeSkin = restored;
    writeJson(cfgPath, cfg);
    return {
      ok: true,
      activeAccountId: String(cfg.activeAccountId || ''),
      active: { id: String(account.id || ''), type: String(account.type || ''), name: String(account.name || ''), uuid: String(account.uuid || '') },
    };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('accounts-remove', async (_evt, { id }) => {
  try {
    bootstrapClientFiles();
    const cfgPath = path.join(getClientDir(), 'config.json');
    const cfg = normalizeAccountsConfig(readJson(cfgPath, null) || {});
    const targetId = String(id || '').trim();
    cfg.accounts = Array.isArray(cfg.accounts) ? cfg.accounts.filter(a => String(a?.id || '') !== targetId) : [];
    if (cfg.activeAccountId === targetId) cfg.activeAccountId = '';
    const active = getActiveAccount(cfg);
    if (active) {
      cfg.activeAccountId = String(active.id || '') || cfg.activeAccountId;
      if (active.type === 'microsoft') {
        const tk = String(active.accessToken || '');
        cfg.microsoftAccount = {
          name: String(active.name || ''),
          uuid: String(active.uuid || ''),
          accessToken: tk ? (encryptLocalSecret(tk) || tk) : '',
          updatedAt: Number(active.updatedAt || 0) || Date.now(),
        };
      }
    } else {
      cfg.microsoftAccount = null;
    }
    writeJson(cfgPath, cfg);
    return { ok: true, activeAccountId: String(cfg.activeAccountId || '') };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

// ── Launch Modrinth ──
ipcMain.handle('launch-modrinth', async (_, { profileId }) => {
  const paths = {
    win32:  path.join(os.homedir(), 'AppData', 'Local', 'ModrinthApp', 'ModrinthApp.exe'),
    darwin: '/Applications/Modrinth App.app/Contents/MacOS/ModrinthApp',
    linux:  path.join(os.homedir(), '.local', 'bin', 'modrinth-app')
  };
  const exe = paths[process.platform];
  if (exe && fs.existsSync(exe)) {
    const p = spawn(exe, profileId ? ['--profile', profileId] : [], { detached:true, stdio:'ignore' });
    p.unref();
    return { ok:true };
  }
  shell.openExternal('https://modrinth.com/app');
  return { ok:true, fallback:true };
});

ipcMain.handle('open-mc-folder',    () => { shell.openPath(getMcDir()); return { ok:true }; });
ipcMain.handle('open-modrinth-url', (_, { url }) => {
  const target = String(url || 'https://modrinth.com/app');
  if (!isSafeExternalUrl(target)) return { ok:false, msg:'URL bloqueada por segurança.' };
  shell.openExternal(target);
  return { ok:true };
});

ipcMain.handle('clipboard-write-text', async (_evt, { text } = {}) => {
  try {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('cosmetics-fetch', async () => {
  try {
    return await cosmeticsFetchForActivePlayer();
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('cosmetics-equip', async (_evt, payload) => {
  try {
    return await cosmeticsEquipForActivePlayer(payload || {});
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('official-skin-upload', async (_evt, { variant } = {}) => {
  try {
    bootstrapClientFiles();
    const cfgPath = path.join(getClientDir(), 'config.json');
    const cfg = normalizeAccountsConfig(readJson(cfgPath, null) || {});
    const ms = getActiveAccount(cfg);
    const token = String(ms?.accessToken || '').trim();
    if (!token) return { ok: false, msg: 'Faça login com Microsoft para trocar a skin original.' };

    const result = await dialog.showOpenDialog(win, {
      title: 'Selecionar skin (.png) — Oficial',
      filters: [{ name: 'Imagem PNG', extensions: ['png'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const src = result.filePaths[0];
    const buf = fs.readFileSync(src);

    const v = String(variant || 'classic').toLowerCase() === 'slim' ? 'slim' : 'classic';
    const boundary = '----HeephOfficialSkin' + Date.now();
    const fileName = path.basename(src).replace(/\r|\n/g, '') || 'skin.png';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="variant"\r\n\r\n${v}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const url = 'https://api.minecraftservices.com/minecraft/profile/skins';
    return await new Promise((resolve) => {
      try {
        const req = net.request({
          method: 'POST',
          url,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length),
          },
        });
        let data = '';
        req.on('response', (r) => {
          r.on('data', (c) => { data += c; });
          r.on('end', () => {
            const code = Number(r.statusCode || 0);
            if (code >= 200 && code < 300) return resolve({ ok: true });
            if (code === 401 || code === 403) return resolve({ ok: false, msg: 'Token Microsoft inválido/expirado. Faça login novamente.' });
            resolve({ ok: false, msg: `Falha ao trocar skin (HTTP ${code || 'ERR'})` });
          });
        });
        req.on('error', (e) => resolve({ ok: false, msg: e?.message || String(e) }));
        req.write(body);
        req.end();
      } catch (e) {
        resolve({ ok: false, msg: e?.message || String(e) });
      }
    });
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('official-skin-reset', async () => {
  try {
    bootstrapClientFiles();
    const cfgPath = path.join(getClientDir(), 'config.json');
    const cfg = normalizeAccountsConfig(readJson(cfgPath, null) || {});
    const ms = getActiveAccount(cfg);
    const token = String(ms?.accessToken || '').trim();
    if (!token) return { ok: false, msg: 'Faça login com Microsoft para trocar a skin original.' };

    const url = 'https://api.minecraftservices.com/minecraft/profile/skins/active';
    return await new Promise((resolve) => {
      try {
        const req = net.request({
          method: 'DELETE',
          url,
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });
        req.on('response', (r) => {
          const code = Number(r.statusCode || 0);
          if (code >= 200 && code < 300) return resolve({ ok: true });
          if (code === 401 || code === 403) return resolve({ ok: false, msg: 'Token Microsoft inválido/expirado. Faça login novamente.' });
          resolve({ ok: false, msg: `Falha ao resetar skin (HTTP ${code || 'ERR'})` });
        });
        req.on('error', (e) => resolve({ ok: false, msg: e?.message || String(e) }));
        req.end();
      } catch (e) {
        resolve({ ok: false, msg: e?.message || String(e) });
      }
    });
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

ipcMain.handle('official-skin-get', async () => {
  try {
    bootstrapClientFiles();
    const cfgPath = path.join(getClientDir(), 'config.json');
    const cfg = normalizeAccountsConfig(readJson(cfgPath, null) || {});
    const ms = getActiveAccount(cfg);
    const token = String(ms?.accessToken || '').trim();
    if (!token) return { ok: false, msg: 'Faça login com Microsoft.' };

    const profileUrl = 'https://api.minecraftservices.com/minecraft/profile';
    const profText = await fetchText(profileUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      maxRedirects: 2,
    });
    const prof = JSON.parse(String(profText?.data || 'null'));
    const skins = Array.isArray(prof?.skins) ? prof.skins : [];
    const active = skins.find(s => s?.state === 'ACTIVE') || skins[0] || null;
    const skinUrl = String(active?.url || '').trim();
    if (!skinUrl) return { ok: false, msg: 'Skin oficial não encontrada.' };

    const img = await fetchBuffer(skinUrl, { maxRedirects: 3 });
    const dataUrl = 'data:image/png;base64,' + Buffer.from(img.data).toString('base64');
    return {
      ok: true,
      name: String(ms?.name || ''),
      uuid: String(ms?.uuid || ''),
      variant: String(active?.variant || ''),
      dataUrl,
    };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

// ── Skins ──
function getSkinsDir() {
  const d = path.join(getClientDir(), 'skins');
  ensureDir(d);
  return d;
}

ipcMain.handle('skins-list', async () => {
  const dir = getSkinsDir();
  const files = fs.readdirSync(dir).filter(f => /\.png$/i.test(f));
  const cfgPath = path.join(getClientDir(), 'config.json');
  const cfg = readJson(cfgPath, null) || {};
  const active = cfg.activeSkin || '';
  return files.map(f => ({
    name: (() => {
      const base = f.replace(/\.png$/i, '');
      const low = base.toLowerCase();
      if (low === 'heeph') return 'Heeph';
      if (low === 'mohud' || low.startsWith('mohud')) return 'Mohud';
      return base;
    })(),
    file: f,
    active: f === active,
    dataUrl: 'data:image/png;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64'),
  }));
});

ipcMain.handle('skin-select', async (_, { file, username } = {}) => {
  const f = String(file || '').trim();
  if (f && (f.includes('..') || f.includes('/') || f.includes('\\') || path.isAbsolute(f))) return { ok: false, msg: 'Caminho inválido.' };
  const cfgPath = path.join(getClientDir(), 'config.json');
  const cfg = readJson(cfgPath, null) || {};
  const u = String(username || '').trim();
  if (u && !cfg.username) cfg.username = u;
  cfg.activeSkin = f;

  // Persist per-offline username so each pirate nick keeps its own skin.
  try {
    const accCfg = normalizeAccountsConfig(cfg);
    const active = getActiveAccount(accCfg);
    const isOffline = !!active && String(active.type || '') === 'offline';
    const keyUser = String(u || accCfg.username || '').trim();
    if (isOffline && keyUser) {
      if (!accCfg.offlineSkins || typeof accCfg.offlineSkins !== 'object') accCfg.offlineSkins = {};
      accCfg.offlineSkins[keyUser.toLowerCase()] = String(file || '');
      writeJson(cfgPath, accCfg);
    } else {
      writeJson(cfgPath, cfg);
    }
  } catch (_) {
    writeJson(cfgPath, cfg);
  }
  try {
    const serverUrl = String(cfg?.heephSkinServer?.url || '').trim().replace(/\/$/, '');
    const secret = String(cfg?.heephSkinServer?.uploadSecret || '').trim();
    if (serverUrl && secret) {
      // Fire and forget — don't block UI waiting for server push
      pushSkinToHeephServer({ file: f, username: u || cfg.username }).catch(() => {});
      return { ok: true, pushed: true };
    }
  } catch (_) {}
  return { ok: true, pushed: false };
});

ipcMain.handle('skin-upload', async (_, { name } = {}) => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Selecionar skin (.png)',
    filters: [{ name: 'Imagem PNG', extensions: ['png'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  const src = result.filePaths[0];
  const originalFileName = path.basename(src);
  const base = String(name || '').trim() || originalFileName.replace(/\.png$/i, '');
  const safeBase = base
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\.+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!safeBase) return { ok: false, msg: 'Nome inválido' };

  let fileName = safeBase + '.png';
  let dest = path.join(getSkinsDir(), fileName);
  let n = 1;
  while (fs.existsSync(dest)) {
    fileName = `${safeBase} (${n++}).png`;
    dest = path.join(getSkinsDir(), fileName);
  }
  try {
    fs.copyFileSync(src, dest);
    return {
      ok: true,
      file: fileName,
      name: safeBase,
      dataUrl: 'data:image/png;base64,' + fs.readFileSync(dest).toString('base64'),
    };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
});

ipcMain.handle('skin-get-config', async () => {
  bootstrapClientFiles();
  const cfg = readJson(path.join(getClientDir(), 'config.json'), null) || {};
  return {
    elyEnabled: !!cfg.authlibInjector?.enabled,
    activeSkin: cfg.activeSkin || '',
  };
});

ipcMain.handle('skin-set-ely', async (_, { enabled }) => {
  const cfgPath = path.join(getClientDir(), 'config.json');
  const cfg = readJson(cfgPath, null) || {};
  if (!cfg.authlibInjector) cfg.authlibInjector = {};
  cfg.authlibInjector.enabled = !!enabled;
  writeJson(cfgPath, cfg);
  return { ok: true };
});

ipcMain.handle('skin-get-server', async () => {
  bootstrapClientFiles();
  const cfg = readJson(path.join(getClientDir(), 'config.json'), null) || {};
  return {
    url:    String(cfg?.heephSkinServer?.url || '').trim(),
    active: !!String(cfg?.heephSkinServer?.url || '').trim(),
  };
});

ipcMain.handle('skin-server-set', async (_evt, { url, uploadSecret } = {}) => {
  try {
    bootstrapClientFiles();
    const cfgPath = path.join(getClientDir(), 'config.json');
    const cfg = readJson(cfgPath, null) || {};
    if (!cfg.heephSkinServer || typeof cfg.heephSkinServer !== 'object') cfg.heephSkinServer = {};

    if (typeof url === 'string') cfg.heephSkinServer.url = String(url || '').trim();
    if (typeof uploadSecret === 'string') {
      const raw = String(uploadSecret || '').trim();
      cfg.heephSkinServer.uploadSecret = raw ? encryptLocalSecret(raw) : '';
    }

    writeJson(cfgPath, cfg);
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e?.message || String(e) };
  }
});

async function pushSkinToHeephServer({ file, username } = {}) {
  const cfg         = readJson(path.join(getClientDir(), 'config.json'), null) || {};
  const serverUrl   = String(cfg?.heephSkinServer?.url          || '').trim().replace(/\/$/, '');
  const secret      = decryptLocalSecret(String(cfg?.heephSkinServer?.uploadSecret || '').trim());
  const u           = String(username || cfg?.username || '').trim();

  if (!serverUrl) return { ok: false, msg: 'heephSkinServer.url não configurado' };
  if (!secret)   return { ok: false, msg: 'uploadSecret não configurado' };
  if (!u)  return { ok: false, msg: 'Nome de jogador não configurado' };

  const skinPath = path.join(getSkinsDir(), file);
  if (!fs.existsSync(skinPath)) return { ok: false, msg: 'Arquivo de skin não encontrado' };

  const skinData = fs.readFileSync(skinPath);
  const boundary = '----HeephBoundary' + Date.now();

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="username"\r\n\r\n${u}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="secret"\r\n\r\n${secret}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="skin"; filename="${file}"\r\nContent-Type: image/png\r\n\r\n`),
    skinData,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve) => {
    try {
      const target = new URL(`${serverUrl}/api/skin`);
      const isHttps = target.protocol === 'https:';
      const client = isHttps ? https : http;
      const req = client.request({
        method: 'POST',
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.ok ? { ok: true } : { ok: false, msg: json.error || 'Erro no servidor' });
          } catch {
            resolve({ ok: false, msg: `Resposta inválida: ${data.slice(0, 80)}` });
          }
        });
      });
      req.on('error', (e) => resolve({ ok: false, msg: e.message }));
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, msg: e.message });
    }
  });
}

ipcMain.handle('skin-push', async (_, { file, username } = {}) => {
  return pushSkinToHeephServer({ file, username });
});
