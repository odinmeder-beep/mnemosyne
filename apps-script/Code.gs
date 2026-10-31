/**
 * Mnemosyne 後端。
 * 從試算表的「擴充功能 → Apps Script」開啟，腳本會使用目前這份試算表。
 * 金鑰只放在指令碼屬性 MNEMOSYNE_KEY。
 *
 * 瀏覽器請用 POST，Content-Type 用 text/plain;charset=utf-8，
 * 內容是 JSON：{ "key", "action", ... }。這樣不會觸發 CORS preflight。
 * 金鑰放在內容裡，不放在網址上。
 */

var ITEMS_SHEET = 'items';
var CATEGORIES_SHEET = 'categories';

function doGet() {
  return json_({ ok: false, error: 'method_not_allowed' });
}

function doPost(e) {
  var body = parseJsonBody_(e);
  var expected = PropertiesService.getScriptProperties().getProperty('MNEMOSYNE_KEY');
  var provided = body && typeof body.key === 'string' ? body.key : '';
  if (!Mnemosyne.authorize(provided, expected)) {
    return json_({ ok: false, error: 'unauthorized' });
  }
  delete body.key;
  try {
    return json_(dispatch_(body));
  } catch (err) {
    return json_(clientError_(err));
  }
}

function ensureHeaderRow_(sheet, headers) {
  var width = headers.length;
  var current = sheet.getRange(1, 1, 1, width).getValues()[0];
  var any = false;
  for (var i = 0; i < width; i++) {
    if (current[i]) any = true;
  }
  if (!any) {
    sheet.getRange(1, 1, 1, width).setValues([headers]);
  } else {
    for (var j = 0; j < width; j++) {
      if (!current[j]) sheet.getRange(1, j + 1).setValue(headers[j]);
    }
  }
  sheet.getRange(1, 1, 1, width).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, sheet.getMaxRows(), width).setNumberFormat('@');
}

function setup() {
  var ss = getSpreadsheet_();
  var itemsSheet = ss.getSheetByName(ITEMS_SHEET);
  if (!itemsSheet) itemsSheet = ss.insertSheet(ITEMS_SHEET);
  ensureHeaderRow_(itemsSheet, Mnemosyne.ITEMS_HEADERS);
  var categoriesSheet = ss.getSheetByName(CATEGORIES_SHEET);
  if (!categoriesSheet) categoriesSheet = ss.insertSheet(CATEGORIES_SHEET);
  ensureHeaderRow_(categoriesSheet, Mnemosyne.CATEGORY_HEADERS);
  console.log('sheets are ready');
  return 'ok';
}

var READ_ACTIONS_ = { list: true, listCategories: true, preview: true };
var LIST_CACHE_KEY_ = 'list_v1';
var LIST_CACHE_SECONDS_ = 300;
var LIST_CACHE_CHUNK_ = 30000;

function dispatch_(body) {
  var action = body.action;
  if (typeof action !== 'string' || !action) return { ok: false, error: 'bad_request' };
  if (!READ_ACTIONS_[action]) clearListCache_();
  if (action === 'list') return handleList_();
  if (action === 'add') return handleAdd_(body);
  if (action === 'update') return handleUpdate_(body);
  if (action === 'delete') return handleDelete_(body);
  if (action === 'preview') return handlePreview_(body);
  if (action === 'backfillImages') return handleBackfillImages_(body);
  if (action === 'listCategories') return handleListCategories_();
  if (action === 'addCategory') return handleAddCategory_(body);
  if (action === 'updateCategory') return handleUpdateCategory_(body);
  if (action === 'renameCategory') return handleRenameCategory_(body);
  if (action === 'deleteCategory') return handleDeleteCategory_(body);
  if (action === 'renameTag') return handleRenameTag_(body);
  if (action === 'deleteTag') return handleDeleteTag_(body);
  return { ok: false, error: 'unknown_action' };
}

