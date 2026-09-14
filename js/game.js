"use strict";
/* =========================================================
 * HIVEBREAK — a honeycomb breaker
 * Vanilla JS canvas game. No dependencies.
 * ========================================================= */

// ---------- canvas setup ----------
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = 960, H = 640;

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
fitCanvas();
window.addEventListener("resize", fitCanvas);

// ---------- helpers ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// ---------- sound (WebAudio, no assets) ----------
const SFX = {
  ctx: null,
  muted: false,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  beep(freq, dur = 0.08, type = "square", gain = 0.16, slide = 0) {
    const c = this.ensure();
    if (!c || this.muted) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, c.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), c.currentTime + dur);
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + dur + 0.02);
  },
  noise(dur = 0.25, gain = 0.3) {
    const c = this.ensure();
    if (!c || this.muted) return;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 1200;
    src.connect(f).connect(g).connect(c.destination);
    src.start();
  },
};
const snd = {
  bounce: () => SFX.beep(220, 0.05, "square", 0.08, -60),
  brick: (combo) => SFX.beep(330 + combo * 22, 0.06, "triangle", 0.14, 120),
  crack: () => SFX.beep(180, 0.05, "sawtooth", 0.1, -40),
  boom: () => { SFX.noise(0.35, 0.4); SFX.beep(90, 0.3, "sawtooth", 0.2, -50); },
  power: () => { SFX.beep(520, 0.09, "sine", 0.16); setTimeout(() => SFX.beep(780, 0.12, "sine", 0.16), 70); },
  laser: () => SFX.beep(920, 0.07, "sawtooth", 0.1, -500),
  lose: () => { SFX.beep(240, 0.3, "sawtooth", 0.2, -160); },
  level: () => [440, 550, 660, 880].forEach((f, i) => setTimeout(() => SFX.beep(f, 0.12, "triangle", 0.15), i * 90)),
  over: () => [330, 262, 196, 147].forEach((f, i) => setTimeout(() => SFX.beep(f, 0.25, "triangle", 0.18), i * 180)),
};

// ---------- hex geometry ----------
const HEX_R = 30;                 // circumradius
const HEX_W = Math.sqrt(3) * HEX_R;
const ROW_H = 1.5 * HEX_R;

function hexCorners(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// circle vs convex polygon: returns {nx, ny, depth} or null
function circlePoly(cx, cy, r, pts) {
  let inside = true, minDist = Infinity, nx = 0, ny = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    // inside test (hex corners wind with positive signed area in canvas coords,
    // so interior points sit on the positive-cross side of every edge)
    if ((x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1) < 0) inside = false;
    // closest point on segment
    const dx = x2 - x1, dy = y2 - y1;
    const t = clamp(((cx - x1) * dx + (cy - y1) * dy) / (dx * dx + dy * dy), 0, 1);
    const px = x1 + dx * t, py = y1 + dy * t;
    const d = Math.hypot(cx - px, cy - py);
    if (d < minDist) {
      minDist = d;
      if (d > 0.0001) { nx = (cx - px) / d; ny = (cy - py) / d; }
      else { nx = 0; ny = -1; }
    }
  }
  if (inside) {
    return { nx, ny, depth: r + minDist };
  }
  if (minDist < r) {
    return { nx, ny, depth: r - minDist };
  }
  return null;
}

