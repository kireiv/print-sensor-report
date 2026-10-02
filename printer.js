// NIIMBOT B1 printing through vendored nblib. Packet sequence: docs/PROTOCOL.md.

import { buildPage, imageDataToRows, printJob, encodePacket } from './vendor/nblib/index.js';
import { connect } from './vendor/nblib/web-bluetooth.js';

const CMD_SET_AUTO_SHUTDOWN = 0x27;
const RESP_SET_AUTO_SHUTDOWN = 0x37;
const RESP_PRINT_ERROR = 0xdb;
const RESP_NOT_SUPPORTED = 0x00;
const CONNECT_TIMEOUT_MS = 25000;

const timeout = (ms, message) => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

// Must be called from a user gesture.
export async function printCanvas(canvas, cfg, onProgress) {
  const link = await Promise.race([
    connect({ namePrefix: cfg.printerNamePrefix }),
    timeout(CONNECT_TIMEOUT_MS, 'принтер не ответил. Включить принтер кнопкой и повторить'),
  ]);
  try {
    let shutdown = 'не менялось';
    if (cfg.autoShutdownLevel) {
      await link.send(encodePacket(CMD_SET_AUTO_SHUTDOWN, [cfg.autoShutdownLevel]));
      const reply = await link.receive([RESP_SET_AUTO_SHUTDOWN, RESP_PRINT_ERROR, RESP_NOT_SUPPORTED], 1000);
      shutdown = reply && reply.cmd === RESP_SET_AUTO_SHUTDOWN ? 'принято' : 'отклонено';
    }

    const ctx = canvas.getContext('2d');
    const rows = imageDataToRows(ctx.getImageData(0, 0, canvas.width, canvas.height));
    const page = buildPage(rows, { direction: 'top', align: 'left' });
    await printJob(link, [() => Promise.resolve(page)], {
      density: cfg.density,
      labelType: cfg.labelType,
      pageTimeoutMs: 10000,
      statusTimeoutMs: 30000,
      onProgress,
    });
    return { printer: link.deviceName, shutdown, bytes: page.data.length };
  } finally {
    link.disconnect();
  }
}
