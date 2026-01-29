const outputEl = document.getElementById('output');
const listOutputEl = document.getElementById('listOutput');
const urlFileEl = document.getElementById('urlFile');
const importUrlsBtn = document.getElementById('importUrls');
const extractCurrentBtn = document.getElementById('extractCurrent');
const extractBatchBtn = document.getElementById('extractBatch');
const pauseBatchBtn = document.getElementById('pauseBatch');
const extractListBtn = document.getElementById('extractList');
const downloadJsonBtn = document.getElementById('downloadJson');
const downloadCsvBtn = document.getElementById('downloadCsv');
const downloadUrlsBtn = document.getElementById('downloadUrls');
const autoPaginateEl = document.getElementById('autoPaginate');
const scheduleTimeEl = document.getElementById('scheduleTime');
const saveScheduleBtn = document.getElementById('saveSchedule');
const runDailyNowBtn = document.getElementById('runDailyNow');
const scheduleInfoEl = document.getElementById('scheduleInfo');
const fixedListHintEl = document.getElementById('fixedListHint');
const autoCategoryHintEl = document.getElementById('autoCategoryHint');
const autoStatusEl = document.getElementById('autoStatus');
const verifyBlockEl = document.getElementById('verifyBlock');
const verifyBlockTextEl = document.getElementById('verifyBlockText');
const verifyResumeBtn = document.getElementById('verifyResume');
const cacheUpdateEnabledEl = document.getElementById('cacheUpdateEnabled');
const downloadHistoryCsvBtn = document.getElementById('downloadHistoryCsv');
const viewCacheBtn = document.getElementById('viewCache');
const downloadCacheBtn = document.getElementById('downloadCache');
const runFilterBtn = document.getElementById('runFilter');
const downloadFilterBtn = document.getElementById('downloadFilter');
const filterOutputEl = document.getElementById('filterOutput');
const downloadHistoryBtn = document.getElementById('downloadHistory');
const tabButtons = Array.from(document.querySelectorAll('.tab-button'));
const tabPanels = Array.from(document.querySelectorAll('.tab-panel'));
const filterLast30QtyEl = document.getElementById('filterLast30Qty');
const filterDiscountedPriceEl = document.getElementById('filterDiscountedPrice');
const filterListedDateEl = document.getElementById('filterListedDate');
const filterSkuDropEl = document.getElementById('filterSkuDrop');
const filterSkuAvgDropEl = document.getElementById('filterSkuAvgDrop');
const filterSkuAvgWindowEl = document.getElementById('filterSkuAvgWindow');

let results = [];
let listUrls = [];
let importedUrls = [];
const MAX_LIST_PAGES = 50;
const FIXED_BATCH_CONCURRENCY = 1;
const FIXED_LIST_URL = 'https://shopee.ph/Motorcycle-ATV-Parts-cat.11020952.11020975?page=0';
const FIXED_LIST_URL_PATTERN = '*://shopee.ph/Motorcycle-ATV-Parts-cat.11020952.11020975*';
const AUTO_CATEGORY_URL = FIXED_LIST_URL;
const TAB_STORAGE_KEY = 'popupActiveTab';
const TAB_READY_TIMEOUT_MS = 60000;
let batchPaused = false;
let batchRunning = false;
let filterUrls = [];
const STORAGE_KEYS = {
  importedUrls: 'importedUrls',
  listUrls: 'listUrls',
  listMeta: 'listMeta',
  batchResults: 'batchResults',
  scheduleTime: 'scheduleTime',
  dailySnapshots: 'dailySnapshots',
  lastRunAt: 'lastRunAt',
  nextRunAt: 'nextRunAt',
  cacheUpdateEnabled: 'cacheUpdateEnabled',
  cachedCategoryUrl: 'cachedCategoryUrl',
  cachedCategoryUrls: 'cachedCategoryUrls',
  cachedCategoryUpdatedAt: 'cachedCategoryUpdatedAt'
};

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

function setActiveTab(tabName) {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle('is-active', isActive);
  });
  tabPanels.forEach((panel) => {
    const isActive = panel.dataset.tab === tabName;
    panel.classList.toggle('is-active', isActive);
  });
  if (tabName) {
    localStorage.setItem(TAB_STORAGE_KEY, tabName);
  }
}

