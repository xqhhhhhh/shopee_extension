const BATCH_TIMEOUT_MS = 45000;
const FIXED_BATCH_CONCURRENCY = 1;
const DAILY_ALARM_NAME = 'daily-crawl';
const DEFAULT_SCHEDULE_TIME = '02:00';
const DEFAULT_CATEGORY_URL = '';
const MAX_DAILY_DAYS = 120;
const INCOMPLETE_RETRY_LIMIT = 2;
const BATCH_REST_EVERY = 5;
const BATCH_REST_MIN_MS = 10 * 1000;
const BATCH_REST_MAX_MS = 60 * 1000;
const CATEGORY_CACHE_TTL_HOURS = 24;
const CATEGORY_CACHE_URL_KEY = 'cachedCategoryUrl';
const CATEGORY_CACHE_KEY = 'cachedCategoryUrls';
const CATEGORY_CACHE_UPDATED_AT_KEY = 'cachedCategoryUpdatedAt';
const KEEP_AUTO_TABS_OPEN = true;
const CATEGORY_COLLECT_TIMEOUT_MS = 30 * 60 * 1000;
let categoryTabId = null;
const INCOMPLETE_WARNINGS = [
  '未找到卖家名称',
  '未找到类目信息',
  '未找到上架时间',
  '未找到SKU表格或SKU行',
  '字段仍在加载'
];

let queue = [];
let results = [];
let running = false;
let paused = false;
let concurrency = FIXED_BATCH_CONCURRENCY;
let pendingDailyRun = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function loadCategoryCache(categoryUrl) {
  const data = await storageGet([
    CATEGORY_CACHE_KEY,
    CATEGORY_CACHE_UPDATED_AT_KEY,
    CATEGORY_CACHE_URL_KEY,
    'listUrls'
  ]);
  const urls = Array.isArray(data[CATEGORY_CACHE_KEY]) ? data[CATEGORY_CACHE_KEY] : [];
  const cachedUrl = data[CATEGORY_CACHE_URL_KEY] || '';
  const updatedAt = data[CATEGORY_CACHE_UPDATED_AT_KEY] || null;
  const fallbackUrls = Array.isArray(data.listUrls) ? data.listUrls : [];
  if (!categoryUrl || cachedUrl !== categoryUrl) {
    return { urls: [], fallbackUrls, updatedAt: null, fresh: false };
  }
  if (!updatedAt) return { urls, updatedAt: null, fresh: false };
  const updatedAtMs = new Date(updatedAt).getTime();
  const ttlMs = CATEGORY_CACHE_TTL_HOURS * 60 * 60 * 1000;
  const fresh = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs < ttlMs : false;
  return { urls, fallbackUrls, updatedAt, fresh };
}

async function saveCategoryCache(categoryUrl, urls) {
  if (!categoryUrl) return;
  await storageSet({
    [CATEGORY_CACHE_URL_KEY]: categoryUrl,
    [CATEGORY_CACHE_KEY]: urls,
    [CATEGORY_CACHE_UPDATED_AT_KEY]: new Date().toISOString()
  });
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
    'lastRunDate',
    'lastRunAt'
  ]);
  const scheduleTime = data.scheduleTime || DEFAULT_SCHEDULE_TIME;
  const categoryUrl = data.categoryUrl || DEFAULT_CATEGORY_URL;
  concurrency = FIXED_BATCH_CONCURRENCY;
  return {
    scheduleTime,
    categoryUrl,
    lastRunDate: data.lastRunDate || null,
    lastRunAt: data.lastRunAt || null,
    concurrency
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

function sendMessageToTab(tabId, message, timeoutMs = BATCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('内容脚本响应超时'));
    }, timeoutMs);

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

function randomBetween(min, max) {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.floor(low + Math.random() * (high - low + 1));
}

