/* =========================================================
   GoCart — Three.js multiplayer racing frontend
   Connects to the Go WebSocket backend for authoritative physics.
   Karts are cloned from a single GLB and tinted per player.
   ========================================================= */

'use strict';

// ── Track constants (must match server player.go) ──
const INNER_R    = 55;
const OUTER_R    = 85;
const MID_R      = (INNER_R + OUTER_R) / 2;
const TOTAL_LAPS = 3;

// ── Lerp speed for remote player interpolation ──
const LERP_POS = 0.25;
const LERP_ROT = 0.25;

const SUFFIXES = ['TH','ST','ND','RD','TH','TH','TH','TH','TH','TH'];

// ── Global state ──
let scene, camera, renderer, clock;
let myId       = null;
let myColor    = null;
let lobbyCode  = null;
let lobbyPriv  = false;
let ws         = null;
let boostCharge = 1.0;
let kartTemplate = null;     // cached GLB scene used as a clone source
let threeReady   = false;    // initThree() has run
let toastTimer   = null;
let pendingJoinName = null;  // sent once WS opens

const keys  = {};
const karts = {}; // id → { mesh, current, target, nameTag, wheels }

// ──────────────────────────────────────────────
// Boot — wire up the menu, kick off model preload
// ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  wireMenu();
  preloadKartModel();
});

function wireMenu() {
  const $ = (id) => document.getElementById(id);

  $('quickBtn').addEventListener('click', () => startMode('quick'));
  $('createBtn').addEventListener('click', () => showPanel('createPanel'));
  $('joinBtn').addEventListener('click',   () => showPanel('joinPanel'));

  $('createGo').addEventListener('click', () => startMode('create'));
  $('joinGo').addEventListener('click',   () => startMode('join'));

  $('createBack').addEventListener('click', () => showPanel('modePanel'));
  $('joinBack').addEventListener('click',   () => showPanel('modePanel'));

  // Enter key submits whichever panel is open
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') startMode('quick'); });
  $('createPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') startMode('create'); });
  $('joinCode').addEventListener('keydown',     (e) => { if (e.key === 'Enter') startMode('join'); });
  $('joinPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') startMode('join'); });
}

function showPanel(id) {
  for (const p of ['modePanel','createPanel','joinPanel']) {
    document.getElementById(p).classList.toggle('hidden', p !== id);
  }
  document.getElementById('menuError').textContent = '';
}

