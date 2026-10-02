// Draws the report on a 2D canvas context, black on white, for a 1-bit printer.
// Only fillRect and fillText are used, so the layout ports to a bitmap font renderer.

const FONT = 'Helvetica, Arial, sans-serif';
const BODY_HEIGHT = 770;

export function reportHeight(cfg) {
  return BODY_HEIGHT + cfg.feedPx;
}

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (sec) => {
  const d = new Date(sec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const ddmm = (sec) => {
  const d = new Date(sec * 1000);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
};
const stamp = (sec) => `${ddmm(sec)} ${hhmm(sec)}`;

export function render(ctx, report, cfg) {
  const W = cfg.widthPx;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, reportHeight(cfg));
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  const text = (str, x, y, size, opt = {}) => {
    ctx.font = `${opt.bold ? 'bold ' : ''}${size}px ${FONT}`;
    ctx.textAlign = opt.align || 'left';
    ctx.fillText(str, x, y);
  };
  const rect = (x, y, w, h) => ctx.fillRect(Math.round(x), Math.round(y), w, h);
  const hdots = (x0, x1, y, on, off, thick = 1) => {
    for (let x = x0; x < x1; x += on + off) rect(x, y, Math.min(on, x1 - x), thick);
  };
  const vdots = (x, y0, y1, on, off) => {
    for (let y = y0; y < y1; y += on + off) rect(x, y, 1, Math.min(on, y1 - y));
  };
  const line = (x0, y0, x1, y1) => {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      rect(x0, y0, 2, 2);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };

  const graph = (key, top, height, threshold) => {
    const left = 46, right = W - 8, plotTop = top + 8, bottom = top + height - 26;
    const s = report.series;
    let min = Infinity, max = -Infinity;
    for (const r of s) { min = Math.min(min, r[key]); max = Math.max(max, r[key]); }
    if (threshold !== undefined) { min = Math.min(min, threshold); max = Math.max(max, threshold); }
    const margin = Math.max(0.5, (max - min) * 0.1);
    const step = [0.5, 1, 2, 5, 10, 20, 50].find((v) => (max - min + 2 * margin) / v <= 6) || 100;
    const lo = Math.floor((min - margin) / step) * step;
    const hi = Math.ceil((max + margin) / step) * step;
    const X = (t) => left + ((t - report.from) / (report.to - report.from)) * (right - left);
    const Y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - plotTop);

    rect(left, plotTop, 1, bottom - plotTop);
    rect(left, bottom, right - left, 1);
    for (let v = lo; v <= hi + 1e-9; v += step) {
      const y = Y(v);
      if (v > lo) hdots(left + 1, right, y, 1, 5);
      text(v.toFixed(step < 1 ? 1 : 0), left - 5, y - 9, 18, { align: 'right' });
    }

    const tick = new Date(report.from * 1000);
    tick.setMinutes(0, 0, 0);
    while (tick.getHours() % 6 !== 0 || tick.getTime() / 1000 < report.from) tick.setHours(tick.getHours() + 1);
    for (; tick.getTime() / 1000 <= report.to; tick.setHours(tick.getHours() + 6)) {
      const x = Math.round(X(tick.getTime() / 1000));
      vdots(x, plotTop, bottom, 1, 5);
      rect(x, bottom, 1, 5);
      const lx = Math.min(Math.max(x, left + 22), right - 24);
      text(`${pad2(tick.getHours())}:00`, lx, bottom + 7, 18, { align: 'center' });
    }

    if (threshold !== undefined) hdots(left + 1, right, Y(threshold) - 1, 6, 4, 2);

    for (let i = 0; i < s.length; i++) {
      const x = X(s[i].time), y = Y(s[i][key]);
      if (i && s[i].time - s[i - 1].time <= 2.5 * report.stepSec) {
        line(X(s[i - 1].time), Y(s[i - 1][key]), x, y);
      } else {
        rect(x, y, 2, 2);
      }
    }
  };

  text(cfg.title, W / 2, 6, 28, { bold: true, align: 'center' });
  text(`${stamp(report.from)} – ${stamp(report.to)}`, W / 2, 42, 20, { align: 'center' });
  rect(0, 70, W, 2);

  text('Температура, °C', 4, 80, 22, { bold: true });
  text(`мин ${report.tMin.toFixed(1)}   макс ${report.tMax.toFixed(1)}`, 4, 108, 22);
  text(`Выше ${cfg.thresholdC} °C: ${report.minutesAbove} мин`, 4, 136, 24, { bold: true });
  graph('temp', 170, 280, cfg.thresholdC);
  rect(0, 460, W, 2);

  text('Влажность, %', 4, 470, 22, { bold: true });
  text(`мин ${report.hMin.toFixed(0)}   макс ${report.hMax.toFixed(0)}`, 4, 498, 22);
  graph('humi', 530, 180);

  const partial = report.first - report.from > 2 * report.stepSec;
  text(
    partial ? `Данные с ${stamp(report.first)}, шаг ${Math.round(report.stepSec)} с` : `Записей ${report.count}, шаг ${Math.round(report.stepSec)} с`,
    4, 722, 18, { bold: true },
  );
  text(`Батарея ${(report.vbat / 1000).toFixed(2)} В. Печать ${stamp(Date.now() / 1000)}`, 4, 744, 18, { bold: true });
}
