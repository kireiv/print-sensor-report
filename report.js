// Pure statistics over log records. No DOM, no BLE: ports to C as is.
// A record is {time: unix seconds, temp: °C, humi: %, vbat: mV}.

export function median(values) {
  const a = values.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function computeReport(records, nowSec, opt) {
  const from = nowSec - opt.windowHours * 3600;
  const sorted = records
    .filter((r) => r.time > from && r.time <= nowSec + 120)
    .sort((a, b) => a.time - b.time);
  const s = sorted.filter((r, i) => i === 0 || r.time !== sorted[i - 1].time);
  if (!s.length) return null;

  const deltas = [];
  for (let i = 1; i < s.length; i++) deltas.push(s[i].time - s[i - 1].time);
  const stepSec = deltas.length ? median(deltas) : 600;

  let tMin = s[0], tMax = s[0], hMin = s[0], hMax = s[0];
  let aboveSec = 0;
  for (let i = 0; i < s.length; i++) {
    const r = s[i];
    if (r.temp < tMin.temp) tMin = r;
    if (r.temp > tMax.temp) tMax = r;
    if (r.humi < hMin.humi) hMin = r;
    if (r.humi > hMax.humi) hMax = r;
    // the sensor stores the average over the step that ends at r.time
    const dt = i ? Math.min(r.time - s[i - 1].time, 2 * stepSec) : stepSec;
    if (r.temp > opt.thresholdC) aboveSec += dt;
  }

  return {
    from,
    to: nowSec,
    first: s[0].time,
    last: s[s.length - 1].time,
    count: s.length,
    stepSec,
    tMin: tMin.temp,
    tMinAt: tMin.time,
    tMax: tMax.temp,
    tMaxAt: tMax.time,
    hMin: hMin.humi,
    hMax: hMax.humi,
    minutesAbove: Math.round(aboveSec / 60),
    vbat: s[s.length - 1].vbat,
    series: s,
  };
}

// True when a report is due: inside the morning window and not printed today.
export function isReportDue(now, lastPrintedDay, opt) {
  const h = now.getHours();
  return h >= opt.printFromHour && h < opt.printToHour && lastPrintedDay !== dayKey(now);
}

export function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
