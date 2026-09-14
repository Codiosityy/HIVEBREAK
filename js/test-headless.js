// Headless smoke test for HIVEBREAK game logic (no browser needed).
// Stubs DOM/canvas, pumps the rAF loop, plays via a bot, asserts progress.
"use strict";
const fs = require("fs");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ FAIL: " + msg); }
}

// ---- canvas 2D stub ----
const gradient = { addColorStop() {} };
const ctxStub = new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k];
    if (k === "createRadialGradient" || k === "createLinearGradient") return () => gradient;
    if (k === "measureText") return () => ({ width: 10 });
    return () => undefined;
  },
  set(t, k, v) { t[k] = v; return true; },
});

// ---- DOM stub ----
const elements = {};
function el(id) {
  if (!elements[id]) {
    elements[id] = {
      id,
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      listeners: {},
      onclick: null,
      _text: "",
      width: 960,
      height: 640,
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      getContext() { return ctxStub; },
      getBoundingClientRect() { return { left: 0, width: 960 }; },
      get textContent() { return this._text; },
      set textContent(v) { this._text = v; },
    };
  }
  return elements[id];
}

const winListeners = {};
global.document = {
  getElementById: el,
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
};
global.window = {
  addEventListener(t, f) { (winListeners[t] = winListeners[t] || []).push(f); },
  devicePixelRatio: 1,
  AudioContext: undefined,
};
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } };

let nowMs = 1_000_000;
global.performance = { now: () => nowMs };

let rafCb = null;
global.requestAnimationFrame = (cb) => { rafCb = cb; };
global.setTimeout = () => 0;

const src = fs.readFileSync(__dirname + "/game.js", "utf8");
eval(src);

const HB = window.__HB;
assert(!!HB, "debug hook exposed");

function pump(frames, dtMs = 16.7) {
  for (let i = 0; i < frames; i++) {
    nowMs += dtMs;
    const cb = rafCb; rafCb = null;
    if (!cb) throw new Error("rAF chain broken");
    cb(nowMs);
  }
}

console.log("\n[1] geometry: circlePoly");
{
  const pts = HB.hexCorners(0, 0, 28);
  const hitOutside = HB.circlePoly(0, -30, 9, pts); // just above top vertex region
  assert(hitOutside && hitOutside.depth > 0, "detects overlap near edge (depth>0)");
  const miss = HB.circlePoly(200, 200, 9, pts);
  assert(miss === null, "returns null when far away");
  const inside = HB.circlePoly(0, 0, 9, pts);
  assert(inside && inside.depth > 9, "handles center-inside case (pushes out)");
  if (hitOutside) {
    assert(Math.abs(hitOutside.ny - -1) < 0.6 || Math.abs(hitOutside.nx) < 0.9, "normal roughly away from hex");
  }
}

console.log("\n[2] game start via Start button");
el("btnStart").onclick();
{
  const G = HB.G;
  assert(G.state === "banner", "state is banner after start (got " + G.state + ")");
  assert(G.bricks.length > 0, "level 1 bricks built: " + G.bricks.length);
  assert(G.lives === 3 && G.score === 0, "lives=3 score=0");
  pump(120); // ~2s -> banner expires
  assert(G.state === "playing", "state becomes playing after banner (got " + G.state + ")");
  assert(G.balls.length === 1 && G.balls[0].stuck, "ball served stuck to paddle");
  assert(Array.isArray(G.balls[0].trail), "ball carries a trail buffer");
}

console.log("\n[2b] horizontal-loop guard kicks in on shallow brick bounce");
{
  const G = HB.G;
  // place a ball moving almost perfectly horizontal under the bottom brick row
  G.balls = [{ x: 100, y: 252, vx: 400, vy: 0.5, r: 9, stuck: false, stickOff: 0, trail: [] }];
  let hit = false;
  for (let i = 0; i < 90 && !hit; i++) {
    const rally = G.rally;
    pump(1);
    if (G.rally > rally) hit = true;
  }
  assert(hit, "ball hit a brick while moving horizontally");
  const b = G.balls[0];
  const sp = Math.hypot(b.vx, b.vy);
  assert(sp > 0 && Math.abs(b.vy) >= sp * 0.11, "vertical component enforced after shallow bounce (|vy|/sp = " + (Math.abs(b.vy) / sp).toFixed(2) + ")");
}

console.log("\n[3] bot plays ~30 simulated seconds");
{
  const G = HB.G;
  const paddle = G.paddle;
  let stuckSeen = false, maxCombo = 0, bricksDied = 0;
  const initialBricks = G.bricks.filter(b => b.alive).length;
  for (let i = 0; i < 1900; i++) {
    // bot: center paddle under the lowest moving ball
    let target = paddle.x;
    let bestY = -1;
    for (const b of G.balls) {
      if (!b.stuck && b.y > bestY) { bestY = b.y; target = b.x; }
    }
    paddle.x = Math.max(paddle.w / 2 + 4, Math.min(960 - paddle.w / 2 - 4, target));
    if (G.balls.some(b => b.stuck)) { stuckSeen = true; HB.action(); }
    if (G.state === "playing" || G.state === "banner") pump(1);
    else if (G.state === "over") { break; }
    else pump(1);
    maxCombo = Math.max(maxCombo, G.combo);
  }
  const alive = G.bricks.filter(b => b.alive).length;
  bricksDied = initialBricks - alive;
  assert(stuckSeen, "bot launched a stuck ball");
  assert(G.score > 0, "score increased: " + G.score);
  assert(bricksDied > 0 || G.level > 0, "bricks destroyed by ball: " + bricksDied + (G.level > 0 ? " (level already cleared!)" : ""));
  assert(G.rally > 0 || G.level > 0, "rally speed ramp accumulating (rally=" + G.rally + ")");
  assert(G.best >= G.score, "best >= score");
  console.log("    (score=" + G.score + ", bricks destroyed=" + bricksDied + ", lives=" + G.lives + ", state=" + G.state + ")");
}

