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

let results = [];
let listUrls = [];
let importedUrls = [];
const MAX_LIST_PAGES = 50;
let batchPaused = false;
let batchRunning = false;
const STORAGE_KEYS = {
  importedUrls: 'importedUrls',
  listUrls: 'listUrls',
  listMeta: 'listMeta',
  batchResults: 'batchResults',
  concurrency: 'batchConcurrency'
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
updateUrlDownloadButton();
updatePauseButton();

async function restoreState() {
  const data = await storageGet([
    STORAGE_KEYS.importedUrls,
    STORAGE_KEYS.listUrls,
    STORAGE_KEYS.listMeta,
    STORAGE_KEYS.batchResults,
    STORAGE_KEYS.concurrency
  ]);

  importedUrls = Array.isArray(data[STORAGE_KEYS.importedUrls]) ? data[STORAGE_KEYS.importedUrls] : [];
  listUrls = Array.isArray(data[STORAGE_KEYS.listUrls]) ? data[STORAGE_KEYS.listUrls] : [];
  results = Array.isArray(data[STORAGE_KEYS.batchResults]) ? data[STORAGE_KEYS.batchResults] : [];
  const savedConcurrency = data[STORAGE_KEYS.concurrency];
  if (savedConcurrency) {
    concurrencyEl.value = String(normalizeConcurrency(savedConcurrency));
  }

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
}

restoreState();