function restoreActiveTab() {
  const saved = localStorage.getItem(TAB_STORAGE_KEY);
  const availableTabs = tabButtons.map((button) => button.dataset.tab).filter(Boolean);
  const fallback = availableTabs.length ? availableTabs[0] : null;
  const target = availableTabs.includes(saved) ? saved : fallback;
  if (target) setActiveTab(target);
}

function tabsQuery(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => resolve(tabs || []));
  });
}

function tabsCreate(createProperties) {
  return new Promise((resolve) => {
    chrome.tabs.create(createProperties, (tab) => resolve(tab));
  });
}

function tabsUpdate(tabId, updateProperties) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => resolve(tab));
  });
}

async function bindSessionContext() {
  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.runtime.sendMessage({
    type: 'session-bind',
    windowId: tab.windowId,
    incognito: tab.incognito
  });
}

function waitForTabComplete(tabId, urlMatch) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('页面加载超时'));
    }, TAB_READY_TIMEOUT_MS);

    function listener(updatedId, changeInfo, tab) {
      if (updatedId !== tabId) return;
      if (changeInfo.status !== 'complete') return;
      if (urlMatch && tab?.url && !tab.url.startsWith(urlMatch)) return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureFixedListTab() {
  const tabs = await tabsQuery({ url: FIXED_LIST_URL_PATTERN });
  let tab = tabs.find((item) => item && item.id && !item.incognito);

  if (tab && tab.id) {
    if (tab.url !== FIXED_LIST_URL) {
      tab = await tabsUpdate(tab.id, { url: FIXED_LIST_URL, active: true });
    } else {
      await tabsUpdate(tab.id, { active: true });
    }
  } else {
    tab = await tabsCreate({ url: FIXED_LIST_URL, active: true });
  }

  if (!tab || !tab.id) return null;
  if (tab.incognito) return null;
  if (tab.status === 'complete' && tab.url && tab.url.startsWith(FIXED_LIST_URL)) {
    return tab;
  }
  return waitForTabComplete(tab.id, FIXED_LIST_URL);
}

function toYmd(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseYmd(text) {
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split('-').map((part) => Number.parseInt(part, 10));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function daysBetween(dateA, dateB) {
  const ms = 24 * 60 * 60 * 1000;
  return Math.round((dateB - dateA) / ms);
}

function setOutput(text) {
  outputEl.textContent = text;
}

function setListOutput(text) {
  listOutputEl.textContent = text;
}

function updateDownloadButtons() {
  const hasData = results.length > 0;
  downloadJsonBtn.disabled = !hasData;
  downloadCsvBtn.disabled = !hasData;
}

function updatePauseButton() {
  const canControl = batchRunning || batchPaused;
  pauseBatchBtn.disabled = !canControl;
  pauseBatchBtn.textContent = batchPaused ? '继续' : '暂停';
}

function updateUrlDownloadButton() {
  downloadUrlsBtn.disabled = listUrls.length === 0;
}

function persistImportedUrls() {
  return storageSet({ [STORAGE_KEYS.importedUrls]: importedUrls });
}

function persistResults() {
  return storageSet({ [STORAGE_KEYS.batchResults]: results });
}

function persistListState(meta) {
  return storageSet({
    [STORAGE_KEYS.listUrls]: listUrls,
    [STORAGE_KEYS.listMeta]: meta || null
  });
}

function updateScheduleInfo({ lastRunAt, nextRunAt }) {
  const parts = [];
  if (lastRunAt) {
    parts.push(`上次: ${new Date(lastRunAt).toLocaleString()}`);
  }
  if (nextRunAt) {
    parts.push(`下次: ${new Date(nextRunAt).toLocaleString()}`);
  }
  scheduleInfoEl.textContent = parts.length ? parts.join(' | ') : '尚未设置自动抓取';
}

function setFilterOutput(text) {
  filterOutputEl.textContent = text;
}

function setAutoStatus(text) {
  if (autoStatusEl) {
    autoStatusEl.textContent = text;
  }
}

function showVerifyBlock({ url, until } = {}) {
  if (!verifyBlockEl) return;
  verifyBlockEl.classList.remove('is-hidden');
  const parts = [];
  if (url) parts.push(`URL: ${url}`);
  if (until) {
    const untilText = typeof until === 'string' ? new Date(until).toLocaleString() : new Date(until).toLocaleString();
    parts.push(`自动解锁: ${untilText}`);
  }
  if (verifyBlockTextEl) {
    verifyBlockTextEl.textContent = parts.join(' | ') || '触发验证页，请手动完成验证后继续';
  }
}

function hideVerifyBlock() {
  if (!verifyBlockEl) return;
  verifyBlockEl.classList.add('is-hidden');
  if (verifyBlockTextEl) verifyBlockTextEl.textContent = '';
}

function updateFilterDownloadButton() {
  downloadFilterBtn.disabled = filterUrls.length === 0;
}

function getRecordDateText(record) {
  if (record?.date) return record.date;
  const ts = record?.capturedAt || record?.extractedAt || '';
  return ts ? ts.slice(0, 10) : null;
}

function getRecordSkuList(record) {
  if (Array.isArray(record?.skus)) return record.skus;
  if (Array.isArray(record?.sku)) return record.sku;
  return [];
}

function getRecordLast30Qty(record) {
  if (typeof record?.last30Qty === 'number') return record.last30Qty;
  if (typeof record?.sales?.last30Qty === 'number') return record.sales.last30Qty;
  return null;
}

function getRecordOriginalPrice(record) {
  if (typeof record?.originalPrice === 'number') return record.originalPrice;
  if (Array.isArray(record?.originalPrice) && record.originalPrice.length) {
    return Math.max(...record.originalPrice.filter((value) => typeof value === 'number'));
  }
  if (typeof record?.price?.original === 'number') return record.price.original;
  if (Array.isArray(record?.price?.originalRange) && record.price.originalRange.length) {
    return Math.max(...record.price.originalRange.filter((value) => typeof value === 'number'));
  }
  return null;
}

function getRecordProductId(record) {
  if (record?.productId) return record.productId;
  if (record?.data?.productId) return record.data.productId;
  return '';
}

function getRecordDiscountedPriceMax(record) {
  const range = Array.isArray(record?.price?.currentPHPRange) ? record.price.currentPHPRange : null;
  if (range && range.length) {
    const values = range.filter((value) => typeof value === 'number');
    return values.length ? Math.max(...values) : null;
  }
  if (typeof record?.price?.currentPHP === 'number') return record.price.currentPHP;
  return null;
}

function getRecordOriginalRange(record) {
  if (Array.isArray(record?.originalPrice) && record.originalPrice.length) {
    return record.originalPrice.filter((value) => typeof value === 'number');
  }
  if (Array.isArray(record?.price?.originalRange) && record.price.originalRange.length) {
    return record.price.originalRange.filter((value) => typeof value === 'number');
  }
  if (typeof record?.originalPrice === 'number') return [record.originalPrice];
  if (typeof record?.price?.original === 'number') return [record.price.original];
  return [];
}

function getFilterOptions() {
  const requireLast30Qty = Boolean(filterLast30QtyEl?.checked);
  const requireDiscountedPrice = Boolean(filterDiscountedPriceEl?.checked);
  const requireListedDate = Boolean(filterListedDateEl?.checked);
  const requireSkuDrop = Boolean(filterSkuDropEl?.checked);
  const requireSkuAvgDrop = Boolean(filterSkuAvgDropEl?.checked);
  const windowValue = Number.parseInt(filterSkuAvgWindowEl?.value || '7', 10);
  const windowSize = Number.isNaN(windowValue) ? 7 : Math.min(60, Math.max(3, windowValue));
  if (filterSkuAvgWindowEl) {
    filterSkuAvgWindowEl.value = String(windowSize);
  }
  const anySelected = requireLast30Qty ||
    requireDiscountedPrice ||
    requireListedDate ||
    requireSkuDrop ||
    requireSkuAvgDrop;
  return {
    requireLast30Qty,
    requireDiscountedPrice,
    requireListedDate,
    requireSkuDrop,
    requireSkuAvgDrop,
    skuAvgWindow: windowSize,
    skuAvgThreshold: 10,
    anySelected
  };
}

function hasSkuDrop(records) {
  const skuMap = new Map();
  for (const record of records) {
    const dateText = getRecordDateText(record);
    if (!record || !dateText) continue;
    const skuList = getRecordSkuList(record);
    if (!skuList.length) continue;
    for (const sku of skuList) {
      const name = sku?.name || '';
      const stock = sku?.stock;
      if (!name || typeof stock !== 'number') continue;
      if (!skuMap.has(name)) skuMap.set(name, new Map());
      skuMap.get(name).set(dateText, stock);
    }
  }

  for (const [name, dateMap] of skuMap.entries()) {
    const dates = Array.from(dateMap.keys()).sort();
    let streak = 1;
    let prevDate = null;
    let prevStock = null;
    for (const dateText of dates) {
      const currentStock = dateMap.get(dateText);
      const currentDate = parseYmd(dateText);
      if (!currentDate) {
        streak = 1;
        prevDate = null;
        prevStock = null;
        continue;
      }
      if (prevDate) {
        const diff = daysBetween(prevDate, currentDate);
        const drop = prevStock - currentStock;
        if (diff === 1 && drop >= 10) {
          streak += 1;
        } else {
          streak = 1;
        }
      }
      if (streak >= 5) {
        return true;
      }
      prevDate = currentDate;
      prevStock = currentStock;
    }
  }
  return false;
}

function hasSkuAverageDrop(records, windowSize, avgDropThreshold) {
  const skuMap = new Map();
  for (const record of records) {
    const dateText = getRecordDateText(record);
    const dateObj = dateText ? parseYmd(dateText) : null;
    if (!dateObj) continue;
    const skuList = getRecordSkuList(record);
    if (!skuList.length) continue;
    for (const sku of skuList) {
      const name = sku?.name || '';
      const stock = sku?.stock;
      if (!name || typeof stock !== 'number') continue;
      if (!skuMap.has(name)) skuMap.set(name, new Map());
      skuMap.get(name).set(dateText, { date: dateObj, stock });
    }
  }

  for (const dateMap of skuMap.values()) {
    const entries = Array.from(dateMap.values()).sort((a, b) => a.date - b.date);
    if (entries.length < windowSize) continue;
    const windowEntries = entries.slice(-windowSize);
    const first = windowEntries[0];
    const last = windowEntries[windowEntries.length - 1];
    const totalDays = daysBetween(first.date, last.date);
    if (totalDays <= 0) continue;
    const totalDrop = first.stock - last.stock;
    if (totalDrop <= 0) continue;
    const avgPerDay = totalDrop / totalDays;
    if (avgPerDay >= avgDropThreshold) return true;
  }

  return false;
}

function matchesRules(records, options) {
  if (!records.length) return false;
  const sorted = records
    .slice()
    .sort((a, b) => (getRecordDateText(a) || '').localeCompare(getRecordDateText(b) || ''));
  const latest = sorted[sorted.length - 1];
  if (!latest) return false;

  if (!options?.anySelected) return true;

  if (options?.requireLast30Qty) {
    const last30Qty = getRecordLast30Qty(latest);
    if (last30Qty == null || last30Qty <= 200) return false;
  }

  if (options?.requireDiscountedPrice) {
    const discountedMax = getRecordDiscountedPriceMax(latest);
    if (discountedMax == null || discountedMax <= 150) return false;
  }

  if (options?.requireListedDate) {
    const listedDate = parseYmd(latest.listedDate);
    if (!listedDate) return false;
    const today = new Date();
    if (daysBetween(listedDate, today) > 500) return false;
  }

  if (options?.requireSkuDrop) {
    if (!hasSkuDrop(sorted)) return false;
  }

  if (options?.requireSkuAvgDrop) {
    if (!hasSkuAverageDrop(sorted, options.skuAvgWindow, options.skuAvgThreshold)) return false;
  }

  return true;
}
function appendResult(result) {
  results.push(result);
  setOutput(JSON.stringify(results, null, 2));
  updateDownloadButtons();
  persistResults();
}

function formatJsonl(data) {
  return data.map((item) => JSON.stringify(item)).join('\n');
}

function formatCsv(data) {
  const headers = [
    'url',
    'productId',
    'sellerName',
    'category',
    'currentPricePHPRange',
    'currentPriceCNYRange',
    'originalPriceRange',
    'discount',
    'listedDate',
    'totalQty',
    'last30Qty',
    'totalRevenue',
    'last30Revenue',
    'skuName',
    'skuPrice',
    'skuStock',
    'skuSalesShare',
    'skuSalesEstimate',
    'error'
  ];

  const rows = [headers.join(',')];
  for (const item of data) {
    if (!item || !item.result || !item.result.success) {
      const row = new Array(headers.length).fill('');
      row[0] = item?.url || '';
      row[headers.length - 1] = item?.result?.error || '';
      rows.push(row.map(csvEscape).join(','));
      continue;
    }
    const payload = item.result.data;
    const skuList = payload.sku && payload.sku.length ? payload.sku : [null];
    for (const sku of skuList) {
      rows.push(
        [
          payload.url || '',
          payload.productId || '',
          payload.sellerName || '',
          payload.category || '',
          payload.price?.currentPHPRange ? JSON.stringify(payload.price.currentPHPRange) : '',
          payload.price?.currentCNYRange ? JSON.stringify(payload.price.currentCNYRange) : '',
          payload.price?.originalRange ? JSON.stringify(payload.price.originalRange) : '',
          payload.price?.discount ?? '',
          payload.listedDate || '',
          payload.sales?.totalQty ?? '',
          payload.sales?.last30Qty ?? '',
          payload.sales?.totalRevenue ?? '',
          payload.sales?.last30Revenue ?? '',
          sku?.name || '',
          sku?.price ?? '',
          sku?.stock ?? '',
          sku?.salesShare || '',
          sku?.salesEstimate ?? '',
          ''
        ].map(csvEscape).join(',')
      );
    }
  }

  return rows.join('\n');
}

function formatSnapshotCsv(records) {
  const headers = [
    'date',
    'capturedAt',
    'url',
    'productId',
    'listedDate',
    'originalPriceRange',
    'last30Qty',
    'skus'
  ];
  const rows = [headers.join(',')];
  for (const record of records) {
    const skus = getRecordSkuList(record);
    const capturedAt = record?.capturedAt || record?.extractedAt || '';
    rows.push(
      [
        getRecordDateText(record) || '',
        capturedAt,
        record?.url || '',
        record?.productId ?? '',
        record?.listedDate ?? '',
        (() => {
          const range = getRecordOriginalRange(record);
          return range.length ? JSON.stringify(range) : '';
        })(),
        getRecordLast30Qty(record) ?? '',
        skus.length ? JSON.stringify(skus) : ''
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return rows.join('\n');
}

function csvEscape(value) {
  const stringValue = String(value ?? '');
  if (/[,"\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({
    url,
    filename,
    saveAs: true
  }, () => {
    URL.revokeObjectURL(url);
  });
}

extractCurrentBtn.addEventListener('click', async () => {
  setOutput('提取中...');
  results = [];
  updateDownloadButtons();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setOutput('未找到当前标签页');
    return;
  }
  if (tab.incognito) {
    setOutput('当前为无痕窗口，无法共享登录态');
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'extract' }, (response) => {
    const err = chrome.runtime.lastError;
    if (err) {
      setOutput(`提取失败: ${err.message}`);
      return;
    }
    appendResult({ url: tab.url, result: response });
  });
});

extractBatchBtn.addEventListener('click', async () => {
  const urls = importedUrls.filter(Boolean);

  if (!urls.length) {
    setOutput('请先导入URL文件');
    return;
  }

  results = [];
  updateDownloadButtons();
  setOutput('批量提取中...');
  persistResults();

  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({
    type: 'batch-start',
    urls,
    concurrency: FIXED_BATCH_CONCURRENCY,
    windowId: tab?.windowId,
    incognito: tab?.incognito
  }, (response) => {
    if (!response || !response.started) {
      setOutput(`批量启动失败: ${response?.error || '未知错误'}`);
      batchRunning = false;
      updatePauseButton();
      return;
    }
    batchRunning = true;
    batchPaused = false;
    updatePauseButton();
  });
});

pauseBatchBtn.addEventListener('click', () => {
  const type = batchPaused ? 'batch-resume' : 'batch-pause';
  chrome.runtime.sendMessage({ type }, (response) => {
    if (!response) return;
    batchPaused = Boolean(response.paused);
    batchRunning = true;
    updatePauseButton();
  });
});

importUrlsBtn.addEventListener('click', () => {
  if (!urlFileEl.files || !urlFileEl.files.length) {
    setOutput('请先选择要导入的文件');
    return;
  }

  const file = urlFileEl.files[0];
  const reader = new FileReader();
  reader.onload = () => {
    const text = typeof reader.result === 'string' ? reader.result : '';
    importedUrls = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    setOutput(`已导入 ${file.name}，共 ${importedUrls.length} 条`);
    persistImportedUrls();
    updatePauseButton();
  };
  reader.onerror = () => {
    setOutput('文件读取失败');
  };
  reader.readAsText(file);
});

saveScheduleBtn.addEventListener('click', async () => {
  const scheduleTime = scheduleTimeEl.value || '02:00';
  const categoryUrl = AUTO_CATEGORY_URL;
  const cacheUpdateEnabled = cacheUpdateEnabledEl ? Boolean(cacheUpdateEnabledEl.checked) : true;
  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  storageSet({
    [STORAGE_KEYS.scheduleTime]: scheduleTime,
    categoryUrl,
    [STORAGE_KEYS.cacheUpdateEnabled]: cacheUpdateEnabled
  }).then(() => {
    chrome.runtime.sendMessage(
      {
        type: 'config-update',
        scheduleTime,
        categoryUrl,
        cacheUpdateEnabled,
        windowId: tab?.windowId,
        incognito: tab?.incognito
      },
      (response) => {
        if (!response || !response.ok) {
          setAutoStatus('自动抓取配置保存失败');
          return;
        }
        setAutoStatus('自动抓取配置已保存');
        chrome.runtime.sendMessage({ type: 'config-status' }, (status) => {
          if (!status) return;
          updateScheduleInfo({ lastRunAt: status.lastRunAt, nextRunAt: status.nextRunAt });
        });
      }
    );
  });
});

runDailyNowBtn.addEventListener('click', async () => {
  const scheduleTime = scheduleTimeEl.value || '02:00';
  const cacheUpdateEnabled = cacheUpdateEnabledEl ? Boolean(cacheUpdateEnabledEl.checked) : true;
  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  chrome.runtime.sendMessage(
    {
      type: 'config-update',
      scheduleTime,
      categoryUrl: AUTO_CATEGORY_URL,
      cacheUpdateEnabled,
      windowId: tab?.windowId,
      incognito: tab?.incognito
    },
    () => {
      chrome.runtime.sendMessage({
        type: 'daily-run-now',
        windowId: tab?.windowId,
        incognito: tab?.incognito
      }, () => {
        setAutoStatus('已触发自动抓取任务');
      });
    }
  );
});

if (verifyResumeBtn) {
  verifyResumeBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'verify-resume' }, () => {
      setAutoStatus('已恢复抓取');
      hideVerifyBlock();
    });
  });
}