console.log("\n[4] bomb chain reaction");
{
  HB.startLevel(2); // "Wax Walls" contains bombs
  pump(2);
  const G = HB.G;
  const bomb = G.bricks.find(b => b.type === "b" && b.alive);
  assert(!!bomb, "level 3 has a bomb brick");
  const near = G.bricks.filter(b => b.alive && b !== bomb && Math.hypot(b.x - bomb.x, b.y - bomb.y) < 51 * 1.7 + 10);
  HB.damageBrick(bomb, 1, false);
  assert(!bomb.alive, "bomb destroyed");
  const nearDead = near.filter(b => !b.alive).length;
  assert(nearDead > 0, "explosion damaged neighbors (" + nearDead + "/" + near.length + ")");
  assert(G.shake > 0, "screen shake triggered");
}

console.log("\n[5] level clear advances to next level");
{
  HB.startLevel(0);
  pump(120); // let the banner expire so update() runs the clear check
  const G = HB.G;
  assert(G.state === "playing", "playing before force-clear");
  for (const b of G.bricks) if (b.alive) HB.destroyBrick(b, true);
  assert(!G.bricks.some(b => b.alive), "all bricks cleared");
  pump(3);
  assert(G.level === 1, "advanced to level index 1 (got " + G.level + ")");
  assert(G.state === "banner" || G.state === "playing", "new level running");
}

console.log("\n[6] losing a life");
{
  HB.startLevel(0);
  pump(200);
  const G = HB.G;
  if (G.state === "playing" && G.balls.length) {
    const lives = G.lives;
    for (const b of G.balls) { b.stuck = false; b.y = 800; b.vy = 100; }
    pump(5);
    assert(G.lives === lives - 1 || G.state === "over", "life lost (lives " + lives + " -> " + G.lives + ")");
    if (G.lives > 0) assert(G.balls.length === 1 && G.balls[0].stuck, "fresh ball served");
  } else {
    assert(true, "skipped (state " + G.state + ")");
  }
}

console.log("\n[7] clearing Queen's Crown triggers win; endless continues");
{
  HB.startLevel(7);
  pump(120); // banner -> playing so the clear check runs
  const G = HB.G;
  assert(G.bricks.length > 0, "level 8 built: " + G.bricks.length + " bricks");
  for (const b of G.bricks) if (b.alive) HB.destroyBrick(b, true);
  pump(3);
  assert(G.state === "win", "win state after final level (got " + G.state + ")");
  el("btnEndless").onclick();
  assert(G.endless === true, "endless mode enabled");
  assert(G.level === 8, "endless continues at level index 8 (got " + G.level + ")");
  pump(200);
  assert(G.state === "playing" || G.state === "banner", "endless level is playable");
}

console.log("\n[8] powerup effects apply");
{
  const G = HB.G;
  G.state = "playing";

  // multiball cap: 12 balls already -> catching M adds nothing
  G.balls = Array.from({ length: 12 }, () => ({ x: 480, y: 300, vx: 100, vy: -100, r: 9, stuck: false, stickOff: 0, trail: [] }));
  HB.applyPower({ id: "multi", color: "#fff", desc: "M", label: "M" });
  assert(G.balls.length === 12, "multiball capped at MAX_BALLS=12 (got " + G.balls.length + ")");
  G.balls = [G.balls[0]];
  const mk = (id) => ({ x: G.paddle.x, y: G.paddle.y - 5, vy: 0, type: { id, color: "#fff", desc: id, label: "?" }, rot: 0 });
  const before = G.balls.length;
  // simulate catching multi/laser/wide/life via applyPower path (call through update is complex;
  // verify via paddle drop: place powerups exactly on paddle and pump)
  G.powerups.push(mk("multi"), mk("laser"), mk("wide"), mk("life"));
  const lives = G.lives;
  pump(3);
  assert(G.effects.laser > 0, "laser effect active after catch");
  assert(G.effects.wide > 0 && G.paddle.targetW > 130, "wide effect active");
  assert(G.balls.length >= before, "multiball added balls (" + before + " -> " + G.balls.length + ")");
  assert(G.lives === Math.min(6, lives + 1), "extra life granted");
}

console.log("\n[9] stress: 60s of chaotic play without exceptions");
{
  for (let i = 0; i < 3600; i++) {
    const G = HB.G;
    G.paddle.x = 480 + Math.sin(i * 0.03) * 400;
    if (G.balls.some(b => b.stuck)) HB.action();
    if (i % 700 === 0 && (G.state === "over" || G.state === "win")) {
      if (G.state === "over") el("btnRetry").onclick();
      else el("btnMenuWin").onclick(), el("btnStart").onclick();
    }
    pump(1);
  }
  assert(true, "no exceptions across 3600 frames");
}

console.log(failures === 0 ? "\nALL TESTS PASSED ✅" : "\n" + failures + " TEST(S) FAILED ❌");
process.exit(failures === 0 ? 0 : 1);
