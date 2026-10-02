// Log download from a pvvx-flashed thermometer. Byte layout: docs/PROTOCOL.md.

const SERVICE = 0x1f10;
const CHARACTERISTIC = 0x1f1f;
const CMD_UTC_TIME = 0x23;
const CMD_LOGGER = 0x35;
const RECORD_LEN = 13;
const IDLE_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [0x35, idx u16, time u32, temp s16 x0.01 °C, humi u16 x0.01 %, vbat u16 mV], little endian
export function parseLogRecord(dv) {
  return {
    idx: dv.getUint16(1, true),
    time: dv.getUint32(3, true),
    temp: dv.getInt16(7, true) / 100,
    humi: dv.getUint16(9, true) / 100,
    vbat: dv.getUint16(11, true),
  };
}

async function write(ch, bytes) {
  const data = new Uint8Array(bytes);
  if (ch.writeValueWithoutResponse) {
    try {
      return await ch.writeValueWithoutResponse(data);
    } catch (e) {
      // fall through to the generic write
    }
  }
  return ch.writeValue(data);
}

const u32le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

// Must be called from a user gesture.
export async function collectLog({ namePrefix, hours, maxRecords, onProgress, showAll }) {
  // Bluefy rejects with values that carry no message, so each step names itself
  const step = (name, promise) =>
    promise.catch((e) => {
      const detail = (e && (e.message || e.name)) || (e === undefined ? 'нет описания' : String(e));
      throw new Error(`${name}: ${detail}`);
    });
  const device = await step(
    'выбор датчика',
    navigator.bluetooth.requestDevice(
      showAll
        ? { acceptAllDevices: true, optionalServices: [SERVICE] }
        : { filters: [{ namePrefix }], optionalServices: [SERVICE] },
    ),
  );
  const tStart = performance.now();
  const server = await step('подключение', device.gatt.connect());
  try {
    const service = await step('сервис 1F10', server.getPrimaryService(SERVICE));
    const ch = await step('характеристика 1F1F', service.getCharacteristic(CHARACTERISTIC));
    const connectMs = performance.now() - tStart;

    const replies = new Map();
    const records = [];
    let lastRx = performance.now();
    let ended = false;
    let cutoff = 0;
    let reachedCutoff = false;

    ch.addEventListener('characteristicvaluechanged', (e) => {
      const dv = e.target.value;
      if (!dv || !dv.byteLength) return;
      lastRx = performance.now();
      const id = dv.getUint8(0);
      if (id !== CMD_LOGGER) {
        replies.set(id, dv);
        return;
      }
      if (dv.byteLength < RECORD_LEN) {
        ended = true;
        return;
      }
      const r = parseLogRecord(dv);
      const prev = records[records.length - 1];
      records.push(r);
      // the sensor sends newest first; stop once the window is covered
      if (prev && prev.time > r.time && r.time < cutoff) reachedCutoff = true;
    });
    await step('подписка на уведомления', ch.startNotifications());

    // the sensor drops the first write after a connect and answers slowly, so reads retry
    const ask = async (bytes, tries = 3, timeoutMs = 4000) => {
      for (let i = 0; i < tries; i++) {
        replies.delete(bytes[0]);
        await write(ch, bytes);
        const until = performance.now() + timeoutMs;
        while (!replies.has(bytes[0]) && performance.now() < until) await sleep(30);
        if (replies.has(bytes[0])) return replies.get(bytes[0]);
      }
      return null;
    };

    const tm = await ask([CMD_UTC_TIME]);
    if (!tm || tm.byteLength < 5) throw new Error('датчик не ответил на запрос времени');
    const devTime = tm.getUint32(1, true);
    const nowSec = Math.floor(Date.now() / 1000);
    // the device clock may hold local time, UTC or an unset value; only its offset matters
    const offset = nowSec - devTime;
    cutoff = devTime - (hours + 1) * 3600;

    const tLog = performance.now();
    lastRx = tLog;
    await write(ch, [CMD_LOGGER, maxRecords & 0xff, (maxRecords >> 8) & 0xff]);
    while (!ended && !reachedCutoff && performance.now() - lastRx < IDLE_MS) {
      await sleep(100);
      if (onProgress) onProgress(records.length);
    }
    if (reachedCutoff) await write(ch, [CMD_LOGGER, 0, 0]);
    const logMs = performance.now() - tLog;
    if (!records.length) throw new Error('датчик не прислал записи');

    // pvvx tools keep local time in the device clock
    const local = Math.floor(Date.now() / 1000) - new Date().getTimezoneOffset() * 60;
    await ask([CMD_UTC_TIME, ...u32le(local)], 1, 3000);

    return {
      name: device.name || namePrefix,
      collectedAt: nowSec,
      clockOffset: offset,
      connectMs: Math.round(connectMs),
      logMs: Math.round(logMs),
      complete: ended || reachedCutoff,
      records: records.map((r) => ({ time: r.time + offset, temp: r.temp, humi: r.humi, vbat: r.vbat })),
    };
  } finally {
    server.disconnect();
  }
}
