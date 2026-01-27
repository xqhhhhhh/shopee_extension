(() => {
  const MAX_WAIT_MS = 30000;
  const POLL_INTERVAL_MS = 500;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseRgb(color) {
    if (!color || color === 'transparent') return null;
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
    if (!m) return null;
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: m[4] == null ? 1 : Number(m[4])
    };
  }

  function rgbToHsl({ r, g, b }) {
    const rN = r / 255;
    const gN = g / 255;
    const bN = b / 255;
    const max = Math.max(rN, gN, bN);
    const min = Math.min(rN, gN, bN);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case rN:
          h = (gN - bN) / d + (gN < bN ? 6 : 0);
          break;
        case gN:
          h = (bN - rN) / d + 2;
          break;
        default:
          h = (rN - gN) / d + 4;
      }
      h *= 60;
    }
    return { h, s: s * 100, l: l * 100 };
  }

  function isOrange(color) {
    const rgb = parseRgb(color);
    if (!rgb || rgb.a === 0) return false;
    const { h, s, l } = rgbToHsl(rgb);
    return h >= 15 && h <= 50 && s >= 35 && l >= 20 && l <= 85;
  }

  function* traverse(root) {
    if (!root) return;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      yield node;
      const children = node.children ? Array.from(node.children) : [];
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push(children[i]);
      }
      if (node.shadowRoot) {
        stack.push(node.shadowRoot);
      }
    }
  }

  function elementHasShopdoraHint(el) {
    if (!(el instanceof HTMLElement)) return false;
    const text = (el.innerText || el.textContent || '').trim();
    if (text && /shopdora/i.test(text)) return true;
    const attrs = el.getAttributeNames();
    for (const name of attrs) {
      const value = el.getAttribute(name);
      if ((name && /shopdora/i.test(name)) || (value && /shopdora/i.test(value))) {
        return true;
      }
    }
    return false;
  }

  function findShopdoraRoot() {
    const direct = document.querySelector('#shopdora-detailPage, #shopdora-shopee-product-detail');
    if (direct) return direct;

    const candidates = [];
    let scanned = 0;
    for (const node of traverse(document.body)) {
      scanned += 1;
      if (scanned > 8000) break;
      if (!(node instanceof HTMLElement)) continue;
      if (elementHasShopdoraHint(node)) {
        candidates.push(node);
      }
    }

    const fallback = Array.from(document.querySelectorAll('[class*="shopdora" i], [id*="shopdora" i]'));
    for (const el of fallback) {
      if (!candidates.includes(el)) candidates.push(el);
    }

    if (!candidates.length) return null;

    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      let current = candidate;
      for (let depth = 0; depth < 6 && current; depth += 1) {
        const rect = current.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        const style = getComputedStyle(current);
        const orangeScore = isOrange(style.backgroundColor) ? 10000 : 0;
        const textLen = ((current.innerText || '').length || 0);
        const score = area + orangeScore + textLen;
        if (score > bestScore) {
          bestScore = score;
          best = current;
        }
        current = current.parentElement;
      }
    }
    return best;
  }

  function normalizeNumber(value) {
    if (!value) return null;
    const clean = value.replace(/[,\s]/g, '');
    const num = Number(clean);
    return Number.isNaN(num) ? null : num;
  }

  function extractFirstMatch(text, patterns) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match;
    }
    return null;
  }

  function extractCurrency(text, symbol) {
    const re = new RegExp(`${symbol}\\s*([\\d,.]+)`);
    const m = text.match(re);
    return m ? normalizeNumber(m[1]) : null;
  }

  function extractAllCurrency(text, symbol) {
    if (!text) return [];
    const re = new RegExp(`${symbol}\\s*([\\d,.]+)`, 'g');
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = normalizeNumber(m[1]);
      if (value != null) matches.push(value);
    }
    return matches;
  }

  function extractLabelValue(lines, labelPatterns) {
    for (const line of lines) {
      for (const pattern of labelPatterns) {
        const match = line.match(pattern);
        if (match) {
          return (match[1] || match[2] || '').trim();
        }
      }
    }
    return null;
  }

  function parseKeyValueLines(text) {
    const lines = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const map = new Map();
    for (const line of lines) {
      if (line.includes(':') || line.includes('：')) {
        const parts = line.split(/[:：]/);
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts.slice(1).join(':').trim();
          if (key && value) map.set(key, value);
        }
      }
    }
    return { lines, map };
  }

  function parseSkuTables(root) {
    const skuRows = [];
    const tables = Array.from(root.querySelectorAll('table'));
    for (const table of tables) {
      const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
      if (!headerRow) continue;
      const headerCells = Array.from(headerRow.querySelectorAll('th, td'));
      const headers = headerCells.map((cell) => (cell.innerText || '').trim());
      const headerText = headers.join(' ');
      if (!/sku|规格|型号|款式|名称/i.test(headerText)) continue;
      const headerKeys = headerCells.map((cell, idx) => {
        const colKey = (cell.getAttribute('data-colkey') || '').trim();
        if (colKey) {
          if (colKey === 'sku') return 'name';
          if (colKey === 'unitPrice') return 'price';
          if (colKey === 'salesRatePercent') return 'salesShare';
          if (colKey === 'stockNum') return 'stock';
          if (colKey === 'sales') return 'salesEstimate';
        }
        const header = headers[idx] || '';
        const normalized = header.replace(/\s+/g, '');
        if (!normalized) return null;
        if (/销量预估|预估|salesestimate|estimate/i.test(normalized)) return 'salesEstimate';
        if (/销量占比|占比|share|比例|percent|%/i.test(normalized)) return 'salesShare';
        if (/库存|stock/i.test(normalized)) return 'stock';
        if (/价格|售价|price/i.test(normalized)) return 'price';
        if (/^sku$/i.test(header.trim())) return 'name';
        if (/sku/i.test(normalized) && !/价格|售价|销量占比|占比|库存|销量预估|预估|share|percent|stock|price/i.test(normalized)) {
          return 'name';
        }
        return null;
      });
      const hasMappedKeys = headerKeys.some(Boolean);

      const rows = Array.from(table.querySelectorAll('tbody tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (!cells.length) continue;
        const sku = {
          name: null,
          price: null,
          stock: null,
          salesShare: null,
          salesEstimate: null
        };
        cells.forEach((cell, idx) => {
          let key = headerKeys[idx];
          if (!key && !hasMappedKeys) {
            if (idx === 0) key = 'name';
            if (idx === 1) key = 'price';
            if (idx === 2) key = 'salesShare';
            if (idx === 3) key = 'stock';
            if (idx === 4) key = 'salesEstimate';
          }
          if (!key) return;
          const value = ((cell.textContent || cell.innerText) || '').trim();
          if (!value) return;
          if (key === 'name') {
            sku.name = value;
          } else if (key === 'price') {
            sku.price = normalizeNumber(value.replace(/[^\d.,]/g, ''));
          } else if (key === 'stock') {
            sku.stock = normalizeNumber(value.replace(/[^\d.,]/g, ''));
          } else if (key === 'salesShare') {
            const shareMatch = value.match(/([\d.]+%)/);
            sku.salesShare = shareMatch ? shareMatch[1] : sku.salesShare;
          } else if (key === 'salesEstimate') {
            sku.salesEstimate = normalizeNumber(value.replace(/[^\d.,]/g, ''));
          }
        });

        if (sku.name || sku.price || sku.stock || sku.salesShare || sku.salesEstimate) {
          skuRows.push(sku);
        }
      }
    }
    return skuRows;
  }

  function getItemValueByTitle(root, titlePattern) {
    const items = Array.from(root.querySelectorAll('.detail-info-item'));
    for (const item of items) {
      const titleEl = item.querySelector('.detail-info-item-title');
      const valueEl = item.querySelector('.detail-info-item-main .item-main');
      if (!titleEl || !valueEl) continue;
      const title = (titleEl.innerText || '').trim();
      if (titlePattern.test(title)) {
        return (valueEl.innerText || '').trim();
      }
    }
    return null;
  }

  function extractLabeledPrice(lines) {
    const priceText = extractLabelValue(lines, [
      /(?:当前售价|售价|Price|价格)\s*[:：]\s*(.+)/i
    ]);
    if (!priceText) return { php: null, cny: null };
    return {
      php: extractCurrency(priceText, '₱'),
      cny: extractCurrency(priceText, '¥')
    };
  }

  function extractModulePrice(root) {
    const result = {
      currentPHP: null,
      currentCNY: null,
      original: null,
      discount: null
    };

    const cnyEl = root.querySelector('.shopdoraPirceList') || document.querySelector('.shopdoraPirceList');
    if (cnyEl) {
      result.currentCNY = extractCurrency(cnyEl.textContent || '', '¥');
    }

    let priceText = '';
    const priceContainer =
      (root.querySelector('.flex.flex-column.IFdRIb') || document.querySelector('.flex.flex-column.IFdRIb')) ||
      (cnyEl ? cnyEl.closest('section') || cnyEl.parentElement : null);
    if (priceContainer) {
      priceText = priceContainer.textContent || '';
    }

    const priceBlock = root.querySelector('.jRlVo0') || document.querySelector('.jRlVo0');
    if (priceBlock) {
      const currentEl = priceBlock.querySelector('.IZPeQz');
      const originalEl = priceBlock.querySelector('.ZA5sW5');
      const discountEl = priceBlock.querySelector('.vms4_3');
      if (currentEl) {
        result.currentPHP = extractCurrency(currentEl.textContent || '', '₱');
      }
      if (originalEl) {
        result.original = extractCurrency(originalEl.textContent || '', '₱');
      }
      if (discountEl) {
        const discountMatch = (discountEl.textContent || '').match(/-?\d+(?:\.\d+)?%/);
        result.discount = discountMatch ? discountMatch[0] : result.discount;
      }
      if (!priceText) {
        priceText = priceBlock.textContent || '';
      }
    }

    if (!priceText) {
      const scope = cnyEl?.closest('#shopdora-detailPage') || root;
      const candidates = Array.from(scope.querySelectorAll('section, div')).filter((el) => {
        const text = (el.textContent || '').trim();
        return text.includes('₱') && text.includes('%');
      });
      if (candidates.length) {
        priceText = candidates.sort((a, b) => a.textContent.length - b.textContent.length)[0].textContent || '';
      }
    }

    if (priceText) {
      const text = priceText;
      const phpValues = extractAllCurrency(text, '₱');
      if (phpValues.length) {
        result.currentPHP = phpValues[0] ?? null;
        result.original = phpValues[1] ?? null;
      }
      const discountMatch = text.match(/-?\\d+(?:\\.\\d+)?%/);
      if (discountMatch) {
        result.discount = discountMatch[0];
      }
    }

    return result;
  }

  function parseSkuFromText(lines) {
    const results = [];
    for (const line of lines) {
      if (!/%/.test(line)) continue;
      const m = line.match(
        /^(.+?)\s+(?:₱|PHP|P|¥|CNY)\s*([\d,.]+)\s+([\d.]+%)\s+([\d,.]+)\s+([\d,.]+)$/
      );
      if (!m) continue;
      results.push({
        name: m[1].trim(),
        price: normalizeNumber(m[2]),
        salesShare: m[3],
        stock: normalizeNumber(m[4]),
        salesEstimate: normalizeNumber(m[5])
      });
    }
    return results;
  }

  function extractData(root) {
    const warnings = [];
    const text = root.innerText || root.textContent || '';
    const { lines } = parseKeyValueLines(text);

    const url = location.href;
    const idMatch = url.match(/i\.(\d+)\.(\d+)/);
    const moduleIdText = getItemValueByTitle(root, /商品id|商品ID|Product ID/i);
    const moduleIdMatch = moduleIdText ? moduleIdText.match(/\d+/) : null;
    const productId = idMatch ? idMatch[2] : moduleIdMatch ? moduleIdMatch[0] : null;

    const sellerName =
      getItemValueByTitle(root, /卖家|Seller/i) ||
      extractLabelValue(lines, [/卖家\s*[:：]\s*(.+)/i, /Seller\s*[:：]\s*(.+)/i]);

    const category =
      getItemValueByTitle(root, /类目|Category/i) ||
      extractLabelValue(lines, [/类目\s*[:：]\s*(.+)/i, /Category\s*[:：]\s*(.+)/i]);

    const listedText =
      getItemValueByTitle(root, /上架时间|Listing Date|Listed on/i) ||
      extractLabelValue(lines, [/上架时间\s*[:：]\s*(.+)/i, /Listing Date\s*[:：]\s*(.+)/i]);
    const listedMatch = listedText ? listedText.match(/(\d{4}-\d{2}-\d{2})/) : null;
    const listedDate = listedMatch ? listedMatch[1] : null;

    const modulePrice = extractModulePrice(root);
    let currentPricePHP = modulePrice.currentPHP;
    let currentPriceCNY = modulePrice.currentCNY;
    const originalPrice = modulePrice.original;
    const discount = modulePrice.discount;

    const totalSalesText = getItemValueByTitle(root, /总销量|Total Sold|Total Sales/i) || '';
    const totalSalesMatch =
      totalSalesText.match(/([\d,.]+)/) ||
      extractFirstMatch(text, [/(?:总销量|Total Sales|Total Sold)\s*[:：]?\s*([\d,.]+)/i]);

    const last30SalesText = getItemValueByTitle(root, /近30日销量|30天销量|Last 30 days/i) || '';
    const last30SalesMatch =
      last30SalesText.match(/([\d,.]+)/) ||
      extractFirstMatch(text, [/(?:近30日销量|30天销量|Last 30 days(?: sales| sold)?)\s*[:：]?\s*([\d,.]+)/i]);

    const totalRevenueText = getItemValueByTitle(root, /总销售额|Total Revenue|Total GMV/i) || '';
    const totalRevenueMatch =
      totalRevenueText.match(/([\d,.]+)/) ||
      extractFirstMatch(text, [/(?:总销售额|Total Revenue|Total GMV)\s*[:：]?\s*(?:₱|PHP|P|¥|CNY)?\s*([\d,.]+)/i]);

    const last30RevenueText = getItemValueByTitle(root, /近30日销售额|30天销售额|Last 30 days revenue/i) || '';
    const last30RevenueMatch =
      last30RevenueText.match(/([\d,.]+)/) ||
      extractFirstMatch(text, [/(?:近30日销售额|30天销售额|Last 30 days revenue)\s*[:：]?\s*(?:₱|PHP|P|¥|CNY)?\s*([\d,.]+)/i]);

    const skuTableRows = parseSkuTables(root);
    const skuFromText = skuTableRows.length ? [] : parseSkuFromText(lines);
    const skus = skuTableRows.length ? skuTableRows : skuFromText;
    if (!currentPriceCNY && skus.length && skus[0].price != null) {
      currentPriceCNY = skus[0].price;
    }

    if (!productId) warnings.push('未能从URL解析商品ID');
    if (!sellerName) warnings.push('未找到卖家名称');
    if (!category) warnings.push('未找到类目信息');
    if (!listedDate) warnings.push('未找到上架时间');
    if (!skus.length) warnings.push('未找到SKU表格或SKU行');

    return {
      url,
      productId,
      sellerName,
      category,
      price: {
        currentPHP: currentPricePHP,
        currentCNY: currentPriceCNY,
        original: originalPrice,
        discount
      },
      listedDate,
      sales: {
        totalQty: totalSalesMatch ? normalizeNumber(totalSalesMatch[1]) : null,
        last30Qty: last30SalesMatch ? normalizeNumber(last30SalesMatch[1]) : null,
        totalRevenue: totalRevenueMatch ? normalizeNumber(totalRevenueMatch[1]) : null,
        last30Revenue: last30RevenueMatch ? normalizeNumber(last30RevenueMatch[1]) : null
      },
      sku: skus,
      extractedAt: new Date().toISOString(),
      warnings
    };
  }

  async function waitForShopdoraRoot(timeoutMs = MAX_WAIT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const root = findShopdoraRoot();
      if (root) return root;
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  function buildDataSignature(data) {
    if (!data) return '';
    const price = data.price || {};
    const sales = data.sales || {};
    const skuSig = (data.sku || [])
      .map((row) => [
        row?.name ?? '',
        row?.price ?? '',
        row?.stock ?? '',
        row?.salesShare ?? '',
        row?.salesEstimate ?? ''
      ].join('|'))
      .join(';;');

    return [
      data.productId ?? '',
      data.sellerName ?? '',
      data.category ?? '',
      data.listedDate ?? '',
      price.currentPHP ?? '',
      price.currentCNY ?? '',
      price.original ?? '',
      price.discount ?? '',
      sales.totalQty ?? '',
      sales.last30Qty ?? '',
      sales.totalRevenue ?? '',
      sales.last30Revenue ?? '',
      skuSig
    ].join('::');
  }

  function isPlaceholderText(text) {
    if (!text) return true;
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (/加载|loading/i.test(trimmed)) return true;
    if (/^(\.{2,}|-+|—+)$/.test(trimmed)) return true;
    return false;
  }

  function getSkuTableStatus(root) {
    const tables = Array.from(root.querySelectorAll('table'));
    for (const table of tables) {
      const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
      if (!headerRow) continue;
      const headerCells = Array.from(headerRow.querySelectorAll('th, td'));
      const headerText = headerCells.map((cell) => (cell.innerText || '').trim()).join(' ');
      if (!/sku|规格|型号|款式|名称/i.test(headerText)) continue;

      const rows = Array.from(table.querySelectorAll('tbody tr'));
      let totalRows = 0;
      let completeRows = 0;
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (!cells.length) continue;
        totalRows += 1;
        const isComplete = cells.every((cell) => !isPlaceholderText(cell.textContent || ''));
        if (isComplete) completeRows += 1;
      }

      return {
        hasTable: true,
        totalRows,
        completeRows,
        isComplete: totalRows > 0 && totalRows === completeRows
      };
    }
    return { hasTable: false, totalRows: 0, completeRows: 0, isComplete: false };
  }

  function hasMinimumData(data, tableStatus) {
    if (tableStatus?.hasTable) {
      return tableStatus.totalRows > 0;
    }
    return Boolean(data && data.sku && data.sku.length);
  }

  async function waitForStableData(root, { timeoutMs, pollMs, stableRounds, idleMs }) {
    let lastSignature = '';
    let stableCount = 0;
    let lastData = null;
    const start = Date.now();
    let lastMutation = Date.now();
    const observer = new MutationObserver(() => {
      lastMutation = Date.now();
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });

    try {
      while (Date.now() - start < timeoutMs) {
        const data = extractData(root);
        const tableStatus = getSkuTableStatus(root);
        const signature = `${buildDataSignature(data)}::${tableStatus.totalRows}::${tableStatus.completeRows}`;
        if (signature && signature === lastSignature) {
          stableCount += 1;
        } else {
          stableCount = 0;
          lastSignature = signature;
        }
        lastData = data;
        const idleEnough = Date.now() - lastMutation >= idleMs;
        const dataReady = tableStatus.hasTable ? tableStatus.isComplete : hasMinimumData(data, tableStatus);
        if (stableCount >= stableRounds && idleEnough && dataReady) {
          return { data, stable: true };
        }
        await sleep(pollMs);
      }
    } finally {
      observer.disconnect();
    }

    return { data: lastData, stable: false };
  }

  async function runExtraction() {
    const retryLimit = 3;
    const retryWaitMs = 5000;
    let root = null;

    for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
      root = await waitForShopdoraRoot(retryWaitMs);
      if (root) break;
      if (attempt < retryLimit) {
        await sleep(300);
      }
    }

    if (!root) {
      return {
        success: false,
        error: `未检测到Shopdora模块，已重试${retryLimit}次。`
      };
    }

    let data = null;
    let stable = false;
    for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
      const result = await waitForStableData(root, {
        timeoutMs: retryWaitMs,
        pollMs: 800,
        stableRounds: 3,
        idleMs: 1200
      });
      data = result.data;
      stable = result.stable;
      if (stable) break;
      if (attempt < retryLimit) {
        await sleep(300);
      }
    }

    if (!stable && data) {
      data.warnings = data.warnings || [];
      data.warnings.push(`字段仍在加载，已重试${retryLimit}次`);
    }

    return { success: true, data };
  }

  const LIST_ITEM_SELECTOR = 'li.col-xs-2-4.shopee-search-item-result__item';
  const LIST_LINK_SELECTOR = '.contents';
  const NEXT_PAGE_SELECTOR = '.shopee-icon-button.shopee-icon-button--right';
  const MAX_LIST_PAGES = 50;
  const SCROLL_IDLE_ROUNDS = 3;
  const SCROLL_STEP_MS = 800;

  function normalizeUrl(href) {
    if (!href) return null;
    try {
      return new URL(href, location.origin).href;
    } catch (error) {
      return null;
    }
  }

  function extractListUrlsFromPage() {
    const items = Array.from(document.querySelectorAll(LIST_ITEM_SELECTOR));
    const urls = [];
    for (const item of items) {
      const contentEl = item.querySelector(LIST_LINK_SELECTOR);
      if (!contentEl) continue;
      let link = null;
      if (contentEl.tagName === 'A') {
        link = contentEl.getAttribute('href') || contentEl.href;
      } else if (typeof contentEl.getAttribute === 'function') {
        link = contentEl.getAttribute('href');
      }
      if (!link) {
        const anchor = contentEl.querySelector('a[href]');
        link = anchor ? anchor.getAttribute('href') || anchor.href : null;
      }
      const normalized = normalizeUrl(link);
      if (normalized) urls.push(normalized);
    }
    return urls;
  }

  async function waitForListItems(timeoutMs = MAX_WAIT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const items = document.querySelectorAll(LIST_ITEM_SELECTOR);
      if (items.length) return Array.from(items);
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  async function autoScrollToLoadAllItems() {
    let idleRounds = 0;
    let lastCount = 0;
    const start = Date.now();

    while (Date.now() - start < MAX_WAIT_MS) {
      const items = document.querySelectorAll(LIST_ITEM_SELECTOR);
      const count = items.length;

      if (count > lastCount) {
        lastCount = count;
        idleRounds = 0;
      } else {
        idleRounds += 1;
      }

      if (idleRounds >= SCROLL_IDLE_ROUNDS) {
        break;
      }

      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await sleep(SCROLL_STEP_MS);
    }

    window.scrollTo({ top: 0, behavior: 'instant' });
    await sleep(200);
  }

  function isNextPageDisabled(button) {
    if (!button) return true;
    if (button.disabled) return true;
    const ariaDisabled = button.getAttribute('aria-disabled');
    if (ariaDisabled === 'true') return true;
    if (button.classList.contains('disabled')) return true;
    if (button.classList.contains('shopee-icon-button--disabled')) return true;
    return false;
  }

  function getPageSignature() {
    const urls = extractListUrlsFromPage();
    if (!urls.length) return '';
    return urls.slice(0, 5).join('|');
  }

  async function waitForPageChange(prevSignature) {
    const start = Date.now();
    while (Date.now() - start < MAX_WAIT_MS) {
      const signature = getPageSignature();
      if (signature && signature !== prevSignature) return signature;
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  async function collectListUrls({ paginate = false, maxPages = MAX_LIST_PAGES } = {}) {
    const warnings = [];
    const urls = new Set();
    let pages = 0;
    const pageLimit = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : MAX_LIST_PAGES;

    const initialItems = await waitForListItems();
    if (!initialItems) {
      return {
        success: false,
        error: '未找到商品列表，页面可能未加载完成。'
      };
    }

    while (true) {
      pages += 1;
      await autoScrollToLoadAllItems();
      const pageUrls = extractListUrlsFromPage();
      if (!pageUrls.length) {
        warnings.push(`第${pages}页未解析到商品链接`);
      } else {
        pageUrls.forEach((url) => urls.add(url));
      }

      if (!paginate) break;
      if (pages >= pageLimit) {
        warnings.push(`已达到最大翻页数限制（${pageLimit}页）`);
        break;
      }

      const nextButton = document.querySelector(NEXT_PAGE_SELECTOR);
      if (!nextButton) {
        warnings.push('未找到下一页按钮');
        break;
      }
      if (isNextPageDisabled(nextButton)) {
        break;
      }

      const signature = getPageSignature();
      nextButton.scrollIntoView({ block: 'center' });
      nextButton.click();

      const changed = await waitForPageChange(signature);
      if (!changed) {
        warnings.push('翻页后页面内容未更新');
        break;
      }

      const items = await waitForListItems();
      if (!items) {
        warnings.push('翻页后商品列表加载失败');
        break;
      }
    }

    return {
      success: true,
      urls: Array.from(urls),
      pages,
      warnings
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;
    if (message.type === 'extract') {
      runExtraction().then(sendResponse);
      return true;
    }
    if (message.type === 'collect-product-urls') {
      collectListUrls({
        paginate: Boolean(message.paginate),
        maxPages: message.maxPages
      }).then(sendResponse);
      return true;
    }
  });
})();