runFilterBtn.addEventListener('click', async () => {
  setFilterOutput('筛选中...');
  filterUrls = [];
  updateFilterDownloadButton();
  const filterOptions = getFilterOptions();

  const data = await storageGet([STORAGE_KEYS.dailySnapshots]);
  const snapshots = Array.isArray(data[STORAGE_KEYS.dailySnapshots])
    ? data[STORAGE_KEYS.dailySnapshots]
    : [];
  if (!snapshots.length) {
    setFilterOutput('暂无历史数据');
    return;
  }

  const grouped = new Map();
  for (const record of snapshots) {
    if (!record || !record.url) continue;
    if (!grouped.has(record.url)) grouped.set(record.url, []);
    grouped.get(record.url).push(record);
  }

  for (const [url, records] of grouped.entries()) {
    if (matchesRules(records, filterOptions)) {
      const sorted = records
        .slice()
        .sort((a, b) => (getRecordDateText(a) || '').localeCompare(getRecordDateText(b) || ''));
      const latest = sorted[sorted.length - 1];
      const productId = getRecordProductId(latest);
      filterUrls.push({ url, productId });
    }
  }

  updateFilterDownloadButton();
  const lines = [`符合条件 ${filterUrls.length} 条`];
  lines.push('');
  lines.push(...filterUrls.map((item) => `${item.productId || ''}\t${item.url}`));
  setFilterOutput(lines.join('\n'));
});