function setMenuButtonsEnabled(enabled) {
  for (const id of ['quickBtn','createBtn','joinBtn','createGo','joinGo']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
}

function setMenuError(msg) {
  document.getElementById('menuError').textContent = msg || '';
}

// ──────────────────────────────────────────────
// Kart-model preload (47 MB GLB; show progress)
// ──────────────────────────────────────────────
function preloadKartModel() {
  const status = document.getElementById('loadingStatus');
  if (typeof THREE.GLTFLoader !== 'function') {
    status.textContent = 'Failed to load GLTFLoader';
    return;
  }
  const loader = new THREE.GLTFLoader();
  loader.load('/models/goCart.glb',
    (gltf) => {
      kartTemplate = prepareKartTemplate(gltf.scene);
      status.textContent = 'Ready.';
      setTimeout(() => status.style.display = 'none', 800);
      setMenuButtonsEnabled(true);
    },
    (progress) => {
      if (progress.total) {
        const pct = Math.round(100 * progress.loaded / progress.total);
        status.textContent = `Loading kart model… ${pct}%`;
      } else {
        const mb = (progress.loaded / 1048576).toFixed(1);
        status.textContent = `Loading kart model… ${mb} MB`;
      }
    },
    (err) => {
      console.error('GLB load failed', err);
      status.textContent = 'Failed to load kart model — check that models/goCart.glb exists.';
    }
  );
}

// prepareKartTemplate normalises scale / orientation / origin so every
// cloned kart sits on the ground facing +Z (matches server move() heading).
function prepareKartTemplate(scene) {
  const wrapper = new THREE.Group();
  wrapper.add(scene);

  // Scale so longest axis ≈ 4 units (rough match for old box kart length).
  let bbox = new THREE.Box3().setFromObject(scene);
  const size = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const targetLen = 4.5;
  scene.scale.setScalar(targetLen / maxDim);

  // Re-centre on origin and rest on the ground (y = 0).
  bbox = new THREE.Box3().setFromObject(scene);
  const centre = bbox.getCenter(new THREE.Vector3());
  scene.position.sub(new THREE.Vector3(centre.x, bbox.min.y, centre.z));

  // Most exported karts face -Z by convention; flip so +Z matches server heading.
  // If the model already faces +Z this just orbits 180° — visually identical
  // to what the player expects from a kart sprite.
  scene.rotation.y = Math.PI;

  // Tag meshes that look like wheels so we can spin them with speed.
  // Heuristic: anything in the lower 35 % of the bbox AND off-centre.
  bbox = new THREE.Box3().setFromObject(scene);
  const yMid = bbox.min.y + (bbox.max.y - bbox.min.y) * 0.35;
  scene.traverse((child) => {
    if (!child.isMesh) return;
    const cb = new THREE.Box3().setFromObject(child);
    const c  = cb.getCenter(new THREE.Vector3());
    child.userData.isWheel = c.y < yMid && Math.abs(c.x) > 0.4;
    child.castShadow = true;
    child.receiveShadow = false;
  });

  return wrapper;
}

// makeKart deep-clones the template and tints every paintable material
// with the player's colour. MeshStandardMaterial.color multiplies the
// baseColor texture, so the kart keeps all baked detail but is recoloured.
function makeKart(colorHex) {
  const tint = new THREE.Color(colorHex);
  const g = kartTemplate.clone(true);

  const wheels = [];
  g.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    // Three's Object3D.clone shares materials — we need our own copy per kart.
    child.material = Array.isArray(child.material)
      ? child.material.map(m => tintMaterial(m.clone(), tint))
      : tintMaterial(child.material.clone(), tint);
    child.castShadow = true;
    if (child.userData.isWheel) wheels.push(child);
  });

  g.userData.wheels = wheels;
  return g;
}

function tintMaterial(mat, tint) {
  if (mat.color) mat.color.copy(tint);
  // Suppress baked-in emissive so the body colour reads correctly under our lights.
  if (mat.emissive) mat.emissive.setScalar(0);
  return mat;
}

// ──────────────────────────────────────────────
// Three.js initialisation (track + environment + loop)
// ──────────────────────────────────────────────
function initThree() {
  if (threeReady) return;
  threeReady = true;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.FogExp2(0x87ceeb, 0.004);

  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 600);
  camera.position.set(0, 8, -15);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Reasonable colour pipeline for PBR-textured GLB:
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.physicallyCorrectLights = true;
  document.getElementById('gameContainer').prepend(renderer.domElement);

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
  sun.position.set(80, 120, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.width  = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far  = 400;
  sun.shadow.camera.left   = -160;
  sun.shadow.camera.right  =  160;
  sun.shadow.camera.top    =  160;
  sun.shadow.camera.bottom = -160;
  scene.add(sun);

  const hemi = new THREE.HemisphereLight(0x87ceeb, 0x3a7d44, 0.35);
  scene.add(hemi);

  buildTrack();
  buildEnvironment();

  clock = new THREE.Clock();

  window.addEventListener('keydown', e => { keys[e.code] = true;  if (shouldPreventDefault(e)) e.preventDefault(); });
  window.addEventListener('keyup',   e => { keys[e.code] = false; });
  window.addEventListener('resize',  onResize);

  // Lobby chip click-to-copy
  document.getElementById('lobbyChip').addEventListener('click', copyLobbyCode);

  animate();
}

function shouldPreventDefault(e) {
  return ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code);
}

