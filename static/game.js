/* =========================================================
   GoCart — Three.js multiplayer racing frontend
   Connects to the Go WebSocket backend for authoritative physics.
   ========================================================= */

'use strict';

// ── Track constants (must match server player.go) ──
const INNER_R   = 55;
const OUTER_R   = 85;
const MID_R     = (INNER_R + OUTER_R) / 2;   // 70
const TOTAL_LAPS = 3;

// ── Lerp speed for remote player interpolation ──
const LERP_POS = 0.25;
const LERP_ROT = 0.25;

// ── Ordinal suffixes ──
const SUFFIXES = ['TH','ST','ND','RD','TH','TH','TH','TH','TH','TH'];

// ── Global state ──
let scene, camera, renderer, clock;
let myId   = null;
let ws     = null;
let boostCharge = 1.0; // 0-1

const keys   = {};
const karts  = {}; // id → { mesh, current, target, nameTag }

let toastTimer = null;

// ──────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────
document.getElementById('nameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') startGame();
});
document.getElementById('joinBtn').addEventListener('click', startGame);

function startGame() {
  const name = document.getElementById('nameInput').value.trim() || 'Racer';
  document.getElementById('menu').style.display = 'none';
  document.getElementById('gameContainer').style.display = 'block';
  initThree();
  connectWS(name);
}

// ──────────────────────────────────────────────
// Three.js initialisation
// ──────────────────────────────────────────────
function initThree() {
  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.FogExp2(0x87ceeb, 0.004);

  // Camera
  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 600);
  camera.position.set(0, 8, -15);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('gameContainer').prepend(renderer.domElement);

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff4e0, 1.1);
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

  window.addEventListener('keydown', e => { keys[e.code] = true;  e.preventDefault(); });
  window.addEventListener('keyup',   e => { keys[e.code] = false; });
  window.addEventListener('resize',  onResize);

  animate();
}

// ──────────────────────────────────────────────
// Track & environment geometry
// ──────────────────────────────────────────────
function buildTrack() {
  // Ground plane
  const groundGeo = new THREE.PlaneGeometry(600, 600);
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x3e8e41 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Inner grass disc
  const innerGeo = new THREE.CircleGeometry(INNER_R - 1, 64);
  const innerMat = new THREE.MeshLambertMaterial({ color: 0x2d7a32 });
  const innerGrass = new THREE.Mesh(innerGeo, innerMat);
  innerGrass.rotation.x = -Math.PI / 2;
  innerGrass.position.y = 0.01;
  scene.add(innerGrass);

  // Asphalt ring
  const trackGeo = new THREE.RingGeometry(INNER_R, OUTER_R, 80);
  const trackMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
  const track = new THREE.Mesh(trackGeo, trackMat);
  track.rotation.x = -Math.PI / 2;
  track.position.y = 0.02;
  track.receiveShadow = true;
  scene.add(track);

  // Curb strips (alternating red / white) at inner and outer edges
  buildCurbs(INNER_R - 0.5, INNER_R + 2, 36);
  buildCurbs(OUTER_R - 2,   OUTER_R + 0.5, 36);

  // Centre-line dashes
  buildCentrelineDashes();

  // Start / finish line (white stripe at Z=0, right side)
  const sfGeo = new THREE.PlaneGeometry(OUTER_R - INNER_R, 3);
  const sfMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const sf = new THREE.Mesh(sfGeo, sfMat);
  sf.rotation.x = -Math.PI / 2;
  sf.rotation.z = Math.PI / 2;
  sf.position.set(MID_R, 0.035, 0);
  scene.add(sf);

  // Checkered finish-line overlay
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
    if (i % 2 === 0) continue; // every other one
    const angle = (i / DASHES) * Math.PI * 2;
    const geo = new THREE.PlaneGeometry(1.5, 5);
    const mesh = new THREE.Mesh(geo, dashMat);
    // Pivot approach: parent rotated around Y places the dash on the circle.
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
        pos.x,
        0.038,
        pos.z + (r - rows / 2 + 0.5) * cd
      );
      // Offset along width (X direction in local space, but rotated)
      mesh.position.x = pos.x + (c - cols / 2 + 0.5) * cw;
      scene.add(mesh);
    }
  }
}

