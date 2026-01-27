const outputEl = document.getElementById('output');
const listOutputEl = document.getElementById('listOutput');
const urlFileEl = document.getElementById('urlFile');
const importUrlsBtn = document.getElementById('importUrls');
const concurrencyEl = document.getElementById('concurrency');
const extractCurrentBtn = document.getElementById('extractCurrent');
const extractBatchBtn = document.getElementById('extractBatch');
const pauseBatchBtn = document.getElementById('pauseBatch');
const extractListBtn = document.getElementById('extractList');
const downloadJsonBtn = document.getElementById('downloadJson');
const downloadCsvBtn = document.getElementById('downloadCsv');
const downloadUrlsBtn = document.getElementById('downloadUrls');
const autoPaginateEl = document.getElementById('autoPaginate');
const categoryUrlEl = document.getElementById('categoryUrl');
const scheduleTimeEl = document.getElementById('scheduleTime');
const saveScheduleBtn = document.getElementById('saveSchedule');
const runDailyNowBtn = document.getElementById('runDailyNow');
const scheduleInfoEl = document.getElementById('scheduleInfo');
const runFilterBtn = document.getElementById('runFilter');
const downloadFilterBtn = document.getElementById('downloadFilter');
const filterOutputEl = document.getElementById('filterOutput');
const downloadHistoryBtn = document.getElementById('downloadHistory');

