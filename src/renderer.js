/* ═══════════════════════════════════════════════════════
   Heeph Client — renderer.js
   Modrinth API: https://api.modrinth.com/v2
═══════════════════════════════════════════════════════ */

const MODRINTH_API = 'https://api.modrinth.com/v2';

// Some bundled UI/helpers may call a global dragEvent handler.
// Provide a safe default to avoid runtime ReferenceError.
try {
  if (typeof window !== 'undefined' && typeof window.dragEvent !== 'function') {
    let _dragEventWarned = false;
    window.dragEvent = function () {
      if (_dragEventWarned) return;
      _dragEventWarned = true;
      console.warn('[dragEvent] called but no handler was provided; ignoring');
    };
  }
} catch (_) {}

let cosmetics3dViewer = null;
let cosmetics3dResize = null;
let cosmetics3dBlobUrl = null;
let cosmeticsCapeBlob = null;
let cosmeticsWingBlob = null;
let _wingAnimId = null;
let _capeAnimId = null;

function stopCapeAnimation() {
  if (_capeAnimId) { cancelAnimationFrame(_capeAnimId); _capeAnimId = null; }
}

function startCapeAnimation(viewer) {
  stopCapeAnimation();
  try {
    const cape = viewer?.playerObject?.cape;
    if (!cape) return;
    const BASE = (10.8 * Math.PI) / 180;
    const anim = () => {
      const t = performance.now() / 1000;
      // Gentle wind sway: two sine waves combined for organic feel
      const sway = Math.sin(t * 1.8) * 5 * (Math.PI/180) + Math.sin(t * 3.1) * 2 * (Math.PI/180);
      cape.rotation.x = BASE + sway;
      _capeAnimId = requestAnimationFrame(anim);
    };
    _capeAnimId = requestAnimationFrame(anim);
  } catch (_) {}
}

function removeDragonWings(v) {
  try {
    if (_wingAnimId) { cancelAnimationFrame(_wingAnimId); _wingAnimId = null; }
    if (!v?.playerObject) return;
    const g = v.playerObject.getObjectByName('__dragonWings');
    if (g) { v.playerObject.remove(g); g.traverse(o => { try { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } } catch(_){} }); }
  } catch (_) {}
}

async function applyDragonWings(viewer, texUrl) {
  try {
    removeDragonWings(viewer);
    const T = window.THREE;
    if (!T || !texUrl || !viewer?.playerObject) return;
    const resp = await fetch(texUrl); if (!resp.ok) return;
    const bl = await resp.blob(), bu = URL.createObjectURL(bl);
    const img = await new Promise((r,j)=>{ const i=new Image(); i.onload=()=>r(i); i.onerror=j; i.src=bu; });
    const cv = document.createElement('canvas'); cv.width=img.width; cv.height=img.height;
    cv.getContext('2d').drawImage(img,0,0); URL.revokeObjectURL(bu);
    console.log('[DragonWings] texture size:', img.width, 'x', img.height);
    const tex = new T.CanvasTexture(cv); tex.magFilter=T.NearestFilter; tex.minFilter=T.NearestFilter;
    tex.wrapS=T.ClampToEdgeWrapping; tex.wrapT=T.ClampToEdgeWrapping;
    // Detect flipY: CanvasTexture may default true or false depending on Three.js version
    // Force true for consistent behavior across versions
    tex.flipY=true;
    // Texture is 256x256 (Ender Dragon wing format)
    const TW=img.width,TH=img.height,D=Math.PI/180;
    // Build quad in XZ plane matching MC's h=0 box top face
    // MC TexturedQuad maps: near-edge(z1)→pv2, far-edge(z2)→pv1
    // flipY=true: Three.js v=0→bottom, v=1→top → v_three = 1 - pixel_row/TH
    const mkQuad=(x1,z1,x2,z2,pu1,pv1,pu2,pv2)=>{
      const g=new T.BufferGeometry();
      const p=new Float32Array([x1,0,z1, x2,0,z1, x1,0,z2, x2,0,z2]);
      const u=new Float32Array([
        pu1/TW,1-pv2/TH, pu2/TW,1-pv2/TH,
        pu1/TW,1-pv1/TH, pu2/TW,1-pv1/TH
      ]);
      g.setIndex([0,2,1, 2,3,1]);
      g.setAttribute('position',new T.BufferAttribute(p,3));
      g.setAttribute('uv',new T.BufferAttribute(u,2));
      return g;
    };
    const bMat=new T.MeshBasicMaterial({color:0x191919});
    const sMat=new T.MeshBasicMaterial({map:tex,side:T.DoubleSide,transparent:true,alphaTest:0.01,depthWrite:false});
    // Ender Dragon wing UV layout in 256x256 texture:
    // Wing skin top face:    (0, 88)  → (56, 144)
    // Wingtip skin top face: (0, 144) → (56, 200)
    const wSG=mkQuad(-10,0.5,0,10.5, 0,88,56,144);
    const tSG=mkQuad(-10,0.5,0,10.5, 0,144,56,200);
    const wBG=new T.BoxGeometry(10,2,2), tBG=new T.BoxGeometry(10,1,1);

    // --- Nested groups replicating exact MC GL call chain ---
    const root=new T.Group(); root.name='__dragonWings'; root.position.set(0,-12,0);
    const gScale=new T.Group(); gScale.scale.set(-1,-1,1); root.add(gScale);
    const gRot=new T.Group(); gRot.rotation.y=Math.PI; gScale.add(gRot);
    const gT1=new T.Group(); gT1.position.set(0,-20,0); gRot.add(gT1);
    const gT2=new T.Group(); gT2.position.set(0,0,3.2); gT1.add(gT2);

    const mkW=()=>{
      const arm=new T.Group(); arm.position.set(-2,0,0);
      const rZ=new T.Group(); rZ.rotation.z=20*D;   arm.add(rZ);
      const rY=new T.Group(); rY.rotation.y=20*D;   rZ.add(rY);
      const rX=new T.Group(); rX.rotation.x=-80*D;  rY.add(rX);

      // Wing bone
      const b=new T.Mesh(wBG,bMat); b.position.set(-5,0,0); rX.add(b);
      // Wing membrane (already in XZ plane, no rotation needed)
      const s=new T.Mesh(wSG,sMat); rX.add(s);

      // Wingtip
      const tipArm=new T.Group(); tipArm.position.set(-10,0,0); rX.add(tipArm);
      const tipRZ=new T.Group(); tipRZ.rotation.z=-0.75; tipArm.add(tipRZ);
      const tb=new T.Mesh(tBG,bMat); tb.position.set(-5,0,0); tipRZ.add(tb);
      const ts=new T.Mesh(tSG,sMat); tipRZ.add(ts);

      return { arm, rZ, rX, tipRZ };
    };

    // Left wing
    const L=mkW(); gT2.add(L.arm);

    // Right wing: MC does glScalef(-1, 1, 1) after first wing render
    const mirror=new T.Group(); mirror.scale.set(-1,1,1); gT2.add(mirror);
    const R=mkW(); mirror.add(R.arm);

    viewer.playerObject.add(root);

    // Idle flap animation
    const BASE_Z=20*D, BASE_X=-80*D, BASE_TIP=-0.75;
    const animate=()=>{
      const t=performance.now()/1000;
      // Slow sine wave: ~1.2s period
      const s=Math.sin(t*2.5);
      // Wing spread (Z): oscillate ±12°
      const zOff=s*12*D;
      // Wing flap (X): oscillate ±8°
      const xOff=s*8*D;
      // Wingtip fold: oscillate ±0.3 rad
      const tipOff=s*0.3;
      [L,R].forEach(w=>{
        w.rZ.rotation.z=BASE_Z+zOff;
        w.rX.rotation.x=BASE_X+xOff;
        w.tipRZ.rotation.z=BASE_TIP-tipOff;
      });
      _wingAnimId=requestAnimationFrame(animate);
    };
    _wingAnimId=requestAnimationFrame(animate);
  } catch(_){}
}

function ensureCosmetics3dViewer() {
  const canvas = document.getElementById('cosmetics-preview-canvas');
  if (!canvas) return null;
  try { if (typeof lowEndModeEnabled !== 'undefined' && lowEndModeEnabled) return null; } catch (_) {}
  if (!window.skinview3d || !window.skinview3d.SkinViewer) return null;

  const wrap = document.getElementById('cosmetics-preview-canvas-wrap');
  const getWH = () => {
    if (wrap) {
      const r = wrap.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) return { w: Math.floor(r.width), h: Math.floor(r.height) };
    }
    return { w: 200, h: 400 };
  };

  if (cosmetics3dViewer) {
    try {
      const { w, h } = getWH();
      cosmetics3dViewer.setSize(w, h);
    } catch (_) {}
    return cosmetics3dViewer;
  }

  const { w, h } = getWH();

  cosmetics3dViewer = new window.skinview3d.SkinViewer({
    canvas,
    width: w,
    height: h,
    zoom: 0.25,
  });

  try {
    cosmetics3dViewer.renderer.setClearColor(0x000000, 0);
    canvas.style.background = 'transparent';
  } catch (_) {}

  try {
    if (typeof cosmetics3dViewer.controls !== 'undefined') {
      cosmetics3dViewer.controls.enableRotate = true;
      cosmetics3dViewer.controls.enableZoom = true;
      cosmetics3dViewer.controls.enablePan = false;
      cosmetics3dViewer.controls.autoRotate = false;
    } else if (window.skinview3d.createOrbitControls) {
      window.skinview3d.createOrbitControls(cosmetics3dViewer);
    }
  } catch (_) {}

  try {
    if (typeof cosmetics3dViewer.autoRotate !== 'undefined') cosmetics3dViewer.autoRotate = false;
  } catch (_) {}

  try {
    const IdleAnimation = window.skinview3d?.IdleAnimation;
    const WalkingAnimation = window.skinview3d?.WalkingAnimation;
    if (IdleAnimation) {
      cosmetics3dViewer.animation = new IdleAnimation();
    } else if (WalkingAnimation) {
      const anim = new WalkingAnimation();
      anim.speed = 0.5;
      cosmetics3dViewer.animation = anim;
    }
  } catch (_) {}

  try {
    cosmetics3dResize = () => {
      try {
        const { w: rw, h: rh } = getWH();
        cosmetics3dViewer.setSize(rw, rh);
      } catch (_) {}
    };
    window.addEventListener('resize', cosmetics3dResize);
  } catch (_) {}

  return cosmetics3dViewer;
}

function forceCosmetics3dResize(delayMs) {
  const run = () => { try { if (typeof cosmetics3dResize === 'function') cosmetics3dResize(); } catch (_) {} };
  if (delayMs) { setTimeout(run, delayMs); } else { run(); }
}

function setCosmetics3dSkinFromDataUrl(viewer, dataUrl) {
  try {
    const s = String(dataUrl || '');
    if (!s.startsWith('data:image/')) return false;
    try { if (cosmetics3dBlobUrl) URL.revokeObjectURL(cosmetics3dBlobUrl); } catch (_) {}

    const comma = s.indexOf(',');
    if (comma === -1) return false;
    const header = s.slice(0, comma);
    const b64 = s.slice(comma + 1);
    const m = /data:([^;]+);base64/i.exec(header);
    const mime = (m && m[1]) ? m[1] : 'image/png';

    let bin;
    try { bin = atob(b64); } catch (_) { return false; }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    cosmetics3dBlobUrl = URL.createObjectURL(blob);
    viewer.loadSkin(cosmetics3dBlobUrl);
    forceCosmetics3dResize();
    return true;
  } catch (_) {
    return false;
  }
}

function applyLowEndMode() {
  try { document.body.classList.toggle('low-end-mode', !!lowEndModeEnabled); } catch (_) {}
}

/* ── Storage ──────────────────────────────────────── */
const load = (k, d='') => localStorage.getItem(k) ?? d;
const save = (k, v)    => localStorage.setItem(k, String(v));

const cfg = {
  username:  load('hc_user'),
  customVer: load('hc_ver'),
  ram:       parseInt(load('hc_ram','2048')),
  elyToken:  load('hc_ely_token'),
  elyUuid:   load('hc_ely_uuid'),
};

const SKIN_SECRET_KEY = 'hc_skin_upload_secret';

let pendingFirstRunOverlay = false;

function isValidOfflineUsername(u) {
  const s = String(u || '').trim();
  return /^[A-Za-z0-9_]{3,16}$/.test(s);
}

function loadPinnedAccounts() {
  try {
    const raw = String(load('hc_account_pins', ''));
    const arr = JSON.parse(raw || '[]');
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch (_) {}
  return [];
}

function savePinnedAccounts(ids) {
  try { save('hc_account_pins', JSON.stringify(Array.isArray(ids) ? ids : [])); } catch (_) {}
}

/* ── Versions modal ──────────────────────────────── */
let availableVersions = ['heeph-1.8.9'];

function openVersionsMenu() {
  const menu = document.getElementById('ver-menu');
  const sel = document.getElementById('ver-select');
  if (!menu || !sel) return;

  const active = String(sel.value || cfg.customVer || '').trim();
  menu.innerHTML = '';

  (availableVersions || ['heeph-1.8.9']).forEach(v => {
    const item = document.createElement('div');
    item.className = 'ver-menu-item' + (String(v) === active ? ' active' : '');

    const nm = document.createElement('div');
    nm.className = 'ver-menu-name';
    nm.textContent = (v === 'heeph-1.8.9') ? 'HEEPH 1.8.9' : String(v);
    const sub = document.createElement('div');
    sub.className = 'ver-menu-sub';
    sub.textContent = (v === 'heeph-1.8.9') ? 'Only version available for now' : 'Version';
    item.appendChild(nm);
    item.appendChild(sub);

    item.onclick = (e) => {
      try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
      sel.value = String(v);
      try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
      closeVersionsMenu();
    };
    menu.appendChild(item);
  });

  menu.style.display = 'flex';
}

function closeVersionsMenu() {
  const menu = document.getElementById('ver-menu');
  if (menu) menu.style.display = 'none';
}

function toggleVersionsMenu() {
  const menu = document.getElementById('ver-menu');
  if (!menu) return;
  const open = (menu.style.display !== 'none' && menu.style.display !== '');
  if (open) closeVersionsMenu();
  else openVersionsMenu();
}

try {
  const wrap = document.querySelector('.version-select-wrap');
  if (wrap) {
    wrap.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleVersionsMenu();
    };
  }

  // Close on outside click
  document.addEventListener('pointerdown', (e) => {
    const t = e?.target;
    const menu = document.getElementById('ver-menu');
    if (!menu) return;
    const clickedWrap = t && t.closest ? t.closest('.version-select-wrap') : null;
    if (clickedWrap) return;
    if (menu.style.display === 'flex') closeVersionsMenu();
  }, true);
} catch (_) {}