function handleList_() {
  var cached = readListCache_();
  if (cached) return { ok: true, items: cached };
  var items = withLock_(function () {
    return Mnemosyne.sortNewestFirst(readAllItems_());
  });
  writeListCache_(items);
  return { ok: true, items: items };
}

// The sheet read is the slow part of list, so keep the sorted list in the
// script cache for a few minutes. Any write action clears it first.
function readListCache_() {
  try {
    var cache = CacheService.getScriptCache();
    var count = Number(cache.get(LIST_CACHE_KEY_ + '_n'));
    if (!count) return null;
    var keys = [];
    for (var i = 0; i < count; i++) keys.push(LIST_CACHE_KEY_ + '_' + i);
    var parts = cache.getAll(keys);
    var text = '';
    for (var j = 0; j < keys.length; j++) {
      if (typeof parts[keys[j]] !== 'string') return null;
      text += parts[keys[j]];
    }
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function writeListCache_(items) {
  try {
    var text = JSON.stringify(items);
    var values = {};
    var count = 0;
    for (var i = 0; i < text.length; i += LIST_CACHE_CHUNK_) {
      values[LIST_CACHE_KEY_ + '_' + count] = text.slice(i, i + LIST_CACHE_CHUNK_);
      count++;
    }
    values[LIST_CACHE_KEY_ + '_n'] = String(count);
    CacheService.getScriptCache().putAll(values, LIST_CACHE_SECONDS_);
  } catch (err) {
    clearListCache_();
  }
}

function clearListCache_() {
  try {
    CacheService.getScriptCache().remove(LIST_CACHE_KEY_ + '_n');
  } catch (err) {}
}

function handlePreview_(body) {
  var url = Mnemosyne.normalizeUrl(body && body.url);
  if (!url) return { ok: false, error: 'invalid_url' };
  return { ok: true, preview: fetchPreview_(url) };
}

function handleAdd_(body) {
  var parsed = Mnemosyne.parseAddFields(body);
  if (!parsed.ok) return parsed;

  var existing = withLock_(function () {
    return Mnemosyne.findDuplicate(readAllItems_(), parsed.fields.url);
  });
  if (existing) return { ok: true, duplicate: true, item: existing };

  var preview = fetchPreview_(parsed.fields.url);
  var now = new Date().toISOString();
  return withLock_(function () {
    var loaded = loadRows_();
    var again = Mnemosyne.findDuplicate(itemsFromEntries_(loaded.entries), parsed.fields.url);
    if (again) return { ok: true, duplicate: true, item: again };
    var item = Mnemosyne.buildNewItem(parsed.fields, preview, now, Utilities.getUuid());
    writeRow_(loaded.sheet, loaded.sheet.getLastRow() + 1, item);
    return { ok: true, duplicate: false, item: item };
  });
}

function handleUpdate_(body) {
  var id = body && typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return { ok: false, error: 'bad_request' };
  var now = new Date().toISOString();
  return withLock_(function () {
    var loaded = loadRows_();
    var entry = findEntry_(loaded.entries, id);
    if (!entry) return { ok: false, error: 'not_found' };
    var applied = Mnemosyne.applyUpdate(entry.item, body, now);
    if (!applied.ok) return applied;
    writeRow_(loaded.sheet, entry.rowNumber, applied.item);
    return { ok: true, item: applied.item };
  });
}

function handleBackfillImages_(body) {
  var limit = 25;
  if (body && body.limit != null && body.limit !== '') {
    var n = Number(body.limit);
    if (!isFinite(n) || n < 1) return { ok: false, error: 'bad_request' };
    limit = Math.floor(n);
  }
  var loaded = withLock_(function () {
    return loadRows_();
  });
  var plan = Mnemosyne.pickImageBackfill(loaded.entries, limit);
  var imageColumn = Mnemosyne.ITEMS_HEADERS.indexOf('image') + 1;
  var writes = [];
  for (var i = 0; i < plan.batch.length; i++) {
    var entry = plan.batch[i];
    var preview = fetchPreview_(entry.item.url);
    var image = preview && preview.image ? preview.image : '-';
    writes.push({ rowNumber: entry.rowNumber, image: image });
  }
  return withLock_(function () {
    var sheet = getItemsSheet_();
    for (var j = 0; j < writes.length; j++) {
      var cell = sheet.getRange(writes[j].rowNumber, imageColumn);
      cell.setNumberFormat('@');
      cell.setValue(writes[j].image);
    }
    var remaining = 0;
    var entries = loadRows_().entries;
    for (var k = 0; k < entries.length; k++) {
      if (String(entries[k].item.image || '').trim() === '') remaining += 1;
    }
    return { ok: true, updated: writes.length, remaining: remaining };
  });
}

function handleDelete_(body) {
  var id = body && typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return { ok: false, error: 'bad_request' };
  return withLock_(function () {
    var loaded = loadRows_();
    var entry = findEntry_(loaded.entries, id);
    if (!entry) return { ok: false, error: 'not_found' };
    loaded.sheet.deleteRow(entry.rowNumber);
    return { ok: true, id: id };
  });
}

function fetchPreview_(url) {
  try {
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true,
      headers: {
        'User-Agent': Mnemosyne.FETCH_REQUEST.userAgent,
        Accept: Mnemosyne.FETCH_REQUEST.accept,
        'Accept-Language': Mnemosyne.FETCH_REQUEST.acceptLanguage,
      },
    });
    var code = response.getResponseCode();
    var html = code >= 200 && code < 300 ? readHtml_(response) : '';
    return Mnemosyne.previewFromFetch(url, code, html);
  } catch (err) {
    console.error('preview fetch failed');
    return Mnemosyne.previewFromFetch(url, 0, '');
  }
}

