const BATCH_TIMEOUT_MS = 45000;

let queue = [];
let results = [];
let running = false;

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('页面加载超时'));
    }, BATCH_TIMEOUT_MS);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
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

async function extractFromUrl(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id);
    const response = await sendMessageToTab(tab.id, { type: 'extract' });
    return response || { success: false, error: '无响应' };
  } catch (error) {
    return { success: false, error: error.message || '未知错误' };
  } finally {
    chrome.tabs.remove(tab.id);
  }
}

async function processQueue() {
  if (running) return;
  running = true;
  results = [];

  const total = queue.length;
  let index = 0;

  while (queue.length) {
    const url = queue.shift();
    index += 1;
    const result = await extractFromUrl(url);
    const payload = {
      url,
      index,
      total,
      result
    };
    results.push(payload);
    chrome.runtime.sendMessage({ type: 'batch-progress', payload });
  }

  chrome.runtime.sendMessage({ type: 'batch-complete', results });
  running = false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === 'batch-start') {
    queue = (message.urls || []).filter(Boolean);
    if (!queue.length) {
      sendResponse({ started: false, error: 'URL列表为空' });
      return;
    }
    processQueue();
    sendResponse({ started: true });
    return true;
  }

  if (message.type === 'batch-get-results') {
    sendResponse({ results });
    return true;
  }
});
