// Rotating "digital earth" for the boot screen: a sphere of glowing dots with
// continent-like clusters, dotted orbit rings, and gold data spikes linked by
// network arcs.

const TEAL = [64, 220, 230];
const GOLD = [255, 190, 60];
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;

// Smooth 3D value noise; thresholded, it gives blobby "landmasses" on the sphere.
function hash(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(x - xi), v = s(y - yi), w = s(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}
// Low-frequency noise dominates so land forms a few large continents, with detail on the coasts.
const landness = (x, y, z) => noise(x * 1.1 + 7, y * 1.1 + 3, z * 1.1 + 11) * 0.75 + noise(x * 3.5 + 1, y * 3.5 + 5, z * 3.5 + 9) * 0.25;
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));

export class Globe {
  constructor(canvas, { dots = 6500, landShare = 0.36 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.running = false;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // Evenly spread points (Fibonacci sphere); the top `landShare` by landness become land.
    this.points = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let k = 0; k < dots; k++) {
      const y = 1 - (k / (dots - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = golden * k;
      const x = Math.cos(th) * r, z = Math.sin(th) * r;
      this.points.push({ x, y, z, l: landness(x, y, z), tw: (k * 2.399) % (Math.PI * 2) });
    }
    const cut = this.points.map((p) => p.l).sort((a, b) => b - a)[Math.floor(dots * landShare)];
    for (const p of this.points) p.land = p.l >= cut;

    // Gold data spikes clustered in three "hubs" on land, like city lights.
    const landPts = this.points.filter((p) => p.land);
    const hubs = [landPts[Math.floor(landPts.length * 0.2)], landPts[Math.floor(landPts.length * 0.5)], landPts[Math.floor(landPts.length * 0.8)]];
    this.spikes = [];
    hubs.forEach((hub, h) => {
      const near = landPts.filter((p) => angle(p, hub) < 0.32);
      for (let k = 0; k < 9 && near.length; k++) {
        const p = near[(k * 53 + h * 17) % near.length];
        this.spikes.push({ x: p.x, y: p.y, z: p.z, len: 0.08 + ((k * 37 + h * 11) % 10) / 28, phase: k * 0.9 + h });
      }
    });
    // Link each spike to its nearest neighbours only, so arcs stay short and hug the surface.
    this.links = [];
    for (const a of this.spikes) {
      const nearest = this.spikes.filter((b) => b !== a).sort((b, c) => angle(a, b) - angle(a, c)).slice(0, 2);
      for (const b of nearest) if (angle(a, b) < 0.9 && !this.links.some(([x, y]) => x === b && y === a)) this.links.push([a, b]);
    }
    this.rings = [
      { tilt: 0.35, yaw: 0.2, r: 1.32, n: 140, speed: 0.25 },
      { tilt: -0.55, yaw: 1.1, r: 1.48, n: 170, speed: -0.18 },
      { tilt: 1.1, yaw: -0.6, r: 1.62, n: 200, speed: 0.12 },
    ];
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (ts) => {
      if (!this.running) return;
      this.draw(ts / 1000);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  // Rotate a unit-sphere point by the globe's spin and axial tilt.
  project(p, spin, tilt) {
    const cs = Math.cos(spin), sn = Math.sin(spin);
    const x = p.x * cs + p.z * sn;
    const z = -p.x * sn + p.z * cs;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    return { x, y: p.y * ct - z * st, z: p.y * st + z * ct };
  }

  draw(time) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const t = this.reduced ? 0 : time;
    // Leave the lower third of the screen for the boot text.
    const R = Math.min(w * 0.36, h * 0.27);
    const cx = w / 2, cy = h * 0.36;
    const spin = t * 0.18;
    const tilt = 0.4;
    const P = (p) => this.project(p, spin, tilt);
    const sx = (q) => cx + q.x * R;
    const sy = (q) => cy - q.y * R;

    // Atmosphere glow
    const glow = ctx.createRadialGradient(cx, cy, R * 0.85, cx, cy, R * 1.35);
    glow.addColorStop(0, rgba(TEAL, 0.28));
    glow.addColorStop(1, rgba(TEAL, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.35, 0, Math.PI * 2);
    ctx.fill();

    const ringPoints = (ring, back) => {
      for (let k = 0; k < ring.n; k++) {
        if (k % 6 === 5) continue; // dashed look
        const a = (k / ring.n) * Math.PI * 2 + t * ring.speed;
        const p = { x: Math.cos(a) * ring.r, y: 0, z: Math.sin(a) * ring.r };
        // tilt the ring plane, then yaw it
        const ct = Math.cos(ring.tilt), st = Math.sin(ring.tilt);
        const q0 = { x: p.x, y: p.y * ct - p.z * st, z: p.y * st + p.z * ct };
        const cy2 = Math.cos(ring.yaw), sy2 = Math.sin(ring.yaw);
        const q = { x: q0.x * cy2 + q0.z * sy2, y: q0.y, z: -q0.x * sy2 + q0.z * cy2 };
        if (back !== q.z < 0) continue;
        if (back && q.x * q.x + q.y * q.y < 1) continue; // hidden behind the planet
        ctx.fillStyle = rgba([210, 255, 250], back ? 0.18 : 0.55);
        ctx.fillRect(cx + q.x * R, cy - q.y * R, 1.6, 1.6);
      }
    };
    for (const ring of this.rings) ringPoints(ring, true);

    // Planet disc
    const body = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R);
    body.addColorStop(0, 'rgba(10,60,80,0.9)');
    body.addColorStop(1, 'rgba(2,14,24,0.95)');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // Dots, lit on the front hemisphere
    for (const p of this.points) {
      const q = P(p);
      if (q.z < -0.05) continue;
      const depth = 0.35 + 0.65 * q.z;
      const twinkle = 0.75 + 0.25 * Math.sin(t * 3 + p.tw);
      if (p.land) {
        ctx.fillStyle = rgba([225, 255, 255], Math.min(1, 1.2 * depth * twinkle));
        const s = 1.6 + 1.4 * depth;
        ctx.fillRect(sx(q) - s / 2, sy(q) - s / 2, s, s);
      } else {
        ctx.fillStyle = rgba(TEAL, 0.22 * depth);
        ctx.fillRect(sx(q) - 0.5, sy(q) - 0.5, 1, 1);
      }
    }

    // Rim light
    ctx.strokeStyle = rgba(TEAL, 0.55);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // Network arcs between nearby gold nodes, raised slightly off the surface;
    // only the parts on the visible hemisphere are drawn.
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = rgba(GOLD, 0.55);
    for (const [a, b] of this.links) {
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k <= 20; k++) {
        const f = k / 20;
        const m = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
        const lift = (1 + 0.12 * Math.sin(Math.PI * f)) / (Math.hypot(m.x, m.y, m.z) || 1);
        const q = P({ x: m.x * lift, y: m.y * lift, z: m.z * lift });
        if (q.z < 0.02) { pen = false; continue; }
        if (!pen) { ctx.moveTo(sx(q), sy(q)); pen = true; } else ctx.lineTo(sx(q), sy(q));
      }
      ctx.stroke();
    }

    // Gold data spikes with glowing base nodes
    ctx.shadowColor = rgba(GOLD, 0.9);
    for (const s of this.spikes) {
      const base = P(s);
      if (base.z < 0.05) continue;
      const len = s.len * (0.6 + 0.4 * Math.sin(t * 2 + s.phase));
      const tip = P({ x: s.x * (1 + len), y: s.y * (1 + len), z: s.z * (1 + len) });
      ctx.shadowBlur = 10;
      ctx.strokeStyle = rgba(GOLD, 0.95);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx(base), sy(base));
      ctx.lineTo(sx(tip), sy(tip));
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(sx(base), sy(base), 3 + 1.5 * Math.sin(t * 4 + s.phase), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    for (const ring of this.rings) ringPoints(ring, false);
  }
}