let msPollTimer = null;
function stopMsPoll() {
  try { if (msPollTimer) clearInterval(msPollTimer); } catch (_) {}
  msPollTimer = null;
}
function startMsPoll() {
  stopMsPoll();
  msPollTimer = setInterval(async () => {
    try {
      if (!$('ms-modal') || $('ms-modal').style.display !== 'flex') return;
      const st = await window.api.microsoftStatus().catch(() => null);
      if (!st?.ok || !st?.loggedIn) return;
      const nm = String(st?.name || '').trim();
      if (nm) {
        cfg.username = nm;
        save('hc_user', cfg.username);
        syncAccountName();
        updateStartSub();
        refreshOfficialSkinAvatar();
      }
      try { if ($('ms-status')) $('ms-status').textContent = 'Conectado!'; } catch (_) {}
      stopMsPoll();
    } catch (_) {}
  }, 2000);
}

function syncAccountName() {
  const nameEl = $('account-name');
  if (nameEl) nameEl.textContent = cfg.username || 'Player';

  try {
    if (!window.api?.microsoftStatus) return;
    window.api.microsoftStatus().then((st) => {
      try {
        if (!st?.ok || !st?.loggedIn) return;
        const nm = String(st?.name || '').trim();
        if (!nm) return;
        if (cfg.username !== nm) {
          cfg.username = nm;
          save('hc_user', cfg.username);
        }
        const el = $('account-name');
        if (el) el.textContent = nm;
      } catch (_) {}
    }).catch(() => null);
  } catch (_) {}
}

async function refreshOfficialSkinAvatar() {
  try {
    const name = String(cfg.username || '').trim();
    const img = $('account-skin');
    const wrap = document.querySelector('.account-avatar');
    if (!img || !wrap) return;
    if (!name) {
      wrap.classList.remove('has-skin');
      img.removeAttribute('src');
      return;
    }

    let ms = null;
    try { ms = await window.api.microsoftStatus().catch(() => null); } catch (_) { ms = null; }
    const isOriginal = !!(ms && ms.ok && ms.loggedIn);

    const setAvatarFromSkinDataUrl = async (dataUrl) => {
      const s = String(dataUrl || '');
      if (!s.startsWith('data:image/')) {
        wrap.classList.remove('has-skin');
        img.removeAttribute('src');
        return;
      }

      const im = new Image();
      im.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 64;
          c.height = 64;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          // Face base (8,8) 8x8
          ctx.drawImage(im, 8, 8, 8, 8, 0, 0, 64, 64);
          // Hat/overlay (40,8) 8x8
          ctx.drawImage(im, 40, 8, 8, 8, 0, 0, 64, 64);
          img.onload = () => { try { wrap.classList.add('has-skin'); } catch (_) {} };
          img.onerror = () => { try { wrap.classList.remove('has-skin'); } catch (_) {} };
          img.src = c.toDataURL('image/png');
        } catch (_) {
          wrap.classList.remove('has-skin');
          img.removeAttribute('src');
        }
      };
      im.onerror = () => {
        wrap.classList.remove('has-skin');
        img.removeAttribute('src');
      };
      im.src = s;
    };

    if (!isOriginal) {
      const skinCfg = await window.api.skinGetConfig().catch(() => null);
      const activeFile = String(skinCfg?.activeSkin || '').trim();
      if (!activeFile) {
        wrap.classList.remove('has-skin');
        img.removeAttribute('src');
        return;
      }
      const list = await window.api.skinsList().catch(() => []);
      const skins = Array.isArray(list) ? list : [];
      const active = skins.find(s => String(s?.file || '') === activeFile) || skins.find(s => !!s?.active) || null;
      await setAvatarFromSkinDataUrl(active?.dataUrl || '');
      return;
    }

    // 1) Resolve username -> UUID (Mojang)
    let id = String(ms?.uuid || '').trim();
    if (!id) {
      const p = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`).catch(() => null);
      if (!p || !p.ok) {
        wrap.classList.remove('has-skin');
        img.removeAttribute('src');
        return;
      }
      const prof = await p.json().catch(() => null);
      id = String(prof?.id || '').trim();
      if (!id) return;
    }

    // 2) Use a render service to show the face (avoids parsing textures)
    const faceUrl = `https://mc-heads.net/avatar/${id}/64`;
    img.onload = () => { try { wrap.classList.add('has-skin'); } catch (_) {} };
    img.onerror = () => { try { wrap.classList.remove('has-skin'); } catch (_) {} };
    img.src = faceUrl;
  } catch (_) {}
}

function renderNewsEmptyState(msg) {
  if (!newsContent) return;
  const header = `
    <div class="news-top">
      <div class="news-top-title">LATEST NEWS</div>
      <a class="news-top-link" href="#" id="news-view-all">View all News</a>
    </div>
  `;
  const body = `
    <div style="padding: 28px 2px; color: rgba(255,255,255,.62); font-size: 12px;">
      ${String(msg || 'Sem notícias por enquanto.')}
    </div>
  `;
  newsContent.innerHTML = header + body;

  const viewAll = document.getElementById('news-view-all');
  if (viewAll) viewAll.onclick = (e) => {
    e.preventDefault();
    if (newsModal && newsModal.querySelector('.news-modal-title')) {
      newsModal.querySelector('.news-modal-title').textContent = 'ALL NEWS';
    }
    openAllNewsModal();
  };
}

/* ── DOM ─────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const loadingStartedAt = Date.now();
const minLoadingMs = 2500;

/* ── i18n ─────────────────────────────────────────── */
let uiLang = 'en';
let lowEndModeEnabled = false;
const I18N = {
  en: {
    tab_home: 'HOME',
    tab_skins: 'SKINS',
    tab_settings: 'SETTINGS',
    account: 'ACCOUNT',
    add_microsoft: 'Add Microsoft',
    username: 'Username',
    settings_game: 'Game',
    settings_general: 'General',
    settings_account: 'Account',
    settings_storage: 'Storage',
    settings_notifications: 'Notifications',
    general_title: 'General Settings',
    game_title: 'Game Settings',
    account_title: 'Account Settings',
    storage_title: 'Storage Settings',
    notifications_title: 'Notification Settings',
  },
  'pt-BR': {
    tab_home: 'INÍCIO',
    tab_skins: 'SKINS',
    tab_settings: 'CONFIGURAÇÕES',
    account: 'CONTA',
    add_microsoft: 'Adicionar Microsoft',
    username: 'Usuário',
    settings_game: 'Jogo',
    settings_general: 'Geral',
    settings_account: 'Conta',
    settings_storage: 'Armazenamento',
    settings_notifications: 'Notificações',
    general_title: 'Configurações Gerais',
    game_title: 'Configurações do Jogo',
    account_title: 'Configurações da Conta',
    storage_title: 'Configurações de Armazenamento',
    notifications_title: 'Configurações de Notificações',
  }
};

function pickLangFromLocale(locale) {
  const l = String(locale || '').toLowerCase();
  if (l.startsWith('pt')) return 'pt-BR';
  return 'en';
}

function t(key) {
  const dict = I18N[uiLang] || I18N.en;
  return dict[key] || (I18N.en[key] || key);
}

function applyI18n() {
  try { document.documentElement.lang = uiLang; } catch (_) {}

  const tabHome = document.querySelector('.tab-btn[data-tab="home"]');
  const tabSkins = document.querySelector('.tab-btn[data-tab="skins"]');
  const tabMenu = document.querySelector('.tab-btn[data-tab="menu"]');
  if (tabHome) tabHome.textContent = t('tab_home');
  if (tabSkins) tabSkins.textContent = t('tab_skins');
  if (tabMenu) tabMenu.textContent = t('tab_settings');

  const accountHeader = document.querySelector('.account-drawer-header span');
  if (accountHeader) accountHeader.textContent = t('account');
  const addMs = document.getElementById('account-add-microsoft');
  const userBtn = document.getElementById('account-username');
  if (addMs) addMs.textContent = t('add_microsoft');
  if (userBtn) userBtn.textContent = t('username');

  const navGame = document.querySelector('.settings-nav-item[data-settings-tab="game"] span:last-child');
  const navGeneral = document.querySelector('.settings-nav-item[data-settings-tab="general"] span:last-child');
  const navAccount = document.querySelector('.settings-nav-item[data-settings-tab="account"] span:last-child');
  const navStorage = document.querySelector('.settings-nav-item[data-settings-tab="storage"] span:last-child');
  const navNotif = document.querySelector('.settings-nav-item[data-settings-tab="notifications"] span:last-child');
  if (navGame) navGame.textContent = t('settings_game');
  if (navGeneral) navGeneral.textContent = t('settings_general');
  if (navAccount) navAccount.textContent = t('settings_account');
  if (navStorage) navStorage.textContent = t('settings_storage');
  if (navNotif) navNotif.textContent = t('settings_notifications');

  applyLowEndMode();
}

/* ── Toast ────────────────────────────────────────── */
let _tt;
let notificationsEnabled = true;
function toast(msg, ms=3000, { force = false } = {}) {
  if (!force && !notificationsEnabled) return;
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.remove('show'), ms);
}

// Surface Chromium network argument issues in a clearer way
try {
  window.addEventListener('error', (ev) => {
    const msg = String(ev?.message || '');
    if (!msg.includes('net::ERR_INVALID_ARGUMENT')) return;
    console.error('[ERR_INVALID_ARGUMENT]', ev);
    try { toast('❌ net::ERR_INVALID_ARGUMENT (see console)', 5000, { force: true }); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const msg = String(ev?.reason?.message || ev?.reason || '');
    if (!msg.includes('net::ERR_INVALID_ARGUMENT')) return;
    console.error('[ERR_INVALID_ARGUMENT][promise]', ev?.reason);
    try { toast('❌ net::ERR_INVALID_ARGUMENT (see console)', 5000, { force: true }); } catch (_) {}
  });
} catch (_) {}

/* ── Format numbers ───────────────────────────────── */
function fmt(n) {
  if (n >= 1_000_000) return (n/1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n/1_000).toFixed(1) + 'K';
  return String(n);
}

/* ── Window controls ──────────────────────────────── */
if ($('wc-min')) $('wc-min').onclick = () => window.api.minimize();
if ($('wc-max')) $('wc-max').onclick = () => window.api.maximize();
if ($('wc-close')) $('wc-close').onclick = () => window.api.close();

// Load app settings early (especially notifications)
try {
  if (window.api?.appSettingsGet) {
    window.api.appSettingsGet().then((r) => {
      if (r && r.ok && r.settings) notificationsEnabled = (r.settings?.notifications?.enabled !== false);
    }).catch(() => {});
  }
} catch (_) {}

// Load language early
try {
  if (window.api?.launcherSettingsGet) {
    window.api.launcherSettingsGet().then((r) => {
      const saved = String(r?.settings?.language || 'auto');
      const locale = String(r?.locale || '');
      lowEndModeEnabled = !!r?.settings?.lowEndMode;
      applyLowEndMode();
      uiLang = (saved === 'auto') ? pickLangFromLocale(locale) : saved;
      if (!I18N[uiLang]) uiLang = 'en';
      applyI18n();
    }).catch(() => {});
  }
} catch (_) {}

/* ── Tab navigation ───────────────────────────────── */
let modsLoaded = false;
let skinsLoaded = false;

document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
  btn.onclick = () => {
    const tab = btn.dataset.tab;

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const nextPage = $(`page-${tab}`);
    if (!nextPage) return;
    const currentPage = document.querySelector('.page.active');
    if (currentPage && currentPage !== nextPage) {
      currentPage.classList.add('page-leave');
      currentPage.classList.remove('active');
      setTimeout(() => {
        try { currentPage.classList.remove('page-leave'); } catch (_) {}
      }, 220);
    }
    nextPage.classList.add('active');

    if (tab === 'mods' && !modsLoaded) {
      modsLoaded = true;
      searchMods();
    }
    if (tab === 'skins') {
      if (!skinsLoaded) {
        skinsLoaded = true;
      }
      if (typeof loadSkinsTab === 'function') loadSkinsTab();
    }
  };
});