downloadFilterBtn.addEventListener('click', () => {
  const lines = filterUrls.map((item) => `${item.productId || ''}\t${item.url}`);
  downloadFile(lines.join('\n'), `shopee_filter_${Date.now()}.txt`, 'text/plain');
});

downloadHistoryBtn.addEventListener('click', async () => {
  const data = await storageGet([STORAGE_KEYS.dailySnapshots]);
  const snapshots = Array.isArray(data[STORAGE_KEYS.dailySnapshots])
    ? data[STORAGE_KEYS.dailySnapshots]
    : [];
  if (!snapshots.length) {
    setAutoStatus('暂无历史数据可下载');
    return;
  }
  const lines = snapshots.map((record) => JSON.stringify(record));
  downloadFile(lines.join('\n'), `shopee_history_${Date.now()}.jsonl`, 'text/plain');
});

if (downloadHistoryCsvBtn) {
  downloadHistoryCsvBtn.addEventListener('click', async () => {
    const data = await storageGet([STORAGE_KEYS.dailySnapshots]);
    const snapshots = Array.isArray(data[STORAGE_KEYS.dailySnapshots])
      ? data[STORAGE_KEYS.dailySnapshots]
      : [];
    if (!snapshots.length) {
      setAutoStatus('暂无历史数据可下载');
      return;
    }
    const csv = formatSnapshotCsv(snapshots);
    downloadFile(csv, `shopee_history_${Date.now()}.csv`, 'text/csv');
  });
}

