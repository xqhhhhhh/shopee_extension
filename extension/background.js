const BATCH_TIMEOUT_MS = 45000;
const FIXED_BATCH_CONCURRENCY = 1;
const DAILY_ALARM_NAME = 'daily-crawl';
const DEFAULT_SCHEDULE_TIME = '02:00';
const DEFAULT_CATEGORY_URL = '';
const DEFAULT_CACHE_UPDATE_ENABLED = true;
const MAX_DAILY_DAYS = 120;
const INCOMPLETE_RETRY_LIMIT = 2;
const BATCH_REST_EVERY = 50;
const BATCH_REST_MIN_MS = 5 * 60 * 1000;
const BATCH_REST_MAX_MS = 10 * 60 * 1000;
const POST_RETRY_ROUNDS = 5;
const POST_RETRY_DELAY_MS = 2 * 60 * 1000;
const CATEGORY_CACHE_TTL_HOURS = 24;
const CATEGORY_CACHE_URL_KEY = 'cachedCategoryUrl';
const CATEGORY_CACHE_KEY = 'cachedCategoryUrls';
const CATEGORY_CACHE_UPDATED_AT_KEY = 'cachedCategoryUpdatedAt';
const SESSION_WINDOW_ID_KEY = 'sessionWindowId';
const KEEP_AUTO_TABS_OPEN = true;
const CATEGORY_COLLECT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_DAILY_RUN_MS = 23 * 60 * 60 * 1000;
const VERIFY_COOLDOWN_MS = 15 * 60 * 1000;
const ITEM_GAP_MIN_MS = 1200;
const ITEM_GAP_MAX_MS = 3000;
const PAGE_SWITCH_DELAY_MIN_MS = 1000;
const PAGE_SWITCH_DELAY_MAX_MS = 3000;
const SCHEDULE_MIN_HOUR = 1;
const SCHEDULE_MAX_HOUR = 23;
const SCHEDULE_WINDOW_MINUTES = 60;
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
let verifyBlocked = false;
let verifyBlockedUrl = null;
let verifyBlockedUntil = null;
let verifyBlockedPrevPaused = false;
let sessionWindowId = null;

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

function tabsQuery(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => resolve(tabs || []));
  });
}

async function loadSessionWindowId() {
  const data = await storageGet([SESSION_WINDOW_ID_KEY]);
  const stored = data[SESSION_WINDOW_ID_KEY];
  sessionWindowId = Number.isFinite(stored) ? stored : null;
}

function setSessionWindowId(windowId) {
  if (!Number.isFinite(windowId)) return;
  sessionWindowId = windowId;
  storageSet({ [SESSION_WINDOW_ID_KEY]: windowId });
}

async function resolveSessionWindowId() {
  if (Number.isFinite(sessionWindowId)) return sessionWindowId;
  const [active] = await tabsQuery({ active: true, lastFocusedWindow: true });
  if (active && !active.incognito) {
    setSessionWindowId(active.windowId);
    return active.windowId;
  }
  const tabs = await tabsQuery({});
  const normal = tabs.find((tab) => tab && !tab.incognito);
  if (normal) {
    setSessionWindowId(normal.windowId);
    return normal.windowId;
  }
  return null;
}

function isVerifyUrl(url) {
  if (!url) return false;
  return /\/verify\/(traffic|captcha|error)/i.test(url);
}

async function hydrateVerifyState() {
  const data = await storageGet(['verifyBlocked', 'verifyBlockedUrl', 'verifyBlockedUntil']);
  verifyBlocked = Boolean(data.verifyBlocked);
  verifyBlockedUrl = data.verifyBlockedUrl || null;
  verifyBlockedUntil = data.verifyBlockedUntil ? new Date(data.verifyBlockedUntil).getTime() : null;
  if (verifyBlocked && verifyBlockedUntil && Date.now() >= verifyBlockedUntil) {
    await clearVerifyBlocked();
  }
}