/* ── Settings page (sidebar) ──────────────────────── */
try {
  const titleEl = document.getElementById('settings-title');
  const panels = document.querySelectorAll('.settings-panel[id^="settings-panel-"]');
  const navItems = document.querySelectorAll('.settings-nav-item[data-settings-tab]');
  const searchInput = document.getElementById('settings-search');

  const hwToggle = document.getElementById('set-hw-accel');
  const trayToggle = document.getElementById('set-exit-to-tray');
  const lowEndToggle = document.getElementById('set-low-end');

  const langSelect = document.getElementById('set-language');
  const langSaveBtn = document.getElementById('set-language-save');

  const notifToggle = document.getElementById('set-notifications');

  const openAccountsBtn = document.getElementById('set-open-accounts');
  const msLogoutBtn = document.getElementById('set-ms-logout');
  const accountStatusEl = document.getElementById('set-account-status');

  const openMcBtn = document.getElementById('set-open-mc');
  const openDataBtn = document.getElementById('set-open-data');
  const clearCacheBtn = document.getElementById('set-clear-cache');
  const clearLogsBtn = document.getElementById('set-clear-logs');
  const heephRepairBtn = document.getElementById('set-heeph-repair');

  const discordTokenEl = document.getElementById('set-discord-token');
  const discordGuildEl = document.getElementById('set-discord-guild');
  const discordNewsEl = document.getElementById('set-discord-news');
  const discordChangelogEl = document.getElementById('set-discord-changelog');
  const discordLimitEl = document.getElementById('set-discord-limit');
  const discordSaveBtn = document.getElementById('set-discord-save');

  const allowHttpToggle = document.getElementById('set-allow-http');
  const allowedHostsEl = document.getElementById('set-allowed-hosts');
  const privacySaveBtn = document.getElementById('set-privacy-save');

  const loadLauncherSettings = async () => {
    if (!window.api?.launcherSettingsGet) return;
    const r = await window.api.launcherSettingsGet().catch(() => null);
    if (!r || !r.ok || !r.settings) return;
    if (hwToggle) hwToggle.checked = (r.settings.hardwareAcceleration !== false);
    if (trayToggle) trayToggle.checked = (r.settings.exitToTray !== false);
    if (langSelect) langSelect.value = String(r.settings.language || 'auto');
    if (lowEndToggle) lowEndToggle.checked = !!r.settings.lowEndMode;
  };

  const loadAppSettings = async () => {
    if (!window.api?.appSettingsGet) return;
    const r = await window.api.appSettingsGet().catch(() => null);
    if (!r || !r.ok || !r.settings) return;
    notificationsEnabled = (r.settings?.notifications?.enabled !== false);
    if (notifToggle) notifToggle.checked = notificationsEnabled;

    if (discordTokenEl) discordTokenEl.value = String(r.settings?.discordNews?.botToken || '');
    if (discordGuildEl) discordGuildEl.value = String(r.settings?.discordNews?.guildId || '');
    if (discordNewsEl) discordNewsEl.value = String(r.settings?.discordNews?.newsChannelId || '');
    if (discordChangelogEl) discordChangelogEl.value = String(r.settings?.discordNews?.changelogChannelId || '');
    if (discordLimitEl) discordLimitEl.value = String(r.settings?.discordNews?.limit ?? 8);

    if (allowHttpToggle) allowHttpToggle.checked = !!r.settings?.security?.allowInsecureHttp;
    if (allowedHostsEl) allowedHostsEl.value = String((r.settings?.security?.allowedUpdateHosts || []).join(', '));
  };

  const refreshAccountStatus = async () => {
    if (!accountStatusEl || !window.api?.microsoftStatus) return;
    const r = await window.api.microsoftStatus().catch(() => null);
    if (!r || !r.ok) return;
    if (!r.loggedIn) accountStatusEl.textContent = 'Not signed in';
    else accountStatusEl.textContent = `Signed in as ${r.name || 'Unknown'}`;
  };

  const prettyTitle = (key) => {
    const k = String(key || '').toLowerCase();
    if (k === 'game') return t('game_title');
    if (k === 'general') return t('general_title');
    if (k === 'account') return t('account_title');
    if (k === 'storage') return t('storage_title');
    if (k === 'notifications') return t('notifications_title');
    if (k === 'discord') return 'Discord Settings';
    if (k === 'privacy') return 'Privacy Settings';
    return 'Settings';
  };

  const setActiveTab = (key) => {
    navItems.forEach(b => b.classList.toggle('active', String(b.dataset.settingsTab) === String(key)));
    panels.forEach(p => p.classList.toggle('is-active', p.id === `settings-panel-${key}`));
    if (titleEl) titleEl.textContent = prettyTitle(key);
    if (searchInput) searchInput.value = '';
    applySettingsSearch('');
  };

  const applySettingsSearch = (q) => {
    const query = String(q || '').trim().toLowerCase();
    const activePanel = document.querySelector('.settings-panel.is-active');
    if (!activePanel) return;
    activePanel.querySelectorAll('.settings-card').forEach(card => {
      const label = String(card.getAttribute('data-setting-label') || '');
      const t = String(card.querySelector('.settings-card-title')?.textContent || '');
      const s = String(card.querySelector('.settings-card-sub')?.textContent || '');
      const hay = `${label} ${t} ${s}`.toLowerCase();
      const ok = !query || hay.includes(query);
      card.style.display = ok ? '' : 'none';
    });
  };

  navItems.forEach(btn => {
    btn.onclick = () => {
      const key = String(btn.dataset.settingsTab || '').trim();
      if (!key) return;
      setActiveTab(key);
    };
  });

  if (searchInput) {
    searchInput.oninput = (e) => {
      applySettingsSearch(e?.target?.value || '');
    };
  }

  const closeBtn = document.getElementById('settings-close');
  if (closeBtn) {
    closeBtn.onclick = () => {
      const homeBtn = document.querySelector('.tab-btn[data-tab="home"]');
      if (homeBtn) homeBtn.click();
    };
  }

  if (hwToggle) {
    hwToggle.onchange = async () => {
      const enabled = !!hwToggle.checked;
      const r = await window.api.launcherSettingsSet({ hardwareAcceleration: enabled }).catch(e => ({ ok:false, msg: e?.message || String(e) }));
      if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to save setting'), 4500, { force: true });
      toast('✅ Saved. Restart required to apply.', 4500, { force: true });
    };
  }

  if (trayToggle) {
    trayToggle.onchange = async () => {
      const enabled = !!trayToggle.checked;
      const r = await window.api.launcherSettingsSet({ exitToTray: enabled }).catch(e => ({ ok:false, msg: e?.message || String(e) }));
      if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to save setting'), 4500, { force: true });
      toast('✅ Saved.', 2500, { force: true });
    };
  }

  if (lowEndToggle) {
    lowEndToggle.onchange = async () => {
      const enabled = !!lowEndToggle.checked;
      const r = await window.api.launcherSettingsSet({ lowEndMode: enabled }).catch(e => ({ ok:false, msg: e?.message || String(e) }));
      if (!r?.ok) {
        lowEndToggle.checked = lowEndModeEnabled;
        return toast('❌ ' + (r?.msg || 'Failed to save setting'), 4500, { force: true });
      }
      lowEndModeEnabled = enabled;
      applyLowEndMode();
      toast('✅ Saved.', 2500, { force: true });
    };
  }

  if (langSaveBtn) {
    langSaveBtn.onclick = async () => {
      const value = String(langSelect?.value || 'auto');
      const r = await window.api.launcherSettingsSet({ language: value }).catch(e => ({ ok:false, msg: e?.message || String(e) }));
      if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to save setting'), 4500, { force: true });
      const rr = await window.api.launcherSettingsGet().catch(() => null);
      const locale = String(rr?.locale || '');
      const saved = String(rr?.settings?.language || 'auto');
      uiLang = (saved === 'auto') ? pickLangFromLocale(locale) : saved;
      if (!I18N[uiLang]) uiLang = 'en';
      applyI18n();
      toast('✅ Saved.', 2500, { force: true });
    };
  }

  if (notifToggle) {
    notifToggle.onchange = async () => {
      const enabled = !!notifToggle.checked;
      const r = await window.api.appSettingsSet({ notifications: { enabled } }).catch(e => ({ ok:false, msg: e?.message || String(e) }));
      if (!r?.ok) {
        notifToggle.checked = notificationsEnabled;
        return toast('❌ ' + (r?.msg || 'Failed to save setting'), 4500, { force: true });
      }
      notificationsEnabled = enabled;
      toast('✅ Saved.', 2500, { force: true });
    };
  }

  if (openAccountsBtn) openAccountsBtn.onclick = () => { try { openAccountDrawer(); } catch (_) {} };

  if (msLogoutBtn) {
    msLogoutBtn.onclick = async () => {
      const r = await window.api.microsoftLogout().catch(e => ({ ok:false, msg: e?.message || String(e) }));
      if (!r?.ok) return toast('❌ ' + (r?.msg || 'Sign out failed'), 4500, { force: true });
      toast('✅ Signed out.', 2500, { force: true });
      refreshOfficialSkinAvatar();
      refreshAccountStatus();
    };
  }

  if (openMcBtn) openMcBtn.onclick = async () => { await window.api.openMcFolder().catch(() => null); };
  if (openDataBtn) openDataBtn.onclick = async () => {
    const r = await window.api.openLauncherDataFolder().catch(e => ({ ok:false, msg: e?.message || String(e) }));
    if (!r?.ok) toast('❌ ' + (r?.msg || 'Failed to open folder'), 4500, { force: true });
  };

  if (clearCacheBtn) clearCacheBtn.onclick = async () => {
    const r = await window.api.clearLauncherCache().catch(e => ({ ok:false, msg: e?.message || String(e) }));
    if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to clear cache'), 4500, { force: true });
    toast('✅ Cache cleared.', 2500, { force: true });
  };

  if (clearLogsBtn) clearLogsBtn.onclick = async () => {
    const r = await window.api.clearLauncherLogs().catch(e => ({ ok:false, msg: e?.message || String(e) }));
    if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to clear logs'), 4500, { force: true });
    toast('✅ Logs cleared.', 2500, { force: true });
  };

  if (heephRepairBtn) heephRepairBtn.onclick = async () => {
    const ok = confirm('Repair will clear safe cache and re-check/update the client files. Continue?');
    if (!ok) return;
    heephRepairBtn.style.opacity = '0.6';
    heephRepairBtn.style.pointerEvents = 'none';
    const r = await window.api.heephRepair({ clearCache: true, clearLogs: false, forceReinstall: false })
      .catch(e => ({ ok:false, msg: e?.message || String(e) }));
    heephRepairBtn.style.opacity = '';
    heephRepairBtn.style.pointerEvents = '';
    if (!r?.ok) return toast('❌ ' + (r?.msg || 'Repair failed'), 6000, { force: true });
    toast('✅ Repair done.', 3500, { force: true });
  };

  if (discordSaveBtn) {
    discordSaveBtn.onclick = async () => {
      const patch = {
        discordNews: {
          botToken: String(discordTokenEl?.value || ''),
          guildId: String(discordGuildEl?.value || ''),
          newsChannelId: String(discordNewsEl?.value || ''),
          changelogChannelId: String(discordChangelogEl?.value || ''),
          limit: Number(discordLimitEl?.value || 8) || 8,
        }
      };
      const r = await window.api.appSettingsSet(patch).catch(e => ({ ok:false, msg: e?.message || String(e) }));
      if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to save setting'), 4500, { force: true });
      toast('✅ Saved.', 2500, { force: true });
    };
  }

  if (privacySaveBtn) {
    privacySaveBtn.onclick = async () => {
      if (allowHttpToggle && allowHttpToggle.checked) {
        const ok = confirm('Enabling HTTP reduces security and can allow malicious updates if you add unsafe hosts. Only enable if you trust your network and the update server. Continue?');
        if (!ok) {
          allowHttpToggle.checked = false;
          return;
        }
      }
      const patch = {
        security: {
          allowInsecureHttp: !!allowHttpToggle?.checked,
          allowedUpdateHosts: String(allowedHostsEl?.value || ''),
        }
      };
      const r = await window.api.appSettingsSet(patch).catch(e => ({ ok:false, msg: e?.message || String(e) }));
      if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to save setting'), 4500, { force: true });
      toast('✅ Saved.', 2500, { force: true });
      if (allowHttpToggle && allowHttpToggle.checked) {
        toast('⚠ HTTP updates enabled. Use only trusted hosts.', 4500, { force: true });
      }
    };
  }

  // Ensure default tab
  setActiveTab('game');
  loadLauncherSettings();
  loadAppSettings();
  refreshAccountStatus();
  applyI18n();
} catch (_) {}

/* ── Account drawer ───────────────────────────────── */
const accountDrawer = $('account-drawer');
const accountBackdrop = $('account-drawer-backdrop');

