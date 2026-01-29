# shopee_extension

## 更像人为操作的行为与参数
项目里包含多种延时、抖动与交互模式，用于模拟真人浏览行为。下面是完整清单与参数。

## 代码外的操作
禁用浏览器的 “自动化特征”（重点！）
若用的是带界面的 Chrome/Firefox（非无头）：在浏览器快捷方式里添加启动参数，抹掉自动化标识

### `extension/content.js`
- **点击前随机等待**：`CLICK_DELAY_MIN_MS = 500`，`CLICK_DELAY_MAX_MS = 2000`（毫秒）
  - 用于 `safeClick()` 的随机点击，及 `clickNextPageWithRetry()` 翻页点击前等待。
- **翻页后停留**：`PAGE_CHANGE_DELAY_MIN_MS = 1000`，`PAGE_CHANGE_DELAY_MAX_MS = 3000`（毫秒）
  - 用于翻页完成后的停留，以及列表页处理的停顿。
- **逐字输入模拟**：`TYPE_DELAY_MIN_MS = 100`，`TYPE_DELAY_MAX_MS = 300`（毫秒/字符）
  - `typeTextLikeHuman()` 逐字触发 keydown/input/keyup 事件。
- **抓取前随机点击**：`PRE_CLICK_MIN_COUNT = 1`，`PRE_CLICK_MAX_COUNT = 3`
  - `simulatePreExtractionInteractions()` 会随机点击可见元素（搜索框/分类/推荐等），每次点击间隔 **300–900ms**。
- **翻页时偶尔回退再前进**：
  - `LIST_BACKTRACK_CHANCE = 0.18`（翻页后 18% 概率回退）
  - `LIST_BACKTRACK_COOLDOWN_PAGES = 2`（至少间隔 2 页再回退）
  - 通过 `simulateBacktrack()` 触发 `history.back()` 后再 `history.forward()`，并加入翻页停留。
- **抓取期间的滚动抖动**：
  - `startScrollJitterLoop()` 每 **800–1600ms** 随机滚动 **160–520px**，等待数据稳定时执行。
- **列表页滚动加载**（模拟浏览商品列表）：
  - `LIST_SCROLL_STEP_RATIO = 0.85`（每步约视窗高度的 85%，最少 320px）
  - `LIST_SCROLL_STEP_MS = 1600`（每次滚动间隔）
  - `LIST_SCROLL_IDLE_ROUNDS = 5`（空转轮次达到后停止）
  - `LIST_SCROLL_SETTLE_MS = 1300`（滚动结束后的停留）

### `extension/background.js`
- **页面/标签切换后的随机等待**：
  - `PAGE_SWITCH_DELAY_MIN_MS = 1000`，`PAGE_SWITCH_DELAY_MAX_MS = 3000`（毫秒）
  - 用于跳转到商品页或分类页后的等待。
- **单个商品之间的间隔**：
  - `ITEM_GAP_MIN_MS = 1200`，`ITEM_GAP_MAX_MS = 3000`（毫秒）
  - 每条 URL 抓取之间的随机间隔。
- **批量抓取中的休息节奏**：
  - `BATCH_REST_EVERY = 5`（每处理 5 条休息一次）
  - `BATCH_REST_MS = 10000`（休息 10 秒）
  - 休息时会重启 worker 标签页，减少长时会话痕迹。