async function setVerifyBlocked(url) {
  if (verifyBlocked) return;
  verifyBlocked = true;
  verifyBlockedUrl = url || null;
  verifyBlockedUntil = Date.now() + VERIFY_COOLDOWN_MS;
  verifyBlockedPrevPaused = paused;
  paused = true;
  saveBatchState();
  await storageSet({
    verifyBlocked: true,
    verifyBlockedUrl: verifyBlockedUrl,
    verifyBlockedUntil: new Date(verifyBlockedUntil).toISOString()
  });
  chrome.runtime.sendMessage({
    type: 'verify-blocked',
    url: verifyBlockedUrl,
    until: verifyBlockedUntil
  });
}

async function clearVerifyBlocked() {
  verifyBlocked = false;
  verifyBlockedUrl = null;
  verifyBlockedUntil = null;
  paused = verifyBlockedPrevPaused;
  verifyBlockedPrevPaused = false;
  saveBatchState();
  await storageSet({
    verifyBlocked: false,
    verifyBlockedUrl: null,
    verifyBlockedUntil: null
  });
  chrome.runtime.sendMessage({ type: 'verify-clear' });
}

async function waitForVerifyClear() {
  while (verifyBlocked) {
    if (verifyBlockedUntil && Date.now() >= verifyBlockedUntil) {
      await clearVerifyBlocked();
      break;
    }
    await sleep(1000);
  }
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
  let hours = Number.parseInt(hoursStr, 10);
  let minutes = Number.parseInt(minutesStr, 10);
  hours = Number.isFinite(hours) ? hours : 2;
  minutes = Number.isFinite(minutes) ? minutes : 0;
  if (hours < SCHEDULE_MIN_HOUR) {
    hours = SCHEDULE_MIN_HOUR;
    minutes = 0;
  }
  if (hours > SCHEDULE_MAX_HOUR) {
    hours = SCHEDULE_MAX_HOUR;
    minutes = 0;
  }
  minutes = Math.min(59, Math.max(0, minutes));
  if (hours === SCHEDULE_MAX_HOUR && minutes > 0) {
    minutes = 0;
  }
  return { hours, minutes };
}

function getScheduleWindow(date, timeText) {
  const { hours, minutes } = parseScheduleTime(timeText);
  const base = new Date(date);
  base.setHours(hours, minutes, 0, 0);
  const start = new Date(base);
  start.setMinutes(start.getMinutes() - SCHEDULE_WINDOW_MINUTES);
  const end = new Date(base);
  end.setMinutes(end.getMinutes() + SCHEDULE_WINDOW_MINUTES);

  const minAllowed = new Date(date);
  minAllowed.setHours(SCHEDULE_MIN_HOUR, 0, 0, 0);
  const maxAllowed = new Date(date);
  maxAllowed.setHours(SCHEDULE_MAX_HOUR, 0, 0, 0);

  const windowStart = new Date(Math.max(start.getTime(), minAllowed.getTime()));
  const windowEnd = new Date(Math.min(end.getTime(), maxAllowed.getTime()));
  return { start: windowStart, end: windowEnd };
}

function randomTimeBetween(start, end) {
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (startMs >= endMs) return startMs;
  return randomBetween(startMs, endMs);
}