// ---------- levels ----------
// chars: . empty | h honey(1hp) | H wax(2hp) | c crystal(3hp) | b bomb
const LEVELS = [
  {
    name: "Worker Cells",
    map: [
      ".hhhhhhhhhh.",
      "hhhhhhhhhhhh",
      "hhhhhhhhhhhh",
      ".hhhhhhhhhh.",
    ],
  },
  {
    name: "Drone Deck",
    map: [
      "HHHHHHHHHHHH",
      "h.h.h.h.h.h.",
      "hhhhhhhhhhhh",
      "h.h.h.h.h.h.",
      ".hhhhhhhhhh.",
    ],
  },
  {
    name: "Wax Walls",
    map: [
      "cHHHHHHHHHHc",
      ".hHHhhhhHHh.",
      "hhhhbbbbhhhh",
      ".hHHhhhhHHh.",
      "cHHHHHHHHHHc",
    ],
  },
  {
    name: "Amber Vault",
    map: [
      "....cccc....",
      "..ccHHHHcc..",
      ".cHHhbbhHHc.",
      ".cHHhbbhHHc.",
      "..ccHHHHcc..",
      "....cccc....",
    ],
  },
  {
    name: "Powder Comb",
    map: [
      "h.b.hh.hh.b.",
      "hhhhhhhhhhhh",
      "HHHbbbbbbHHH",
      "hhhhhhhhhhhh",
      ".b.hh..hh.b.",
      "hhhhhhhhhhhh",
    ],
  },
  {
    name: "The Maze",
    map: [
      "cc.hh.cc.hh.",
      ".hhhhh..hhhh",
      "h.cc.hh.cc.h",
      "hhhh..hhhhh.",
      "h.cc.hh.cc.h",
      ".hhhh..hhhhc",
    ],
  },
  {
    name: "Royal Guard",
    map: [
      "cHbHHHHHHbHc",
      "HhhhhhhhhhhH",
      "HhccbbbbcchH",
      "HhhhhhhhhhhH",
      "cHbHHHHHHbHc",
    ],
  },
  {
    name: "Queen's Crown",
    map: [
      "c.cc.cccc.cc.c",
      "HhhHHhhhhHHhhH",
      "Hh.b.HHHH.b.hh",
      "ccHhhccccccHcc",
      ".HhhhbbbbhhhhH",
      "..HhhHHHHHhhH.",
      "...bHHHHHHb...",
    ],
  },
];

// ---------- state ----------
const G = {
  state: "menu",          // menu | banner | playing | paused | over | win
  level: 0,
  endless: false,
  score: 0,
  best: +(localStorage.getItem("hivebreak_best") || 0),
  lives: 3,
  combo: 0,
  bricks: [],
  balls: [],
  paddle: { x: W / 2, y: H - 46, w: 130, h: 16, targetW: 130 },
  powerups: [],
  lasers: [],
  particles: [],
  texts: [],
  effects: { wide: 0, laser: 0, slow: 0, sticky: 0 },
  laserCd: 0,
  bannerT: 0,
  shake: 0,
  time: 0,
  firing: false,
  rally: 0, // brick hits since last serve; gently ramps ball speed
};

const MAX_BALLS = 12;
function rallyMul() { return Math.min(1.3, 1 + G.rally * 0.006); }

const BRICK_COLORS = {
  h:  { fill: "#f6b93b", edge: "#c47f0e", glow: "rgba(246,185,59,.35)", hp: 1, pts: 50 },
  H:  { fill: "#e58e26", edge: "#9c5c0b", glow: "rgba(229,142,38,.35)", hp: 2, pts: 90 },
  c:  { fill: "#b8860b", edge: "#6e4f06", glow: "rgba(184,134,11,.4)", hp: 3, pts: 150 },
  b:  { fill: "#e84118", edge: "#8c1f06", glow: "rgba(232,65,24,.5)", hp: 1, pts: 120 },
};

const POWER_TYPES = [
  { id: "wide",   label: "W", color: "#2ecc71", desc: "WIDE BAR" },
  { id: "multi",  label: "M", color: "#ffc93c", desc: "MULTIBALL" },
  { id: "laser",  label: "L", color: "#e84118", desc: "STINGERS" },
  { id: "slow",   label: "S", color: "#4aa3ff", desc: "SLOW BEE" },
  { id: "sticky", label: "C", color: "#a55eea", desc: "STICKY COMB" },
  { id: "life",   label: "+", color: "#ff6b81", desc: "+1 BEE" },
];

// ---------- level building ----------
function loadLevel(idx) {
  const def = LEVELS[idx % LEVELS.length];
  G.bricks = [];
  const map = def.map;
  const rows = map.length;
  const cols = Math.max(...map.map((r) => r.length));
  const totalW = cols * HEX_W + HEX_W / 2;
  const ox = (W - totalW) / 2 + HEX_W / 2;
  const oy = 96;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < map[r].length; c++) {
      const ch = map[r][c];
      if (ch === ".") continue;
      const x = ox + c * HEX_W + (r % 2 ? HEX_W / 2 : 0);
      const y = oy + r * ROW_H;
      const hp = BRICK_COLORS[ch].hp;
      G.bricks.push({
        x, y, r: HEX_R - 2, type: ch,
        hp, maxHp: hp, alive: true,
        flash: 0, wobble: Math.random() * Math.PI * 2,
      });
    }
  }
}

function ballSpeed() {
  const base = 340 + Math.min(G.level, 14) * 12 + (G.endless ? (G.level - LEVELS.length) * 6 : 0);
  return base;
}