function readHtml_(response) {
  var headers = response.getHeaders() || {};
  var contentType = '';
  for (var key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key) && String(key).toLowerCase() === 'content-type') {
      contentType = String(headers[key]);
    }
  }
  var charset = 'UTF-8';
  var match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType);
  if (match) charset = match[1];
  var text = '';
  try {
    text = response.getContentText(charset) || '';
  } catch (err) {
    text = response.getContentText() || '';
  }
  if (text.length > Mnemosyne.MAX_HTML_CHARS) text = text.slice(0, Mnemosyne.MAX_HTML_CHARS);
  return text;
}

function cellText_(value) {
  if (value == null || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) return '';
    return value.toISOString();
  }
  return String(value);
}

function readCategories_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(CATEGORIES_SHEET);
  if (!sheet) {
    var missing = new Error('not_setup');
    missing.code = 'not_setup';
    throw missing;
  }
  var headers = Mnemosyne.CATEGORY_HEADERS;
  var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  for (var h = 0; h < headers.length; h++) {
    if (String(current[h] || '') !== headers[h]) {
      var bad = new Error('not_setup');
      bad.code = 'not_setup';
      throw bad;
    }
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { sheet: sheet, categories: [] };
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var categories = [];
  for (var i = 0; i < values.length; i++) {
    var name = String(values[i][0] || '').trim();
    if (!name) continue;
    categories.push({
      name: name,
      color: String(values[i][1] || ''),
      parent: String(values[i][2] || '').trim(),
      createdAt: cellText_(values[i][3]),
    });
  }
  return { sheet: sheet, categories: categories };
}

function handleListCategories_() {
  return withLock_(function () {
    var loaded = readCategories_();
    if (loaded.categories.length) return { ok: true, categories: loaded.categories };
    var seeded = Mnemosyne.seedCategories(readAllItems_(), [], new Date().toISOString());
    for (var i = 0; i < seeded.length; i++) {
      loaded.sheet.appendRow([seeded[i].name, seeded[i].color, seeded[i].parent, seeded[i].createdAt]);
    }
    return { ok: true, categories: seeded };
  });
}