function pickRandomRunTime(timeText, now = new Date()) {
  const todayWindow = getScheduleWindow(now, timeText);
  const nowMs = now.getTime();
  const todayEndMs = todayWindow.end.getTime();
  if (nowMs <= todayEndMs) {
    const earliestMs = Math.max(todayWindow.start.getTime(), nowMs + 1000);
    if (earliestMs <= todayEndMs) {
      return randomTimeBetween(new Date(earliestMs), todayWindow.end);
    }
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowWindow = getScheduleWindow(tomorrow, timeText);
  return randomTimeBetween(tomorrowWindow.start, tomorrowWindow.end);
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
  return pickRandomRunTime(timeText, new Date());
}

async function loadConfig() {
  const data = await storageGet([
    'scheduleTime',
    'categoryUrl',
    'cacheUpdateEnabled',
    'lastRunDate',
    'lastRunAt',
    SESSION_WINDOW_ID_KEY
  ]);
  const scheduleTime = data.scheduleTime || DEFAULT_SCHEDULE_TIME;
  const categoryUrl = data.categoryUrl || DEFAULT_CATEGORY_URL;
  concurrency = FIXED_BATCH_CONCURRENCY;
  const cacheUpdateEnabled =
    typeof data.cacheUpdateEnabled === 'boolean' ? data.cacheUpdateEnabled : DEFAULT_CACHE_UPDATE_ENABLED;
  return {
    scheduleTime,
    categoryUrl,
    lastRunDate: data.lastRunDate || null,
    lastRunAt: data.lastRunAt || null,
    cacheUpdateEnabled,
    concurrency,
    sessionWindowId: Number.isFinite(data[SESSION_WINDOW_ID_KEY]) ? data[SESSION_WINDOW_ID_KEY] : null
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
  const window = getScheduleWindow(now, scheduleTime);
  return now >= window.end;
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

async function ensureCategoryTab(categoryUrl, windowId) {
  if (categoryTabId) {
    try {
      const existing = await chrome.tabs.get(categoryTabId);
      if (existing && existing.id && !existing.incognito) {
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
    const tab = tabs.find((item) => item && item.id && !item.incognito);
    if (tab && tab.id) {
      categoryTabId = tab.id;
      await chrome.tabs.update(tab.id, { url: categoryUrl, active: true });
      return tab;
    }
  }

  const createOptions = { url: categoryUrl, active: true };
  if (Number.isFinite(windowId)) {
    createOptions.windowId = windowId;
  }
  const created = await chrome.tabs.create(createOptions);
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

function forceCloseTab(tabId) {
  if (!tabId) return Promise.resolve();
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => resolve());
  });
}

async function restartWorkerTab(tabId) {
  if (!tabId) return null;
  try {
    const existing = await chrome.tabs.get(tabId);
    if (!existing || existing.incognito) return null;
    const created = await chrome.tabs.create({
      url: 'about:blank',
      active: false,
      windowId: existing.windowId
    });
    await forceCloseTab(tabId);
    return created?.id ?? null;
  } catch (error) {
    return null;
  }
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

function shouldRetryAfterRun(result) {
  if (!result || !result.success || !result.data) return false;
  if (!result.data.productId) return false;
  return isIncompleteResult(result);
}

async function extractFromUrl(url, existingTabId) {
  let tabId = existingTabId;
  try {
    if (!tabId) {
      const windowId = await resolveSessionWindowId();
      const createOptions = { url, active: true };
      if (Number.isFinite(windowId)) {
        createOptions.windowId = windowId;
      }
      const tab = await chrome.tabs.create(createOptions);
      tabId = tab.id;
      if (tab.incognito) {
        await safeCloseTab(tabId);
        return { result: { success: false, error: '当前为无痕窗口，无法共享登录态' }, tabId: null };
      }
    } else {
      const current = await chrome.tabs.get(tabId);
      if (current?.incognito) {
        return { result: { success: false, error: '当前为无痕窗口，无法共享登录态' }, tabId };
      }
      await chrome.tabs.update(tabId, { url, active: true });
    }
    await waitForTabComplete(tabId, url);
    const tab = await chrome.tabs.get(tabId);
    if (tab?.incognito) {
      return { result: { success: false, error: '当前为无痕窗口，无法共享登录态' }, tabId };
    }
    if (isVerifyUrl(tab?.url)) {
      await setVerifyBlocked(tab.url);
      return { result: { success: false, error: '触发验证页', blocked: true }, tabId };
    }
    await sleep(randomBetween(PAGE_SWITCH_DELAY_MIN_MS, PAGE_SWITCH_DELAY_MAX_MS));
    const response = await sendMessageToTab(tabId, { type: 'extract' }, BATCH_TIMEOUT_MS);
    return { result: response || { success: false, error: '无响应' }, tabId };
  } catch (error) {
    return { result: { success: false, error: error.message || '未知错误' }, tabId };
  }
}

async function collectCategoryUrls(categoryUrl, timeoutMs = CATEGORY_COLLECT_TIMEOUT_MS) {
  const windowId = await resolveSessionWindowId();
  const tab = await ensureCategoryTab(categoryUrl, windowId);
  try {
    if (tab?.incognito) {
      return { success: false, error: '当前为无痕窗口，无法共享登录态' };
    }
    await waitForTabComplete(tab.id, categoryUrl);
    const current = await chrome.tabs.get(tab.id);
    if (current?.incognito) {
      return { success: false, error: '当前为无痕窗口，无法共享登录态' };
    }
    if (isVerifyUrl(current?.url)) {
      await setVerifyBlocked(current.url);
      return { success: false, error: '触发验证页', blocked: true };
    }
    await sleep(randomBetween(PAGE_SWITCH_DELAY_MIN_MS, PAGE_SWITCH_DELAY_MAX_MS));
    const response = await sendMessageToTab(tab.id, {
      type: 'collect-product-urls',
      paginate: true,
      maxPages: 50
    }, timeoutMs);
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

async function processQueue({
  emitEvents = true,
  recordResults = true,
  allowPause = true,
  onItem,
  deadlineMs
} = {}) {
  if (running) return;
  running = true;
  await hydrateVerifyState();
  await loadSessionWindowId();
  if (recordResults) {
    results = [];
  }
  saveBatchState({ saveResults: recordResults });

  const isDeadlineReached = () => Number.isFinite(deadlineMs) && Date.now() >= deadlineMs;
  let stoppedByDeadline = false;

  let total = queue.length;
  let index = 0;
  const workerCount = Math.max(1, Math.min(concurrency, total || 1));
  const retryCounts = new Map();
  const latestResults = new Map();
  let processedCount = 0;

  async function runWorker() {
    let tabId = null;
    try {
      while (true) {
        if (verifyBlocked) {
          await waitForVerifyClear();
          if (verifyBlocked) continue;
        }
        if (isDeadlineReached()) {
          stoppedByDeadline = true;
          break;
        }
        if (queue.length === 0) break;
        if (allowPause && paused) {
          await sleep(300);
          continue;
        }
        const url = queue.shift();
        if (!url) continue;
        const { result, tabId: nextTabId } = await extractFromUrl(url, tabId);
        tabId = nextTabId;
        if (result?.blocked) {
          queue.unshift(url);
          continue;
        }
        index += 1;
        processedCount += 1;
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

        if (processedCount % BATCH_REST_EVERY !== 0) {
          const gapMs = randomBetween(ITEM_GAP_MIN_MS, ITEM_GAP_MAX_MS);
          if (isDeadlineReached()) {
            stoppedByDeadline = true;
            break;
          }
          await sleep(gapMs);
        }

        if (processedCount % BATCH_REST_EVERY === 0) {
          if (isDeadlineReached()) {
            stoppedByDeadline = true;
            break;
          }
          if (tabId != null) {
            tabId = await restartWorkerTab(tabId);
          }
          await sleep(randomBetween(BATCH_REST_MIN_MS, BATCH_REST_MAX_MS));
        }
      }
    } finally {
      if (tabId != null) {
        await safeCloseTab(tabId);
      }
    }
  }

  async function runRound() {
    if (isDeadlineReached()) {
      stoppedByDeadline = true;
      return;
    }
    const currentWorkers = Array.from({ length: workerCount }, () => runWorker());
    await Promise.all(currentWorkers);
  }

  await runRound();

  for (let round = 1; round <= POST_RETRY_ROUNDS; round += 1) {
    if (isDeadlineReached()) {
      stoppedByDeadline = true;
      break;
    }
    const retryUrls = Array.from(latestResults.values())
      .filter((payload) => shouldRetryAfterRun(payload?.result))
      .map((payload) => payload.url)
      .filter(Boolean);

    if (!retryUrls.length) break;
    queue = Array.from(new Set(retryUrls));
    total += queue.length;
    if (isDeadlineReached()) {
      stoppedByDeadline = true;
      break;
    }
    await sleep(POST_RETRY_DELAY_MS);
    await runRound();
    if (stoppedByDeadline) break;
  }

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

  await loadSessionWindowId();
  const config = await loadConfig();
  if (!config.categoryUrl) {
    return;
  }
  const deadlineMs = Date.now() + MAX_DAILY_RUN_MS;
  const remainingMs = () => Math.max(0, deadlineMs - Date.now());

  const cache = await loadCategoryCache(config.categoryUrl);
  const forceRefresh = source === 'manual';
  const cacheUpdateEnabled = config.cacheUpdateEnabled !== false;
  let cachedUrls = cache.urls.slice();
  let listResult = null;

  if (!cachedUrls.length && cache.fallbackUrls && cache.fallbackUrls.length) {
    cachedUrls = cache.fallbackUrls.slice();
    await saveCategoryCache(config.categoryUrl, cachedUrls);
  }

  if (cacheUpdateEnabled && (forceRefresh || !cache.fresh || !cachedUrls.length)) {
    const leftMs = remainingMs();
    if (leftMs <= 0) {
      await scheduleDailyAlarm(config.scheduleTime);
      return;
    }
    const timeoutMs = Math.min(CATEGORY_COLLECT_TIMEOUT_MS, leftMs);
    listResult = await collectCategoryUrls(config.categoryUrl, timeoutMs);
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
    await scheduleDailyAlarm(config.scheduleTime);
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
    deadlineMs,
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
    if (message.incognito) {
      sendResponse({ started: false, error: '当前为无痕窗口，无法共享登录态' });
      return;
    }
    if (Number.isFinite(message.windowId)) {
      setSessionWindowId(message.windowId);
    }
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
    const cacheUpdateEnabled =
      typeof message.cacheUpdateEnabled === 'boolean' ? message.cacheUpdateEnabled : DEFAULT_CACHE_UPDATE_ENABLED;
    if (!message.incognito && Number.isFinite(message.windowId)) {
      setSessionWindowId(message.windowId);
    }
    storageSet({ scheduleTime, categoryUrl, cacheUpdateEnabled }).then(async () => {
      await scheduleDailyAlarm(scheduleTime);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'config-status') {
    loadConfig().then((config) => {
      storageGet(['nextRunAt', 'verifyBlocked', 'verifyBlockedUrl', 'verifyBlockedUntil']).then((data) => {
        sendResponse({
          scheduleTime: config.scheduleTime,
          categoryUrl: config.categoryUrl,
          lastRunAt: config.lastRunAt,
          lastRunDate: config.lastRunDate,
          nextRunAt: data.nextRunAt || null,
          running,
          cacheUpdateEnabled: config.cacheUpdateEnabled,
          verifyBlocked: Boolean(data.verifyBlocked),
          verifyBlockedUrl: data.verifyBlockedUrl || null,
          verifyBlockedUntil: data.verifyBlockedUntil || null
        });
      });
    });
    return true;
  }

  if (message.type === 'verify-resume') {
    clearVerifyBlocked().then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'daily-run-now') {
    if (!message.incognito && Number.isFinite(message.windowId)) {
      setSessionWindowId(message.windowId);
    }
    runDailyJob('manual');
    sendResponse({ started: true });
    return true;
  }

  if (message.type === 'session-bind') {
    if (!message.incognito && Number.isFinite(message.windowId)) {
      setSessionWindowId(message.windowId);
    }
    sendResponse({ ok: true });
    return true;
  }
});