function newBall(x, y, angle = -Math.PI / 2) {
  const s = ballSpeed();
  return { x, y, vx: Math.cos(angle) * s, vy: Math.sin(angle) * s, r: 9, stuck: true, stickOff: 0, trail: [] };
}

function serveBall() {
  G.rally = 0;
  G.balls = [newBall(G.paddle.x, G.paddle.y - 14)];
  G.balls[0].stuck = true;
}

function startLevel(idx) {
  G.level = idx;
  loadLevel(idx);
  G.powerups = [];
  G.lasers = [];
  G.effects = { wide: 0, laser: 0, slow: 0, sticky: 0 };
  G.paddle.targetW = 130;
  serveBall();
  G.state = "banner";
  G.bannerT = 1.6;
  snd.level();
}

function startGame() {
  G.score = 0;
  G.lives = 3;
  G.combo = 0;
  G.endless = false;
  startLevel(0);
}

// ---------- input ----------
const keys = {};
window.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (["ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
  if (e.code === "KeyM") toggleMute();
  if (e.code === "KeyP" || e.code === "Escape") togglePause();
  if (e.code === "Space") action();
});
window.addEventListener("keyup", (e) => (keys[e.code] = false));

function canvasX(clientX) {
  const rect = canvas.getBoundingClientRect();
  return ((clientX - rect.left) / rect.width) * W;
}
canvas.addEventListener("mousemove", (e) => {
  if (G.state === "playing" || G.state === "banner") {
    G.paddle.x = clamp(canvasX(e.clientX), G.paddle.w / 2 + 4, W - G.paddle.w / 2 - 4);
  }
});
canvas.addEventListener("mousedown", (e) => {
  SFX.ensure();
  if (G.state === "playing" || G.state === "banner") action();
});
canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  SFX.ensure();
  const t = e.touches[0];
  if (G.state === "playing" || G.state === "banner") {
    G.paddle.x = clamp(canvasX(t.clientX), G.paddle.w / 2 + 4, W - G.paddle.w / 2 - 4);
    action();
  }
}, { passive: false });
canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  const t = e.touches[0];
  G.paddle.x = clamp(canvasX(t.clientX), G.paddle.w / 2 + 4, W - G.paddle.w / 2 - 4);
}, { passive: false });

// space / click: launch stuck balls, fire lasers
function action() {
  if (G.state === "banner") G.bannerT = Math.min(G.bannerT, 0.01);
  if (G.state !== "playing" && G.state !== "banner") return;
  let launched = false;
  for (const b of G.balls) {
    if (b.stuck) {
      b.stuck = false;
      const s = ballSpeed();
      const a = -Math.PI / 2 + rand(-0.2, 0.2);
      b.vx = Math.cos(a) * s;
      b.vy = Math.sin(a) * s;
      launched = true;
    }
  }
  if (launched) snd.power();
  G.firing = true;
  setTimeout(() => (G.firing = false), 180);
  fireLasers(true);
}

function fireLasers(fromAction) {
  if (G.effects.laser <= 0) return;
  if (G.laserCd > 0 && !fromAction) return;
  G.laserCd = 0.22;
  const p = G.paddle;
  G.lasers.push({ x: p.x - p.w / 2 + 10, y: p.y - 10 }, { x: p.x + p.w / 2 - 10, y: p.y - 10 });
  snd.laser();
}

function togglePause() {
  if (G.state === "playing" || G.state === "banner") {
    G.state = "paused";
    show("paused");
  } else if (G.state === "paused") {
    G.state = "playing";
    hide("paused");
  }
  $("pauseBtn").textContent = G.state === "paused" ? "▶" : "⏸";
}

function toggleMute() {
  SFX.muted = !SFX.muted;
  document.getElementById("muteBtn").textContent = SFX.muted ? "🔇" : "🔊";
}

// ---------- UI overlays ----------
const $ = (id) => document.getElementById(id);
function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }
function hideAll() { ["menu", "paused", "over", "win"].forEach(hide); }

$("btnStart").onclick = () => { SFX.ensure(); snd.power(); hideAll(); startGame(); };
$("btnResume").onclick = () => { G.state = "playing"; hide("paused"); };
$("btnRestartP").onclick = () => { hideAll(); startGame(); };
$("btnRetry").onclick = () => { hideAll(); startGame(); };
$("btnMenuOver").onclick = () => { hideAll(); G.state = "menu"; $("menuHigh").textContent = G.best; show("menu"); };
$("btnEndless").onclick = () => {
  hideAll();
  G.endless = true;
  startLevel(G.level + 1);
};
$("btnMenuWin").onclick = () => { hideAll(); G.state = "menu"; $("menuHigh").textContent = G.best; show("menu"); };
$("muteBtn").onclick = () => { SFX.ensure(); toggleMute(); };
$("pauseBtn").onclick = () => { SFX.ensure(); togglePause(); };