if (viewCacheBtn) {
  viewCacheBtn.addEventListener('click', async () => {
    const data = await storageGet([
      STORAGE_KEYS.cachedCategoryUrl,
      STORAGE_KEYS.cachedCategoryUrls,
      STORAGE_KEYS.cachedCategoryUpdatedAt,
      STORAGE_KEYS.listUrls
    ]);
    const cachedUrls = Array.isArray(data[STORAGE_KEYS.cachedCategoryUrls])
      ? data[STORAGE_KEYS.cachedCategoryUrls]
      : [];
    const fallbackUrls = Array.isArray(data[STORAGE_KEYS.listUrls]) ? data[STORAGE_KEYS.listUrls] : [];
    const urls = cachedUrls.length ? cachedUrls : fallbackUrls;
    if (!urls.length) {
      setAutoStatus('暂无缓存URL');
      return;
    }
    const updatedAt = data[STORAGE_KEYS.cachedCategoryUpdatedAt] || '';
    const lines = [
      `缓存URL: ${data[STORAGE_KEYS.cachedCategoryUrl] || '未记录'}`,
      updatedAt ? `更新时间: ${updatedAt}` : '更新时间: 未记录',
      `数量: ${urls.length}`,
      '',
      ...urls
    ];
    setFilterOutput(lines.join('\n'));
    setActiveTab('auto');
  });
}

