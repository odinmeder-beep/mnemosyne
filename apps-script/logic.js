/**
 * 純邏輯：判斷平台、讀取標題、列和資料的轉換、檢查金鑰。
 * 這個檔案不要呼叫試算表或 UrlFetchApp。Node 測試會直接載入它。
 * Apps Script 會把 var Mnemosyne 當成全域物件；其他檔案請用 Mnemosyne.函式名稱。
 */
var Mnemosyne = (function () {
  'use strict';

  var ITEMS_HEADERS = Object.freeze([
    'id',
    'url',
    'platform',
    'title',
    'summary',
    'note',
    'category',
    'tags',
    'createdAt',
    'updatedAt',
    'image',
  ]);

  var USER_FIELDS = Object.freeze([
    'url',
    'platform',
    'title',
    'summary',
    'note',
    'category',
    'tags',
  ]);

  var MAX_HTML_CHARS = 500000;
  var MAX_URL_LENGTH = 4096;

  // Threads returns og:title to preview crawlers and an empty shell to a browser UA.
  var FETCH_REQUEST = Object.freeze({
    userAgent: 'Twitterbot/1.0',
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    acceptLanguage: 'zh-TW,zh;q=0.9,en;q=0.8',
  });

  var NAMED_ENTITIES = {
    nbsp: ' ',
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
  };

  function hostIs(hostname, domain) {
    return hostname === domain || hostname.endsWith('.' + domain);
  }

  // Apps Script V8 has no URL constructor. Parse http(s) links directly.
  function parseHttpUrl(input) {
    if (typeof input !== 'string') return null;
    var trimmed = input.trim();
    if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
    if (/[\u0000-\u0020\u007f]/.test(trimmed)) return null;

    var match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(trimmed);
    if (!match) return null;

    var scheme = match[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;

    var authority = match[2];
    if (!authority) return null;
    var at = authority.lastIndexOf('@');
    var hostport = at === -1 ? authority : authority.slice(at + 1);
    if (!hostport || hostport.indexOf('[') !== -1 || hostport.indexOf(']') !== -1) return null;

    var hostname = hostport;
    var port = '';
    var colon = hostport.lastIndexOf(':');
    if (colon !== -1) {
      if (hostport.indexOf(':') !== colon) return null;
      hostname = hostport.slice(0, colon);
      port = hostport.slice(colon + 1);
      if (!/^\d+$/.test(port)) return null;
      var portNumber = parseInt(port, 10);
      if (portNumber < 0 || portNumber > 65535) return null;
      if ((scheme === 'https' && portNumber === 443) || (scheme === 'http' && portNumber === 80)) {
        port = '';
      } else {
        port = String(portNumber);
      }
    }

    hostname = hostname.toLowerCase();
    if (!hostname) return null;

    var pathname = match[3] || '';
    if (!pathname) pathname = '/';
    if (pathname.length > 1 && pathname.charAt(pathname.length - 1) === '/') {
      pathname = pathname.slice(0, -1);
    }

    return {
      href: scheme + '://' + hostname + (port ? ':' + port : '') + pathname + (match[4] || ''),
      hostname: hostname,
    };
  }

  function detectPlatform(url) {
    var parsed = parseHttpUrl(url);
    if (!parsed) return 'web';
    var hostname = parsed.hostname.replace(/^www\./, '');
    if (hostIs(hostname, 'threads.net') || hostIs(hostname, 'threads.com')) return 'threads';
    if (hostIs(hostname, 'instagram.com') || hostIs(hostname, 'instagr.am')) return 'instagram';
    if (
      hostIs(hostname, 'facebook.com') ||
      hostIs(hostname, 'fb.com') ||
      hostIs(hostname, 'fb.watch') ||
      hostIs(hostname, 'fb.me')
    ) {
      return 'facebook';
    }
    if (hostIs(hostname, 'x.com') || hostIs(hostname, 'twitter.com')) return 'x';
    return 'web';
  }

  function normalizeUrl(input) {
    var parsed = parseHttpUrl(input);
    return parsed ? parsed.href : '';
  }

  function decodeHtmlEntities(text) {
    return String(text)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&#(\d+);/g, function (_, dec) {
        var code = Number(dec);
        if (!code || code > 0x10ffff) return _;
        return String.fromCodePoint(code);
      })
      .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
        var code = parseInt(hex, 16);
        if (!code || code > 0x10ffff) return _;
        return String.fromCodePoint(code);
      })
      .replace(/&([a-z]+);/gi, function (_, name) {
        var key = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : _;
      })
      .replace(/\s+/g, ' ')
      .trim();
  }

  function readAttributes(tag) {
    var attrs = {};
    var start = tag.search(/\s/);
    if (start === -1) return attrs;
    var body = tag.slice(start).replace(/\/?\s*>$/, '');
    var re = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
    var match;
    while ((match = re.exec(body))) {
      var key = match[1].toLowerCase();
      var value = match[2] != null ? match[2] : match[3] != null ? match[3] : match[4] || '';
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) attrs[key] = value;
    }
    return attrs;
  }

  function readMetaContent(html, key) {
    var re = /<meta\b[^>]*>/gi;
    var wanted = key.toLowerCase();
    var match;
    while ((match = re.exec(html))) {
      var attrs = readAttributes(match[0]);
      var labels = [attrs.property, attrs.name, attrs.itemprop];
      var hit = false;
      for (var i = 0; i < labels.length; i++) {
        if (labels[i] && String(labels[i]).toLowerCase() === wanted) hit = true;
      }
      if (!hit) continue;
      var content = decodeHtmlEntities(attrs.content || '');
      if (content) return content;
    }
    return '';
  }

  function readTitleText(html) {
    var match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (!match) return '';
    return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, ''));
  }

  function firstNonEmpty(values) {
    for (var i = 0; i < values.length; i++) {
      if (values[i]) return values[i];
    }
    return '';
  }

  function readLinkHref(html, relValue) {
    var re = /<link\b[^>]*>/gi;
    var wanted = relValue.toLowerCase();
    var match;
    while ((match = re.exec(html))) {
      var attrs = readAttributes(match[0]);
      var rel = String(attrs.rel || '').toLowerCase().split(/\s+/);
      var hit = false;
      for (var i = 0; i < rel.length; i++) {
        if (rel[i] === wanted) hit = true;
      }
      if (!hit) continue;
      var href = decodeHtmlEntities(attrs.href || '');
      if (href) return href;
    }
    return '';
  }

  function pageBase(pageUrl) {
    if (typeof pageUrl !== 'string') return null;
    var match = /^(https?):\/\/([^/?#]+)([^?#]*)/i.exec(pageUrl.trim());
    if (!match) return null;
    return { scheme: match[1].toLowerCase(), host: match[2], path: match[3] || '/' };
  }

  function resolveUrl(pageUrl, raw) {
    if (!raw || typeof raw !== 'string') return '';
    var ref = raw.trim();
    if (!ref || /[\u0000-\u001f\u007f]/.test(ref)) return '';
    if (/^https?:\/\//i.test(ref)) return ref;
    var base = pageBase(pageUrl);
    if (!base) return '';
    if (ref.indexOf('//') === 0) return base.scheme + ':' + ref;
    if (ref.charAt(0) === '/') return base.scheme + '://' + base.host + ref;
    if (ref.charAt(0) === '?' || ref.charAt(0) === '#') return '';
    var slash = base.path.lastIndexOf('/');
    var dir = slash >= 0 ? base.path.slice(0, slash + 1) : '/';
    var parts = (dir + ref).split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '' || parts[i] === '.') {
        if (i === 0) out.push('');
        continue;
      }
      if (parts[i] === '..') {
        if (out.length > 1) out.pop();
        continue;
      }
      out.push(parts[i]);
    }
    var path = out.join('/');
    if (path.charAt(0) !== '/') path = '/' + path;
    return base.scheme + '://' + base.host + path;
  }

  function extractMeta(html, pageUrl) {
    var empty = { title: '', summary: '', image: '' };
    if (typeof html !== 'string' || !html) return empty;
    var source = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
    var imageRaw = firstNonEmpty([
      readMetaContent(source, 'og:image'),
      readMetaContent(source, 'twitter:image'),
      readLinkHref(source, 'image_src'),
    ]);
    return {
      title: firstNonEmpty([
        readMetaContent(source, 'og:title'),
        readMetaContent(source, 'twitter:title'),
        readTitleText(source),
      ]),
      summary: firstNonEmpty([
        readMetaContent(source, 'og:description'),
        readMetaContent(source, 'twitter:description'),
        readMetaContent(source, 'description'),
      ]),
      image: resolveUrl(pageUrl, imageRaw),
    };
  }

  function previewFromFetch(url, httpStatus, html) {
    var normalized = normalizeUrl(url);
    var preview = {
      url: normalized,
      platform: detectPlatform(normalized),
      title: '',
      summary: '',
      image: '',
      fetched: false,
    };
    if (!normalized) return preview;
    if (typeof httpStatus !== 'number' || httpStatus < 200 || httpStatus >= 300) return preview;
    var meta = extractMeta(html, typeof url === 'string' && url.trim() ? url.trim() : normalized);
    preview.title = meta.title;
    preview.summary = meta.summary;
    preview.image = meta.image;
    preview.fetched = true;
    return preview;
  }

  var CATEGORY_HEADERS = Object.freeze(['name', 'color', 'parent', 'createdAt']);

  var CATEGORY_COLORS = Object.freeze([
    '#e74c3c',
    '#e67e22',
    '#f1c40f',
    '#7cb342',
    '#2e7d32',
    '#00897b',
    '#3d8195',
    '#5dade2',
    '#2980b9',
    '#8e44ad',
    '#d81b60',
    '#f48fb1',
    '#90a4ae',
    '#b0bec5',
    '#37474f',
    '#1c1c1c',
  ]);

  function categoryColorAt(index) {
    var size = CATEGORY_COLORS.length;
    var n = Number(index);
    if (!n || n < 0) n = 0;
    return CATEGORY_COLORS[Math.floor(n) % size];
  }

  function parseCategoryList(value) {
    var pieces = [];
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) pieces.push(value[i]);
    } else if (value != null && String(value).trim() !== '') {
      pieces.push(value);
    }
    var names = [];
    var seen = {};
    for (var p = 0; p < pieces.length; p++) {
      var parts = String(pieces[p] == null ? '' : pieces[p]).split(';');
      for (var j = 0; j < parts.length; j++) {
        var name = parts[j].trim();
        if (!name || seen[name]) continue;
        seen[name] = true;
        names.push(name);
      }
    }
    return names;
  }

  function serializeCategoryList(value) {
    return parseCategoryList(value).join('; ');
  }

  function distinctCategoryNames(items) {
    var seen = {};
    var names = [];
    var list = items || [];
    for (var i = 0; i < list.length; i++) {
      var raw = list[i] && list[i].category != null ? list[i].category : '';
      var parsed = parseCategoryList(raw);
      for (var n = 0; n < parsed.length; n++) {
        if (seen[parsed[n]]) continue;
        seen[parsed[n]] = true;
        names.push(parsed[n]);
      }
    }
    return names;
  }

  function seedCategories(items, existing, nowIso) {
    var have = {};
    var rows = existing || [];
    for (var i = 0; i < rows.length; i++) {
      var known = rows[i] && rows[i].name != null ? String(rows[i].name).trim() : '';
      if (known) have[known] = true;
    }
    var names = distinctCategoryNames(items);
    var created = [];
    var next = 0;
    for (var h = 0; h < rows.length; h++) {
      if (rows[h] && String(rows[h].name || '').trim()) next += 1;
    }
    for (var j = 0; j < names.length; j++) {
      if (have[names[j]]) continue;
      created.push({
        name: names[j],
        color: categoryColorAt(next),
        parent: '',
        createdAt: nowIso,
      });
      next += 1;
    }
    return created;
  }

  function duplicateCategory(categories, name) {
    var wanted = String(name || '').trim();
    if (!wanted) return false;
    var list = categories || [];
    for (var i = 0; i < list.length; i++) {
      var current = list[i] && list[i].name != null ? String(list[i].name).trim() : '';
      if (current === wanted) return true;
    }
    return false;
  }

  function validHexColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(String(value || '').trim());
  }

  function categoryDescendants(categories, root) {
    var children = {};
    var list = categories || [];
    for (var i = 0; i < list.length; i++) {
      var name = list[i] && list[i].name != null ? String(list[i].name).trim() : '';
      var parent = list[i] && list[i].parent != null ? String(list[i].parent).trim() : '';
      if (!name || !parent) continue;
      if (!children[parent]) children[parent] = [];
      children[parent].push(name);
    }
    var matched = {};
    var stack = [String(root || '').trim()];
    var guard = 0;
    while (stack.length && guard < 1000) {
      guard += 1;
      var current = stack.pop();
      if (!current || matched[current]) continue;
      matched[current] = true;
      var kids = children[current] || [];
      for (var k = 0; k < kids.length; k++) stack.push(kids[k]);
    }
    return matched;
  }

  function itemMatchesCategory(itemCategory, filterName, categories) {
    var filter = String(filterName || '').trim();
    var names = parseCategoryList(itemCategory);
    if (filter === '__none__') return names.length === 0;
    if (!filter) return true;
    var allowed = categoryDescendants(categories, filter);
    for (var i = 0; i < names.length; i++) {
      if (allowed[names[i]]) return true;
    }
    return false;
  }

  function planAddCategory(categories, input, nowIso) {
    var name = input && input.name != null ? String(input.name).trim() : '';
    if (!name) return { ok: false, error: 'bad_request' };
    var list = categories || [];
    if (duplicateCategory(list, name)) return { ok: false, error: 'duplicate' };
    var parent = input && input.parent != null ? String(input.parent).trim() : '';
    if (parent === name) return { ok: false, error: 'bad_request' };
    if (parent && !duplicateCategory(list, parent)) return { ok: false, error: 'bad_request' };
    var color = input && input.color != null ? String(input.color).trim() : '';
    if (!validHexColor(color)) color = categoryColorAt(list.length);
    else color = color.toLowerCase();
    return {
      ok: true,
      category: { name: name, color: color, parent: parent, createdAt: nowIso },
    };
  }

  function planUpdateCategory(categories, input) {
    var name = input && input.name != null ? String(input.name).trim() : '';
    if (!name) return { ok: false, error: 'bad_request' };
    var list = categories || [];
    var found = null;
    for (var i = 0; i < list.length; i++) {
      var current = list[i] && list[i].name != null ? String(list[i].name).trim() : '';
      if (current === name) found = list[i];
    }
    if (!found) return { ok: false, error: 'not_found' };
    var next = {
      name: name,
      color: found.color || '',
      parent: found.parent ? String(found.parent).trim() : '',
      createdAt: found.createdAt || '',
    };
    if (input.color != null) {
      var color = String(input.color).trim();
      if (!validHexColor(color)) return { ok: false, error: 'bad_request' };
      next.color = color.toLowerCase();
    }
    if (input.parent != null) {
      var parent = String(input.parent).trim();
      if (parent === name) return { ok: false, error: 'bad_request' };
      if (parent && !duplicateCategory(list, parent)) return { ok: false, error: 'bad_request' };
      var descendants = categoryDescendants(list, name);
      if (parent && descendants[parent]) return { ok: false, error: 'bad_request' };
      next.parent = parent;
    }
    return { ok: true, category: next };
  }

  function imageNeedsFetch(value) {
    return String(value == null ? '' : value).trim() === '';
  }

  function pickImageBackfill(entries, limit) {
    var n = Number(limit);
    if (!n || n < 1) n = 25;
    n = Math.floor(n);
    var batch = [];
    var pending = 0;
    var list = entries || [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i] && list[i].item ? list[i].item : list[i];
      if (!item || !imageNeedsFetch(item.image)) continue;
      pending += 1;
      if (batch.length < n) batch.push(list[i]);
    }
    return { batch: batch, remaining: pending - batch.length };
  }

  function parseTags(value) {
    if (Array.isArray(value)) {
      var fromList = [];
      for (var i = 0; i < value.length; i++) {
        var piece = String(value[i] == null ? '' : value[i]).trim();
        if (piece) fromList.push(piece);
      }
      return fromList;
    }
    if (value == null || value === '') return [];
    return String(value)
      .split(',')
      .map(function (part) {
        return part.trim();
      })
      .filter(Boolean);
  }

  function readTagsInput(value) {
    if (value == null || value === '') return { ok: true, value: [] };
    if (typeof value === 'string') return { ok: true, value: parseTags(value) };
    if (Array.isArray(value)) {
      var tags = [];
      for (var i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') return { ok: false, value: [] };
        var parts = parseTags(value[i]);
        for (var j = 0; j < parts.length; j++) tags.push(parts[j]);
      }
      return { ok: true, value: tags };
    }
    return { ok: false, value: [] };
  }

  function serializeTags(value) {
    return parseTags(value).join(', ');
  }

  function cellToString(value) {
    if (value == null || value === '') return '';
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return '';
      return value.toISOString();
    }
    return String(value);
  }

  function rowToItem(row) {
    var source = row || [];
    var item = {};
    for (var i = 0; i < ITEMS_HEADERS.length; i++) {
      item[ITEMS_HEADERS[i]] = cellToString(source[i]);
    }
    item.tags = parseTags(item.tags);
    item.category = parseCategoryList(item.category);
    return item;
  }

  function itemToRow(item) {
    return ITEMS_HEADERS.map(function (key) {
      if (key === 'tags') return serializeTags(item.tags);
      if (key === 'category') return serializeCategoryList(item.category);
      var value = item[key];
      return value == null ? '' : String(value);
    });
  }

  function authorize(providedKey, expectedKey) {
    if (typeof expectedKey !== 'string' || expectedKey.length === 0) return false;
    if (typeof providedKey !== 'string') return false;
    if (providedKey.length !== expectedKey.length) return false;
    var diff = 0;
    for (var i = 0; i < expectedKey.length; i++) {
      diff |= providedKey.charCodeAt(i) ^ expectedKey.charCodeAt(i);
    }
    return diff === 0;
  }

  function readCategoryInput(value) {
    if (value == null || value === '') return { ok: true, value: [] };
    if (typeof value === 'string') return { ok: true, value: parseCategoryList(value) };
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') return { ok: false, value: [] };
      }
      return { ok: true, value: parseCategoryList(value) };
    }
    return { ok: false, value: [] };
  }

  function readOptionalText(input, field) {
    if (!Object.prototype.hasOwnProperty.call(input, field) || input[field] == null) {
      return { ok: true, value: '' };
    }
    if (typeof input[field] !== 'string') return { ok: false, value: '' };
    return { ok: true, value: input[field].trim() };
  }

  function parseAddFields(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, error: 'bad_request' };
    }
    var url = normalizeUrl(input.url);
    if (!url) return { ok: false, error: 'invalid_url' };
    var note = readOptionalText(input, 'note');
    if (!note.ok) return { ok: false, error: 'bad_request' };
    var category = readCategoryInput(input.category);
    if (!category.ok) return { ok: false, error: 'bad_request' };
    var tags = readTagsInput(input.tags);
    if (!tags.ok) return { ok: false, error: 'bad_request' };
    return {
      ok: true,
      fields: {
        url: url,
        note: note.value,
        category: category.value,
        tags: tags.value,
      },
    };
  }

  function buildNewItem(fields, fetched, nowIso, id) {
    var title = fetched && typeof fetched.title === 'string' ? fetched.title : '';
    var summary = fetched && typeof fetched.summary === 'string' ? fetched.summary : '';
    var image = fetched && typeof fetched.image === 'string' ? fetched.image : '';
    return {
      id: id,
      url: fields.url,
      platform: detectPlatform(fields.url),
      title: title,
      summary: summary,
      note: fields.note,
      category: parseCategoryList(fields.category),
      tags: parseTags(fields.tags),
      createdAt: nowIso,
      updatedAt: nowIso,
      image: image,
    };
  }

  function cloneItem(item) {
    return {
      id: item.id,
      url: item.url,
      platform: item.platform,
      title: item.title,
      summary: item.summary,
      note: item.note,
      category: parseCategoryList(item.category),
      tags: parseTags(item.tags),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      image: item.image == null ? '' : String(item.image),
    };
  }

  function applyUpdate(item, patch, nowIso) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'bad_request' };
    }
    var changes = {};
    var any = false;
    for (var i = 0; i < USER_FIELDS.length; i++) {
      var field = USER_FIELDS[i];
      if (!Object.prototype.hasOwnProperty.call(patch, field) || patch[field] == null) continue;
      any = true;
      if (field === 'url') {
        var url = normalizeUrl(patch.url);
        if (!url) return { ok: false, error: 'invalid_url' };
        changes.url = url;
      } else if (field === 'tags') {
        var tags = readTagsInput(patch.tags);
        if (!tags.ok) return { ok: false, error: 'bad_request' };
        changes.tags = tags.value;
      } else if (field === 'category') {
        var categories = readCategoryInput(patch.category);
        if (!categories.ok) return { ok: false, error: 'bad_request' };
        changes.category = categories.value;
      } else if (typeof patch[field] !== 'string') {
        return { ok: false, error: 'bad_request' };
      } else {
        changes[field] = patch[field].trim();
      }
    }
    if (!any) return { ok: false, error: 'bad_request' };

    var next = cloneItem(item);
    var keys = Object.keys(changes);
    for (var k = 0; k < keys.length; k++) next[keys[k]] = changes[keys[k]];
    if (
      Object.prototype.hasOwnProperty.call(changes, 'url') &&
      !Object.prototype.hasOwnProperty.call(changes, 'platform')
    ) {
      next.platform = detectPlatform(changes.url);
    }
    next.updatedAt = nowIso;
    return { ok: true, item: next };
  }

  function findDuplicate(items, url) {
    var target = normalizeUrl(url);
    if (!target) return null;
    for (var i = 0; i < items.length; i++) {
      if (normalizeUrl(items[i].url) === target) return items[i];
    }
    return null;
  }

  function sortNewestFirst(items) {
    return items.slice().sort(function (a, b) {
      if (a.createdAt !== b.createdAt) {
        if (!a.createdAt) return 1;
        if (!b.createdAt) return -1;
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      if (a.updatedAt === b.updatedAt) return 0;
      if (!a.updatedAt) return 1;
      if (!b.updatedAt) return -1;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
  }

  return {
    ITEMS_HEADERS: ITEMS_HEADERS,
    USER_FIELDS: USER_FIELDS,
    MAX_HTML_CHARS: MAX_HTML_CHARS,
    FETCH_REQUEST: FETCH_REQUEST,
    detectPlatform: detectPlatform,
    normalizeUrl: normalizeUrl,
    extractMeta: extractMeta,
    previewFromFetch: previewFromFetch,
    pickImageBackfill: pickImageBackfill,
    CATEGORY_HEADERS: CATEGORY_HEADERS,
    CATEGORY_COLORS: CATEGORY_COLORS,
    parseCategoryList: parseCategoryList,
    serializeCategoryList: serializeCategoryList,
    seedCategories: seedCategories,
    duplicateCategory: duplicateCategory,
    itemMatchesCategory: itemMatchesCategory,
    planAddCategory: planAddCategory,
    planUpdateCategory: planUpdateCategory,
    parseTags: parseTags,
    serializeTags: serializeTags,
    rowToItem: rowToItem,
    itemToRow: itemToRow,
    authorize: authorize,
    parseAddFields: parseAddFields,
    buildNewItem: buildNewItem,
    applyUpdate: applyUpdate,
    findDuplicate: findDuplicate,
    sortNewestFirst: sortNewestFirst,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Mnemosyne;
}
