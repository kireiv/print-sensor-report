import { CONFIG } from './config.js';
import { collectLog } from './sensor.js';
import { computeReport, isReportDue, dayKey } from './report.js';
import { render, reportHeight } from './render.js';
import { printCanvas } from './printer.js';

const LOG_KEY = 'fridge.log';
const PRINTED_KEY = 'fridge.printedDay';
const params = new URLSearchParams(location.search);
const demo = params.has('demo');
const showAll = params.has('all');

const $ = (id) => document.getElementById(id);
const canvas = $('preview');
const status = (msg, kind = '') => {
  $('status').textContent = msg;
  $('status').className = kind;
};

const load = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch (e) {
    return null;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // private mode: the page still works until it is closed
  }
};

let log = load(LOG_KEY);
let printedDay = load(PRINTED_KEY);

function demoLog() {
  const now = Math.floor(Date.now() / 1000);
  const records = [];
  for (let t = now - 26 * 3600; t <= now; t += 60) {
    const h = (now - t) / 3600;
    const defrost = h > 9 && h < 9.6 ? 2.8 * Math.sin(((h - 9) / 0.6) * Math.PI) : 0;
    records.push({
      time: t,
      temp: 2.6 + 0.7 * Math.sin(t / 900) + defrost,
      humi: 72 + 9 * Math.sin(t / 2100) + defrost * 3,
      vbat: 2950,
    });
  }
  return { name: 'ATC_DEMO', collectedAt: now, connectMs: 0, logMs: 0, complete: true, records };
}

function show() {
  const hasBt = !!navigator.bluetooth;
  $('collect').disabled = !hasBt && !demo;
  $('print').disabled = !log || !hasBt;
  if (!log) {
    canvas.hidden = true;
    return null;
  }
  const report = computeReport(log.records, log.collectedAt, CONFIG);
  if (!report) {
    canvas.hidden = true;
    status('В журнале датчика нет записей за последние сутки.', 'bad');
    return null;
  }
  canvas.width = CONFIG.widthPx;
  canvas.height = reportHeight(CONFIG);
  render(canvas.getContext('2d'), report, CONFIG);
  canvas.hidden = false;
  $('print').classList.toggle('due', isReportDue(new Date(), printedDay, CONFIG));
  return report;
}

$('collect').addEventListener('click', async () => {
  $('collect').disabled = true;
  try {
    status('Подключение к датчику…');
    log = demo
      ? demoLog()
      : await collectLog({
          namePrefix: CONFIG.sensorNamePrefix,
          hours: CONFIG.windowHours,
          maxRecords: CONFIG.maxRecords,
          showAll,
          onProgress: (n) => status(`Чтение журнала: ${n} записей…`),
        });
    save(LOG_KEY, log);
    const report = show();
    if (!report) return;
    const link = `Связь ${(log.connectMs / 1000).toFixed(1)} с, чтение ${(log.logMs / 1000).toFixed(1)} с, записей ${log.records.length}.`;
    const step = report.stepSec > 120 ? ` Шаг записи ${Math.round(report.stepSec)} с. Для точного счёта минут установить 60 с.` : '';
    const due = isReportDue(new Date(), printedDay, CONFIG);
    status(
      (due ? 'Отчёт за смену готов. Перейти к принтеру и нажать «Печать». ' : 'Данные сохранены. ') + link + step,
      log.complete ? 'ok' : 'bad',
    );
  } catch (e) {
    status(`Ошибка датчика: ${(e && e.message) || String(e)}`, 'bad');
  } finally {
    show();
  }
});

$('print').addEventListener('click', async () => {
  $('print').disabled = true;
  try {
    status('Подключение к принтеру…');
    const res = await printCanvas(canvas, CONFIG, () => status('Печать…'));
    printedDay = dayKey(new Date());
    save(PRINTED_KEY, printedDay);
    status(`Отчёт напечатан на ${res.printer}. Автоотключение: ${res.shutdown}.`, 'ok');
  } catch (e) {
    status(`Ошибка принтера: ${(e && e.message) || String(e)}`, 'bad');
  } finally {
    show();
  }
});

if (!navigator.bluetooth && !demo) {
  status('Браузер не поддерживает Bluetooth. Открыть страницу в Bluefy.', 'bad');
} else if (log) {
  const d = new Date(log.collectedAt * 1000);
  status(`Сохранённые данные от ${d.toLocaleString('ru-RU')}.` + (printedDay === dayKey(new Date()) ? ' Отчёт сегодня напечатан.' : ''));
} else {
  status('Данных нет. Подойти к датчику и нажать «Собрать».');
}
show();
