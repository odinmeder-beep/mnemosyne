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

  function extractMeta(html) {
    var empty = { title: '', summary: '' };
    if (typeof html !== 'string' || !html) return empty;
    var source = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
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
    };
  }

  function previewFromFetch(url, httpStatus, html) {
    var normalized = normalizeUrl(url);
    var preview = {
      url: normalized,
      platform: detectPlatform(normalized),
      title: '',
      summary: '',
      fetched: false,
    };
    if (!normalized) return preview;
    if (typeof httpStatus !== 'number' || httpStatus < 200 || httpStatus >= 300) return preview;
    var meta = extractMeta(html);
    preview.title = meta.title;
    preview.summary = meta.summary;
    preview.fetched = true;
    return preview;
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
    return item;
  }

  function itemToRow(item) {
    return ITEMS_HEADERS.map(function (key) {
      if (key === 'tags') return serializeTags(item.tags);
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
    var category = readOptionalText(input, 'category');
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
    return {
      id: id,
      url: fields.url,
      platform: detectPlatform(fields.url),
      title: title,
      summary: summary,
      note: fields.note,
      category: fields.category,
      tags: parseTags(fields.tags),
      createdAt: nowIso,
      updatedAt: nowIso,
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
      category: item.category,
      tags: parseTags(item.tags),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
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