function buildEnvironment() {
  // Grandstands on one straight
  buildStands(-120, 0, 0);

  // Trees around outside
  const rng = mulberry32(42);
  for (let i = 0; i < 40; i++) {
    const angle = (i / 40) * Math.PI * 2 + rng() * 0.3;
    const r = OUTER_R + 18 + rng() * 35;
    const t = makeTree(3 + rng() * 3);
    t.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
    scene.add(t);
  }

  // Trees inside the loop
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const r = rng() * (INNER_R - 12) + 5;
    const t = makeTree(2 + rng() * 3);
    t.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
    scene.add(t);
  }

  // Tyre-stack barriers at track entry points (decorative)
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

  // Roof
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
// Kart mesh factory
// ──────────────────────────────────────────────
function makeKart(colorHex) {
  const color = parseInt(colorHex.replace('#', ''), 16);
  const g = new THREE.Group();

  const bodyMat    = new THREE.MeshLambertMaterial({ color });
  const darkMat    = new THREE.MeshLambertMaterial({ color: 0x111111 });
  const chromeMat  = new THREE.MeshLambertMaterial({ color: 0xcccccc });
  const windowMat  = new THREE.MeshLambertMaterial({ color: 0x224466, transparent: true, opacity: 0.7 });

  // Main body
  const bodyGeo = new THREE.BoxGeometry(2.6, 0.7, 4.2);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);

  // Nose cone
  const noseGeo = new THREE.BoxGeometry(2.2, 0.5, 1.2);
  const nose = new THREE.Mesh(noseGeo, bodyMat);
  nose.position.set(0, 0.45, 2.6);
  nose.castShadow = true;
  g.add(nose);

  // Cockpit
  const cockpitGeo = new THREE.BoxGeometry(1.4, 0.65, 2);
  const cockpit = new THREE.Mesh(cockpitGeo, bodyMat);
  cockpit.position.set(0, 1.08, 0.2);
  cockpit.castShadow = true;
  g.add(cockpit);

  // Windscreen
  const wsGeo = new THREE.BoxGeometry(1.2, 0.55, 0.15);
  const ws = new THREE.Mesh(wsGeo, windowMat);
  ws.position.set(0, 1.2, 1.2);
  ws.rotation.x = 0.4;
  g.add(ws);

  // Rear wing
  const wingGeo = new THREE.BoxGeometry(3.0, 0.12, 0.9);
  const wing = new THREE.Mesh(wingGeo, bodyMat);
  wing.position.set(0, 1.35, -2.1);
  wing.rotation.x = -0.25;
  g.add(wing);

  const stanchionGeo = new THREE.BoxGeometry(0.15, 0.6, 0.15);
  for (const sx of [-1.1, 1.1]) {
    const s = new THREE.Mesh(stanchionGeo, chromeMat);
    s.position.set(sx, 1.0, -2.1);
    g.add(s);
  }

  // Wheels
  const wheelGeo = new THREE.CylinderGeometry(0.75, 0.75, 0.55, 14);
  const rimGeo   = new THREE.CylinderGeometry(0.38, 0.38, 0.58, 10);
  const rimMat   = new THREE.MeshLambertMaterial({ color: 0xaaaaaa });

  const wheelPos = [
    [-1.55, 0.5,  1.7],
    [ 1.55, 0.5,  1.7],
    [-1.55, 0.5, -1.7],
    [ 1.55, 0.5, -1.7],
  ];
  wheelPos.forEach(([wx, wy, wz]) => {
    const wheel = new THREE.Mesh(wheelGeo, darkMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, wy, wz);
    wheel.castShadow = true;
    g.add(wheel);

    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.z = Math.PI / 2;
    rim.position.set(wx, wy, wz);
    g.add(rim);
  });

  // Exhaust pipes
  const exGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.8, 8);
  for (const ex of [-0.5, 0.5]) {
    const pipe = new THREE.Mesh(exGeo, chromeMat);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(ex, 0.6, -2.5);
    g.add(pipe);
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
  sprite.position.y = 3.5;
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
// WebSocket networking
// ──────────────────────────────────────────────
function connectWS(playerName) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'setName', name: playerName }));
    showToast('Connected!', 2000);
  };

  ws.onmessage = e => {
    // Server may batch multiple JSON objects separated by newlines.
    e.data.split('\n').forEach(line => {
      line = line.trim();
      if (!line) return;
      try { handleServerMsg(JSON.parse(line)); } catch {}
    });
  };

  ws.onclose = () => showToast('Disconnected', 0);
}

function handleServerMsg(msg) {
  switch (msg.type) {
    case 'init':
      myId = msg.yourId;
      break;

    case 'state':
      applyState(msg.players || []);
      break;
  }
}