// ──────────────────────────────────────────────
// Track & environment geometry
// ──────────────────────────────────────────────
function buildTrack() {
  const groundGeo = new THREE.PlaneGeometry(600, 600);
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x3e8e41 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const innerGeo = new THREE.CircleGeometry(INNER_R - 1, 64);
  const innerMat = new THREE.MeshLambertMaterial({ color: 0x2d7a32 });
  const innerGrass = new THREE.Mesh(innerGeo, innerMat);
  innerGrass.rotation.x = -Math.PI / 2;
  innerGrass.position.y = 0.01;
  scene.add(innerGrass);

  const trackGeo = new THREE.RingGeometry(INNER_R, OUTER_R, 80);
  const trackMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
  const track = new THREE.Mesh(trackGeo, trackMat);
  track.rotation.x = -Math.PI / 2;
  track.position.y = 0.02;
  track.receiveShadow = true;
  scene.add(track);

  buildCurbs(INNER_R - 0.5, INNER_R + 2, 36);
  buildCurbs(OUTER_R - 2,   OUTER_R + 0.5, 36);
  buildCentrelineDashes();

  const sfGeo = new THREE.PlaneGeometry(OUTER_R - INNER_R, 3);
  const sfMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const sf = new THREE.Mesh(sfGeo, sfMat);
  sf.rotation.x = -Math.PI / 2;
  sf.rotation.z = Math.PI / 2;
  sf.position.set(MID_R, 0.035, 0);
  scene.add(sf);

  buildCheckerboard(sf.position, OUTER_R - INNER_R, 3);
}

function buildCurbs(r0, r1, segments) {
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const color = i % 2 === 0 ? 0xe74c3c : 0xffffff;
    const geo = new THREE.RingGeometry(r0, r1, 1, 1, a0, a1 - a0);
    const mat = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.025;
    scene.add(mesh);
  }
}

function buildCentrelineDashes() {
  const dashMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const DASHES = 24;
  for (let i = 0; i < DASHES; i++) {
    if (i % 2 === 0) continue;
    const angle = (i / DASHES) * Math.PI * 2;
    const geo = new THREE.PlaneGeometry(1.5, 5);
    const mesh = new THREE.Mesh(geo, dashMat);
    const pivot = new THREE.Object3D();
    pivot.rotation.y = -angle;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(MID_R, 0.03, 0);
    pivot.add(mesh);
    scene.add(pivot);
  }
}

function buildCheckerboard(pos, width, depth) {
  const cols = 6, rows = 2;
  const cw = width / cols, cd = depth / rows;
  const mat0 = new THREE.MeshLambertMaterial({ color: 0x000000 });
  const mat1 = new THREE.MeshLambertMaterial({ color: 0xffffff });
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const mat = (c + r) % 2 === 0 ? mat0 : mat1;
      const geo = new THREE.PlaneGeometry(cw - 0.05, cd - 0.05);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = Math.PI / 2;
      mesh.position.set(
        pos.x + (c - cols / 2 + 0.5) * cw,
        0.038,
        pos.z + (r - rows / 2 + 0.5) * cd
      );
      scene.add(mesh);
    }
  }
}

function buildEnvironment() {
  buildStands(-120, 0, 0);

  const rng = mulberry32(42);
  for (let i = 0; i < 40; i++) {
    const angle = (i / 40) * Math.PI * 2 + rng() * 0.3;
    const r = OUTER_R + 18 + rng() * 35;
    const t = makeTree(3 + rng() * 3);
    t.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
    scene.add(t);
  }

  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const r = rng() * (INNER_R - 12) + 5;
    const t = makeTree(2 + rng() * 3);
    t.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
    scene.add(t);
  }

  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const stack = makeTyreStack();
    stack.position.set(
      Math.cos(angle) * (OUTER_R + 3),
      0,
      Math.sin(angle) * (OUTER_R + 3)
    );
    stack.rotation.y = angle;
    scene.add(stack);
  }
}