async function renderAccountList() {
  const listEl = $('account-list');
  if (!listEl) return;
  let res;
  try {
    res = await window.api.accountsList();
  } catch (e) {
    res = { ok: false, msg: e?.message || String(e) };
  }
  if (!res?.ok) {
    listEl.innerHTML = `<div class="account-row"><div class="account-row-name">Error</div><div style="color:rgba(255,255,255,.65);font-size:11px;line-height:1.4">${String(res?.msg || 'Failed to load accounts')}</div></div>`;
    return;
  }

  const pins = new Set(loadPinnedAccounts());
  const accounts = (Array.isArray(res.accounts) ? res.accounts : []).slice().sort((a, b) => {
    const ap = pins.has(String(a?.id || '')) ? 1 : 0;
    const bp = pins.has(String(b?.id || '')) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0);
  });
  const activeId = String(res.activeAccountId || '').trim();
  if (accounts.length === 0) {
    listEl.innerHTML = `<div class="account-row"><div class="account-row-name">No accounts</div><div style="color:rgba(255,255,255,.65);font-size:11px;line-height:1.4">Add a Microsoft account below.</div></div>`;
    return;
  }

  listEl.innerHTML = accounts.map(a => {
    const id = String(a?.id || '');
    const name = String(a?.name || '');
    const type = String(a?.type || '');
    const uuid = String(a?.uuid || '').trim();
    const isActive = id && id === activeId;
    const pinned = pins.has(id);
    const badge = isActive ? 'ACTIVE' : (type === 'microsoft' ? 'MICROSOFT' : type.toUpperCase());
    const primaryLabel = isActive ? 'In use' : 'Switch';
    const primaryCls = isActive ? '' : 'primary';
    const avatarUrl = uuid ? `https://mc-heads.net/avatar/${encodeURIComponent(uuid)}/32` : '';
    return `
      <div class="account-row" data-account-id="${id.replace(/"/g, '&quot;')}">
        <div class="account-row-top">
          <div class="account-row-left">
            <div class="account-row-avatar">
              ${avatarUrl ? `<img class="account-row-avatar-img" src="${avatarUrl}" alt="" />` : ''}
            </div>
            <div class="account-row-text">
              <div class="account-row-name">${name.replace(/</g, '&lt;')}</div>
              <div class="account-row-sub">${type === 'microsoft' ? 'Microsoft' : (type || 'Account')}</div>
            </div>
          </div>
          <div class="account-row-badge">${badge}</div>
        </div>
        <div class="account-row-actions">
          <button class="account-row-btn ${primaryCls}" data-action="use" ${isActive ? 'disabled' : ''}>${primaryLabel}</button>
          <button class="account-row-btn" data-action="pin">${pinned ? 'Unpin' : 'Pin'}</button>
          <button class="account-row-btn danger" data-action="remove">Remove</button>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('[data-action="use"]').forEach(btn => {
    btn.onclick = async (e) => {
      const row = e?.target?.closest?.('.account-row');
      const id = String(row?.getAttribute?.('data-account-id') || '').trim();
      if (!id) return;
      const r = await window.api.accountsSetActive({ id }).catch(err => ({ ok:false, msg: err?.message || String(err) }));
      if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to switch account'), 4500);
      try {
        cfg.username = String(r?.active?.name || cfg.username || '');
        save('hc_user', cfg.username);
      } catch (_) {}
      syncAccountName();
      updateStartSub();
      refreshOfficialSkinAvatar();
      try { loadSkinsTab(); } catch (_) {}
      await renderAccountList();
      toast('✅ Account switched', 2500);
      closeAccountDrawer();
    };
  });

  listEl.querySelectorAll('[data-action="remove"]').forEach(btn => {
    btn.onclick = async (e) => {
      const row = e?.target?.closest?.('.account-row');
      const id = String(row?.getAttribute?.('data-account-id') || '').trim();
      if (!id) return;
      const r = await window.api.accountsRemove({ id }).catch(err => ({ ok:false, msg: err?.message || String(err) }));
      if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to remove account'), 4500);
      await renderAccountList();
      syncAccountName();
      updateStartSub();
      refreshOfficialSkinAvatar();
      toast('🗑 Account removed', 2500);
    };
  });

  listEl.querySelectorAll('[data-action="pin"]').forEach(btn => {
    btn.onclick = async (e) => {
      const row = e?.target?.closest?.('.account-row');
      const id = String(row?.getAttribute?.('data-account-id') || '').trim();
      if (!id) return;
      const cur = loadPinnedAccounts();
      const set = new Set(cur.map(String));
      if (set.has(id)) set.delete(id);
      else set.add(id);
      savePinnedAccounts(Array.from(set));
      await renderAccountList();
    };
  });
}

function openAccountDrawer() {
  accountDrawer?.classList.add('open');
  accountBackdrop?.classList.add('open');
  renderAccountList();
}

function closeAccountDrawer() {
  accountDrawer?.classList.remove('open');
  accountBackdrop?.classList.remove('open');
}

if ($('tb-account')) $('tb-account').onclick = () => openAccountDrawer();
if ($('account-drawer-close')) $('account-drawer-close').onclick = () => closeAccountDrawer();
if ($('account-drawer-backdrop')) $('account-drawer-backdrop').onclick = () => closeAccountDrawer();
if ($('account-add-microsoft')) $('account-add-microsoft').onclick = async () => {
  closeAccountDrawer();
  if ($('ms-modal')) {
    $('ms-status').textContent = 'Waiting for code...';
    $('ms-code').textContent = '—';
    $('ms-url').textContent = 'https://microsoft.com/link';
    $('ms-modal').style.display = 'flex';
    startMsPoll();
  }
  toast('🔐 Microsoft: starting login...', 3500);
  const res = await window.api.microsoftLogin().catch((e) => ({ ok: false, msg: e.message }));
  if (!res?.ok) toast('❌ ' + (res?.msg || 'Microsoft login failed'), 6000);
};
if ($('account-username')) $('account-username').onclick = () => { closeAccountDrawer(); openSettings(true); };

try {
  const frMs = document.getElementById('first-run-add-microsoft');
  const frUser = document.getElementById('first-run-add-username');
  const fr = document.getElementById('first-run');
  if (frMs) frMs.onclick = () => {
    try { if (fr) fr.style.display = 'none'; } catch (_) {}
    try { document.getElementById('account-add-microsoft')?.click?.(); } catch (_) {}
  };
  if (frUser) frUser.onclick = () => {
    try { if (fr) fr.style.display = 'none'; } catch (_) {}
    try { document.getElementById('account-username')?.click?.(); } catch (_) {}
  };
} catch (_) {}

if ($('ms-close')) $('ms-close').onclick = () => { try { $('ms-modal').style.display = 'none'; } catch (_) {} stopMsPoll(); };
if ($('ms-modal')) $('ms-modal').onclick = (e) => { if (e.target === $('ms-modal')) { $('ms-modal').style.display = 'none'; stopMsPoll(); } };
if ($('ms-open')) $('ms-open').onclick = () => { try { window.api.openUrl(String($('ms-url')?.textContent || 'https://microsoft.com/link')); } catch (_) {} };
if ($('ms-copy')) $('ms-copy').onclick = async () => {
  try {
    const code = String($('ms-code')?.textContent || '').trim();
    if (!code || code === '—') return;
    let copied = false;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
        copied = true;
      }
    } catch (_) {
      copied = false;
    }
    if (!copied && window.api?.clipboardWriteText) {
      const r = await window.api.clipboardWriteText(code).catch(() => ({ ok: false }));
      copied = !!r?.ok;
    }
    if (!copied) throw new Error('copy failed');
    toast('📋 Code copied!', 2500);
  } catch (_) {
    toast('❌ Could not copy code', 3500);
  }
};

// ── Ad slot ────────────────────────────────────────
if ($('ad-mohud')) {
  $('ad-mohud').onclick = () => {
    try { window.api.openUrl('https://mohud.com.br'); } catch (_) {}
  };
}

try {
  const btn = document.getElementById('skin-cosmetics-btn');
  if (btn) btn.onclick = () => {
    cosmeticsState.loaded = false;
    openCosmeticsModal().catch(() => null);
  };
  const btnOff = document.getElementById('official-cosmetics-btn');
  if (btnOff) btnOff.onclick = () => {
    cosmeticsState.loaded = false;
    openCosmeticsModal().catch(() => null);
  };
  const closeBtn = document.getElementById('cosmetics-close');
  if (closeBtn) closeBtn.onclick = (e) => {
    try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
    closeCosmeticsModal();
  };
  const modal = document.getElementById('cosmetics-modal');
  if (modal) modal.onclick = (e) => { if (e.target === modal) closeCosmeticsModal(); };

  const navAll = document.getElementById('cosmetics-nav-all');
  const navCapes = document.getElementById('cosmetics-nav-capes');
  const navWings = document.getElementById('cosmetics-nav-wings');
  if (navAll) navAll.onclick = () => setCosmeticsCategory('all');
  if (navCapes) navCapes.onclick = () => setCosmeticsCategory('capes');
  if (navWings) navWings.onclick = () => setCosmeticsCategory('wings');

  const getBtn = document.getElementById('cosmetics-get');
  if (getBtn) getBtn.onclick = () => {
    try { window.api.openUrl('https://heeph.com/cosmetics/br'); } catch (_) {}
  };
} catch (_) {}

// ── Microsoft device code UI ────────────────────────
try {
  window.api?.onMicrosoftDeviceCode?.((p) => {
    const url = String(p?.verificationUri || '').trim() || 'https://microsoft.com/link';
    const code = String(p?.userCode || '').trim();
    if ($('ms-modal')) {
      $('ms-status').textContent = 'Waiting for browser confirmation...';
      $('ms-code').textContent = code || '—';
      $('ms-url').textContent = url;
    }
    if (code) toast(`🔐 Microsoft: code ${code}`, 9000);
    try { window.api.openUrl(url); } catch (_) {}
  });
} catch (_) {}

try {
  window.api?.onMicrosoftAuth?.((p) => {
    if (!p) return;
    stopMsPoll();
    if (!p.ok) {
      toast('❌ ' + (p.msg || 'Microsoft login failed'), 7000);
      try { if ($('ms-status')) $('ms-status').textContent = 'Login failed.'; } catch (_) {}
      return;
    }
    const nm = String(p?.name || '').trim();
    if (nm) {
      cfg.username = nm;
      save('hc_user', cfg.username);
      syncAccountName();
      updateStartSub();
      refreshOfficialSkinAvatar();
      try { renderAccountList(); } catch (_) {}
    }
    toast(`✅ Signed in: ${nm || 'Microsoft'}`, 4500);
    try { if ($('ms-modal')) $('ms-modal').style.display = 'none'; } catch (_) {}
  });
} catch (_) {}

/* ── Canvas background ────────────────────────────── */
(function initCanvas() {
  const canvas = $('scene-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  function resize() { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; }
  resize();
  new ResizeObserver(resize).observe(canvas);

  const bubbles = Array.from({length:30}, () => ({ x:Math.random(), y:Math.random(), r:2+Math.random()*4, vy:-(0.0002+Math.random()*0.0003), alpha:0.1+Math.random()*0.3 }));
  const blocks  = Array.from({length:12}, () => ({ x:Math.random(), y:Math.random(), s:8+Math.random()*14, vx:(Math.random()-.5)*0.00015, vy:(Math.random()-.5)*0.00015, hue:Math.random()>.5?'#2d6a2d':'#8b4513', alpha:0.25+Math.random()*0.3 }));
  const groundC = ['#8b2020','#6b3a1f','#2d6a2d','#8b4513','#b03030','#3a5a1a'];
  let t=0;

  function draw() {
    const W=canvas.width, H=canvas.height;
    ctx.clearRect(0,0,W,H);
    const g=ctx.createLinearGradient(0,0,0,H);
    g.addColorStop(0,'#0d3550'); g.addColorStop(.4,'#0a4a3a'); g.addColorStop(1,'#051825');
    ctx.fillStyle=g; ctx.fillRect(0,0,W,H);

    for(let i=0;i<6;i++){
      const x=(i/6+Math.sin(t*.0003+i)*.05)*W;
      const lg=ctx.createLinearGradient(x,0,x+40,H*.8);
      lg.addColorStop(0,'rgba(100,200,180,.07)'); lg.addColorStop(.5,'rgba(100,200,180,.04)'); lg.addColorStop(1,'rgba(100,200,180,0)');
      ctx.fillStyle=lg; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x+40,H*.8); ctx.lineTo(x-10,H*.8); ctx.closePath(); ctx.fill();
    }
    blocks.forEach(b => {
      b.x=(b.x+b.vx+1)%1; b.y=(b.y+b.vy+1)%1;
      ctx.save(); ctx.globalAlpha=b.alpha; ctx.fillStyle=b.hue; ctx.fillRect(b.x*W,b.y*H,b.s,b.s);
      ctx.fillStyle='rgba(0,0,0,.3)'; ctx.fillRect(b.x*W,b.y*H+b.s-2,b.s,2); ctx.fillRect(b.x*W+b.s-2,b.y*H,2,b.s); ctx.restore();
    });
    ctx.save(); ctx.globalAlpha=.6;
    for(let i=0;i<Math.floor(W/18)+1;i++){
      const bh=16+Math.sin(i*1.3)*8; ctx.fillStyle=groundC[i%groundC.length]; ctx.fillRect(i*18,H-bh,18,bh);
      ctx.fillStyle='rgba(0,0,0,.25)'; ctx.fillRect(i*18,H-bh,18,3);
    }
    ctx.restore();
    bubbles.forEach(b => {
      b.y+=b.vy; if(b.y<-0.02)b.y=1;
      ctx.beginPath(); ctx.arc(b.x*W,b.y*H,b.r,0,Math.PI*2);
      ctx.strokeStyle=`rgba(150,220,200,${b.alpha})`; ctx.lineWidth=1; ctx.stroke();
    });
    const v=ctx.createRadialGradient(W/2,H/2,W*.2,W/2,H/2,W*.8);
    v.addColorStop(0,'rgba(0,0,0,0)'); v.addColorStop(1,'rgba(0,0,0,.55)');
    ctx.fillStyle=v; ctx.fillRect(0,0,W,H);
    t++; requestAnimationFrame(draw);
  }
  draw();
})();

/* ── Load system info ─────────────────────────────── */
async function loadInfo() {
  try {
    const info = await window.api.getInfo();

    const sel  = $('ver-select');
    sel.innerHTML = '';
    const vers = ['heeph-1.8.9'];
    availableVersions = vers;
    vers.forEach(v => {
      const o = document.createElement('option');
      o.value=v;
      o.textContent = v === 'heeph-1.8.9' ? 'HEEPH 1.8.9' : `Minecraft ${v}`;
      if(v===cfg.customVer) o.selected=true;
      sel.appendChild(o);
    });
    if(!cfg.customVer && vers.length) cfg.customVer = vers[0];
    updateStartSub();

    try {
      const [ms, acc] = await Promise.all([
        window.api?.microsoftStatus ? window.api.microsoftStatus().catch(() => null) : Promise.resolve(null),
        window.api?.accountsList ? window.api.accountsList().catch(() => null) : Promise.resolve(null),
      ]);
      const loggedIn = !!(ms && ms.ok && ms.loggedIn);
      const accounts = Array.isArray(acc?.accounts) ? acc.accounts : [];
      if (loggedIn) {
        const nm = String(ms?.name || '').trim();
        if (nm) {
          cfg.username = nm;
          try { save('hc_user', cfg.username); } catch (_) {}
          try { syncAccountName(); } catch (_) {}
          try { refreshOfficialSkinAvatar(); } catch (_) {}
        }
      } else if (accounts.length > 0) {
        const active = acc?.active || null;
        const nm = String(active?.name || accounts?.[0]?.name || '').trim();
        if (nm) {
          cfg.username = nm;
          try { save('hc_user', cfg.username); } catch (_) {}
          try { syncAccountName(); } catch (_) {}
          try { refreshOfficialSkinAvatar(); } catch (_) {}
        }
      } else {
        cfg.username = '';
        try { localStorage.removeItem('hc_user'); } catch (_) {}
        try { syncAccountName(); } catch (_) {}
        try { refreshOfficialSkinAvatar(); } catch (_) {}
        pendingFirstRunOverlay = true;
      }
    } catch (_) {}

    const maxRam = Math.min(info.totalMem-512, 16384);
    $('cfg-ram').max = maxRam;
    $('cfg-ram-max').textContent = `${maxRam} MB`;
    if ($('menu-ram')) $('menu-ram').max = maxRam;
    if ($('menu-ram-max')) $('menu-ram-max').textContent = `${maxRam} MB`;
    if ($('menu-ram')) $('menu-ram').value = cfg.ram;
    if ($('menu-ram-label')) $('menu-ram-label').textContent = cfg.ram;
    startPlayTimeMonitor();
  } catch(e) { console.error(e); }
  const ld = document.getElementById('loading');
  if (ld) {
    const elapsed = Date.now() - loadingStartedAt;
    const wait = Math.max(0, minLoadingMs - elapsed);
    setTimeout(() => {
      ld.classList.add('hidden');
      const root = document.getElementById('app-root');
      if (root) root.classList.remove('app-hidden');

      if (pendingFirstRunOverlay) {
        pendingFirstRunOverlay = false;
        try {
          const fr = document.getElementById('first-run');
          if (fr) fr.style.display = 'flex';
        } catch (_) {}
      }
    }, wait);
  }
}

async function tryLoadWebhookNews() {
  // Temporarily disabled
  return null;
}

function updateStartSub() {
  const ver = $('ver-select')?.value || cfg.customVer || '?';
  $('start-sub').textContent = ver === 'heeph-1.8.9' ? '◆ HEEPH 1.8.9' : `◆ ${ver}`;
}
$('ver-select').onchange = e => { cfg.customVer=e.target.value; save('hc_ver',cfg.customVer); updateStartSub(); };

let playTimeTimer = null;
function fmtDuration(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

async function tickPlayTime() {
  try {
    const st = await window.api.heephStatus();
    if (st?.ok && st.running) {
      $('start-sub').textContent = `▶ Em execução — ${fmtDuration(st.elapsedMs)}`;
      return;
    }
  } catch (_) {}
  updateStartSub();
}

function startPlayTimeMonitor() {
  if (playTimeTimer) return;
  tickPlayTime();
  playTimeTimer = setInterval(tickPlayTime, 1000);
}

/* ── Start game ───────────────────────────────────── */
$('start-btn').onclick = async () => {
  const username = cfg.username || 'Player';
  const ram      = cfg.ram;
  const elyToken = (cfg.elyToken || '').trim();
  const elyUuid  = (cfg.elyUuid || '').trim();

  $('start-btn').style.opacity='0.6';
  $('start-btn').style.pointerEvents='none';
  $('start-sub').textContent='🔒 Validando...';

  try {
    if (window.api?.heephPreflight) {
      const pf = await window.api.heephPreflight({ username, ram, elyToken, elyUuid })
        .catch(e => ({ ok:false, errors: [e?.message || String(e)], warnings: [] }));
      const errs = Array.isArray(pf?.errors) ? pf.errors : [];
      const warns = Array.isArray(pf?.warnings) ? pf.warnings : [];
      if (warns.length) toast('⚠ ' + String(warns[0] || 'Warning'), 4500);
      if (!pf?.ok) {
        toast('❌ ' + String(errs[0] || 'Preflight failed'), 6000, { force: true });
        $('start-sub').textContent='❌ Pré-check falhou';
        $('start-btn').style.opacity='';
        $('start-btn').style.pointerEvents='';
        return;
      }
    }
  } catch (_) {}

  $('start-sub').textContent='⏳ Checking for updates...';

  let res;
  try {
    res = await window.api.heephPlay({ username, ram, elyToken, elyUuid });
  } catch (e) {
    res = { ok:false, msg: e.message };
  }
  if(res.ok) {
    if(res.updated) toast(`⬇ Updated to ${res.version}`);
    if (res.alreadyRunning) {
      toast('🎮 Minecraft is already running!');
      $('start-sub').textContent = `▶ Running — ${username}`;
    } else {
      toast('🎮 Minecraft started!');
      $('start-sub').textContent = `✅ Started — ${username}`;
    }
    startPlayTimeMonitor();
  } else {
    toast('❌ '+(res.msg || 'Failed to start'), 5000);
    $('start-sub').textContent='❌ Failed to start';
  }

  $('start-btn').style.opacity='';
  $('start-btn').style.pointerEvents='';
  setTimeout(tickPlayTime, 4000);
};

// Update download progress (auto-update)
try {
  const startBtn = $('start-btn');
  const startSub = $('start-sub');
  const defaultBg = startBtn ? startBtn.style.background : '';
  const fmtBytes = (n) => {
    const v = Number(n || 0);
    if (!v) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let u = 0;
    let x = v;
    while (x >= 1024 && u < units.length - 1) { x /= 1024; u++; }
    return `${x.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
  };

  window.api?.onUpdateProgress?.((p) => {
    if (!startBtn || !startSub) return;
    if (!p) return;

    if (p.stage === 'done' || p.stage === 'error') {
      startBtn.style.background = defaultBg;
      startBtn.style.boxShadow = '';
      try { updateStartSub(); } catch (_) {}
      return;
    }

    if (p.stage !== 'downloading') return;

    // Purple while downloading
    startBtn.style.background = 'linear-gradient(135deg, #7c3aed, #a855f7)';
    startBtn.style.boxShadow = '0 6px 28px rgba(168,85,247,.45)';

    const received = Number(p.received || 0);
    const total = Number(p.total || 0);
    const pct = total > 0 ? Math.min(100, Math.max(0, (received / total) * 100)) : 0;

    if (total > 0) {
      startSub.textContent = `⬇ Atualizando... ${pct.toFixed(0)}% (${fmtBytes(received)} / ${fmtBytes(total)})`;
    } else {
      startSub.textContent = `⬇ Atualizando... (${fmtBytes(received)})`;
    }
  });

  // Restore visuals when the page fully reloads or user relaunches
  window.addEventListener('beforeunload', () => {
    try {
      if (startBtn) {
        startBtn.style.background = defaultBg;
        startBtn.style.boxShadow = '';
      }
      try { updateStartSub(); } catch (_) {}
    } catch (_) {}
  });
} catch (_) {}

/* ── News / Changelog ─────────────────────────────── */
const newsContent = $('news-content');
const newsModal = $('news-modal');
const newsModalBackdrop = $('news-modal-backdrop');
const newsModalClose = $('news-modal-close');
const newsModalBody = $('news-modal-body');

// Launcher auto-update UI (Electron app update)
try {
  const startBtn = $('start-btn');
  const startSub = $('start-sub');
  const fmtBytes = (n) => {
    const v = Number(n || 0);
    if (!v) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let u = 0;
    let x = v;
    while (x >= 1024 && u < units.length - 1) { x /= 1024; u++; }
    return `${x.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
  };

  let installArmed = false;
  if (startSub) {
    startSub.style.cursor = '';
    startSub.onclick = null;
  }

  const armInstall = () => {
    if (!startSub) return;
    installArmed = true;
    startSub.style.cursor = 'pointer';
    startSub.onclick = async () => {
      if (!installArmed) return;
      const res = await window.api.launcherInstallUpdate().catch((e) => ({ ok: false, msg: e.message }));
      if (!res?.ok) toast('❌ ' + (res?.msg || 'Failed to install update'), 5000);
    };
  };

  window.api?.onLauncherUpdate?.((p) => {
    if (!p) return;

    const loading = document.getElementById('loading');
    const loadingVisible = !!(loading && !loading.classList.contains('hidden'));
    const loadingText = loading ? loading.querySelector('.loading-text') : null;
    const setLoadingText = (t) => {
      try { if (loadingVisible && loadingText) loadingText.textContent = t; } catch (_) {}
    };

    if (p.stage === 'checking') {
      setLoadingText('checking updates...');
    } else if (p.stage === 'available') {
      setLoadingText('downloading update...');
    } else if (p.stage === 'downloading') {
      const pct = Number(p.percent || 0);
      setLoadingText(`downloading... ${pct.toFixed(0)}%`);
    } else if (p.stage === 'downloaded') {
      setLoadingText('update ready — restart to apply');
    } else if (p.stage === 'error') {
      setLoadingText('update failed');
    }

    if (!startBtn || !startSub) return;

    if (p.stage === 'checking') {
      toast('🔎 Checking launcher update...', 2500);
      return;
    }

    if (p.stage === 'available') {
      toast('⬇ Launcher update available. Downloading...', 3000);
      return;
    }

    if (p.stage === 'downloading') {
      startBtn.style.background = 'linear-gradient(135deg, #7c3aed, #a855f7)';
      startBtn.style.boxShadow = '0 6px 28px rgba(168,85,247,.45)';
      const pct = Number(p.percent || 0);
      const tr = Number(p.transferred || 0);
      const tt = Number(p.total || 0);
      if (tt > 0) startSub.textContent = `⬇ Updating launcher... ${pct.toFixed(0)}% (${fmtBytes(tr)} / ${fmtBytes(tt)})`;
      else startSub.textContent = `⬇ Updating launcher... (${fmtBytes(tr)})`;
      return;
    }

    if (p.stage === 'downloaded') {
      startBtn.style.background = '';
      startBtn.style.boxShadow = '';
      startSub.textContent = '✅ Launcher updated — click here to restart';
      toast('✅ Launcher update downloaded. Click the text below START to restart and install.', 7000);
      armInstall();
      return;
    }

    if (p.stage === 'none') {
      return;
    }

    if (p.stage === 'error') {
      try { updateStartSub(); } catch (_) {}
      toast('❌ Launcher update: ' + (p.msg || 'error'), 6000);
      return;
    }
  });
} catch (_) {}

let lastNewsItems = [];
const NEWS_CACHE_KEY = 'hc_news_cache_v1';

async function refreshNewsFromServer() {
  // Temporarily disabled
  renderNewsEmptyState('News is temporarily disabled.');
  try {
    document.querySelectorAll('.news-empty-sub').forEach(el => el.remove());
  } catch (_) {}
  return null;
}

function buildAllNewsListHtml(items) {
  const safe = Array.isArray(items) ? items : [];
  if (!safe.length) {
    return `
      <div class="news-empty">
        <div class="news-empty-title">No news yet</div>
        <button class="news-empty-btn" id="news-empty-refresh" type="button">Refresh</button>
      </div>
    `;
  }

  const rows = safe.map((i) => {
    const title = String(i.title || '');
    const meta = String(i.meta || '');
    const img = String(i.image || '');
    const badge = String(i.badge || '');
    const url = String(i.url || '');
    const bg = img ? `style="background-image:url('${img.replace(/'/g, '%27')}')"` : '';
    const badgeHtml = badge ? `<div class="news-row-badge">${badge}</div>` : '';
    const dataUrl = url ? `data-url="${url.replace(/"/g, '&quot;')}"` : '';
    return `
      <div class="news-row" ${dataUrl}>
        <div class="news-row-img" ${bg}></div>
        <div class="news-row-text">
          <div class="news-row-top">
            <div class="news-row-title">${title}</div>
            ${badgeHtml}
          </div>
          <div class="news-row-meta">${meta}</div>
        </div>
      </div>
    `;
  }).join('');

  return `<div class="news-list">${rows}</div>`;
}