if (downloadCacheBtn) {
  downloadCacheBtn.addEventListener('click', async () => {
    const data = await storageGet([
      STORAGE_KEYS.cachedCategoryUrls,
      STORAGE_KEYS.listUrls
    ]);
    const cachedUrls = Array.isArray(data[STORAGE_KEYS.cachedCategoryUrls])
      ? data[STORAGE_KEYS.cachedCategoryUrls]
      : [];
    const fallbackUrls = Array.isArray(data[STORAGE_KEYS.listUrls]) ? data[STORAGE_KEYS.listUrls] : [];
    const urls = cachedUrls.length ? cachedUrls : fallbackUrls;
    if (!urls.length) {
      setAutoStatus('暂无缓存URL可下载');
      return;
    }
    downloadFile(urls.join('\n'), `shopee_cache_${Date.now()}.txt`, 'text/plain');
  });
}

extractListBtn.addEventListener('click', async () => {
  setListOutput('打开固定分类页...');
  listUrls = [];
  updateUrlDownloadButton();
  persistListState(null);

  let tab;
  try {
    tab = await ensureFixedListTab();
  } catch (error) {
    setListOutput(`打开固定分类页失败: ${error.message}`);
    return;
  }

  if (!tab || !tab.id) {
    setListOutput('未能打开固定分类页（请使用非无痕窗口）');
    return;
  }
  if (tab.incognito) {
    setListOutput('当前为无痕窗口，无法共享登录态');
    return;
  }

  setListOutput('页面加载完成，开始抓取...');
  chrome.tabs.sendMessage(
    tab.id,
    { type: 'collect-product-urls', paginate: autoPaginateEl.checked, maxPages: MAX_LIST_PAGES },
    (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        setListOutput(`抓取失败: ${err.message}`);
        return;
      }
      if (!response || !response.success) {
        setListOutput(`抓取失败: ${response?.error || '未知错误'}`);
        return;
      }

      listUrls = response.urls || [];
      updateUrlDownloadButton();
      const lines = [
        `共 ${listUrls.length} 条链接`,
        `页数: ${response.pages || 0}`
      ];
      if (response.warnings && response.warnings.length) {
        lines.push(`提示: ${response.warnings.join('；')}`);
      }
      persistListState({
        pages: response.pages || 0,
        warnings: response.warnings || []
      });
      lines.push('');
      lines.push(...listUrls);
      setListOutput(lines.join('\n'));
    }
  );
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'batch-progress') {
    batchRunning = true;
    appendResult({
      url: message.payload.url,
      result: message.payload.result
    });
    updatePauseButton();
  }
  if (message.type === 'batch-complete') {
    if (Array.isArray(message.results) && message.results.length) {
      results = message.results;
    }
    setOutput(JSON.stringify(results, null, 2));
    batchRunning = false;
    batchPaused = false;
    updatePauseButton();
    persistResults();
  }
  if (message.type === 'verify-blocked') {
    showVerifyBlock({ url: message.url, until: message.until });
    setAutoStatus('触发验证页，已暂停抓取');
  }
  if (message.type === 'verify-clear') {
    hideVerifyBlock();
    setAutoStatus('验证已清除，抓取已继续');
  }
});