function buildStands(x, y, z) {
  const standMat = new THREE.MeshLambertMaterial({ color: 0x95a5a6 });
  const geo = new THREE.BoxGeometry(60, 12, 10);
  const mesh = new THREE.Mesh(geo, standMat);
  mesh.position.set(x, 6, z);
  mesh.castShadow = true;
  scene.add(mesh);

  const roofGeo = new THREE.BoxGeometry(62, 1.5, 11);
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x7f8c8d });
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.set(x, 13, z);
  scene.add(roof);
}

function makeTree(h) {
  const g = new THREE.Group();
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.55, h * 0.45, 7);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.position.y = h * 0.225;
  trunk.castShadow = true;
  g.add(trunk);

  const leafGeo = new THREE.ConeGeometry(h * 0.6, h * 0.9, 7);
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x1e8449 });
  const leaf = new THREE.Mesh(leafGeo, leafMat);
  leaf.position.y = h * 0.45 + h * 0.45;
  leaf.castShadow = true;
  g.add(leaf);
  return g;
}

function makeTyreStack() {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x111111 });
  for (let i = 0; i < 3; i++) {
    const geo = new THREE.TorusGeometry(0.7, 0.3, 8, 16);
    const m = new THREE.Mesh(geo, mat);
    m.position.y = 0.6 + i * 1.2;
    m.rotation.x = Math.PI / 2;
    g.add(m);
  }
  return g;
}

// ──────────────────────────────────────────────
// Name-tag sprite above kart
// ──────────────────────────────────────────────
function makeNameTag(name) {
  const canvas = document.createElement('canvas');
  canvas.width  = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(ctx, 4, 4, 248, 56, 14);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.slice(0, 14), 128, 32);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(5, 1.25, 1);
  sprite.position.y = 4.0;
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ──────────────────────────────────────────────
// Lobby flow + WebSocket
// ──────────────────────────────────────────────
function startMode(mode) {
  setMenuError('');
  if (!kartTemplate) { setMenuError('Kart still loading…'); return; }

  const name = (document.getElementById('nameInput').value || '').trim() || 'Racer';
  pendingJoinName = name;

  // Open WS first; once it's open we send the appropriate join request.
  if (!ws || ws.readyState >= WebSocket.CLOSING) connectWS();

  const send = () => sendJoinRequest(mode, name);
  if (ws.readyState === WebSocket.OPEN) send();
  else ws.addEventListener('open', send, { once: true });
}

function sendJoinRequest(mode, name) {
  if (mode === 'quick') {
    ws.send(JSON.stringify({ type: 'quickMatch', name }));
  } else if (mode === 'create') {
    const password = document.getElementById('createPassword').value || '';
    ws.send(JSON.stringify({ type: 'createLobby', name, password, private: true }));
  } else if (mode === 'join') {
    const code = (document.getElementById('joinCode').value || '').trim().toUpperCase();
    const password = document.getElementById('joinPassword').value || '';
    if (!code) { setMenuError('Enter a lobby code.'); return; }
    ws.send(JSON.stringify({ type: 'joinLobby', name, code, password }));
  }
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = e => {
    e.data.split('\n').forEach(line => {
      line = line.trim();
      if (!line) return;
      try { handleServerMsg(JSON.parse(line)); } catch {}
    });
  };

  ws.onclose = () => {
    if (threeReady) showToast('Disconnected', 0);
    else setMenuError('Connection closed.');
  };

  ws.onerror = () => setMenuError('Connection error.');
}

function handleServerMsg(msg) {
  switch (msg.type) {
    case 'init':
      myId = msg.yourId;
      break;

    case 'joined':
      myColor   = msg.color;
      lobbyCode = msg.code;
      lobbyPriv = !!msg.isPrivate;
      enterGame();
      break;

    case 'lobbyError':
      setMenuError(prettyLobbyError(msg.error));
      break;

    case 'state':
      applyState(msg.players || []);
      break;
  }
}