function renderAllNewsList(items) {
  if (!newsModalBody) return;
  newsModalBody.innerHTML = buildAllNewsListHtml(items);

  const refreshBtn = document.getElementById('news-empty-refresh');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      const next = await refreshNewsFromServer();
      if (next === null) toast('News is temporarily disabled.', 3000);
      renderAllNewsList(next || lastNewsItems);
    };
  }

  newsModalBody.querySelectorAll('.news-row[data-url]').forEach(el => {
    el.onclick = () => {
      const url = el.getAttribute('data-url') || '';
      if (url) window.api.openUrl(url);
    };
  });
}

function renderNewsDetail(item) {
  if (!newsModalBody) return;
  const i = item || {};
  const title = String(i.title || '');
  const meta = String(i.meta || '');
  const img = String(i.image || '');
  const badge = String(i.badge || '');
  const url = String(i.url || '');
  const imgHtml = img ? `<div class="news-detail-img" style="background-image:url('${img.replace(/'/g, '%27')}')"></div>` : '';
  const badgeHtml = badge ? `<div class="news-row-badge">${badge}</div>` : '';
  const btnHtml = url ? `<button class="news-open-site" id="news-open-site" type="button">Acessar site</button>` : '';

  newsModalBody.innerHTML = `
    <div class="news-detail">
      ${imgHtml}
      <div class="news-detail-top">
        <div class="news-detail-title">${title}</div>
        <div class="news-detail-actions">
          ${badgeHtml}
          ${btnHtml}
        </div>
      </div>
      <div class="news-detail-meta">${meta}</div>
      <div class="news-detail-divider"></div>
      <div class="news-detail-sub">TODAS AS NOTÍCIAS</div>
      <div id="news-detail-list">${buildAllNewsListHtml(lastNewsItems)}</div>
    </div>
  `;

  if (url) {
    const btn = document.getElementById('news-open-site');
    if (btn) btn.onclick = () => window.api.openUrl(url);
  }

  newsModalBody.querySelectorAll('#news-detail-list .news-row[data-url]').forEach(el => {
    el.onclick = () => {
      const u = el.getAttribute('data-url') || '';
      if (u) window.api.openUrl(u);
    };
  });
}

function openAllNewsModal() {
  if (!newsModal || !newsModalBackdrop) return;
  renderAllNewsList(lastNewsItems);
  newsModalBackdrop.style.display = 'block';
  newsModal.style.display = 'flex';
  requestAnimationFrame(() => {
    newsModalBackdrop.classList.add('is-open');
    newsModal.classList.add('is-open');
  });
}

function closeAllNewsModal() {
  if (!newsModal || !newsModalBackdrop) return;
  newsModalBackdrop.classList.remove('is-open');
  newsModal.classList.remove('is-open');
  setTimeout(() => {
    newsModalBackdrop.style.display = 'none';
    newsModal.style.display = 'none';
  }, 200);
}

if (newsModalClose) newsModalClose.onclick = closeAllNewsModal;
if (newsModalBackdrop) newsModalBackdrop.onclick = closeAllNewsModal;

const NEWS_ITEMS = [
  {
    title: 'Bem-vindo ao Heeph',
    meta: 'Atualizações e avisos vão aparecer aqui.',
    image: 'https://images.unsplash.com/photo-1546447147-3fc2c5d7c2f9?auto=format&fit=crop&w=1200&q=60',
    badge: 'Includes Reward',
    url: 'https://example.com',
  },
  {
    title: 'Revamp',
    meta: 'Melhorias de UI e performance no launcher.',
    image: 'https://images.unsplash.com/photo-1520975916090-3105956dac38?auto=format&fit=crop&w=1200&q=60',
    badge: '',
    url: 'https://example.com',
  },
];

const CHANGELOG_ITEMS = [
  {
    title: 'Changelog',
    meta: 'As mudanças de versão vão aparecer aqui.',
  },
];

function renderNewsItems(items) {
  if (!newsContent) return;
  lastNewsItems = Array.isArray(items) ? items : [];
  const header = `
    <div class="news-top">
      <div class="news-top-title">LATEST NEWS</div>
      <a class="news-top-link" href="#" id="news-view-all">View all News</a>
    </div>
  `;

  const cards = items.map((i, idx) => {
    const title = String(i.title || '');
    const meta = String(i.meta || '');
    const img = String(i.image || '');
    const badge = String(i.badge || '');
    const url = String(i.url || '');
    const badgeHtml = badge ? `<div class="news-card-badge">${badge}</div>` : '';
    const bg = img ? `style="background-image:url('${img.replace(/'/g, '%27')}')"` : '';
    const dataUrl = url ? `data-url="${url.replace(/"/g, '&quot;')}"` : '';
    const dataIdx = `data-idx="${idx}"`;
    return `
      <div class="news-card" ${dataUrl} ${dataIdx}>
        <div class="news-card-media" ${bg}></div>
        <div class="news-card-overlay"></div>
        ${badgeHtml}
        <div class="news-card-text">
          <div class="news-card-title">${title}</div>
          <div class="news-card-meta">${meta}</div>
        </div>
        <div class="news-card-cta">›</div>
      </div>
    `;
  }).join('');

  newsContent.innerHTML = header + `<div class="news-carousel">${cards}</div>`;

  const viewAll = document.getElementById('news-view-all');
  if (viewAll) viewAll.onclick = (e) => {
    e.preventDefault();
    if (newsModal && newsModal.querySelector('.news-modal-title')) {
      newsModal.querySelector('.news-modal-title').textContent = 'ALL NEWS';
    }
    openAllNewsModal();
  };

  newsContent.querySelectorAll('.news-card').forEach(el => {
    el.onclick = () => {
      const idx = parseInt(el.getAttribute('data-idx') || '-1', 10);
      const item = (Array.isArray(lastNewsItems) && idx >= 0) ? lastNewsItems[idx] : null;
      if (item) {
        openAllNewsModal();
        renderNewsDetail(item);
      }
    };
  });
}

function loadNewsPanel() {
  // primeiro tenta cache local (se existir), depois atualiza via servidor
  try {
    const cached = JSON.parse(localStorage.getItem(NEWS_CACHE_KEY) || 'null');
    if (Array.isArray(cached) && cached.length) {
      renderNewsItems(cached);
    } else {
      renderNewsEmptyState('Loading...');
    }
  } catch {
    renderNewsEmptyState('Loading...');
  }

  (async () => {
    const webhookItems = await tryLoadWebhookNews();
    if (webhookItems === null) {
      if (!lastNewsItems.length) renderNewsEmptyState('News server unavailable.');
      return;
    }

    renderNewsItems(webhookItems);
    try { localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify(webhookItems)); } catch {}
  })();
}

loadNewsPanel();

