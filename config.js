export const CONFIG = {
  title: 'Холодильная камера',
  sensorNamePrefix: 'ATC_',
  printerNamePrefix: 'B1',

  thresholdC: 4,
  windowHours: 24,
  // a report is due once per day, at the first collection in this local-time window
  printFromHour: 7,
  printToHour: 14,

  // B1: 384 dots across the head, 8 dots per mm
  widthPx: 384,
  labelType: 3, // 1 gaps, 2 black mark, 3 continuous
  density: 3, // 1..5
  feedPx: 80, // blank tail so the report clears the tear bar
  autoShutdownLevel: 4, // 1..4, 4 is the longest; 0 leaves the printer setting alone

  maxRecords: 5000,
};