downloadJsonBtn.addEventListener('click', () => {
  downloadFile(formatJsonl(results), `shopdora_${Date.now()}.jsonl`, 'text/plain');
});

downloadCsvBtn.addEventListener('click', () => {
  const csv = formatCsv(results);
  downloadFile(csv, `shopdora_${Date.now()}.csv`, 'text/csv');
});

downloadUrlsBtn.addEventListener('click', () => {
  downloadFile(listUrls.join('\n'), `shopee_urls_${Date.now()}.txt`, 'text/plain');
});

setOutput('等待提取...');
setListOutput('等待抓取...');
setFilterOutput('等待筛选...');
updateUrlDownloadButton();
updatePauseButton();
updateFilterDownloadButton();

bindSessionContext();

if (tabButtons.length) {
  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const tabName = button.dataset.tab;
      if (tabName) setActiveTab(tabName);
    });
  });
  restoreActiveTab();
}


async function restoreState() {
  const data = await storageGet([
    STORAGE_KEYS.importedUrls,
    STORAGE_KEYS.listUrls,
    STORAGE_KEYS.listMeta,
    STORAGE_KEYS.batchResults,
    STORAGE_KEYS.scheduleTime,
    STORAGE_KEYS.cacheUpdateEnabled,
    STORAGE_KEYS.lastRunAt,
    STORAGE_KEYS.nextRunAt
  ]);

  importedUrls = Array.isArray(data[STORAGE_KEYS.importedUrls]) ? data[STORAGE_KEYS.importedUrls] : [];
  listUrls = Array.isArray(data[STORAGE_KEYS.listUrls]) ? data[STORAGE_KEYS.listUrls] : [];
  results = Array.isArray(data[STORAGE_KEYS.batchResults]) ? data[STORAGE_KEYS.batchResults] : [];

  const savedSchedule = data[STORAGE_KEYS.scheduleTime];
  if (savedSchedule) {
    scheduleTimeEl.value = savedSchedule;
  }
  if (cacheUpdateEnabledEl) {
    const savedCacheUpdate = data[STORAGE_KEYS.cacheUpdateEnabled];
    cacheUpdateEnabledEl.checked = savedCacheUpdate !== false;
  }
  updateScheduleInfo({
    lastRunAt: data[STORAGE_KEYS.lastRunAt] || null,
    nextRunAt: data[STORAGE_KEYS.nextRunAt] || null
  });

  updateDownloadButtons();
  updateUrlDownloadButton();
  updatePauseButton();

  if (results.length) {
    setOutput(JSON.stringify(results, null, 2));
  } else if (importedUrls.length) {
    setOutput(`已导入 ${importedUrls.length} 条URL`);
  }

  if (listUrls.length) {
    const meta = data[STORAGE_KEYS.listMeta] || {};
    const lines = [
      `共 ${listUrls.length} 条链接`,
      `页数: ${meta.pages || 0}`
    ];
    if (meta.warnings && meta.warnings.length) {
      lines.push(`提示: ${meta.warnings.join('；')}`);
    }
    lines.push('');
    lines.push(...listUrls);
    setListOutput(lines.join('\n'));
  }

  chrome.runtime.sendMessage({ type: 'batch-status' }, (response) => {
    if (!response) return;
    batchPaused = Boolean(response.paused);
    batchRunning = Boolean(response.running);
    updatePauseButton();
  });

  chrome.runtime.sendMessage({ type: 'config-status' }, (status) => {
    if (!status) return;
    if (status.scheduleTime) scheduleTimeEl.value = status.scheduleTime;
    if (cacheUpdateEnabledEl && typeof status.cacheUpdateEnabled === 'boolean') {
      cacheUpdateEnabledEl.checked = status.cacheUpdateEnabled;
    }
    updateScheduleInfo({ lastRunAt: status.lastRunAt, nextRunAt: status.nextRunAt });
    if (status.verifyBlocked) {
      showVerifyBlock({ url: status.verifyBlockedUrl, until: status.verifyBlockedUntil });
    } else {
      hideVerifyBlock();
    }
  });
}

restoreState();