/* ── Settings ─────────────────────────────────────── */
let cfgSelectedSkinFile = '';
function openSettings(forceSimple = false) {
  $('cfg-username').value   = cfg.username;
  $('cfg-custom-ver').value = cfg.customVer;
  $('cfg-ram').value        = cfg.ram;
  $('cfg-ram-label').textContent = cfg.ram;
  if ($('cfg-ely-token')) $('cfg-ely-token').value = cfg.elyToken || '';
  if ($('cfg-ely-uuid')) $('cfg-ely-uuid').value = cfg.elyUuid || '';
  try {
    const secEl = document.getElementById('cfg-skin-server-secret');
    if (secEl) secEl.value = String(load(SKIN_SECRET_KEY, '') || '');
  } catch (_) {}

  const groups = {
    skin: $('cfg-skin-group') || null,
    customVer: $('cfg-custom-ver')?.closest?.('.field-group') || null,
    ram: $('cfg-ram')?.closest?.('.field-group') || null,
    token: $('cfg-ely-token')?.closest?.('.field-group') || null,
    uuid: $('cfg-ely-uuid')?.closest?.('.field-group') || null,
  };

  const fillSkinPicker = async () => {
    const list_el = $('cfg-skin-list');
    const preview = $('cfg-skin-canvas');
    const nameEl  = $('cfg-skin-name');
    if (!list_el) return;

    const [skinCfg, list] = await Promise.all([
      window.api.skinGetConfig().catch(() => ({})),
      window.api.skinsList().catch(() => []),
    ]);
    const activeFile = String(skinCfg?.activeSkin || '').trim();
    cfgSelectedSkinFile = activeFile;
    list_el.innerHTML = '';

    const skins = Array.isArray(list) ? list : [];
    if (skins.length === 0) {
      const em = document.createElement('div');
      em.className = 'cfg-skin-empty';
      em.textContent = 'No skins found. Add skins in the Skins tab.';
      list_el.appendChild(em);
      return;
    }

    const selectSkin = (s) => {
      cfgSelectedSkinFile = String(s?.file || '');
      if (nameEl) nameEl.textContent = s?.name || '—';
      if (preview) renderSkinOnCanvas(preview, s?.dataUrl || '', 64, 128);
      list_el.querySelectorAll('.cfg-skin-thumb').forEach(t => {
        t.classList.toggle('active', t.dataset.file === cfgSelectedSkinFile);
      });
    };

    skins.forEach(s => {
      const card = document.createElement('div');
      card.className = 'cfg-skin-thumb' + (String(s?.file || '') === activeFile ? ' active' : '');
      card.dataset.file = String(s?.file || '');

      const cv = document.createElement('canvas');
      cv.width = 40; cv.height = 80;
      renderSkinOnCanvas(cv, s?.dataUrl || '', 40, 80);
      const nm = document.createElement('div');
      nm.className = 'cfg-skin-thumb-name';
      nm.textContent = s?.name || '';
      card.appendChild(cv);
      card.appendChild(nm);
      card.onclick = () => selectSkin(s);
      list_el.appendChild(card);

      if (String(s?.file || '') === activeFile) selectSkin(s);
    });
  };

  const applySimple = (simple) => {
    if (groups.customVer) groups.customVer.style.display = simple ? 'none' : '';
    if (groups.ram) groups.ram.style.display = simple ? 'none' : '';
    if (groups.token) groups.token.style.display = simple ? 'none' : '';
    if (groups.uuid) groups.uuid.style.display = simple ? 'none' : '';
    if (groups.skin) groups.skin.style.display = simple ? '' : 'none';
    if (simple) fillSkinPicker().catch(() => null);
  };

  if (forceSimple) {
    applySimple(true);
  } else {
    try {
      window.api.microsoftStatus().then((st) => {
        applySimple(!(st?.ok && st?.loggedIn));
      }).catch(() => applySimple(true));
    } catch (_) {
      applySimple(true);
    }
  }

  $('modal').style.display = 'flex';
}
function closeSettings() { $('modal').style.display='none'; }
$('cfg-ram').oninput    = e => { $('cfg-ram-label').textContent=e.target.value; };
$('modal-close').onclick = closeSettings;
$('cfg-cancel').onclick  = closeSettings;
$('modal').onclick = e => { if(e.target===$('modal')) closeSettings(); };
$('cfg-save').onclick = () => {
  const nextUser = $('cfg-username').value.trim();
  cfg.customVer = $('cfg-custom-ver').value.trim() || $('ver-select').value;
  cfg.ram       = parseInt($('cfg-ram').value);
  cfg.elyToken  = ($('cfg-ely-token')?.value || '').trim();
  cfg.elyUuid   = ($('cfg-ely-uuid')?.value || '').trim();
  const skinSecret = String(document.getElementById('cfg-skin-server-secret')?.value || '').trim();

  try {
    const sg = $('cfg-skin-group');
    const inSimpleMode = !!(sg && sg.style.display !== 'none');
    if (inSimpleMode) {
      if (!isValidOfflineUsername(nextUser)) {
        toast('❌ Username inválido. Use 3–16 caracteres: letras/números/_ (sem espaços).', 6000, { force: true });
        return;
      }
    }
  } catch (_) {}

  cfg.username = nextUser;
  save('hc_user',cfg.username);
  save('hc_ver',cfg.customVer);
  save('hc_ram',cfg.ram);
  try { save(SKIN_SECRET_KEY, skinSecret); } catch (_) {}
  try {
    if (window.api?.skinServerSet) {
      window.api.skinServerSet({ uploadSecret: skinSecret }).catch(() => null);
    }
  } catch (_) {}

  try {
    const sg = $('cfg-skin-group');
    const inSimpleMode = !!(sg && sg.style.display !== 'none');
    if (inSimpleMode && cfg.username) {
      window.api.accountsUpsertOffline({ username: cfg.username }).then((r) => {
        if (!r?.ok) return;
        try {
          cfg.username = String(r?.active?.name || cfg.username || '');
          save('hc_user', cfg.username);
        } catch (_) {}
        syncAccountName();
        updateStartSub();
        refreshOfficialSkinAvatar();
        try { loadSkinsTab(); } catch (_) {}
        try { renderAccountList(); } catch (_) {}
      }).catch(() => null);
    }
  } catch (_) {}

  try {
    const sg = $('cfg-skin-group');
    if (sg && sg.style.display !== 'none' && cfgSelectedSkinFile) {
      window.api.skinSelect({ file: cfgSelectedSkinFile, username: cfg.username || '' }).then(() => {
        try { refreshOfficialSkinAvatar(); } catch (_) {}
      }).catch(() => null);
    }
  } catch (_) {}

  closeSettings();
  syncAccountName();
  updateStartSub();
  toast('✅ Settings saved!');
};
if ($('menu-ram')) $('menu-ram').oninput = e => { $('menu-ram-label').textContent = e.target.value; };
if ($('menu-ram-save')) $('menu-ram-save').onclick = () => {
  cfg.ram = parseInt($('menu-ram').value);
  save('hc_ram', cfg.ram);
  $('cfg-ram').value = cfg.ram;
  $('cfg-ram-label').textContent = cfg.ram;
  $('menu-ram-label').textContent = cfg.ram;
  toast('✅ RAM saved!');
};

/* ═══════════════════════════════════════════════════
   MODS — Modrinth API integration
═══════════════════════════════════════════════════ */

let modsState = {
  query:    '',
  version:  '',
  loader:   '',
  category: '',
  sort:     'relevance',
  offset:   0,
  limit:    20,
  total:    0,
  isGrid:   true,
};

/* ── Build Modrinth search URL ────────────────────── */
function buildSearchUrl(s) {
  const facets = [['project_type:mod']];
  if(s.version)  facets.push([`versions:${s.version}`]);
  if(s.loader)   facets.push([`categories:${s.loader}`]);
  if(s.category) facets.push([`categories:${s.category}`]);

  const params = new URLSearchParams({
    limit:  s.limit,
    offset: s.offset,
    index:  s.sort,
    facets: JSON.stringify(facets),
  });
  if(s.query) params.set('query', s.query);

  return `${MODRINTH_API}/search?${params}`;
}

/* ── Fetch via main process (bypasses CORS) ───────── */
async function modrinthGet(url) {
  const res = await window.api.modrinthFetch(url);
  if(!res.ok) throw new Error(res.error || 'API error');
  return res.data;
}

/* ── Main search function ─────────────────────────── */
async function searchMods(resetPage=true) {
  if(resetPage) modsState.offset = 0;

  const grid  = $('mods-grid');
  const loading = $('mods-loading');
  const empty   = $('mods-empty');
  const pagination = $('mods-pagination');
  const countEl    = $('mods-count');

  grid.innerHTML = '';
  loading.style.display = 'flex';
  empty.style.display   = 'none';
  pagination.style.display = 'none';
  countEl.textContent = 'Buscando...';

  try {
    const url  = buildSearchUrl(modsState);
    const data = await modrinthGet(url);

    modsState.total = data.total_hits;
    loading.style.display = 'none';

    if(!data.hits || data.hits.length === 0) {
      empty.style.display = 'flex';
      countEl.textContent = 'No mods found';
      return;
    }

    countEl.textContent = `${fmt(modsState.total)} mods found`;
    renderMods(data.hits);

    // Pagination
    const totalPages = Math.ceil(modsState.total / modsState.limit);
    const currentPage = Math.floor(modsState.offset / modsState.limit) + 1;

    if(totalPages > 1) {
      pagination.style.display = 'flex';
      $('page-info').textContent = `Page ${currentPage} of ${totalPages}`;
      $('page-prev').disabled = modsState.offset === 0;
      $('page-next').disabled = modsState.offset + modsState.limit >= modsState.total;
    }

  } catch(e) {
    loading.style.display = 'none';
    empty.style.display   = 'flex';
    countEl.textContent   = 'Failed to fetch mods';
    console.error('Modrinth search error:', e);
    toast('❌ Failed to connect to Modrinth', 4000);
  }
}

/* ── Render mod cards ─────────────────────────────── */
function renderMods(hits) {
  const grid = $('mods-grid');
  grid.className = 'mods-grid' + (modsState.isGrid ? '' : ' list-view');

  hits.forEach(mod => {
    const card = document.createElement('div');
    card.className = 'mod-card';
    card.onclick   = () => openModDetail(mod);

    const iconHTML = mod.icon_url
      ? `<img class="mod-icon" src="${mod.icon_url}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"/><div class="mod-icon-placeholder" style="display:none">🧩</div>`
      : `<div class="mod-icon-placeholder">🧩</div>`;

    const topCats = (mod.categories || []).slice(0,2).map(c => `<span class="mod-cat">${c}</span>`).join('');

    card.innerHTML = `
      <div class="mod-card-header">
        ${iconHTML}
        <div class="mod-info">
          <div class="mod-name">${escHtml(mod.title)}</div>
          <div class="mod-author">by ${escHtml(mod.author)}</div>
        </div>
      </div>
      <div class="mod-desc">${escHtml(mod.description)}</div>
      <div class="mod-footer">
        <div class="mod-downloads">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
          ${fmt(mod.downloads)}
        </div>
        <div class="mod-cats">${topCats}</div>
      </div>`;

    grid.appendChild(card);
  });
}

/* ── Mod detail modal ─────────────────────────────── */
let currentModUrl = '';

async function openModDetail(mod) {
  // Fetch full project data for richer info
  let project = mod;
  try {
    const full = await modrinthGet(`${MODRINTH_API}/project/${mod.project_id || mod.slug}`);
    project = { ...mod, ...full };
  } catch(e) { /* use search result as fallback */ }

  currentModUrl = `https://modrinth.com/mod/${project.slug || project.project_id}`;

  $('md-icon').src = project.icon_url || '';
  $('md-icon').style.display = project.icon_url ? 'block' : 'none';
  $('md-name').textContent = project.title || '—';
  $('md-by').textContent   = `por ${project.author || '—'}`;
  $('md-downloads').textContent = fmt(project.downloads || 0);
  $('md-followers').textContent = fmt(project.follows || project.followers || 0);
  $('md-license').textContent   = project.license?.id || project.license || '—';
  $('md-desc').textContent      = project.description || '—';

  // Categories
  const cats = project.categories || [];
  $('md-cats').innerHTML = cats.map(c => `<span class="md-tag">${c}</span>`).join('');

  // Versions
  const vers = (project.versions || project.game_versions || []).slice(0,12);
  $('md-versions').innerHTML = vers.map(v => `<span class="md-chip">${v}</span>`).join('') || '<span class="md-chip">—</span>';

  // Loaders
  const loaders = project.loaders || [];
  $('md-loaders').innerHTML = loaders.map(l => `<span class="md-chip">${l}</span>`).join('') || '<span class="md-chip">—</span>';

  $('mod-modal').style.display = 'flex';
}

$('mod-modal-close').onclick  = () => { $('mod-modal').style.display='none'; };
$('mod-modal-cancel').onclick = () => { $('mod-modal').style.display='none'; };
$('mod-modal').onclick = e => { if(e.target===$('mod-modal')) $('mod-modal').style.display='none'; };
$('md-open-url').onclick = () => { window.api.openUrl(currentModUrl); };

/* ── Filter controls ──────────────────────────────── */
// Search input + button
$('mods-search-btn').onclick = () => {
  modsState.query = $('mods-search').value.trim();
  searchMods();
};
$('mods-search').onkeydown = e => {
  if(e.key==='Enter') { modsState.query=$('mods-search').value.trim(); searchMods(); }
};

// Version
$('filter-version').onchange = e => { modsState.version=e.target.value; searchMods(); };

// Sort
$('filter-sort').onchange = e => { modsState.sort=e.target.value; searchMods(); };

// Loader chips
$('filter-loader').querySelectorAll('.chip').forEach(btn => {
  btn.onclick = () => {
    $('filter-loader').querySelectorAll('.chip').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    modsState.loader = btn.dataset.val;
    searchMods();
  };
});

// Category chips
$('filter-category').querySelectorAll('.chip').forEach(btn => {
  btn.onclick = () => {
    $('filter-category').querySelectorAll('.chip').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    modsState.category = btn.dataset.val;
    searchMods();
  };
});

/* ── Pagination ───────────────────────────────────── */
$('page-prev').onclick = () => {
  if(modsState.offset===0) return;
  modsState.offset = Math.max(0, modsState.offset - modsState.limit);
  searchMods(false);
  $('mods-main') && ($('mods-grid').scrollTop=0);
};
$('page-next').onclick = () => {
  if(modsState.offset + modsState.limit >= modsState.total) return;
  modsState.offset += modsState.limit;
  searchMods(false);
};

/* ── View toggle ──────────────────────────────────── */
$('view-grid').onclick = () => {
  modsState.isGrid=true;
  $('view-grid').classList.add('active');
  $('view-list').classList.remove('active');
  $('mods-grid').classList.remove('list-view');
};
$('view-list').onclick = () => {
  modsState.isGrid=false;
  $('view-list').classList.add('active');
  $('view-grid').classList.remove('active');
  $('mods-grid').classList.add('list-view');
};

/* ── Utils ────────────────────────────────────────── */
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ════════════════════════════════════════════════════
   SKINS TAB
═══════════════════════════════════════════════════ */

/* ── 2D skin renderer (canvas) ────────────────────── */
function renderSkinOnCanvas(canvas, dataUrl, canvasW, canvasH) {
  const s = String(dataUrl || '');
  if (!s.startsWith('data:image/')) {
    try {
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvasW, canvasH);
    } catch (_) {}
    return;
  }
  const img = new Image();
  img.onerror = () => {
    try {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvasW, canvasH);
    } catch (_) {}
    console.error('[SKINS] Failed to load skin image (2D preview)');
  };
  img.onload = () => {
    const isNew = img.height >= 64;
    const S = canvasW / 16;           // scale: 1 logical unit = S px
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.imageSmoothingEnabled = false;

    // dp(sx,sy,sw,sh, dx,dy,dw,dh) — all dx/dy/dw/dh in logical units
    const dp = (sx, sy, sw, sh, dx, dy, dw, dh) =>
      ctx.drawImage(img, sx, sy, sw, sh, dx*S, dy*S, dw*S, dh*S);

    // Head (front)
    dp(8,  8, 8, 8,  4, 0, 8, 8);
    // Hat overlay
    dp(40, 8, 8, 8,  3.5, -0.5, 9, 9);
    // Body (front)
    dp(20, 20, 8, 12, 4, 8, 8, 12);
    // Right arm — player's right = viewer's LEFT
    dp(44, 20, 4, 12, 0, 8, 4, 12);
    // Left arm — player's left = viewer's RIGHT
    if (isNew) {
      dp(36, 52, 4, 12, 12, 8, 4, 12);
    } else {
      ctx.save();
      ctx.translate(16 * S, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 44, 20, 4, 12, 0, 8*S, 4*S, 12*S);
      ctx.restore();
    }
    // Right leg — player's right = viewer's LEFT
    dp(4, 20, 4, 12, 4, 20, 4, 12);
    // Left leg
    if (isNew) {
      dp(20, 52, 4, 12, 8, 20, 4, 12);
    } else {
      ctx.save();
      ctx.translate(16 * S, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 4, 20, 4, 12, 0, 20*S, 4*S, 12*S);
      ctx.restore();
    }
  };
  img.src = s;
}

