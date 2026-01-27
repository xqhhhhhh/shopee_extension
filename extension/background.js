const BATCH_TIMEOUT_MS = 45000;
const MAX_CONCURRENCY = 10;
const DAILY_ALARM_NAME = 'daily-crawl';
const DEFAULT_SCHEDULE_TIME = '02:00';
const DEFAULT_CATEGORY_URL = '';
const MAX_DAILY_DAYS = 120;

let queue = [];
let results = [];
let running = false;
let paused = false;
let concurrency = 3;
let pendingDailyRun = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return 1;
  return Math.min(MAX_CONCURRENCY, Math.max(1, parsed));
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (items) => resolve(items || {}));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

function toYmd(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseScheduleTime(timeText) {
  if (!timeText || !/^\d{2}:\d{2}$/.test(timeText)) return { hours: 2, minutes: 0 };
  const [hoursStr, minutesStr] = timeText.split(':');
  const hours = Math.min(23, Math.max(0, Number.parseInt(hoursStr, 10)));
  const minutes = Math.min(59, Math.max(0, Number.parseInt(minutesStr, 10)));
  return { hours, minutes };
}

function nextRunAt(timeText) {
  const now = new Date();
  const { hours, minutes } = parseScheduleTime(timeText);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

async function loadConfig() {
  const data = await storageGet([
    'scheduleTime',
    'categoryUrl',
    'batchConcurrency',
    'lastRunDate',
    'lastRunAt'
  ]);
  const scheduleTime = data.scheduleTime || DEFAULT_SCHEDULE_TIME;
  const categoryUrl = data.categoryUrl || DEFAULT_CATEGORY_URL;
  const storedConcurrency = normalizeConcurrency(data.batchConcurrency ?? concurrency);
  concurrency = storedConcurrency;
  return {
    scheduleTime,
    categoryUrl,
    lastRunDate: data.lastRunDate || null,
    lastRunAt: data.lastRunAt || null,
    concurrency: storedConcurrency
  };
}

async function scheduleDailyAlarm(scheduleTime) {
  const when = nextRunAt(scheduleTime || DEFAULT_SCHEDULE_TIME);
  chrome.alarms.create(DAILY_ALARM_NAME, { when });
  await storageSet({ nextRunAt: new Date(when).toISOString() });
}

function shouldRunMissed(scheduleTime, lastRunDate) {
  const now = new Date();
  const today = toYmd(now);
  if (lastRunDate === today) return false;
  const { hours, minutes } = parseScheduleTime(scheduleTime);
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  return now >= target;
}
function saveBatchState({ saveResults = true } = {}) {
  const payload = {
    batchQueue: queue,
    batchRunning: running,
    batchPaused: paused,
    batchConcurrency: concurrency
  };
  if (saveResults) {
    payload.batchResults = results;
  }
  chrome.storage.local.set(payload);
}

function waitForTabComplete(tabId, targetUrl) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('页面加载超时'));
    }, BATCH_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    function isTarget(tab) {
      if (!tab) return false;
      if (tab.status !== 'complete') return false;
      if (!targetUrl) return true;
      return tab.url === targetUrl;
    }

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        return;
      }
      if (isTarget(tab)) {
        cleanup();
        resolve();
      }
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('内容脚本响应超时'));
    }, BATCH_TIMEOUT_MS);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timeout);
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

async function extractFromUrl(url, existingTabId) {
  let tabId = existingTabId;
  try {
    if (!tabId) {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
    } else {
      await chrome.tabs.update(tabId, { url, active: false });
    }
    await waitForTabComplete(tabId, url);
    const response = await sendMessageToTab(tabId, { type: 'extract' });
    return { result: response || { success: false, error: '无响应' }, tabId };
  } catch (error) {
    return { result: { success: false, error: error.message || '未知错误' }, tabId };
  }
}

async function collectCategoryUrls(categoryUrl) {
  const tab = await chrome.tabs.create({ url: categoryUrl, active: false });
  try {
    await waitForTabComplete(tab.id, categoryUrl);
    const response = await sendMessageToTab(tab.id, {
      type: 'collect-product-urls',
      paginate: true,
      maxPages: 50
    });
    return response || { success: false, error: '无响应' };
  } catch (error) {
    return { success: false, error: error.message || '未知错误' };
  } finally {
    chrome.tabs.remove(tab.id);
  }
}

function buildDailyRecord(data, dateStr) {
  const skus = Array.isArray(data?.sku)
    ? data.sku.map((sku) => ({
      name: sku?.name || '',
      stock: sku?.stock ?? null
    }))
    : [];
  return {
    date: dateStr,
    capturedAt: new Date().toISOString(),
    url: data?.url || '',
    productId: data?.productId || null,
    listedDate: data?.listedDate || null,
    originalPrice: data?.price?.original ?? null,
    last30Qty: data?.sales?.last30Qty ?? null,
    skus
  };
}

function pruneSnapshots(records) {
  if (!Array.isArray(records)) return [];
  const sorted = records.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_DAILY_DAYS);
  const cutoffStr = toYmd(cutoff);
  return sorted.filter((record) => (record.date || '') >= cutoffStr);
}

async function saveDailySnapshots(newRecords) {
  if (!newRecords.length) return;
  const data = await storageGet(['dailySnapshots']);
  const existing = Array.isArray(data.dailySnapshots) ? data.dailySnapshots : [];
  const map = new Map();
  for (const record of existing) {
    if (!record || !record.date || !record.url) continue;
    map.set(`${record.date}::${record.url}`, record);
  }
  for (const record of newRecords) {
    if (!record || !record.date || !record.url) continue;
    map.set(`${record.date}::${record.url}`, record);
  }
  const merged = pruneSnapshots(Array.from(map.values()));
  await storageSet({ dailySnapshots: merged });
}