$("menuHigh").textContent = G.best;

// ---------- fx spawners ----------
function burst(x, y, color, n = 14, speed = 240) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2);
    const s = rand(0.25, 1) * speed;
    G.particles.push({
      x, y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60,
      life: rand(0.35, 0.8), t: 0,
      color, size: rand(2, 5.5), hexy: Math.random() < 0.4,
    });
  }
}

function floatText(x, y, text, color = "#ffc93c") {
  G.texts.push({ x, y, text, color, t: 0, life: 0.9 });
}

// ---------- brick damage ----------
function damageBrick(brick, dmg, viaBomb) {
  if (!brick.alive) return;
  brick.hp -= dmg;
  brick.flash = 1;
  if (brick.hp <= 0) {
    destroyBrick(brick, viaBomb);
  } else {
    snd.crack();
    burst(brick.x, brick.y, BRICK_COLORS[brick.type].fill, 5, 140);
  }
}

function destroyBrick(brick, viaBomb) {
  if (!brick.alive) return;
  brick.alive = false;
  const def = BRICK_COLORS[brick.type];
  const mult = 1 + Math.floor(G.combo / 4);
  const pts = def.pts * mult;
  G.score += pts;
  if (G.score > G.best) {
    G.best = G.score;
    localStorage.setItem("hivebreak_best", G.best);
  }
  floatText(brick.x, brick.y, "+" + pts, def.fill);
  burst(brick.x, brick.y, def.fill, 16);

  if (brick.type === "b") {
    // bomb: explode, damage neighbors
    snd.boom();
    G.shake = 14;
    burst(brick.x, brick.y, "#ff7f50", 30, 420);
    burst(brick.x, brick.y, "#ffc93c", 20, 320);
    const RADIUS = HEX_W * 1.7;
    for (const other of G.bricks) {
      if (other.alive && other !== brick) {
        const d = Math.hypot(other.x - brick.x, other.y - brick.y);
        if (d < RADIUS) damageBrick(other, 99, true);
      }
    }
  } else {
    snd.brick(G.combo);
  }

  // chance to drop a powerup (not from chain explosions, keeps it sane)
  if (!viaBomb && Math.random() < 0.14) {
    const weights = [22, 18, 16, 16, 14, 6];
    let total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    let type = POWER_TYPES[0];
    for (let i = 0; i < POWER_TYPES.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { type = POWER_TYPES[i]; break; }
    }
    G.powerups.push({ x: brick.x, y: brick.y, vy: 110, type, rot: 0 });
  }
}

function applyPower(type) {
  const p = G.paddle;
  snd.power();
  floatText(p.x, p.y - 26, type.desc, type.color);
  switch (type.id) {
    case "wide": G.effects.wide = 12; p.targetW = 195; break;
    case "laser": G.effects.laser = 9; break;
    case "slow": G.effects.slow = 8; break;
    case "sticky": G.effects.sticky = 10; break;
    case "life":
      G.lives = Math.min(G.lives + 1, 6);
      break;
    case "multi": {
      if (G.balls.length >= MAX_BALLS) break; // don't flood the hive
      const src = G.balls.find((b) => !b.stuck) || G.balls[0];
      if (src) {
        const s = Math.hypot(src.vx, src.vy) || ballSpeed();
        const base = Math.atan2(src.vy, src.vx);
        for (const da of [-0.5, 0.5]) {
          if (G.balls.length >= MAX_BALLS) break;
          G.balls.push({
            x: src.x, y: src.y,
            vx: Math.cos(base + da) * s, vy: Math.sin(base + da) * s,
            r: 9, stuck: false, stickOff: 0, trail: [],
          });
        }
      }
      break;
    }
  }
}