let skin3dViewer = null;
let skin3dResize = null;
let skin3dBlobUrl = null;

function ensureSkin3dViewer() {
  const canvas = document.getElementById('skin-preview-canvas');
  if (!canvas) return null;
  if (lowEndModeEnabled) return null;
  if (skin3dViewer) return skin3dViewer;
  if (!window.skinview3d || !window.skinview3d.SkinViewer) {
    try { toast('Preview 3D indisponível (skinview3d não carregou)'); } catch (_) {}
    return null;
  }

  skin3dViewer = new window.skinview3d.SkinViewer({
    canvas,
    width: 1,
    height: 1,
  });

  try {
    if (skin3dViewer.camera && skin3dViewer.camera.position) {
      skin3dViewer.camera.position.set(0, 14, 42);
    }
  } catch (_) {}

  try {
    if (skin3dViewer.controls) {
      skin3dViewer.controls.enableRotate = true;
      skin3dViewer.controls.enableZoom = true;
      skin3dViewer.controls.enablePan = false;
      if (skin3dViewer.controls.target && skin3dViewer.controls.target.set) {
        skin3dViewer.controls.target.set(0, 10, 0);
      }
      skin3dViewer.controls.minDistance = 28;
      skin3dViewer.controls.maxDistance = 64;
    }
  } catch (_) {}

  try {
    if (window.skinview3d.IdleAnimation) {
      skin3dViewer.animation = new window.skinview3d.IdleAnimation();
    }
  } catch (_) {}

  const resize = () => {
    const wrap = document.getElementById('skin-preview-wrap');
    const rect = (wrap && wrap.getBoundingClientRect) ? wrap.getBoundingClientRect() : canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    canvas.width = w;
    canvas.height = h;
    skin3dViewer.width = w;
    skin3dViewer.height = h;
    try {
      if (skin3dViewer.renderer && skin3dViewer.renderer.setPixelRatio) {
        // Canvas já foi ajustado com DPR; manter pixelRatio 1 evita double-scaling.
        skin3dViewer.renderer.setPixelRatio(1);
      }
    } catch (_) {}
  };
  skin3dResize = resize;
  window.addEventListener('resize', resize);
  resize();

  return skin3dViewer;
}

function forceSkin3dResize() {
  if (!skin3dViewer || !skin3dResize) return;
  try {
    skin3dResize();
    requestAnimationFrame(() => {
      try { skin3dResize(); } catch (_) {}
    });
  } catch (_) {}
}

function set3dSkinFromDataUrl(viewer, dataUrl) {
  if (!viewer || !viewer.loadSkin) return false;
  try {
    if (skin3dBlobUrl) {
      URL.revokeObjectURL(skin3dBlobUrl);
      skin3dBlobUrl = null;
    }
    if (!dataUrl) {
      viewer.loadSkin(null);
      forceSkin3dResize();
      return true;
    }

    const s = String(dataUrl || '').trim();
    if (!s) return false;
    // If it's already a URL, pass through.
    if (!s.startsWith('data:')) {
      if (s.startsWith('file:') || s.startsWith('http:') || s.startsWith('https:') || s.startsWith('blob:')) {
        viewer.loadSkin(s);
        forceSkin3dResize();
        return true;
      }
      // Avoid passing unknown/invalid strings to skinview3d (can trigger Chromium net::ERR_INVALID_ARGUMENT)
      return false;
    }

    if (!s.startsWith('data:image/')) return false;

    // Electron/Chromium can throw net::ERR_INVALID_ARGUMENT when fetching data: URLs.
    // Convert base64 data URL -> Blob manually and use an object URL.
    const comma = s.indexOf(',');
    if (comma === -1) return false;
    const header = s.slice(0, comma);
    const b64 = s.slice(comma + 1);
    const m = /data:([^;]+);base64/i.exec(header);
    const mime = (m && m[1]) ? m[1] : 'image/png';
    let bin;
    try { bin = atob(b64); } catch (_) { return false; }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    skin3dBlobUrl = URL.createObjectURL(blob);
    viewer.loadSkin(skin3dBlobUrl);
    forceSkin3dResize();

    return true;
  } catch (_) {
    return false;
  }
}

/* ── Skins state ──────────────────────────────────── */
let skinsData = [];        // [{ name, file, active, dataUrl }]
let skinsElyEnabled = false;
let heephServerActive = false;

let cosmeticsState = {
  loaded: false,
  loading: false,
  availabilityChecked: false,
  hasAny: false,
  isOriginalContext: false,
  identityKey: '',
  category: 'wings',
  previewSkinDataUrl: '',
  capes: [],
  wings: [],
  selectedCapeName: '',
  selectedWingName: '',
};

function updateCosmeticsButtonsVisibility() {
  try {
    const btn = document.getElementById('skin-cosmetics-btn');
    if (btn) btn.style.display = (!cosmeticsState.isOriginalContext) ? '' : 'none';
  } catch (_) {}
  try {
    const btn = document.getElementById('official-cosmetics-btn');
    if (btn) btn.style.display = (cosmeticsState.isOriginalContext) ? '' : 'none';
  } catch (_) {}
}

function resetCosmeticsState() {
  cosmeticsState.loaded = false;
  cosmeticsState.loading = false;
  cosmeticsState.availabilityChecked = false;
  cosmeticsState.hasAny = false;
  cosmeticsState.capes = [];
  cosmeticsState.wings = [];
  cosmeticsState.selectedCapeName = '';
  cosmeticsState.selectedWingName = '';
  updateCosmeticsButtonsVisibility();
}

async function prefetchCosmeticsAvailability() {
  try {
    if (!window.api?.cosmeticsFetch) return;
    if (cosmeticsState.loading) return;
    if (cosmeticsState.availabilityChecked) return;

    cosmeticsState.loading = true;
    const r = await window.api.cosmeticsFetch().catch(() => null);
    cosmeticsState.loading = false;
    cosmeticsState.availabilityChecked = true;

    if (!r?.ok) {
      cosmeticsState.hasAny = false;
      updateCosmeticsButtonsVisibility();
      return;
    }
    cosmeticsState.capes = Array.isArray(r.capes) ? r.capes : [];
    cosmeticsState.wings = Array.isArray(r.wings) ? r.wings : [];
    cosmeticsState.loaded = true;
    cosmeticsState.hasAny = (cosmeticsState.capes.length > 0 || cosmeticsState.wings.length > 0);

    const equippedCape = cosmeticsState.capes.find(x => x.equipped);
    const equippedWing = cosmeticsState.wings.find(x => x.equipped);
    cosmeticsState.selectedCapeName = equippedCape ? equippedCape.name : '';
    cosmeticsState.selectedWingName = equippedWing ? equippedWing.name : '';

    updateCosmeticsButtonsVisibility();
  } catch (_) {}
}

function setCosmeticsCategory(cat) {
  cosmeticsState.category = String(cat || 'wings');
  const allBtn = document.getElementById('cosmetics-nav-all');
  const capesBtn = document.getElementById('cosmetics-nav-capes');
  const wingsBtn = document.getElementById('cosmetics-nav-wings');
  if (allBtn) allBtn.classList.toggle('active', cosmeticsState.category === 'all');
  if (capesBtn) capesBtn.classList.toggle('active', cosmeticsState.category === 'capes');
  if (wingsBtn) wingsBtn.classList.toggle('active', cosmeticsState.category === 'wings');

  const titleEl = document.getElementById('cosmetics-main-title');
  if (titleEl) titleEl.textContent = cosmeticsState.category === 'all' ? 'All Cosmetics' : (cosmeticsState.category === 'capes' ? 'Capes' : 'Wings');

  renderCosmeticsList();
}

function updateCosmeticsCounts() {
  const capes = Array.isArray(cosmeticsState.capes) ? cosmeticsState.capes : [];
  const wings = Array.isArray(cosmeticsState.wings) ? cosmeticsState.wings : [];
  const all = capes.length + wings.length;
  try { const el = document.getElementById('cosmetics-count-all'); if (el) el.textContent = String(all); } catch (_) {}
  try { const el = document.getElementById('cosmetics-count-capes'); if (el) el.textContent = String(capes.length); } catch (_) {}
  try { const el = document.getElementById('cosmetics-count-wings'); if (el) el.textContent = String(wings.length); } catch (_) {}
}

async function refreshCosmeticsPreviewSkin() {
  try {
    cosmeticsState.previewSkinDataUrl = '';
    if (cosmeticsState.isOriginalContext) {
      const r = await window.api.officialSkinGet().catch(() => null);
      cosmeticsState.previewSkinDataUrl = String(r?.dataUrl || '');
      return;
    }
    const [skinCfg, list] = await Promise.all([
      window.api.skinGetConfig().catch(() => null),
      window.api.skinsList().catch(() => null),
    ]);
    const activeFile = String(skinCfg?.activeSkin || '').trim();
    const arr = Array.isArray(list) ? list : [];
    const active = arr.find(s => String(s.file || '') === activeFile) || arr.find(s => s.active) || null;
    cosmeticsState.previewSkinDataUrl = String(active?.dataUrl || '');
  } catch (_) {
    cosmeticsState.previewSkinDataUrl = '';
  }
}

function updateCosmeticsPreview() {
  const capes = Array.isArray(cosmeticsState.capes) ? cosmeticsState.capes : [];
  const wings = Array.isArray(cosmeticsState.wings) ? cosmeticsState.wings : [];
  const cape = cosmeticsState.selectedCapeName ? capes.find(x => x.name === cosmeticsState.selectedCapeName) : null;
  const wing = cosmeticsState.selectedWingName ? wings.find(x => x.name === cosmeticsState.selectedWingName) : null;

  try {
    const hint = document.getElementById('cosmetics-preview-hint');
    if (hint) hint.textContent = (cape || wing) ? '' : 'Select a cosmetic';
  } catch (_) {}

  let viewer = null;
  try { viewer = ensureCosmetics3dViewer(); } catch (_) { viewer = null; }
  if (viewer) {
    forceCosmetics3dResize(0);
    if (cosmeticsState.previewSkinDataUrl) {
      try { setCosmetics3dSkinFromDataUrl(viewer, cosmeticsState.previewSkinDataUrl); } catch (_) {}
    }

    (async () => {
      try {
        const capeTexUrl = cape ? (cape.textureUrl || cape.previewUrl || '') : '';

        const fetchAndNormalizeCape = async (url) => {
          if (!url) return '';
          try {
            const resp = await fetch(url);
            if (!resp.ok) return '';
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);
            const img = await new Promise((res, rej) => {
              const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = blobUrl;
            });
            const { width: w, height: h } = img;
            if ((w === 2 * h) || (17 * w === 22 * h) || (11 * w === 23 * h)) return blobUrl;
            URL.revokeObjectURL(blobUrl);
            const c = document.createElement('canvas');
            c.width = 64; c.height = 32;
            c.getContext('2d').drawImage(img, 0, 0, 64, 32);
            return c.toDataURL('image/png');
          } catch (_) { return ''; }
        };

        const wingTexUrl = wing ? (wing.textureUrl || wing.previewUrl || '') : '';
        if (wingTexUrl) {
          await applyDragonWings(viewer, wingTexUrl);
        } else {
          removeDragonWings(viewer);
        }

        if (capeTexUrl) {
          try { if (cosmeticsCapeBlob && cosmeticsCapeBlob.startsWith('blob:')) URL.revokeObjectURL(cosmeticsCapeBlob); } catch (_) {}
          cosmeticsCapeBlob = await fetchAndNormalizeCape(capeTexUrl);
          if (cosmeticsCapeBlob && typeof viewer.loadCape === 'function') {
            try { viewer.loadCape(cosmeticsCapeBlob, { backEquipment: 'cape' }); } catch (_) {}
            startCapeAnimation(viewer);
          }
        } else {
          stopCapeAnimation();
          try { if (typeof viewer.loadCape === 'function') viewer.loadCape(null); } catch (_) {}
          try { viewer.playerObject.backEquipment = null; } catch (_) {}
        }
      } catch (_) {}
    })();
    return;
  }

  const canvas = document.getElementById('cosmetics-preview-canvas');
  if (!canvas) return;
  try {
    renderSkinOnCanvas(canvas, cosmeticsState.previewSkinDataUrl, 160, 320);
  } catch (_) {}
}

function setCosmeticsPreview(item) {
  const canvas = document.getElementById('cosmetics-preview-canvas');
  if (canvas) {
    try {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } catch (_) {}
  }
  updateCosmeticsPreview();
}

