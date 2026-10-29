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

function setup() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(ITEMS_SHEET);
  if (!sheet) sheet = ss.insertSheet(ITEMS_SHEET);
  var headers = Mnemosyne.ITEMS_HEADERS;
  var width = headers.length;
  var current = sheet.getRange(1, 1, 1, width).getValues()[0];
  var matches = true;
  for (var i = 0; i < width; i++) {
    if (String(current[i] || '') !== headers[i]) matches = false;
  }
  if (!matches) sheet.getRange(1, 1, 1, width).setValues([headers]);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, sheet.getMaxRows(), width).setNumberFormat('@');
  console.log('items sheet is ready');
  return 'ok';
}

function dispatch_(body) {
  var action = body.action;
  if (typeof action !== 'string' || !action) return { ok: false, error: 'bad_request' };
  if (action === 'list') return handleList_();
  if (action === 'add') return handleAdd_(body);
  if (action === 'update') return handleUpdate_(body);
  if (action === 'delete') return handleDelete_(body);
  if (action === 'preview') return handlePreview_(body);
  return { ok: false, error: 'unknown_action' };
}

function handleList_() {
  return withLock_(function () {
    return { ok: true, items: Mnemosyne.sortNewestFirst(readAllItems_()) };
  });
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