function applyState(players) {
  const seen = new Set();

  players.forEach(s => {
    seen.add(s.id);

    if (!karts[s.id]) {
      // First time seeing this player — spawn kart
      const mesh    = makeKart(s.color);
      const nameTag = makeNameTag(s.name);
      mesh.add(nameTag);
      scene.add(mesh);

      karts[s.id] = {
        mesh,
        nameTag,
        current: { x: s.x, y: s.y, z: s.z, rotY: s.rotY },
        target:  { ...s },
      };
    } else {
      karts[s.id].target = { ...s };
    }
  });

  // Remove karts for players who left
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
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const boosting = keys['ShiftLeft'] || keys['ShiftRight'];

  const inp = {
    type:    'input',
    forward: !!(keys['ArrowUp']   || keys['KeyW']),
    back:    !!(keys['ArrowDown'] || keys['KeyS']),
    left:    !!(keys['ArrowLeft'] || keys['KeyA']),
    right:   !!(keys['ArrowRight']|| keys['KeyD']),
    boost:   !!boosting,
  };

  // Manage boost charge
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

// ──────────────────────────────────────────────
// Interpolation
// ──────────────────────────────────────────────
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
    k.mesh.children.forEach(child => {
      if (child.geometry instanceof THREE.CylinderGeometry &&
          child.geometry.parameters.radiusTop < 0.8) {
        // wheels are cylinders rotated 90° on Z
        child.rotation.x += speed * 0.04;
      }
    });

    // Hide own name tag so it doesn't overlap the HUD
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

  // Speed (convert units/s → km/h with factor ~3.6)
  const kmh = me ? Math.abs(Math.round(me.speed * 3.6)) : 0;
  document.getElementById('speedValue').textContent = kmh;

  // Lap
  const lap = me ? Math.min(me.lap + 1, TOTAL_LAPS) : 1;
  document.getElementById('lapDisplay').textContent =
    `LAP ${lap} / ${TOTAL_LAPS}`;

  // Finished banner
  if (me && me.finished && !window._shownFinish) {
    window._shownFinish = true;
    showToast('FINISHED! 🏁', 0);
  }

  // Boost bar
  document.getElementById('boostFill').style.height = (boostCharge * 100) + '%';

  // Position (rank by lap desc, then distance-to-finish asc)
  const allPlayers = Object.values(karts).map(k => k.target).filter(Boolean);
  allPlayers.sort((a, b) => {
    if (b.lap !== a.lap) return b.lap - a.lap;
    // More of the lap completed = farther along
    const da = distAlongTrack(a.x, a.z);
    const db = distAlongTrack(b.x, b.z);
    return db - da;
  });
  const pos = allPlayers.findIndex(p => p.id === myId) + 1;
  const ord = pos <= 3 ? SUFFIXES[pos] : 'TH';
  document.getElementById('posOrdinal').textContent = pos || 1;
  document.getElementById('posSuffix').textContent  = ord;

  // Player list
  const entries = document.getElementById('plEntries');
  entries.innerHTML = '';
  allPlayers.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'pl-entry';
    div.innerHTML = `
      <span class="pl-dot" style="background:${p.color}"></span>
      <span class="pl-name">${escHtml(p.name)}</span>
      <span class="pl-lap">L${Math.min(p.lap + 1, TOTAL_LAPS)}</span>`;
    entries.appendChild(div);
  });
}

// Estimate how far around the track (in radians) a position is.
function distAlongTrack(x, z) {
  // Track goes counterclockwise; angle increases as kart progresses.
  // atan2(z, x) gives angle; we want CCW from the start line at (MID_R, 0).
  let angle = Math.atan2(z, x);
  // Normalise so 0 = start line and increasing = more progress
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

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  ctx.arc(cx, cy, W / 2, 0, Math.PI * 2);
  ctx.fill();

  // Grass inside
  ctx.fillStyle = '#2d7a32';
  ctx.beginPath();
  ctx.arc(cx, cy, INNER_R * scale, 0, Math.PI * 2);
  ctx.fill();

  // Track ring
  ctx.strokeStyle = '#555';
  ctx.lineWidth = (OUTER_R - INNER_R) * scale;
  ctx.beginPath();
  ctx.arc(cx, cy, MID_R * scale, 0, Math.PI * 2);
  ctx.stroke();

  // Start line
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + INNER_R * scale, cy);
  ctx.lineTo(cx + OUTER_R * scale, cy);
  ctx.stroke();

  // Karts
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

// ──────────────────────────────────────────────
// Resize handler
// ──────────────────────────────────────────────
function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

// ──────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Deterministic PRNG (mulberry32) so trees are the same every reload.
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