function handleAddCategory_(body) {
  var now = new Date().toISOString();
  return withLock_(function () {
    var loaded = readCategories_();
    var planned = Mnemosyne.planAddCategory(loaded.categories, body || {}, now);
    if (!planned.ok) return planned;
    var row = planned.category;
    loaded.sheet.appendRow([row.name, row.color, row.parent, row.createdAt]);
    return { ok: true, category: row };
  });
}

function handleUpdateCategory_(body) {
  return withLock_(function () {
    var loaded = readCategories_();
    var planned = Mnemosyne.planUpdateCategory(loaded.categories, body || {});
    if (!planned.ok) return planned;
    var lastRow = loaded.sheet.getLastRow();
    if (lastRow < 2) return { ok: false, error: 'not_found' };
    var names = loaded.sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i][0] || '').trim() !== planned.category.name) continue;
      loaded.sheet.getRange(i + 2, 2, 1, 2).setValues([[planned.category.color, planned.category.parent]]);
      return { ok: true, category: planned.category };
    }
    return { ok: false, error: 'not_found' };
  });
}

function handleRenameCategory_(body) {
  var from = body && typeof body.from === 'string' ? body.from.trim() : '';
  var to = body && typeof body.to === 'string' ? body.to.trim() : '';
  if (!from || !to) return { ok: false, error: 'bad_request' };
  var now = new Date().toISOString();
  return withLock_(function () {
    var loadedCats = readCategories_();
    var planned = Mnemosyne.planRenameCategory(loadedCats.categories, from, to);
    if (!planned.ok) return planned;

    var catRows = planned.categories.map(function (c) {
      return [c.name, c.color, c.parent, c.createdAt];
    });
    if (catRows.length > 0) {
      loadedCats.sheet.getRange(2, 1, catRows.length, Mnemosyne.CATEGORY_HEADERS.length).setValues(catRows);
    }

    var itemsSheet = getItemsSheet_();
    var lastRow = itemsSheet.getLastRow();
    var changed = 0;
    if (lastRow >= 2) {
      var width = Mnemosyne.ITEMS_HEADERS.length;
      var range = itemsSheet.getRange(2, 1, lastRow - 1, width);
      var values = range.getValues();
      var res = Mnemosyne.renameCategoryInItems(values, from, to, now);
      changed = res.changed;
      if (changed > 0) {
        range.setValues(values);
      }
    }
    return { ok: true, changed: changed, category: planned.category };
  });
}

function handleDeleteCategory_(body) {
  var name = body && typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { ok: false, error: 'bad_request' };
  var now = new Date().toISOString();
  return withLock_(function () {
    var loadedCats = readCategories_();
    var planned = Mnemosyne.planDeleteCategory(loadedCats.categories, name);
    if (!planned.ok) return planned;

    var lastCatRow = loadedCats.sheet.getLastRow();
    if (lastCatRow >= 2) {
      var catNames = loadedCats.sheet.getRange(2, 1, lastCatRow - 1, 1).getValues();
      for (var r = 0; r < catNames.length; r++) {
        if (String(catNames[r][0] || '').trim() === name) {
          loadedCats.sheet.deleteRow(r + 2);
          break;
        }
      }
    }
    if (planned.categories.length > 0) {
      var catRows = planned.categories.map(function (c) {
        return [c.name, c.color, c.parent, c.createdAt];
      });
      loadedCats.sheet.getRange(2, 1, catRows.length, Mnemosyne.CATEGORY_HEADERS.length).setValues(catRows);
    }

    var itemsSheet = getItemsSheet_();
    var lastRow = itemsSheet.getLastRow();
    var changed = 0;
    if (lastRow >= 2) {
      var width = Mnemosyne.ITEMS_HEADERS.length;
      var range = itemsSheet.getRange(2, 1, lastRow - 1, width);
      var values = range.getValues();
      var res = Mnemosyne.deleteCategoryFromItems(values, name, now);
      changed = res.changed;
      if (changed > 0) {
        range.setValues(values);
      }
    }
    return { ok: true, changed: changed };
  });
}

