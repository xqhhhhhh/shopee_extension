const outputEl = document.getElementById('output');
const urlListEl = document.getElementById('urlList');
const extractCurrentBtn = document.getElementById('extractCurrent');
const extractBatchBtn = document.getElementById('extractBatch');
const downloadJsonBtn = document.getElementById('downloadJson');
const downloadCsvBtn = document.getElementById('downloadCsv');

let results = [];

function setOutput(text) {
  outputEl.textContent = text;
}

function updateDownloadButtons() {
  const hasData = results.length > 0;
  downloadJsonBtn.disabled = !hasData;
  downloadCsvBtn.disabled = !hasData;
}

function appendResult(result) {
  results.push(result);
  setOutput(JSON.stringify(results, null, 2));
  updateDownloadButtons();
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
  const urls = urlListEl.value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!urls.length) {
    setOutput('请先输入URL列表');
    return;
  }

  results = [];
  updateDownloadButtons();
  setOutput('批量提取中...');

  chrome.runtime.sendMessage({ type: 'batch-start', urls }, (response) => {
    if (!response || !response.started) {
      setOutput(`批量启动失败: ${response?.error || '未知错误'}`);
    }
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'batch-progress') {
    appendResult({
      url: message.payload.url,
      result: message.payload.result
    });
  }
  if (message.type === 'batch-complete') {
    setOutput(JSON.stringify(results, null, 2));
  }
});

downloadJsonBtn.addEventListener('click', () => {
  downloadFile(JSON.stringify(results, null, 2), `shopdora_${Date.now()}.json`, 'application/json');
});

downloadCsvBtn.addEventListener('click', () => {
  const csv = formatCsv(results);
  downloadFile(csv, `shopdora_${Date.now()}.csv`, 'text/csv');
});

setOutput('等待提取...');