function renderCosmeticsList() {
  const empty = document.getElementById('cosmetics-empty');
  const listEl = document.getElementById('cosmetics-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const capes = Array.isArray(cosmeticsState.capes) ? cosmeticsState.capes : [];
  const wings = Array.isArray(cosmeticsState.wings) ? cosmeticsState.wings : [];

  const items = (() => {
    if (cosmeticsState.category === 'capes') return capes.map(c => ({ ...c, __kind: 'cape' }));
    if (cosmeticsState.category === 'wings') return wings.map(w => ({ ...w, __kind: 'wing' }));
    return [...capes.map(c => ({ ...c, __kind: 'cape' })), ...wings.map(w => ({ ...w, __kind: 'wing' }))];
  })();

  const hasAny = items.length > 0;
  if (empty) {
    const total = capes.length + wings.length;
    empty.textContent = total === 0 ? 'Você não possui nenhum item.' : 'No cosmetics in this category.';
    empty.style.display = hasAny ? 'none' : '';
  }

  const makeCard = (item) => {
    const isCape = item.__kind === 'cape';
    const activeName = isCape ? cosmeticsState.selectedCapeName : cosmeticsState.selectedWingName;
    const card = document.createElement('div');
    card.className = 'cosmetic-card' + (activeName === item.name ? ' active' : '');

    const img = document.createElement('img');
    img.className = 'cosmetic-card-img';
    img.alt = '';
    img.src = item.previewUrl || '';

    const nm = document.createElement('div');
    nm.className = 'cosmetic-card-name';
    nm.textContent = item.name || '';

    const sub = document.createElement('div');
    sub.className = 'cosmetic-card-sub';
    sub.textContent = item.equipped ? 'Equipped' : 'Click to equip';

    card.appendChild(img);
    card.appendChild(nm);
    card.appendChild(sub);

    card.onclick = async () => {
      try {
        if (!window.api?.cosmeticsEquip) return;

        if (isCape) cosmeticsState.selectedCapeName = (cosmeticsState.selectedCapeName === item.name) ? '' : item.name;
        else cosmeticsState.selectedWingName = (cosmeticsState.selectedWingName === item.name) ? '' : item.name;

        updateCosmeticsPreview();

        const cape = cosmeticsState.selectedCapeName ? capes.find(x => x.name === cosmeticsState.selectedCapeName) : null;
        const wing = cosmeticsState.selectedWingName ? wings.find(x => x.name === cosmeticsState.selectedWingName) : null;
        const r = await window.api.cosmeticsEquip({ cape, wing }).catch(e => ({ ok:false, msg: e?.message || String(e) }));
        if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to equip cosmetics'), 4500);

        capes.forEach(c => { c.equipped = cape ? (c.name === cape.name) : false; });
        wings.forEach(w => { w.equipped = wing ? (w.name === wing.name) : false; });
        renderCosmeticsList();
        updateCosmeticsPreview();
        toast('✅ Cosmetics equipped', 2500);
      } catch (_) {}
    };

    return card;
  };

  items.forEach(it => listEl.appendChild(makeCard(it)));
}

async function openCosmeticsModal() {
  const modal = document.getElementById('cosmetics-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  modal.style.pointerEvents = 'auto';

  forceCosmetics3dResize(30);
  forceCosmetics3dResize(100);

  await refreshCosmeticsPreviewSkin();

  if (!cosmeticsState.loaded) {
    const r = await window.api.cosmeticsFetch().catch(e => ({ ok:false, msg: e?.message || String(e) }));
    if (!r?.ok) {
      toast('❌ ' + (r?.msg || 'Cosmetics server unavailable'), 5000);
      cosmeticsState.loaded = true;
      cosmeticsState.capes = [];
      cosmeticsState.wings = [];
      cosmeticsState.hasAny = false;
      updateCosmeticsButtonsVisibility();
      updateCosmeticsCounts();
      renderCosmeticsList();
      updateCosmeticsPreview();
      return;
    }
    cosmeticsState.loaded = true;
    cosmeticsState.availabilityChecked = true;
    cosmeticsState.capes = Array.isArray(r.capes) ? r.capes : [];
    cosmeticsState.wings = Array.isArray(r.wings) ? r.wings : [];
    cosmeticsState.hasAny = (cosmeticsState.capes.length > 0 || cosmeticsState.wings.length > 0);

    const equippedCape = cosmeticsState.capes.find(x => x.equipped);
    const equippedWing = cosmeticsState.wings.find(x => x.equipped);
    cosmeticsState.selectedCapeName = equippedCape ? equippedCape.name : '';
    cosmeticsState.selectedWingName = equippedWing ? equippedWing.name : '';
    updateCosmeticsButtonsVisibility();
  }

  updateCosmeticsCounts();
  setCosmeticsCategory(cosmeticsState.category || 'wings');
  updateCosmeticsPreview();
  forceCosmetics3dResize(80);
  forceCosmetics3dResize(300);
}

function closeCosmeticsModal() {
  const modal = document.getElementById('cosmetics-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.style.pointerEvents = 'none';
  }
  try { if (cosmetics3dViewer) removeDragonWings(cosmetics3dViewer); } catch (_) {}
}

/* ── Load / refresh tab ───────────────────────────── */
async function loadSkinsTab() {
  let ms = null;
  try {
    ms = await window.api.microsoftStatus();
  } catch (_) {
    ms = null;
  }
  const isOriginal = !!(ms && ms.ok && ms.loggedIn);

  const officialCard = document.getElementById('official-skin-card');
  const uploadBtn = document.getElementById('skin-upload-btn');
  const gallery = document.getElementById('skin-gallery');
  const empty = document.getElementById('skin-gallery-empty');
  const galleryHeader = document.querySelector('.skin-gallery-header');
  const elyCard = document.querySelector('.ely-card');

  const officialUpload = document.getElementById('official-skin-upload');
  const officialReset = document.getElementById('official-skin-reset');
  const officialVariant = document.getElementById('official-skin-variant');
  const officialVariantRow = officialVariant ? officialVariant.closest('.official-skin-row') : null;

  if (officialCard) officialCard.style.display = isOriginal ? '' : 'none';
  if (uploadBtn) uploadBtn.style.display = isOriginal ? 'none' : '';
  if (galleryHeader) galleryHeader.style.display = isOriginal ? 'none' : '';
  if (elyCard) elyCard.style.display = isOriginal ? 'none' : '';

  // For original (Microsoft) accounts, don't allow skin upload/reset via launcher.
  if (officialUpload) officialUpload.style.display = isOriginal ? 'none' : '';
  if (officialReset) officialReset.style.display = isOriginal ? 'none' : '';
  if (officialVariantRow) officialVariantRow.style.display = isOriginal ? 'none' : '';

  if (isOriginal) {
    if (gallery) gallery.style.display = 'none';
    if (empty) empty.style.display = 'none';
    // Load official skin into preview
    try {
      const wrap = document.getElementById('skin-preview-wrap');
      const viewer = ensureSkin3dViewer();
      forceSkin3dResize();
      const preview = document.getElementById('skin-preview-canvas');
      const previewName = document.getElementById('skin-preview-name');
      const placeholder = document.getElementById('skin-preview-placeholder');
      const r = await window.api.officialSkinGet().catch(() => null);
      if (r && r.ok && r.dataUrl) {
        if (placeholder) placeholder.style.display = 'none';
        if (wrap) wrap.classList.add('has-skin');
        if (!set3dSkinFromDataUrl(viewer, r.dataUrl)) {
          if (preview) renderSkinOnCanvas(preview, r.dataUrl, 128, 256);
        }
        if (previewName) previewName.textContent = String(r.name || 'Skin oficial');
      } else {
        if (previewName) previewName.textContent = 'Skin oficial';
        if (wrap) wrap.classList.remove('has-skin');
        if (placeholder) placeholder.style.display = '';
      }
    } catch (_) {}

    updateCosmeticsButtonsVisibility();
    prefetchCosmeticsAvailability();
    return;
  }

  const [skinCfg, list, srv] = await Promise.all([
    window.api.skinGetConfig(),
    window.api.skinsList(),
    window.api.skinGetServer(),
  ]);
  skinsData = list;
  skinsElyEnabled = skinCfg.elyEnabled;
  heephServerActive = !!srv.active;

  const toggle = $('ely-toggle');
  if (toggle) toggle.checked = skinsElyEnabled;

  updateElyCardStatus(srv);
  renderSkinsGallery(skinCfg.activeSkin);

  updateCosmeticsButtonsVisibility();
  prefetchCosmeticsAvailability();
}

function updateElyCardStatus(srv) {
  const sub = document.getElementById('ely-card-sub');
  if (!sub) return;
  if (srv.active) {
    sub.textContent = `Heeph Skins server active — everyone can see it`;
    sub.style.color = 'var(--accent2)';
  } else {
    sub.textContent = 'Enable Authlib Injector to show your skin in-game';
    sub.style.color = '';
  }
}

/* ── Render gallery ───────────────────────────────── */
function renderSkinsGallery(activeSkinFile) {
  const gallery = $('skin-gallery');
  const empty   = $('skin-gallery-empty');
  const count   = $('skin-gallery-count');
  const preview = $('skin-preview-canvas');
  const previewName  = $('skin-preview-name');
  const placeholder  = $('skin-preview-placeholder');
  if (!gallery) return;

  const canDeleteSkinFile = (file) => {
    const f = String(file || '').trim().toLowerCase();
    if (!f) return false;
    const base = f.replace(/\.png$/i, '');
    return !(base === 'heeph' || base === 'mohud' || base.startsWith('mohud'));
  };

  const isDefaultSkinFile = (file) => {
    const f = String(file || '').trim().toLowerCase();
    if (!f) return false;
    const base = f.replace(/\.png$/i, '');
    return base === 'heeph' || base === 'mohud' || base.startsWith('mohud');
  };

  const sortDefaultSkins = (arr) => {
    const score = (f) => {
      const base = String(f || '').trim().toLowerCase().replace(/\.png$/i, '');
      if (base === 'heeph') return 0;
      if (base === 'mohud' || base.startsWith('mohud')) return 1;
      return 99;
    };
    return (Array.isArray(arr) ? arr : []).slice().sort((a, b) => score(a?.file) - score(b?.file));
  };

  gallery.innerHTML = '';
  if (count) count.textContent = skinsData.length;

  const isEmpty = skinsData.length === 0;
  gallery.style.display = isEmpty ? 'none' : 'grid';
  if (empty)  empty.style.display  = isEmpty ? '' : 'none';

  // Find the active skin's dataUrl for the big preview
  const wrap = document.getElementById('skin-preview-wrap');
  const viewer = ensureSkin3dViewer();
  forceSkin3dResize();
  const activeSkin = skinsData.find(s => s.file === activeSkinFile) || skinsData.find(s => s.active) || null;
  if (activeSkin && preview) {
    if (placeholder) placeholder.style.display = 'none';
    if (wrap) wrap.classList.add('has-skin');
    if (!set3dSkinFromDataUrl(viewer, activeSkin.dataUrl)) {
      renderSkinOnCanvas(preview, activeSkin.dataUrl, 128, 256);
    }
    if (previewName) previewName.textContent = activeSkin.name;
  } else {
    if (placeholder) placeholder.style.display = '';
    if (wrap) wrap.classList.remove('has-skin');
    if (preview) {
      if (!set3dSkinFromDataUrl(viewer, null)) {
        const c = preview.getContext('2d');
        c.clearRect(0,0,preview.width,preview.height);
      }
    }
    if (previewName) previewName.textContent = 'No skin';
  }

  const makeSkinCard = (skin) => {
    const card = document.createElement('div');
    card.className = 'skin-card' + (skin.file === (activeSkin?.file) ? ' active' : '');

    const cv = document.createElement('canvas');
    cv.className = 'skin-card-canvas';
    renderSkinOnCanvas(cv, skin.dataUrl, 64, 128);

    const nm = document.createElement('div');
    nm.className = 'skin-card-name';
    nm.textContent = skin.name;

    if (canDeleteSkinFile(skin.file)) {
      const del = document.createElement('button');
      del.className = 'skin-card-del';
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Remove skin';
      del.onclick = async (e) => {
        try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
        const r = await window.api.skinRemove({ file: skin.file }).catch(err => ({ ok:false, msg: err?.message || String(err) }));
        if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to remove skin'), 4500);
        toast('🗑 Skin removed', 2500);
        try { await loadSkinsTab(); } catch (_) {}
        try { refreshOfficialSkinAvatar(); } catch (_) {}
      };
      card.appendChild(del);
    }

    card.appendChild(cv);
    card.appendChild(nm);
    card.onclick = async () => {
      try {
        const s = String(skin?.dataUrl || '').trim();
        console.log('[SKINS] select', {
          file: skin?.file,
          name: skin?.name,
          dataUrlPrefix: s.slice(0, 32),
          dataUrlLen: s.length,
        });
      } catch (_) {}
      await window.api.skinSelect({ file: skin.file, username: cfg.username || '' });
      gallery.querySelectorAll('.skin-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      if (placeholder) placeholder.style.display = 'none';
      if (wrap) wrap.classList.add('has-skin');
      forceSkin3dResize();
      const used3d = set3dSkinFromDataUrl(viewer, skin.dataUrl);
      if (!used3d) {
        renderSkinOnCanvas(preview, skin.dataUrl, 128, 256);
      }
      try { console.log('[SKINS] preview mode', used3d ? '3d' : '2d'); } catch (_) {}
      if (previewName) previewName.textContent = skin.name;

      try { refreshOfficialSkinAvatar(); } catch (_) {}

      toast(`Skin "${skin.name}" selected`);
    };

    return card;
  };

  const defaults = sortDefaultSkins(skinsData.filter(s => isDefaultSkinFile(s?.file)));
  const custom = skinsData.filter(s => !isDefaultSkinFile(s?.file));

  const addSection = (title, items) => {
    const t = document.createElement('div');
    t.className = 'skin-gallery-section-title';
    t.textContent = title;
    const grid = document.createElement('div');
    grid.className = 'skin-gallery-section-grid';
    (Array.isArray(items) ? items : []).forEach(s => grid.appendChild(makeSkinCard(s)));
    gallery.appendChild(t);
    gallery.appendChild(grid);
  };

  if (defaults.length) addSection('Skins padrões', defaults);
  if (custom.length) addSection('Skins adicionadas', custom);
}

/* ── Ely.by toggle ────────────────────────────────── */
const elyToggle = $('ely-toggle');
if (elyToggle) {
  elyToggle.onchange = async () => {
    const enabled = elyToggle.checked;
    await window.api.skinSetEly({ enabled });
    skinsElyEnabled = enabled;
    toast(enabled ? 'In-game skins enabled' : 'In-game skins disabled');
  };
}

/* ── Upload button ────────────────────────────────── */
const uploadBtn = $('skin-upload-btn');
if (uploadBtn) {
  uploadBtn.onclick = async () => {
    const res = await window.api.skinUpload({});
    if (res.canceled) return;
    if (!res.ok) { toast('Import failed: ' + (res.msg || '?')); return; }
    toast(`Skin "${res.name}" imported`);
    await loadSkinsTab();
  };
}

if ($('official-skin-open')) {
  $('official-skin-open').onclick = () => {
    try {
      window.api.openUrl('https://www.minecraft.net/msaprofile/mygames/editskin');
    } catch (_) {}
  };
}

if ($('official-skin-upload')) {
  $('official-skin-upload').onclick = async () => {
    const variant = String($('official-skin-variant')?.value || 'classic');
    toast('⬆ Uploading official skin...', 3500);
    const r = await window.api.officialSkinUpload({ variant }).catch(e => ({ ok:false, msg: e?.message || String(e) }));
    if (r?.canceled) return;
    if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to upload skin'), 6500);
    toast('✅ Official skin updated!', 3500);
    setTimeout(() => { try { refreshOfficialSkinAvatar(); } catch (_) {} }, 800);
    setTimeout(() => { try { loadSkinsTab(); } catch (_) {} }, 900);
  };
}

if ($('official-skin-reset')) {
  $('official-skin-reset').onclick = async () => {
    toast('↩ Resetting official skin...', 3500);
    const r = await window.api.officialSkinReset().catch(e => ({ ok:false, msg: e?.message || String(e) }));
    if (!r?.ok) return toast('❌ ' + (r?.msg || 'Failed to reset skin'), 6500);
    toast('✅ Official skin reset!', 3500);
    setTimeout(() => { try { refreshOfficialSkinAvatar(); } catch (_) {} }, 800);
    setTimeout(() => { try { loadSkinsTab(); } catch (_) {} }, 900);
  };
}

/* ── Init ─────────────────────────────────────────── */
syncAccountName();
refreshOfficialSkinAvatar();
loadInfo();