function buildUrlPattern(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}*`;
  } catch (error) {
    return null;
  }
}

function normalizeCategoryUrlForCache(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('page')) {
      parsed.searchParams.set('page', '0');
    }
    return parsed.href;
  } catch (error) {
    return url || '';
  }
}

async function updateCategoryCache(categoryUrl, urls) {
  if (!categoryUrl || !Array.isArray(urls) || !urls.length) return;
  const data = await storageGet([CATEGORY_CACHE_KEY]);
  const existing = Array.isArray(data[CATEGORY_CACHE_KEY]) ? data[CATEGORY_CACHE_KEY] : [];
  const merged = Array.from(new Set([...existing, ...urls]));
  await saveCategoryCache(categoryUrl, merged);
}

async function ensureCategoryTab(categoryUrl) {
  if (categoryTabId) {
    try {
      const existing = await chrome.tabs.get(categoryTabId);
      if (existing && existing.id) {
        await chrome.tabs.update(existing.id, { url: categoryUrl, active: true });
        return existing;
      }
    } catch (error) {
      categoryTabId = null;
    }
  }

  const pattern = buildUrlPattern(categoryUrl);
  if (pattern) {
    const tabs = await chrome.tabs.query({ url: [pattern] });
    const tab = tabs.find((item) => item && item.id);
    if (tab && tab.id) {
      categoryTabId = tab.id;
      await chrome.tabs.update(tab.id, { url: categoryUrl, active: true });
      return tab;
    }
  }

  const created = await chrome.tabs.create({ url: categoryUrl, active: true });
  categoryTabId = created.id || null;
  return created;
}

function safeCloseTab(tabId) {
  return new Promise((resolve) => {
    if (KEEP_AUTO_TABS_OPEN) {
      chrome.tabs.update(tabId, { url: 'about:blank' }, () => resolve());
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve();
        return;
      }
      chrome.tabs.query({ windowId: tab.windowId }, (tabs) => {
        if (chrome.runtime.lastError) {
          resolve();
          return;
        }
        const count = Array.isArray(tabs) ? tabs.length : 0;
        if (count <= 1) {
          chrome.tabs.update(tabId, { url: 'about:blank', active: true }, () => resolve());
          return;
        }
        chrome.tabs.remove(tabId, () => resolve());
      });
    });
  });
}

function isIncompleteResult(result) {
  if (!result || !result.success || !result.data) return false;
  const data = result.data;
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const hasMissingWarning = warnings.some((warning) => INCOMPLETE_WARNINGS.some((key) => warning.includes(key)));
  const missingCoreFields =
    !data.sellerName ||
    !data.category ||
    !data.listedDate ||
    !Array.isArray(data.sku) ||
    data.sku.length === 0;
  return hasMissingWarning || missingCoreFields;
}

async function extractFromUrl(url, existingTabId) {
  let tabId = existingTabId;
  try {
    if (!tabId) {
      const tab = await chrome.tabs.create({ url, active: true });
      tabId = tab.id;
    } else {
      await chrome.tabs.update(tabId, { url, active: true });
    }
    await waitForTabComplete(tabId, url);
    await sleep(1200);
    const response = await sendMessageToTab(tabId, { type: 'extract' }, BATCH_TIMEOUT_MS);
    return { result: response || { success: false, error: '无响应' }, tabId };
  } catch (error) {
    return { result: { success: false, error: error.message || '未知错误' }, tabId };
  }
}

async function collectCategoryUrls(categoryUrl) {
  const tab = await ensureCategoryTab(categoryUrl);
  try {
    await waitForTabComplete(tab.id, categoryUrl);
    await sleep(1200);
    const response = await sendMessageToTab(tab.id, {
      type: 'collect-product-urls',
      paginate: true,
      maxPages: 50
    }, CATEGORY_COLLECT_TIMEOUT_MS);
    return response || { success: false, error: '无响应' };
  } catch (error) {
    return { success: false, error: error.message || '未知错误' };
  }
}

function buildDailyRecord(data, dateStr) {
  if (!data) return null;
  const capturedAt = data.extractedAt || new Date().toISOString();
  return {
    ...data,
    date: dateStr,
    capturedAt
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
  const retryCounts = new Map();
  const latestResults = new Map();
  let processedCount = 0;

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
        processedCount += 1;
        const { result, tabId: nextTabId } = await extractFromUrl(url, tabId);
        tabId = nextTabId;
        const payload = {
          url,
          index,
          total,
          result
        };
        if (recordResults) {
          latestResults.set(url, payload);
          results = Array.from(latestResults.values());
          saveBatchState({ saveResults: true });
        }
        if (emitEvents) {
          chrome.runtime.sendMessage({ type: 'batch-progress', payload });
        }
        if (typeof onItem === 'function') {
          onItem(payload);
        }

        if (isIncompleteResult(result)) {
          const currentRetries = retryCounts.get(url) || 0;
          if (currentRetries < INCOMPLETE_RETRY_LIMIT) {
            retryCounts.set(url, currentRetries + 1);
            queue.push(url);
          }
        }

        if (processedCount % BATCH_REST_EVERY === 0) {
          const restMs = randomBetween(BATCH_REST_MIN_MS, BATCH_REST_MAX_MS);
          await sleep(restMs);
        }
      }
    } finally {
      if (tabId != null) {
        await safeCloseTab(tabId);
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

  const cache = await loadCategoryCache(config.categoryUrl);
  const forceRefresh = source === 'manual';
  let cachedUrls = cache.urls.slice();
  let listResult = null;

  if (!cachedUrls.length && cache.fallbackUrls && cache.fallbackUrls.length) {
    cachedUrls = cache.fallbackUrls.slice();
    await saveCategoryCache(config.categoryUrl, cachedUrls);
  }

  if (forceRefresh || !cache.fresh || !cachedUrls.length) {
    listResult = await collectCategoryUrls(config.categoryUrl);
    if (listResult?.success && Array.isArray(listResult.urls) && listResult.urls.length) {
      const merged = new Set([...cachedUrls, ...listResult.urls]);
      cachedUrls = Array.from(merged);
      await saveCategoryCache(config.categoryUrl, cachedUrls);
    }
  }

  if (!cachedUrls.length) {
    const refreshed = await loadCategoryCache(config.categoryUrl);
    cachedUrls = refreshed.urls.slice();
  }

  if (!cachedUrls.length) {
    return;
  }

  queue = cachedUrls.slice();
  paused = false;
  concurrency = FIXED_BATCH_CONCURRENCY;

  const dateStr = toYmd(new Date());
  const dailyRecordMap = new Map();
  let saveChain = Promise.resolve();
  await processQueue({
    emitEvents: source === 'manual',
    recordResults: true,
    allowPause: false,
    onItem: (payload) => {
      if (payload?.result?.success && payload.result.data) {
        const record = buildDailyRecord(payload.result.data, dateStr);
        if (record) {
          dailyRecordMap.set(record.url, record);
          saveChain = saveChain.then(() => saveDailySnapshots([record]));
        }
      }
    }
  });

  await saveChain;
  await saveDailySnapshots(Array.from(dailyRecordMap.values()));
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
    concurrency = FIXED_BATCH_CONCURRENCY;
    paused = false;
    saveBatchState({ saveResults: true });
    processQueue({ emitEvents: true, recordResults: true, allowPause: true });
    sendResponse({ started: true });
    return true;
  }

  if (message.type === 'collect-product-urls-progress') {
    const payload = message.payload || {};
    const categoryUrl = normalizeCategoryUrlForCache(payload.categoryUrl || '');
    const urls = Array.isArray(payload.urls) ? payload.urls : [];
    updateCategoryCache(categoryUrl, urls).then(() => {
      sendResponse({ ok: true });
    });
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