let results = [];
let listUrls = [];
let importedUrls = [];
const MAX_LIST_PAGES = 50;
let batchPaused = false;
let batchRunning = false;
let filterUrls = [];
const STORAGE_KEYS = {
  importedUrls: 'importedUrls',
  listUrls: 'listUrls',
  listMeta: 'listMeta',
  batchResults: 'batchResults',
  concurrency: 'batchConcurrency',
  scheduleTime: 'scheduleTime',
  categoryUrl: 'categoryUrl',
  dailySnapshots: 'dailySnapshots',
  lastRunAt: 'lastRunAt',
  nextRunAt: 'nextRunAt'
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

function normalizeConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return 1;
  return Math.min(10, Math.max(1, parsed));
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

function persistConcurrency(value) {
  return storageSet({ [STORAGE_KEYS.concurrency]: value });
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

function updateFilterDownloadButton() {
  downloadFilterBtn.disabled = filterUrls.length === 0;
}

function hasSkuDrop(records) {
  const skuMap = new Map();
  for (const record of records) {
    if (!record || !record.date || !Array.isArray(record.skus)) continue;
    for (const sku of record.skus) {
      const name = sku?.name || '';
      const stock = sku?.stock;
      if (!name || typeof stock !== 'number') continue;
      if (!skuMap.has(name)) skuMap.set(name, new Map());
      skuMap.get(name).set(record.date, stock);
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

function matchesRules(records) {
  if (!records.length) return false;
  const sorted = records.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const latest = sorted[sorted.length - 1];
  if (!latest) return false;

  const last30Qty = typeof latest.last30Qty === 'number' ? latest.last30Qty : null;
  if (last30Qty == null || last30Qty <= 200) return false;

  const originalPrice = typeof latest.originalPrice === 'number' ? latest.originalPrice : null;
  if (originalPrice == null || originalPrice <= 150) return false;

  const listedDate = parseYmd(latest.listedDate);
  if (!listedDate) return false;
  const today = new Date();
  if (daysBetween(listedDate, today) > 500) return false;

  if (!hasSkuDrop(sorted)) return false;

  return true;
}
function appendResult(result) {
  results.push(result);
  setOutput(JSON.stringify(results, null, 2));
  updateDownloadButtons();
  persistResults();
}

function formatCsv(data) {
  const headers = [
    'url',
    'productId',
    'sellerName',
    'category',
    'currentPricePHP',
    'currentPriceCNY',
    'originalPrice',
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
      rows.push([item.url || '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', item?.result?.error || ''].map(csvEscape).join(','));
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
          payload.price?.currentPHP ?? '',
          payload.price?.currentCNY ?? '',
          payload.price?.original ?? '',
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

  chrome.tabs.sendMessage(tab.id, { type: 'extract' }, (response) => {
    const err = chrome.runtime.lastError;
    if (err) {
      setOutput(`提取失败: ${err.message}`);
      return;
    }
    appendResult({ url: tab.url, result: response });
  });
});

extractBatchBtn.addEventListener('click', () => {
  const urls = importedUrls.filter(Boolean);

  if (!urls.length) {
    setOutput('请先导入URL文件');
    return;
  }

  const concurrency = normalizeConcurrency(concurrencyEl.value);
  concurrencyEl.value = String(concurrency);
  persistConcurrency(concurrency);
  results = [];
  updateDownloadButtons();
  setOutput('批量提取中...');
  persistResults();

  chrome.runtime.sendMessage({ type: 'batch-start', urls, concurrency }, (response) => {
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

concurrencyEl.addEventListener('change', () => {
  const value = normalizeConcurrency(concurrencyEl.value);
  concurrencyEl.value = String(value);
  persistConcurrency(value);
});

saveScheduleBtn.addEventListener('click', () => {
  const scheduleTime = scheduleTimeEl.value || '02:00';
  const categoryUrl = (categoryUrlEl.value || '').trim();
  storageSet({
    [STORAGE_KEYS.scheduleTime]: scheduleTime,
    [STORAGE_KEYS.categoryUrl]: categoryUrl
  }).then(() => {
    chrome.runtime.sendMessage(
      { type: 'config-update', scheduleTime, categoryUrl },
      (response) => {
        if (!response || !response.ok) {
          setOutput('自动抓取配置保存失败');
          return;
        }
        setOutput('自动抓取配置已保存');
        chrome.runtime.sendMessage({ type: 'config-status' }, (status) => {
          if (!status) return;
          updateScheduleInfo({ lastRunAt: status.lastRunAt, nextRunAt: status.nextRunAt });
        });
      }
    );
  });
});

runDailyNowBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'daily-run-now' }, () => {
    setOutput('已触发自动抓取任务');
  });
});

runFilterBtn.addEventListener('click', async () => {
  setFilterOutput('筛选中...');
  filterUrls = [];
  updateFilterDownloadButton();

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
    if (matchesRules(records)) {
      filterUrls.push(url);
    }
  }

  updateFilterDownloadButton();
  const lines = [`符合条件 ${filterUrls.length} 条`];
  lines.push('');
  lines.push(...filterUrls);
  setFilterOutput(lines.join('\n'));
});

downloadFilterBtn.addEventListener('click', () => {
  downloadFile(filterUrls.join('\n'), `shopee_filter_${Date.now()}.txt`, 'text/plain');
});

downloadHistoryBtn.addEventListener('click', async () => {
  const data = await storageGet([STORAGE_KEYS.dailySnapshots]);
  const snapshots = Array.isArray(data[STORAGE_KEYS.dailySnapshots])
    ? data[STORAGE_KEYS.dailySnapshots]
    : [];
  if (!snapshots.length) {
    setOutput('暂无历史数据可下载');
    return;
  }
  const lines = snapshots.map((record) => JSON.stringify(record));
  downloadFile(lines.join('\n'), `shopee_history_${Date.now()}.jsonl`, 'text/plain');
});

extractListBtn.addEventListener('click', async () => {
  setListOutput('抓取中...');
  listUrls = [];
  updateUrlDownloadButton();
  persistListState(null);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setListOutput('未找到当前标签页');
    return;
  }

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
    setOutput(JSON.stringify(results, null, 2));
    batchRunning = false;
    batchPaused = false;
    updatePauseButton();
    persistResults();
  }
});

downloadJsonBtn.addEventListener('click', () => {
  downloadFile(JSON.stringify(results, null, 2), `shopdora_${Date.now()}.json`, 'application/json');
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

async function restoreState() {
  const data = await storageGet([
    STORAGE_KEYS.importedUrls,
    STORAGE_KEYS.listUrls,
    STORAGE_KEYS.listMeta,
    STORAGE_KEYS.batchResults,
    STORAGE_KEYS.concurrency,
    STORAGE_KEYS.scheduleTime,
    STORAGE_KEYS.categoryUrl,
    STORAGE_KEYS.lastRunAt,
    STORAGE_KEYS.nextRunAt
  ]);

  importedUrls = Array.isArray(data[STORAGE_KEYS.importedUrls]) ? data[STORAGE_KEYS.importedUrls] : [];
  listUrls = Array.isArray(data[STORAGE_KEYS.listUrls]) ? data[STORAGE_KEYS.listUrls] : [];
  results = Array.isArray(data[STORAGE_KEYS.batchResults]) ? data[STORAGE_KEYS.batchResults] : [];
  const savedConcurrency = data[STORAGE_KEYS.concurrency];
  if (savedConcurrency) {
    concurrencyEl.value = String(normalizeConcurrency(savedConcurrency));
  }

  const savedSchedule = data[STORAGE_KEYS.scheduleTime];
  if (savedSchedule) {
    scheduleTimeEl.value = savedSchedule;
  }
  const savedCategory = data[STORAGE_KEYS.categoryUrl];
  if (savedCategory) {
    categoryUrlEl.value = savedCategory;
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
    if (response.concurrency) {
      concurrencyEl.value = String(normalizeConcurrency(response.concurrency));
    }
    updatePauseButton();
  });

  chrome.runtime.sendMessage({ type: 'config-status' }, (status) => {
    if (!status) return;
    if (status.scheduleTime) scheduleTimeEl.value = status.scheduleTime;
    if (status.categoryUrl) categoryUrlEl.value = status.categoryUrl;
    updateScheduleInfo({ lastRunAt: status.lastRunAt, nextRunAt: status.nextRunAt });
  });
}

restoreState();