async function processQueue({ emitEvents = true, recordResults = true, allowPause = true, onItem } = {}) {
  if (running) return;
  running = true;
  if (recordResults) {
    results = [];
  }
  saveBatchState({ saveResults: recordResults });

  const total = queue.length;
  let index = 0;
  const workerCount = Math.max(1, Math.min(concurrency, total || 1));

  async function runWorker() {
    let tabId = null;
    try {
      while (true) {
        if (queue.length === 0) break;
        if (allowPause && paused) {
          await sleep(300);
          continue;
        }
        const url = queue.shift();
        if (!url) continue;
        index += 1;
        const { result, tabId: nextTabId } = await extractFromUrl(url, tabId);
        tabId = nextTabId;
        const payload = {
          url,
          index,
          total,
          result
        };
        if (recordResults) {
          results.push(payload);
          saveBatchState({ saveResults: true });
        }
        if (emitEvents) {
          chrome.runtime.sendMessage({ type: 'batch-progress', payload });
        }
        if (typeof onItem === 'function') {
          onItem(payload);
        }
      }
    } finally {
      if (tabId != null) {
        chrome.tabs.remove(tabId);
      }
    }
  }

  const workers = Array.from({ length: workerCount }, () => runWorker());
  await Promise.all(workers);

  if (emitEvents) {
    chrome.runtime.sendMessage({ type: 'batch-complete', results });
  }
  running = false;
  saveBatchState({ saveResults: recordResults });

  if (pendingDailyRun) {
    pendingDailyRun = false;
    runDailyJob('pending');
  }
}

async function runDailyJob(source) {
  if (running) {
    pendingDailyRun = true;
    return;
  }

  const config = await loadConfig();
  if (!config.categoryUrl) {
    return;
  }

  const listResult = await collectCategoryUrls(config.categoryUrl);
  if (!listResult || !listResult.success || !Array.isArray(listResult.urls) || !listResult.urls.length) {
    return;
  }

  queue = listResult.urls.slice();
  paused = false;
  concurrency = normalizeConcurrency(config.concurrency);

  const dateStr = toYmd(new Date());
  const dailyRecords = [];
  await processQueue({
    emitEvents: false,
    recordResults: false,
    allowPause: false,
    onItem: (payload) => {
      if (payload?.result?.success && payload.result.data) {
        dailyRecords.push(buildDailyRecord(payload.result.data, dateStr));
      }
    }
  });

  await saveDailySnapshots(dailyRecords);
  const now = new Date();
  await storageSet({
    lastRunDate: toYmd(now),
    lastRunAt: now.toISOString()
  });
  await scheduleDailyAlarm(config.scheduleTime);

  if (pendingDailyRun) {
    pendingDailyRun = false;
    await runDailyJob('pending');
  }
}

async function initSchedule(reason) {
  const config = await loadConfig();
  await storageSet({ scheduleTime: config.scheduleTime, categoryUrl: config.categoryUrl });
  await scheduleDailyAlarm(config.scheduleTime);
  if (reason === 'startup' && shouldRunMissed(config.scheduleTime, config.lastRunDate)) {
    await runDailyJob('startup');
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initSchedule('install');
});

chrome.runtime.onStartup.addListener(() => {
  initSchedule('startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === DAILY_ALARM_NAME) {
    runDailyJob('alarm');
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === 'batch-start') {
    queue = (message.urls || []).filter(Boolean);
    if (!queue.length) {
      sendResponse({ started: false, error: 'URL列表为空' });
      return;
    }
    if (message.concurrency != null) {
      concurrency = normalizeConcurrency(message.concurrency);
    }
    paused = false;
    saveBatchState({ saveResults: true });
    processQueue({ emitEvents: true, recordResults: true, allowPause: true });
    sendResponse({ started: true });
    return true;
  }

  if (message.type === 'batch-pause') {
    paused = true;
    saveBatchState();
    sendResponse({ paused: true });
    return true;
  }

  if (message.type === 'batch-resume') {
    paused = false;
    saveBatchState();
    sendResponse({ paused: false });
    return true;
  }

  if (message.type === 'batch-status') {
    sendResponse({ running, paused, remaining: queue.length, concurrency });
    return true;
  }

  if (message.type === 'batch-get-results') {
    sendResponse({ results });
    return true;
  }

  if (message.type === 'config-update') {
    const scheduleTime = message.scheduleTime || DEFAULT_SCHEDULE_TIME;
    const categoryUrl = (message.categoryUrl || '').trim();
    storageSet({ scheduleTime, categoryUrl }).then(async () => {
      await scheduleDailyAlarm(scheduleTime);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'config-status') {
    loadConfig().then((config) => {
      storageGet(['nextRunAt']).then((data) => {
        sendResponse({
          scheduleTime: config.scheduleTime,
          categoryUrl: config.categoryUrl,
          lastRunAt: config.lastRunAt,
          lastRunDate: config.lastRunDate,
          nextRunAt: data.nextRunAt || null,
          running
        });
      });
    });
    return true;
  }

  if (message.type === 'daily-run-now') {
    runDailyJob('manual');
    sendResponse({ started: true });
    return true;
  }
});