// ---------- update ----------
function update(dt) {
  G.time += dt;
  const p = G.paddle;

  // timers
  for (const k of ["wide", "laser", "slow", "sticky"]) {
    if (G.effects[k] > 0) {
      G.effects[k] -= dt;
      if (G.effects[k] <= 0) {
        G.effects[k] = 0;
        if (k === "wide") p.targetW = 130;
      }
    }
  }
  if (G.laserCd > 0) G.laserCd -= dt;
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 40);

  // paddle size lerp
  p.w += (p.targetW - p.w) * Math.min(1, dt * 10);

  // keyboard paddle movement
  const spd = 560;
  if (keys["ArrowLeft"]) p.x -= spd * dt;
  if (keys["ArrowRight"]) p.x += spd * dt;
  p.x = clamp(p.x, p.w / 2 + 4, W - p.w / 2 - 4);

  // keep stuck balls glued to the paddle (also during the level banner)
  for (const b of G.balls) {
    if (b.stuck) {
      b.x = p.x + b.stickOff;
      b.y = p.y - p.h / 2 - b.r - 1;
      b.trail.length = 0;
    }
  }

  if (G.state !== "playing") return;

  const speedMul = (G.effects.slow > 0 ? 0.62 : 1) * rallyMul();

  // auto-fire while laser active and holding space
  if (G.effects.laser > 0 && (G.firing || keys["Space"])) fireLasers(false);

  // balls
  for (const b of G.balls) {
    if (b.stuck) continue;
    // substep movement to avoid tunneling
    const stepLen = b.r * 0.5;
    let dist = Math.hypot(b.vx, b.vy) * speedMul * dt;
    const steps = Math.max(1, Math.ceil(dist / stepLen));
    for (let s = 0; s < steps && !b.dead; s++) {
      b.x += (b.vx * speedMul * dt) / steps;
      b.y += (b.vy * speedMul * dt) / steps;

      // walls
      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); snd.bounce(); }
      if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx); snd.bounce(); }
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); snd.bounce(); }
      if (b.y > H + 40) { b.dead = true; break; }

      // paddle
      if (
        b.vy > 0 &&
        b.y + b.r >= p.y - p.h / 2 && b.y - b.r <= p.y + p.h / 2 &&
        b.x >= p.x - p.w / 2 - b.r && b.x <= p.x + p.w / 2 + b.r
      ) {
        if (G.effects.sticky > 0) {
          b.stuck = true;
          b.stickOff = clamp(b.x - p.x, -p.w / 2 + 10, p.w / 2 - 10);
          G.combo = 0;
          snd.bounce();
        } else {
          const rel = clamp((b.x - p.x) / (p.w / 2), -1, 1);
          const ang = -Math.PI / 2 + rel * (Math.PI / 3);
          const s = Math.max(Math.hypot(b.vx, b.vy), ballSpeed() * 0.9);
          b.vx = Math.cos(ang) * s;
          b.vy = Math.sin(ang) * s;
          b.y = p.y - p.h / 2 - b.r - 0.5;
          G.combo = 0;
          snd.bounce();
        }
        continue;
      }

      // bricks
      for (const brick of G.bricks) {
        if (!brick.alive) continue;
        const hit = circlePoly(b.x, b.y, b.r, hexCorners(brick.x, brick.y, brick.r));
        if (hit) {
          // push out & reflect
          b.x += hit.nx * hit.depth;
          b.y += hit.ny * hit.depth;
          const dot = b.vx * hit.nx + b.vy * hit.ny;
          if (dot < 0) {
            b.vx -= 2 * dot * hit.nx;
            b.vy -= 2 * dot * hit.ny;
          }
          // keep a minimum vertical share so the ball can't loop forever horizontally
          const sp = Math.hypot(b.vx, b.vy);
          if (sp > 0 && Math.abs(b.vy) < sp * 0.12) {
            const sign = b.vy === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(b.vy);
            b.vy = sign * sp * 0.2;
            b.vx = Math.sign(b.vx || 1) * Math.sqrt(Math.max(0, sp * sp - b.vy * b.vy));
          }
          G.combo++;
          G.rally++;
          damageBrick(brick, 1, false);
          break;
        }
      }
    }
    // trail for juice
    if (!b.dead) {
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 10) b.trail.shift();
    }
  }

  // remove dead balls / lose life
  const before = G.balls.length;
  G.balls = G.balls.filter((b) => !b.dead);
  if (G.balls.length === 0 && before > 0) {
    G.lives--;
    G.combo = 0;
    snd.lose();
    if (G.lives <= 0) {
      gameOver();
      return;
    }
    serveBall();
  }

  // lasers
  for (const l of G.lasers) l.y -= 720 * dt;
  for (const l of G.lasers) {
    for (const brick of G.bricks) {
      if (!brick.alive) continue;
      if (Math.hypot(l.x - brick.x, l.y - brick.y) < brick.r) {
        l.dead = true;
        G.combo++;
        G.rally++;
        damageBrick(brick, 1, false);
        break;
      }
    }
  }
  G.lasers = G.lasers.filter((l) => !l.dead && l.y > -20);

  // powerups fall
  for (const pu of G.powerups) {
    pu.y += pu.vy * dt;
    pu.rot += dt * 2.4;
    if (
      pu.y + 12 >= p.y - p.h / 2 && pu.y - 12 <= p.y + p.h / 2 &&
      pu.x >= p.x - p.w / 2 - 12 && pu.x <= p.x + p.w / 2 + 12
    ) {
      pu.dead = true;
      applyPower(pu.type);
    }
  }
  G.powerups = G.powerups.filter((pu) => !pu.dead && pu.y < H + 30);

  // particles & texts
  for (const pt of G.particles) {
    pt.t += dt;
    pt.vy += 620 * dt;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
  }
  G.particles = G.particles.filter((pt) => pt.t < pt.life);
  for (const tx of G.texts) { tx.t += dt; tx.y -= 46 * dt; }
  G.texts = G.texts.filter((tx) => tx.t < tx.life);

  // brick flash decay
  for (const brick of G.bricks) {
    if (brick.flash > 0) brick.flash = Math.max(0, brick.flash - dt * 4);
  }

  // level cleared?
  if (!G.bricks.some((b) => b.alive)) {
    if (!G.endless && G.level >= LEVELS.length - 1) {
      G.state = "win";
      $("winScore").textContent = G.score.toLocaleString();
      $("winBest").textContent = G.best.toLocaleString();
      snd.level();
      show("win");
    } else {
      startLevel(G.level + 1);
    }
  }
}

