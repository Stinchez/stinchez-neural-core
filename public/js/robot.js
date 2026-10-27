// Animated "robot mind": rotating sensor rings, a radar sweep, the markets
// orbiting the core, and a robot face whose colour shows its current mood.

const MOOD = {
  idle: { core: '#00e5ff', glow: 'rgba(0,229,255,0.32)', rgb: '0,229,255', label: 'SCANNING' },
  wait: { core: '#ffc53d', glow: 'rgba(255,197,61,0.36)', rgb: '255,197,61', label: 'TARGET ARMED' },
  go: { core: '#39ff88', glow: 'rgba(57,255,136,0.45)', rgb: '57,255,136', label: 'READY' },
};
const MAGENTA = '#ff2bd6';

export class RobotMind {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mood = 'idle';
    this.nodes = []; // { id, label, score }
    this.focus = null;
    this.t = 0;
    this.blink = 0;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const loop = (ts) => {
      this.draw(ts / 1000);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setMarkets(nodes, focus) {
    this.nodes = nodes;
    this.focus = focus;
  }

  setMood(mood) {
    this.mood = MOOD[mood] ? mood : 'idle';
  }

  draw(time) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth || 300;
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.shadowBlur = 0;
    const speed = this.reduced ? 0.15 : 1;
    const t = time * speed;
    const c = size / 2;
    const mood = MOOD[this.mood];
    const R = size * 0.46;

    // Glow
    const g = ctx.createRadialGradient(c, c, R * 0.1, c, c, R);
    g.addColorStop(0, mood.glow);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    // Outer tick ring (clockwise)
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(t * 0.25);
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      const long = k % 6 === 0;
      ctx.strokeStyle = long ? mood.core : 'rgba(138,152,168,0.45)';
      ctx.lineWidth = long ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.94, Math.sin(a) * R * 0.94);
      ctx.lineTo(Math.cos(a) * R * (long ? 0.86 : 0.9), Math.sin(a) * R * (long ? 0.86 : 0.9));
      ctx.stroke();
    }
    ctx.restore();

    // Middle segmented ring (counter-clockwise)
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(-t * 0.8);
    ctx.lineWidth = 3;
    for (let k = 0; k < 6; k++) {
      ctx.strokeStyle = k % 2 ? 'rgba(255,43,214,0.75)' : mood.core;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.62, (k / 6) * Math.PI * 2, (k / 6) * Math.PI * 2 + 0.6);
      ctx.stroke();
    }
    ctx.restore();

    // Inner fast ring
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(t * 1.6);
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(230,237,243,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Radar sweep
    const sweep = (t * 1.2) % (Math.PI * 2);
    ctx.save();
    ctx.translate(c, c);
    for (let k = 0; k < 24; k++) {
      ctx.fillStyle = `rgba(${mood.rgb},${0.16 * (1 - k / 24)})`;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R * 0.8, sweep - (k + 1) * 0.03, sweep - k * 0.03);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Orbiting markets (slow rotation)
    const n = this.nodes.length;
    const orbit = R * 0.78;
    const spin = t * 0.08;
    ctx.font = `600 ${Math.max(9, size * 0.032)}px JetBrains Mono, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.nodes.forEach((node, k) => {
      const a = spin + (k / n) * Math.PI * 2 - Math.PI / 2;
      const x = c + Math.cos(a) * orbit;
      const y = c + Math.sin(a) * orbit;
      const focused = node.id === this.focus;
      // Light up nodes the radar beam has just passed over.
      const behind = (((sweep - a) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const swept = behind < 0.7;
      if (focused) {
        ctx.strokeStyle = mood.core;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const r = 4 + Math.min(1.5, node.score ?? 0) * 5 + (focused ? 3 : 0);
      ctx.fillStyle = node.ready ? '#22c55e' : focused ? mood.core : swept ? '#e6edf3' : 'rgba(138,152,168,0.8)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (node.ready || focused) {
        ctx.strokeStyle = node.ready ? '#22c55e' : mood.core;
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(time * 4);
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (node.best) {
        // Rotating target-lock brackets on the self-scan's best market.
        const s = r + 9;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(time * 1.5);
        ctx.strokeStyle = MAGENTA;
        ctx.lineWidth = 2;
        ctx.shadowColor = MAGENTA;
        ctx.shadowBlur = 8;
        for (let q = 0; q < 4; q++) {
          ctx.rotate(Math.PI / 2);
          ctx.beginPath();
          ctx.moveTo(s, s - 5);
          ctx.lineTo(s, s);
          ctx.lineTo(s - 5, s);
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.fillStyle = node.best ? MAGENTA : focused ? '#d9f7ff' : 'rgba(108,138,163,0.95)';
      const ly = y + (Math.sin(a) > 0 ? r + 14 : -r - 14);
      ctx.fillText(node.label, x, ly);
    });

    // Robot head
    const hw = R * 0.42, hh = R * 0.34;
    const bob = this.reduced ? 0 : Math.sin(time * 2) * 2;
    ctx.save();
    ctx.translate(c, c + bob);
    ctx.fillStyle = '#071423';
    ctx.strokeStyle = mood.core;
    ctx.lineWidth = 2;
    roundRect(ctx, -hw / 2, -hh / 2, hw, hh, 10);
    ctx.fill();
    ctx.stroke();
    // antenna
    ctx.beginPath();
    ctx.moveTo(0, -hh / 2);
    ctx.lineTo(0, -hh / 2 - 12);
    ctx.stroke();
    ctx.fillStyle = mood.core;
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(time * 6);
    ctx.beginPath();
    ctx.arc(0, -hh / 2 - 15, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // eyes: scan left-right, blink now and then
    const blinking = (time % 4) < 0.12;
    const look = this.reduced ? 0 : Math.sin(time * 1.3) * hw * 0.06;
    const eyeH = blinking ? 1.5 : hh * 0.18;
    ctx.fillStyle = mood.core;
    ctx.shadowColor = mood.core;
    ctx.shadowBlur = 12;
    for (const ex of [-hw * 0.2, hw * 0.2]) {
      roundRect(ctx, ex - hw * 0.09 + look, -hh * 0.12 - eyeH / 2, hw * 0.18, eyeH, 3);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    // mouth: equaliser bars
    const bars = 7;
    for (let k = 0; k < bars; k++) {
      const h = (this.reduced ? 0.5 : 0.35 + 0.65 * Math.abs(Math.sin(time * 5 + k))) * hh * 0.16;
      ctx.fillRect(-hw * 0.28 + k * (hw * 0.56 / bars), hh * 0.28 - h, hw * 0.05, h);
    }
    ctx.restore();

    // Mood label
    ctx.fillStyle = mood.core;
    ctx.shadowColor = mood.core;
    ctx.shadowBlur = 10;
    ctx.font = `700 ${Math.max(10, size * 0.038)}px Orbitron, JetBrains Mono, monospace`;
    ctx.fillText(mood.label, c, c + hh / 2 + 22 + bob);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