function handleRenameTag_(body) {
  var from = body && typeof body.from === 'string' ? body.from.trim() : '';
  var to = body && typeof body.to === 'string' ? body.to.trim() : '';
  if (!from || !to) return { ok: false, error: 'bad_request' };
  var now = new Date().toISOString();
  return withLock_(function () {
    var itemsSheet = getItemsSheet_();
    var lastRow = itemsSheet.getLastRow();
    var changed = 0;
    if (lastRow >= 2) {
      var width = Mnemosyne.ITEMS_HEADERS.length;
      var range = itemsSheet.getRange(2, 1, lastRow - 1, width);
      var values = range.getValues();
      var res = Mnemosyne.renameTagInItems(values, from, to, now);
      changed = res.changed;
      if (changed > 0) {
        range.setValues(values);
      }
    }
    return { ok: true, changed: changed };
  });
}

function handleDeleteTag_(body) {
  var name = body && typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { ok: false, error: 'bad_request' };
  var now = new Date().toISOString();
  return withLock_(function () {
    var itemsSheet = getItemsSheet_();
    var lastRow = itemsSheet.getLastRow();
    var changed = 0;
    if (lastRow >= 2) {
      var width = Mnemosyne.ITEMS_HEADERS.length;
      var range = itemsSheet.getRange(2, 1, lastRow - 1, width);
      var values = range.getValues();
      var res = Mnemosyne.deleteTagFromItems(values, name, now);
      changed = res.changed;
      if (changed > 0) {
        range.setValues(values);
      }
    }
    return { ok: true, changed: changed };
  });
}

function getSpreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var err = new Error('找不到試算表。請從試算表的「擴充功能 → Apps Script」開啟這個專案。');
    err.code = 'internal_error';
    throw err;
  }
  return ss;
}

function getItemsSheet_() {
  var sheet = getSpreadsheet_().getSheetByName(ITEMS_SHEET);
  if (!sheet) {
    var missing = new Error('not_setup');
    missing.code = 'not_setup';
    throw missing;
  }
  var headers = Mnemosyne.ITEMS_HEADERS;
  var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (String(current[i] || '') !== headers[i]) {
      var bad = new Error('not_setup');
      bad.code = 'not_setup';
      throw bad;
    }
  }
  return sheet;
}

function loadRows_() {
  var sheet = getItemsSheet_();
  var lastRow = sheet.getLastRow();
  var width = Mnemosyne.ITEMS_HEADERS.length;
  if (lastRow < 2) return { sheet: sheet, entries: [] };
  var values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  var entries = [];
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] == null || String(values[i][0]) === '') continue;
    entries.push({ rowNumber: i + 2, item: Mnemosyne.rowToItem(values[i]) });
  }
  return { sheet: sheet, entries: entries };
}

function readAllItems_() {
  return itemsFromEntries_(loadRows_().entries);
}

function itemsFromEntries_(entries) {
  var items = [];
  for (var i = 0; i < entries.length; i++) items.push(entries[i].item);
  return items;
}

function findEntry_(entries, id) {
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].item.id === id) return entries[i];
  }
  return null;
}

function writeRow_(sheet, rowNumber, item) {
  var width = Mnemosyne.ITEMS_HEADERS.length;
  var range = sheet.getRange(rowNumber, 1, 1, width);
  range.setNumberFormat('@');
  range.setValues([Mnemosyne.itemToRow(item)]);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    var busy = new Error('busy');
    busy.code = 'busy';
    throw busy;
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function parseJsonBody_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw || typeof raw !== 'string' || raw.length > 100000) return null;
  try {
    var data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch (err) {
    return null;
  }
}

function clientError_(err) {
  var code = err && err.code;
  if (code === 'not_setup' || code === 'busy') return { ok: false, error: code };
  console.error(err && err.stack ? err.stack : err);
  return { ok: false, error: 'internal_error' };
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