function gameOver() {
  G.state = "over";
  $("finalScore").textContent = G.score.toLocaleString();
  $("newBest").textContent = G.score >= G.best && G.score > 0 ? "★ NEW BEST! ★" : "";
  snd.over();
  show("over");
}

// ---------- background (pre-rendered honeycomb) ----------
const bgCanvas = document.createElement("canvas");
bgCanvas.width = W; bgCanvas.height = H;
(function drawBg() {
  const g = bgCanvas.getContext("2d");
  const grad = g.createRadialGradient(W / 2, -100, 100, W / 2, H / 2, 800);
  grad.addColorStop(0, "#241b0d");
  grad.addColorStop(1, "#0d0a06");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  g.strokeStyle = "rgba(255, 201, 60, 0.05)";
  g.lineWidth = 1.5;
  const r = 34;
  const w = Math.sqrt(3) * r, rh = 1.5 * r;
  for (let row = -1; row < H / rh + 2; row++) {
    for (let col = -1; col < W / w + 2; col++) {
      const x = col * w + (row % 2 ? w / 2 : 0);
      const y = row * rh;
      g.beginPath();
      const pts = hexCorners(x, y, r - 3);
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < 6; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.stroke();
    }
  }
})();

// ---------- draw ----------
function drawHexPath(x, y, r) {
  ctx.beginPath();
  const pts = hexCorners(x, y, r);
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < 6; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

function draw() {
  ctx.save();
  if (G.shake > 0) {
    ctx.translate(rand(-G.shake, G.shake) * 0.5, rand(-G.shake, G.shake) * 0.5);
  }

  ctx.drawImage(bgCanvas, 0, 0, W, H);

  // bricks
  for (const brick of G.bricks) {
    if (!brick.alive) continue;
    const def = BRICK_COLORS[brick.type];
    const wob = Math.sin(G.time * 2 + brick.wobble) * 1.2;
    const y = brick.y + wob;

    // glow for bombs (pulsing)
    if (brick.type === "b") {
      const pulse = 0.5 + 0.5 * Math.sin(G.time * 6 + brick.wobble);
      ctx.shadowColor = `rgba(232,65,24,${0.5 + pulse * 0.4})`;
      ctx.shadowBlur = 18 + pulse * 12;
    } else {
      ctx.shadowColor = def.glow;
      ctx.shadowBlur = 10;
    }

    // damage crack scale: darken as hp drops
    const dmg = brick.hp / brick.maxHp;
    drawHexPath(brick.x, y, brick.r);
    const grad = ctx.createLinearGradient(brick.x, y - brick.r, brick.x, y + brick.r);
    grad.addColorStop(0, def.fill);
    grad.addColorStop(1, shade(def.fill, -35));
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.shadowBlur = 0;

    if (dmg < 1) {
      ctx.fillStyle = `rgba(20, 14, 6, ${(1 - dmg) * 0.45})`;
      drawHexPath(brick.x, y, brick.r);
      ctx.fill();
    }

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = def.edge;
    drawHexPath(brick.x, y, brick.r);
    ctx.stroke();

    // inner highlight
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    drawHexPath(brick.x, y - 1.5, brick.r * 0.62);
    ctx.stroke();

    // flash on hit
    if (brick.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${brick.flash * 0.65})`;
      drawHexPath(brick.x, y, brick.r);
      ctx.fill();
    }

    // bomb icon
    if (brick.type === "b") {
      ctx.fillStyle = "#fff";
      ctx.font = "bold 17px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("✸", brick.x, y + 1);
    }
  }

  // powerups
  for (const pu of G.powerups) {
    ctx.save();
    ctx.translate(pu.x, pu.y);
    ctx.rotate(Math.sin(pu.rot) * 0.35);
    ctx.shadowColor = pu.type.color;
    ctx.shadowBlur = 14;
    drawHexPath(0, 0, 14);
    ctx.fillStyle = shade(pu.type.color, -30);
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = pu.type.color;
    drawHexPath(0, 0, 14);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(pu.type.label, 0, 1);
    ctx.restore();
  }

  // lasers
  ctx.fillStyle = "#ff5f3c";
  ctx.shadowColor = "#e84118";
  ctx.shadowBlur = 10;
  for (const l of G.lasers) {
    ctx.fillRect(l.x - 2.5, l.y - 12, 5, 16);
  }
  ctx.shadowBlur = 0;

  // paddle (hive bar)
  const p = G.paddle;
  const px = p.x - p.w / 2, py = p.y - p.h / 2;
  ctx.shadowColor = G.effects.laser > 0 ? "#e84118" : "rgba(255,201,60,.6)";
  ctx.shadowBlur = 16;
  const pgrad = ctx.createLinearGradient(0, py, 0, py + p.h);
  pgrad.addColorStop(0, "#ffd968");
  pgrad.addColorStop(0.5, "#f0a92a");
  pgrad.addColorStop(1, "#a86a10");
  ctx.fillStyle = pgrad;
  roundRect(px, py, p.w, p.h, 8);
  ctx.fill();
  ctx.shadowBlur = 0;

  // bee stripes on paddle
  ctx.fillStyle = "rgba(30, 20, 5, 0.85)";
  const stripeW = 12, gap = 22;
  for (let sx = px + 14; sx < px + p.w - 14; sx += gap) {
    roundRect(sx, py + 3, stripeW, p.h - 6, 3);
    ctx.fill();
  }
  // laser cannons
  if (G.effects.laser > 0) {
    ctx.fillStyle = "#e84118";
    ctx.fillRect(px + 6, py - 6, 8, 8);
    ctx.fillRect(px + p.w - 14, py - 6, 8, 8);
  }
  // sticky glow
  if (G.effects.sticky > 0) {
    ctx.strokeStyle = `rgba(165, 94, 234, ${0.5 + 0.4 * Math.sin(G.time * 8)})`;
    ctx.lineWidth = 3;
    roundRect(px - 2, py - 2, p.w + 4, p.h + 4, 10);
    ctx.stroke();
  }

  // balls (bees)
  for (const b of G.balls) {
    // trail
    for (let i = 0; i < b.trail.length; i++) {
      const t = b.trail[i];
      ctx.globalAlpha = ((i + 1) / b.trail.length) * 0.28;
      ctx.fillStyle = "#ffc93c";
      ctx.beginPath();
      ctx.arc(t.x, t.y, b.r * (0.25 + 0.55 * (i / b.trail.length)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.shadowColor = "#ffc93c";
    ctx.shadowBlur = 16;
    const bg = ctx.createRadialGradient(b.x - 3, b.y - 3, 1, b.x, b.y, b.r);
    bg.addColorStop(0, "#fff3c4");
    bg.addColorStop(0.6, "#ffc93c");
    bg.addColorStop(1, "#d78a10");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // stripes
    ctx.strokeStyle = "rgba(40,25,5,0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.65, -0.6, 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.65, Math.PI - 0.6, Math.PI + 0.6);
    ctx.stroke();
    // wings flutter when stuck
    if (b.stuck) {
      const fl = Math.sin(G.time * 40) * 3;
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.ellipse(b.x - 6, b.y - b.r - 3 + fl * 0.3, 5, 8, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(b.x + 6, b.y - b.r - 3 - fl * 0.3, 5, 8, 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // particles
  for (const pt of G.particles) {
    const a = 1 - pt.t / pt.life;
    ctx.globalAlpha = a;
    ctx.fillStyle = pt.color;
    if (pt.hexy) {
      drawHexPath(pt.x, pt.y, pt.size);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // floating texts
  for (const tx of G.texts) {
    const a = 1 - tx.t / tx.life;
    ctx.globalAlpha = a;
    ctx.fillStyle = tx.color;
    ctx.font = "bold 15px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(tx.text, tx.x, tx.y);
  }
  ctx.globalAlpha = 1;

  // active effect badges
  drawEffects();

  // combo multiplier indicator
  const mult = 1 + Math.floor(G.combo / 4);
  if (mult > 1 && (G.state === "playing" || G.state === "banner")) {
    const pulse = 1 + 0.06 * Math.sin(G.time * 10);
    ctx.save();
    ctx.translate(W - 20, 30);
    ctx.scale(pulse, pulse);
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffc93c";
    ctx.shadowColor = "rgba(255,201,60,.7)";
    ctx.shadowBlur = 12;
    ctx.fillText("COMBO x" + mult, 0, 0);
    ctx.shadowBlur = 0;
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "rgba(245,236,215,.65)";
    ctx.fillText(G.combo + " hits", 0, 16);
    ctx.restore();
  }

  // level banner
  if (G.state === "banner") {
    const def = LEVELS[G.level % LEVELS.length];
    const a = clamp(G.bannerT / 0.4, 0, 1);
    ctx.fillStyle = `rgba(10,7,3,${0.55 * a})`;
    ctx.fillRect(0, H / 2 - 70, W, 140);
    ctx.globalAlpha = a;
    ctx.fillStyle = "#ffc93c";
    ctx.font = "bold 42px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`LEVEL ${G.level + 1}${G.endless ? " · ENDLESS" : ""}`, W / 2, H / 2 - 8);
    ctx.fillStyle = "#f5ecd7";
    ctx.font = "20px sans-serif";
    ctx.fillText(`— ${def.name} —`, W / 2, H / 2 + 30);
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "rgba(245,236,215,.7)";
    ctx.fillText("SPACE / CLICK to launch", W / 2, H / 2 + 56);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

function drawEffects() {
  const items = [];
  if (G.effects.wide > 0) items.push(["WIDE", "#2ecc71", G.effects.wide / 12]);
  if (G.effects.laser > 0) items.push(["STINGERS", "#e84118", G.effects.laser / 9]);
  if (G.effects.slow > 0) items.push(["SLOW", "#4aa3ff", G.effects.slow / 8]);
  if (G.effects.sticky > 0) items.push(["STICKY", "#a55eea", G.effects.sticky / 10]);
  let x = 16, y = 20;
  ctx.font = "bold 11px sans-serif";
  for (const [name, color, frac] of items) {
    const w = 86;
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    roundRect(x, y, w, 22, 6);
    ctx.fill();
    ctx.fillStyle = color;
    roundRect(x + 2, y + 2, (w - 4) * clamp(frac, 0, 1), 18, 4);
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, x + w / 2, y + 12);
    x += w + 10;
  }
  ctx.textBaseline = "alphabetic";
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp((n >> 16) + amt, 0, 255);
  const g = clamp(((n >> 8) & 0xff) + amt, 0, 255);
  const b = clamp((n & 0xff) + amt, 0, 255);
  return `rgb(${r},${g},${b})`;
}

// ---------- HUD ----------
function updateHud() {
  $("score").textContent = G.score.toLocaleString();
  $("high").textContent = G.best.toLocaleString();
  $("level").textContent = G.endless ? G.level + 1 + "∞" : G.level + 1;
  $("lives").textContent = "🐝".repeat(Math.max(0, G.lives)) || "—";
}

// ---------- debug/test hook (used by headless smoke test) ----------
if (typeof window !== "undefined") {
  window.__HB = {
    get G() { return G; },
    action, damageBrick, destroyBrick, startLevel, startGame, applyPower, circlePoly, hexCorners,
  };
}

// ---------- main loop ----------
let last = performance.now();
function loop(now) {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.033));
  last = now;

  if (G.state === "banner") {
    G.bannerT -= dt;
    if (G.bannerT <= 0) G.state = "playing";
  }
  if (G.state === "playing" || G.state === "banner") {
    update(dt);
  } else if (G.state === "over" || G.state === "win") {
    // let particles finish
    for (const pt of G.particles) {
      pt.t += dt;
      pt.vy += 620 * dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
    }
    G.particles = G.particles.filter((pt) => pt.t < pt.life);
  }

  draw();
  updateHud();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