function prettyLobbyError(code) {
  switch (code) {
    case 'no_such_lobby':   return 'No lobby with that code.';
    case 'wrong_password':  return 'Wrong password.';
    case 'lobby_full':      return 'Lobby is full.';
    case 'already_in_lobby':return 'You are already in a lobby.';
    case 'lobby_alloc_failed': return 'Server is at capacity. Try again.';
    default: return 'Could not join lobby (' + code + ').';
  }
}

function enterGame() {
  document.getElementById('menu').style.display = 'none';
  document.getElementById('gameContainer').style.display = 'block';

  // Show / hide lobby chip + render code
  const chip = document.getElementById('lobbyChip');
  if (lobbyCode) {
    chip.style.display = 'block';
    chip.querySelector('.code').textContent = lobbyCode;
    chip.querySelector('.label').textContent = lobbyPriv ? 'Private Lobby' : 'Public Lobby';
  } else {
    chip.style.display = 'none';
  }

  initThree();
}

function copyLobbyCode() {
  if (!lobbyCode) return;
  const text = lobbyCode;
  const done = () => {
    const chip = document.getElementById('lobbyChip');
    chip.classList.add('flash');
    setTimeout(() => chip.classList.remove('flash'), 1200);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done, done);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove();
    done();
  }
}

// ──────────────────────────────────────────────
// State application
// ──────────────────────────────────────────────
function applyState(players) {
  const seen = new Set();

  players.forEach(s => {
    seen.add(s.id);

    if (!karts[s.id]) {
      const mesh    = makeKart(s.color);
      const nameTag = makeNameTag(s.name);
      mesh.add(nameTag);
      scene.add(mesh);

      karts[s.id] = {
        mesh,
        nameTag,
        wheels:  mesh.userData.wheels || [],
        current: { x: s.x, y: s.y, z: s.z, rotY: s.rotY },
        target:  { ...s },
      };
    } else {
      karts[s.id].target = { ...s };
    }
  });

  for (const id in karts) {
    if (!seen.has(id)) {
      scene.remove(karts[id].mesh);
      delete karts[id];
    }
  }
}

// ──────────────────────────────────────────────
// Input
// ──────────────────────────────────────────────
let lastInputJSON = '';

function sendInput() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !lobbyCode) return;

  const boosting = keys['ShiftLeft'] || keys['ShiftRight'];

  const inp = {
    type:    'input',
    forward: !!(keys['ArrowUp']   || keys['KeyW']),
    back:    !!(keys['ArrowDown'] || keys['KeyS']),
    left:    !!(keys['ArrowLeft'] || keys['KeyA']),
    right:   !!(keys['ArrowRight']|| keys['KeyD']),
    boost:   !!boosting,
  };

  if (boosting) {
    boostCharge = Math.max(0, boostCharge - 0.008);
    if (boostCharge === 0) inp.boost = false;
  } else {
    boostCharge = Math.min(1, boostCharge + 0.003);
  }

  const j = JSON.stringify(inp);
  if (j !== lastInputJSON) {
    ws.send(j);
    lastInputJSON = j;
  }
}

// ──────────────────────────────────────────────
// Animation loop
// ──────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  sendInput();
  interpolateKarts(dt);
  updateCamera();
  updateHUD();
  drawMinimap();

  renderer.render(scene, camera);
}

function interpolateKarts() {
  for (const id in karts) {
    const k = karts[id];
    const c = k.current;
    const t = k.target;

    c.x    += (t.x    - c.x)    * LERP_POS;
    c.y    += (t.y    - c.y)    * LERP_POS;
    c.z    += (t.z    - c.z)    * LERP_POS;
    c.rotY += shortAngleDiff(c.rotY, t.rotY) * LERP_ROT;

    k.mesh.position.set(c.x, c.y, c.z);
    k.mesh.rotation.y = c.rotY;

    // Spin wheels proportional to speed
    const speed = t.speed || 0;
    if (k.wheels && k.wheels.length) {
      for (const w of k.wheels) w.rotation.x += speed * 0.04;
    }

    // Hide own name tag — overlaps the HUD
    if (id === myId && k.nameTag) k.nameTag.visible = false;
  }
}

