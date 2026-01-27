const BATCH_TIMEOUT_MS = 45000;
const MAX_CONCURRENCY = 10;

let queue = [];
let results = [];
let running = false;
let paused = false;
let concurrency = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return 1;
  return Math.min(MAX_CONCURRENCY, Math.max(1, parsed));
}

function saveBatchState() {
  chrome.storage.local.set({
    batchResults: results,
    batchQueue: queue,
    batchRunning: running,
    batchPaused: paused,
    batchConcurrency: concurrency
  });
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

async function processQueue() {
  if (running) return;
  running = true;
  results = [];
  saveBatchState();

  const total = queue.length;
  let index = 0;
  const workerCount = Math.max(1, Math.min(concurrency, total || 1));

  async function runWorker() {
    let tabId = null;
    try {
      while (true) {
        if (queue.length === 0) break;
        if (paused) {
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
        results.push(payload);
        saveBatchState();
        chrome.runtime.sendMessage({ type: 'batch-progress', payload });
      }
    } finally {
      if (tabId != null) {
        chrome.tabs.remove(tabId);
      }
    }
  }

  const workers = Array.from({ length: workerCount }, () => runWorker());
  await Promise.all(workers);

  chrome.runtime.sendMessage({ type: 'batch-complete', results });
  running = false;
  saveBatchState();
}

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
    saveBatchState();
    processQueue();
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
});
