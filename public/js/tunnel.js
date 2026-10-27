// Binary wormhole backdrop: cyan and magenta 0s and 1s spiral out of a dark
// centre toward the viewer, with an occasional electric-blue spark.

const CYAN = [64, 220, 255];
const MAGENTA = [255, 60, 200];
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;

export class Tunnel {
  constructor(canvas, { count = 520, fps = 30 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.frameMs = 1000 / fps;
    this.last = 0;
    this.running = false;
    this.visible = true;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.bits = Array.from({ length: count }, (_, k) => this.spawn(k, true));
    this.sparks = [];

    // Don't spend CPU on the animation while it's scrolled away or the tab is hidden.
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; }).observe(canvas);
    }
  }

  spawn(k = 0, anywhere = false) {
    return {
      angle: Math.random() * Math.PI * 2,
      z: anywhere ? 0.15 + Math.random() * 2.85 : 3,
      spin: 0.25 + Math.random() * 0.35,
      text: Math.random() < 0.55 ? (Math.random() < 0.5 ? '0' : '1') : Array.from({ length: 2 + (k % 3) }, () => (Math.random() < 0.5 ? '0' : '1')).join(''),
      color: Math.random() < 0.55 ? CYAN : MAGENTA,
      flip: Math.random() < 0.5,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (this.reduced) { this.draw(0, 0); return; }
    const loop = (ts) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      if (!this.visible || document.hidden || ts - this.last < this.frameMs) return;
      const dt = this.last ? Math.min(0.1, (ts - this.last) / 1000) : 0;
      this.last = ts;
      this.draw(ts / 1000, dt);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  draw(time, dt) {
    const { canvas, ctx } = this;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w * 0.5, cy = h * 0.5;
    const scale = Math.max(w, h) * 0.16;

    // Depth haze toward the centre of the tunnel
    const haze = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.6);
    haze.addColorStop(0, 'rgba(0,0,0,0.95)');
    haze.addColorStop(0.18, 'rgba(10,8,40,0.6)');
    haze.addColorStop(1, 'rgba(10,8,40,0)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Far bits first so near ones overlap them.
    this.bits.sort((a, b) => b.z - a.z);
    for (let k = 0; k < this.bits.length; k++) {
      const b = this.bits[k];
      b.z -= dt * 0.55;
      b.angle += dt * b.spin * (1.4 / (b.z + 0.4));
      if (b.z <= 0.12) { this.bits[k] = this.spawn(k); continue; }
      const r = scale / b.z;
      const x = cx + Math.cos(b.angle) * r;
      const y = cy + Math.sin(b.angle) * r * 0.92;
      if (x < -40 || x > w + 40 || y < -40 || y > h + 40) continue;
      const size = Math.min(34, 7 / b.z + 4);
      const alpha = Math.min(0.9, (3 - b.z) / 2.2) * (b.z < 0.35 ? b.z / 0.35 : 1);
      ctx.save();
      ctx.translate(x, y);
      // Characters lie along the tunnel wall, rotated to follow the spiral.
      ctx.rotate(b.angle + (b.flip ? Math.PI / 2 : -Math.PI / 2));
      ctx.font = `600 ${size.toFixed(1)}px JetBrains Mono, monospace`;
      ctx.fillStyle = rgba(b.color, alpha);
      ctx.fillText(b.text, 0, 0);
      ctx.restore();
    }

    // Electric-blue spark crawling along the tunnel wall now and then.
    if (Math.random() < dt * 0.8 && this.sparks.length < 2) {
      this.sparks.push({ angle: Math.random() * Math.PI * 2, z: 1.2 + Math.random(), life: 1 });
    }
    ctx.shadowColor = 'rgba(90,140,255,1)';
    ctx.shadowBlur = 18;
    ctx.lineWidth = 2;
    for (const s of this.sparks) {
      s.life -= dt * 1.4;
      s.angle += dt * 0.6;
      const r = scale / s.z;
      const x0 = cx + Math.cos(s.angle) * r, y0 = cy + Math.sin(s.angle) * r * 0.92;
      ctx.strokeStyle = `rgba(150,190,255,${Math.max(0, s.life)})`;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      for (let j = 1; j <= 6; j++) {
        ctx.lineTo(x0 + (Math.random() - 0.5) * 22, y0 + (Math.random() - 0.5) * 22);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    this.sparks = this.sparks.filter((s) => s.life > 0);
  }
}