function shortAngleDiff(a, b) {
  let d = b - a;
  while (d >  Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// ──────────────────────────────────────────────
// Camera — chase cam behind the local kart
// ──────────────────────────────────────────────
const camDist   = 16;
const camHeight = 7;

function updateCamera() {
  if (!myId || !karts[myId]) return;
  const c = karts[myId].current;

  const tx = c.x - Math.sin(c.rotY) * camDist;
  const tz = c.z - Math.cos(c.rotY) * camDist;

  camera.position.x += (tx - camera.position.x) * 0.12;
  camera.position.y += (c.y + camHeight - camera.position.y) * 0.12;
  camera.position.z += (tz - camera.position.z) * 0.12;

  camera.lookAt(c.x, c.y + 1.5, c.z);
}

// ──────────────────────────────────────────────
// HUD
// ──────────────────────────────────────────────
function updateHUD() {
  const me = myId && karts[myId] ? karts[myId].target : null;

  const kmh = me ? Math.abs(Math.round(me.speed * 3.6)) : 0;
  document.getElementById('speedValue').textContent = kmh;

  const lap = me ? Math.min(me.lap + 1, TOTAL_LAPS) : 1;
  document.getElementById('lapDisplay').textContent =
    `LAP ${lap} / ${TOTAL_LAPS}`;

  if (me && me.finished && !window._shownFinish) {
    window._shownFinish = true;
    showToast('FINISHED! 🏁', 0);
  }

  document.getElementById('boostFill').style.height = (boostCharge * 100) + '%';

  const allPlayers = Object.values(karts).map(k => k.target).filter(Boolean);
  allPlayers.sort((a, b) => {
    if (b.lap !== a.lap) return b.lap - a.lap;
    return distAlongTrack(b.x, b.z) - distAlongTrack(a.x, a.z);
  });
  const pos = allPlayers.findIndex(p => p.id === myId) + 1;
  const ord = pos <= 3 ? SUFFIXES[pos] : 'TH';
  document.getElementById('posOrdinal').textContent = pos || 1;
  document.getElementById('posSuffix').textContent  = ord;

  const entries = document.getElementById('plEntries');
  entries.innerHTML = '';
  allPlayers.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'pl-entry';
    div.innerHTML = `
      <span class="pl-dot" style="background:${p.color}"></span>
      <span class="pl-name">${escHtml(p.name)}</span>
      <span class="pl-lap">L${Math.min(p.lap + 1, TOTAL_LAPS)}</span>`;
    entries.appendChild(div);
  });
}

function distAlongTrack(x, z) {
  let angle = Math.atan2(z, x);
  angle = (angle + Math.PI * 2) % (Math.PI * 2);
  return angle;
}

// ──────────────────────────────────────────────
// Minimap
// ──────────────────────────────────────────────
function drawMinimap() {
  const canvas = document.getElementById('minimap');
  const ctx    = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const scale = (W / 2 - 10) / OUTER_R;

  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  ctx.arc(cx, cy, W / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#2d7a32';
  ctx.beginPath();
  ctx.arc(cx, cy, INNER_R * scale, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#555';
  ctx.lineWidth = (OUTER_R - INNER_R) * scale;
  ctx.beginPath();
  ctx.arc(cx, cy, MID_R * scale, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + INNER_R * scale, cy);
  ctx.lineTo(cx + OUTER_R * scale, cy);
  ctx.stroke();

  for (const id in karts) {
    const k  = karts[id];
    const px = cx + k.current.x * scale;
    const py = cy + k.current.z * scale;
    const r  = id === myId ? 5 : 3.5;

    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = k.target.color || '#fff';
    ctx.fill();

    if (id === myId) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ──────────────────────────────────────────────
// Toast notifications
// ──────────────────────────────────────────────
function showToast(text, duration) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.style.opacity = '1';
  if (toastTimer) clearTimeout(toastTimer);
  if (duration > 0) {
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, duration);
  }
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
