# Shopdora Extractor

用于从 Shopee 商品页中 **Shopdora 插件模块** 提取结构化数据的 Chrome 扩展。

## 功能
- 自动定位页面中 Shopdora 橙色模块并提取数据
- 支持动态加载等待，自动重试
- 支持单页与批量 URL 抓取
- 支持分类页商品链接抓取（可自动翻页）
- 一键导出 JSON / CSV
- 失败或字段缺失会给出明确提示

## 安装
1. 打开 Chrome → `chrome://extensions`
2. 打开「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目目录 `/Users/xuqihan/Desktop/code_study/shopee_extension2.0`

## 使用
- 打开 Shopee 商品页（例如题目中的商品链接）
- 点击扩展图标 → 「提取当前页」
- 批量提取：在文本框中粘贴 URL（每行一个）→ 「批量提取」
- 分类页链接：打开分类页 → 「抓取当前分类页链接」，可勾选「自动翻页」
- 提取完成后可下载 JSON / CSV

## 注意事项
- 扩展只能读取 **页面 DOM 中可访问的 Shopdora 模块**。
- 若 Shopdora 使用了 **closed Shadow DOM** 或独立 iframe 且不可访问，扩展无法读取内容。
- 如果数据字段显示为 `null` 或 `warnings` 中提示缺失，说明页面内容未渲染完成或模块结构不同，可稍后重试。

## 主要文件
- `manifest.json` 扩展清单
- `content.js` 负责定位 Shopdora 模块并解析数据
- `background.js` 负责批量任务队列
- `popup.html` / `popup.js` / `popup.css` 弹窗 UI
