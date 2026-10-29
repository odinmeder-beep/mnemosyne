'use strict';

var DEFAULT_EXEC_URL = 'https://script.google.com/macros/s/AKfycbzjZvIIGRK6XLs6B8IpI2OQ33YeiheLJ__v-I38ybvX67vVw7h0iSxCKEFtt2zq4X3s5A/exec';
var STORAGE_KEY = 'mnemosyne.key';
var STORAGE_SORT = 'mnemosyne.sort';
var PAGE_SIZE = 40;
var PLATFORMS = ['threads', 'instagram', 'facebook', 'x', 'web'];

var PLATFORM_LABEL = {
  threads: 'Threads',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
  web: '網頁',
};

var dateFormat = new Intl.DateTimeFormat('zh-Hant-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

var items = [];
var itemsLoaded = false;
var categories = [];
var editingId = null;
var useFormMeta = false;
var pendingDelete = null;
var renderToken = 0;
var currentView = 'list';
var query = '';
var sortMode = readSort();
var platformFilter = '';
var categoryFilter = '';
var tagFilter = '';
var visibleLimit = PAGE_SIZE;
var searchTimer = null;

var navBack = document.getElementById('nav-back');
var navAdd = document.getElementById('nav-add');
var navSettings = document.getElementById('nav-settings');
var banner = document.getElementById('banner');
var viewList = document.getElementById('view-list');
var viewForm = document.getElementById('view-form');
var viewSettings = document.getElementById('view-settings');
var listTools = document.getElementById('list-tools');
var searchInput = document.getElementById('search');
var sortSelect = document.getElementById('sort');
var platformFilters = document.getElementById('platform-filters');
var categoryFilters = document.getElementById('category-filters');
var activeFilters = document.getElementById('active-filters');
var resultCount = document.getElementById('result-count');
var listStatus = document.getElementById('list-status');
var empty = document.getElementById('empty');
var emptyText = document.getElementById('empty-text');
var emptyAdd = document.getElementById('empty-add');
var clearFiltersBtn = document.getElementById('clear-filters');
var cards = document.getElementById('cards');
var showMoreBtn = document.getElementById('show-more');
var formHeading = document.getElementById('form-heading');
var itemForm = document.getElementById('item-form');
var itemUrl = document.getElementById('item-url');
var itemTitle = document.getElementById('item-title');
var itemSummary = document.getElementById('item-summary');
var itemNote = document.getElementById('item-note');
var itemCategory = document.getElementById('item-category');
var itemTags = document.getElementById('item-tags');
var previewBtn = document.getElementById('preview-btn');
var previewStatus = document.getElementById('preview-status');
var formMessage = document.getElementById('form-message');
var saveBtn = document.getElementById('save-btn');
var formDelete = document.getElementById('form-delete');
var settingsForm = document.getElementById('settings-form');
var secretKeyInput = document.getElementById('secret-key');
var toggleKey = document.getElementById('toggle-key');
var settingsMessage = document.getElementById('settings-message');
var clearSettingsBtn = document.getElementById('clear-settings');
var confirmBox = document.getElementById('confirm');
var confirmText = document.getElementById('confirm-text');
var confirmDeleteBtn = document.getElementById('confirm-delete');
var confirmCancelBtn = document.getElementById('confirm-cancel');

function readSort() {
  var saved = localStorage.getItem(STORAGE_SORT);
  if (saved === 'oldest' || saved === 'title' || saved === 'newest') return saved;
  return 'newest';
}

function hasSettings() {
  return Boolean(localStorage.getItem(STORAGE_KEY));
}

function isHttpUrl(value) {
  try {
    var parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

var SHARE_STORAGE = 'mnemosyne.share';

function firstHttpUrl(value) {
  var match = String(value == null ? '' : value).match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return '';
  var raw = match[0].replace(/[)\].,;:!?，。、】）》」』]+$/g, '');
  if (!isHttpUrl(raw)) return '';
  return new URL(raw).href;
}

function sharedLinkFromParams(params) {
  var fields = ['url', 'text', 'title'];
  for (var i = 0; i < fields.length; i++) {
    var found = firstHttpUrl(params.get(fields[i]));
    if (found) return found;
  }
  return '';
}

function pendingShare() {
  var raw = sessionStorage.getItem(SHARE_STORAGE);
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { url: typeof parsed.url === 'string' ? parsed.url : '' };
  } catch (err) {
    sessionStorage.removeItem(SHARE_STORAGE);
    return null;
  }
}

function rememberShareFromLocation() {
  var params = new URLSearchParams(location.search);
  if (params.get('share') !== '1') return;
  sessionStorage.setItem(SHARE_STORAGE, JSON.stringify({ url: sharedLinkFromParams(params) }));
  history.replaceState(null, '', location.pathname + location.hash);
}

function applySharedDraft() {
  var shared = pendingShare();
  if (!shared) return;
  sessionStorage.removeItem(SHARE_STORAGE);
  if (shared.url) {
    itemUrl.value = shared.url;
    onPreview();
    return;
  }
  previewStatus.hidden = false;
  previewStatus.textContent = '這次分享裡沒有找到連結。';
}

function openSharedAdd() {
  if (location.hash !== '#/add') location.hash = '#/add';
  else showForm(null);
}

function errorMessage(err) {
  var code = err && err.code;
  var messages = {
    unauthorized: '金鑰不正確。請到設定確認金鑰。',
    invalid_url: '請貼上以 http 或 https 開頭的網址。',
    not_found: '找不到這則收藏，可能已經刪除。',
    duplicate: '已經有同名的分類。',
    not_setup: '試算表還沒建立。請在 Apps Script 執行 setup。',
    busy: '暫時忙碌，請再試一次。',
    network: '連不上後端。請檢查網址與網路。',
    bad_response: '後端的回覆無法讀取。請確認網址是以 /exec 結尾的部署網址。',
    method_not_allowed: '請改用以 /exec 結尾的部署網址。',
  };
  if (messages[code]) return messages[code];
  if (code && /^[a-z0-9_]+$/.test(code)) return '發生問題（' + code + '）。請再試一次。';
  return '發生問題，請再試一次。';
}

function callApi(action, extra) {
  var key = localStorage.getItem(STORAGE_KEY);
  var payload = { key: key, action: action };
  if (extra) {
    Object.keys(extra).forEach(function (name) {
      payload[name] = extra[name];
    });
  }
  return fetch(DEFAULT_EXEC_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  }).then(function (response) {
    return response.text().then(function (text) {
      var data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        var bad = new Error('bad_response');
        bad.code = 'bad_response';
        throw bad;
      }
      if (!data || data.ok !== true) {
        var failed = new Error((data && data.error) || 'internal_error');
        failed.code = (data && data.error) || 'internal_error';
        throw failed;
      }
      return data;
    });
  }).catch(function (err) {
    if (err && err.code) throw err;
    var network = new Error('network');
    network.code = 'network';
    throw network;
  });
}

function formatDate(iso) {
  if (!iso) return '';
  var date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return dateFormat.format(date);
}

function parseTags(value) {
  return String(value || '').split(',').map(function (part) {
    return part.trim();
  }).filter(Boolean);
}

function showBanner(err) {
  banner.hidden = false;
  banner.className = 'banner';
  banner.textContent = errorMessage(err);
}

function clearBanner() {
  banner.hidden = true;
  banner.textContent = '';
}

function setHeader() {
  var configured = hasSettings();
  navAdd.hidden = currentView !== 'list';
  navSettings.hidden = currentView !== 'list';
  navBack.hidden = currentView === 'list' || !configured;
}

function setView(name) {
  currentView = name;
  viewList.hidden = name !== 'list';
  viewForm.hidden = name !== 'form';
  viewSettings.hidden = name !== 'settings';
  setHeader();
}

function hideConfirm() {
  confirmBox.hidden = true;
  pendingDelete = null;
}

function showFormMessage(text, ok) {
  formMessage.hidden = false;
  formMessage.className = ok ? 'banner ok' : 'banner';
  formMessage.textContent = text;
}

function clearFormMessage() {
  formMessage.hidden = true;
  formMessage.textContent = '';
  formMessage.className = 'banner';
}

function refreshCategories() {
  return callApi('listCategories').then(function (data) {
    categories = Array.isArray(data.categories) ? data.categories : [];
    return categories;
  });
}

function orderedCategoryRows(query) {
  var needle = String(query || '').trim().toLowerCase();
  var byParent = {};
  categories.forEach(function (cat) {
    var name = cat && cat.name ? String(cat.name).trim() : '';
    if (!name) return;
    var parent = cat.parent ? String(cat.parent).trim() : '';
    if (!byParent[parent]) byParent[parent] = [];
    byParent[parent].push({ name: name, color: cat.color || '', parent: parent });
  });
  Object.keys(byParent).forEach(function (key) {
    byParent[key].sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hant'); });
  });
  function subtreeHasMatch(name, guard) {
    if (guard > 8) return false;
    if (!needle || name.toLowerCase().indexOf(needle) !== -1) return true;
    var kids = byParent[name] || [];
    for (var i = 0; i < kids.length; i++) {
      if (subtreeHasMatch(kids[i].name, guard + 1)) return true;
    }
    return false;
  }
  var out = [];
  function walk(parent, depth, guard) {
    if (guard > 8) return;
    (byParent[parent] || []).forEach(function (cat) {
      if (needle && !subtreeHasMatch(cat.name, 0)) return;
      out.push({ name: cat.name, color: cat.color, depth: depth });
      walk(cat.name, depth + 1, guard + 1);
    });
  }
  walk('', 0, 0);
  return out;
}

function renderCategoryPicker() {
  var chosenBox = document.getElementById('chosen-category');
  var list = document.getElementById('category-list');
  var search = document.getElementById('category-search');
  if (!chosenBox || !list || !itemCategory) return;
  var chosen = categoryNames({ category: itemCategory.value });
  chosenBox.replaceChildren();
  if (chosen.length) {
    chosenBox.hidden = false;
    chosen.forEach(function (name) {
      var picked = document.createElement('button');
      picked.type = 'button';
      picked.className = 'cat-chip';
      picked.textContent = name;
      var pickedColor = colorFor(name) || '#3d8195';
      picked.style.background = pickedColor;
      picked.style.color = chipTextColor(pickedColor);
      picked.addEventListener('click', function () {
        writeCategoryField(chosen.filter(function (entry) { return entry !== name; }));
        renderCategoryPicker();
      });
      chosenBox.appendChild(picked);
    });
  } else {
    chosenBox.hidden = true;
  }
  var query = search ? search.value : '';
  list.replaceChildren();
  orderedCategoryRows(query).forEach(function (row) {
    var line = document.createElement('label');
    line.className = 'cat-row' + (chosen.indexOf(row.name) !== -1 ? ' is-on' : '');
    line.style.paddingLeft = (0.75 + row.depth * 1.15) + 'rem';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = chosen.indexOf(row.name) !== -1;
    box.addEventListener('change', function () {
      var next = categoryNames({ category: itemCategory.value });
      var index = next.indexOf(row.name);
      if (box.checked && index === -1) next.push(row.name);
      if (!box.checked && index !== -1) next.splice(index, 1);
      writeCategoryField(next);
      renderCategoryPicker();
    });
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = row.color || '#90a4ae';
    var label = document.createElement('span');
    label.textContent = row.name;
    line.append(box, dot, label);
    list.appendChild(line);
  });
}

function usableImage(value) {
  var text = value == null ? '' : String(value).trim();
  if (!text || text === '-') return '';
  return text;
}

function faviconUrl(pageUrl) {
  var match = /^https?:\/\/([^/?#]+)/i.exec(String(pageUrl || ''));
  if (!match) return '';
  var host = match[1].split(':')[0];
  if (!host) return '';
  return 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64';
}

function renderThumb(item) {
  var box = document.createElement('div');
  box.className = 'thumb';
  var photo = usableImage(item.image);
  var icon = faviconUrl(item.url);
  function showIcon() {
    box.replaceChildren();
    if (!icon) return;
    var fallback = document.createElement('img');
    fallback.className = 'thumb-icon';
    fallback.alt = '';
    fallback.referrerPolicy = 'no-referrer';
    fallback.src = icon;
    fallback.addEventListener('error', function () { box.replaceChildren(); });
    box.appendChild(fallback);
  }
  if (photo) {
    var img = document.createElement('img');
    img.className = 'thumb-photo';
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = photo;
    img.addEventListener('error', showIcon);
    box.appendChild(img);
  } else {
    showIcon();
  }
  return box;
}

function renderCard(item) {
  var card = document.createElement('article');
  card.className = 'card';
  var top = document.createElement('div');
  top.className = 'card-top';
  var main = document.createElement('div');
  main.className = 'card-main';

  var meta = document.createElement('div');
  meta.className = 'meta';
  var badge = document.createElement('span');
  var platform = PLATFORM_LABEL[item.platform] ? item.platform : 'web';
  badge.className = 'badge ' + platform;
  badge.textContent = PLATFORM_LABEL[platform];
  var time = document.createElement('time');
  if (item.createdAt) time.dateTime = item.createdAt;
  time.textContent = formatDate(item.createdAt);
  meta.append(badge, time);

  var title = document.createElement('a');
  title.className = 'title';
  title.href = item.url || '#';
  title.target = '_blank';
  title.rel = 'noopener noreferrer';
  title.textContent = item.title || item.url || '沒有標題';
  main.append(meta, title);

  if (item.summary) {
    var summary = document.createElement('p');
    summary.className = 'summary';
    summary.textContent = item.summary;
    main.append(summary);
  }
  if (item.note) {
    var note = document.createElement('p');
    note.className = 'note';
    note.textContent = item.note;
    main.append(note);
  }
  var itemCategories = categoryNames(item);
  if (itemCategories.length) {
    var category = document.createElement('div');
    category.className = 'category';
    itemCategories.forEach(function (name) {
      var chip = document.createElement('span');
      chip.className = 'cat-chip';
      chip.textContent = name;
      var chipColor = colorFor(name);
      if (chipColor) {
        chip.style.background = chipColor;
        chip.style.color = chipTextColor(chipColor);
      }
      category.appendChild(chip);
    });
    main.append(category);
  }
  var tags = Array.isArray(item.tags) ? item.tags : [];
  if (tags.length) {
    var row = document.createElement('div');
    row.className = 'tags';
    tags.forEach(function (tag) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag' + (tag === tagFilter ? ' is-on' : '');
      chip.textContent = tag;
      chip.addEventListener('click', function () {
        tagFilter = tagFilter === tag ? '' : tag;
        visibleLimit = PAGE_SIZE;
        renderResults();
      });
      row.append(chip);
    });
    main.append(row);
  }

  var actions = document.createElement('div');
  actions.className = 'card-actions';
  var edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'ghost';
  edit.textContent = '編輯';
  edit.addEventListener('click', function () {
    location.hash = '#/edit/' + encodeURIComponent(item.id);
  });
  var remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'ghost';
  remove.textContent = '刪除';
  remove.addEventListener('click', function () {
    openConfirm(item);
  });
  actions.append(edit, remove);
  main.append(actions);
  top.append(renderThumb(item), main);
  card.append(top);
  return card;
}

function tagsOf(item) {
  return Array.isArray(item.tags) ? item.tags : [];
}

function categoryNames(item) {
  var value = item && item.category;
  var pieces = [];
  if (Array.isArray(value)) pieces = value;
  else if (value != null && String(value).trim()) pieces = String(value).split(';');
  var names = [];
  var seen = {};
  pieces.forEach(function (part) {
    var name = String(part == null ? '' : part).trim();
    if (!name || seen[name]) return;
    seen[name] = true;
    names.push(name);
  });
  return names;
}

function writeCategoryField(names) {
  itemCategory.value = categoryNames({ category: names }).join('; ');
}

function itemHasCategory(item, filter) {
  var names = categoryNames(item);
  if (filter === '__none__') return names.length === 0;
  for (var i = 0; i < names.length; i++) {
    if (categoryInFilter(names[i], filter)) return true;
  }
  return false;
}

function categoryInFilter(name, filter) {
  var root = String(filter || '').trim();
  var current = name == null ? '' : String(name).trim();
  if (!root) return true;
  if (root === '__none__') return current === '';
  var children = {};
  categories.forEach(function (cat) {
    var parent = cat.parent ? String(cat.parent).trim() : '';
    var catName = cat.name ? String(cat.name).trim() : '';
    if (!parent || !catName) return;
    if (!children[parent]) children[parent] = [];
    children[parent].push(catName);
  });
  var matched = {};
  var stack = [root];
  var guard = 0;
  while (stack.length && guard < 1000) {
    guard += 1;
    var next = stack.pop();
    if (!next || matched[next]) continue;
    matched[next] = true;
    (children[next] || []).forEach(function (child) { stack.push(child); });
  }
  return Boolean(matched[current]);
}

function colorFor(name) {
  for (var i = 0; i < categories.length; i++) {
    if (categories[i].name === name && categories[i].color) return categories[i].color;
  }
  return '';
}

function chipTextColor(hex) {
  var raw = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return '#fff';
  var r = parseInt(raw.slice(0, 2), 16);
  var g = parseInt(raw.slice(2, 4), 16);
  var b = parseInt(raw.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#1e1a16' : '#fff';
}

function searchText(item) {
  if (item._search) return item._search;
  item._search = [item.title, item.summary, item.note]
    .concat(categoryNames(item))
    .concat(tagsOf(item))
    .join('\n')
    .toLowerCase();
  return item._search;
}

function searchWords() {
  return query.trim().toLowerCase().split(/[\s\u3000]+/).filter(Boolean);
}

function matchesQuery(item, words) {
  if (!words.length) return true;
  var text = searchText(item);
  for (var i = 0; i < words.length; i++) {
    if (text.indexOf(words[i]) === -1) return false;
  }
  return true;
}

function platformOf(item) {
  return PLATFORM_LABEL[item.platform] ? item.platform : 'web';
}

function filteredItems() {
  var words = searchWords();
  var list = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (platformFilter && platformOf(item) !== platformFilter) continue;
    if (categoryFilter && !itemHasCategory(item, categoryFilter)) continue;
    if (tagFilter && tagsOf(item).indexOf(tagFilter) === -1) continue;
    if (!matchesQuery(item, words)) continue;
    list.push(item);
  }
  if (sortMode === 'oldest') {
    list.sort(function (a, b) { return timeValue(a) - timeValue(b); });
  } else if (sortMode === 'title') {
    list.sort(function (a, b) {
      var at = (a.title || a.url || '').trim();
      var bt = (b.title || b.url || '').trim();
      return at.localeCompare(bt, 'zh-Hant', { sensitivity: 'base', numeric: true });
    });
  } else {
    list.sort(function (a, b) { return timeValue(b) - timeValue(a); });
  }
  return list;
}

function timeValue(item) {
  var time = Date.parse(item.createdAt || '');
  return Number.isNaN(time) ? 0 : time;
}

function filtersActive() {
  return Boolean(query.trim() || platformFilter || categoryFilter || tagFilter);
}

function makeChip(label, count, pressed, value, color) {
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip' + (pressed ? ' is-on' : '');
  button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  button.setAttribute('data-value', value);
  if (color) {
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = color;
    button.appendChild(dot);
  }
  button.appendChild(document.createTextNode(label));
  if (count != null) {
    var mark = document.createElement('span');
    mark.className = 'count';
    mark.textContent = String(count);
    button.appendChild(mark);
  }
  return button;
}

function renderFilterChips() {
  platformFilters.replaceChildren();
  platformFilters.appendChild(makeChip('全部', null, platformFilter === '', ''));
  PLATFORMS.forEach(function (platform) {
    platformFilters.appendChild(makeChip(PLATFORM_LABEL[platform], null, platformFilter === platform, platform));
  });

  var names = [];
  var seen = {};
  function addName(name) {
    if (!name || seen[name]) return;
    seen[name] = true;
    names.push(name);
  }
  orderedCategoryRows('').forEach(function (row) { addName(row.name); });
  items.forEach(function (item) {
    categoryNames(item).forEach(addName);
  });
  var uncategorized = 0;
  items.forEach(function (item) {
    if (!categoryNames(item).length) uncategorized += 1;
  });
  categoryFilters.replaceChildren();
  categoryFilters.appendChild(makeChip('全部', items.length, categoryFilter === '', ''));
  names.forEach(function (name) {
    var count = 0;
    items.forEach(function (item) {
      if (itemHasCategory(item, name)) count += 1;
    });
    categoryFilters.appendChild(makeChip(name, count, categoryFilter === name, name, colorFor(name)));
  });
  categoryFilters.appendChild(makeChip('未分類', uncategorized, categoryFilter === '__none__', '__none__'));
}

function renderActiveTag() {
  activeFilters.replaceChildren();
  if (!tagFilter) {
    activeFilters.hidden = true;
    return;
  }
  activeFilters.hidden = false;
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip is-on';
  button.textContent = '標籤：' + tagFilter + ' ×';
  button.addEventListener('click', function () {
    tagFilter = '';
    visibleLimit = PAGE_SIZE;
    renderResults();
  });
  activeFilters.appendChild(button);
}

function setListLoading(on) {
  listStatus.textContent = on ? '讀取中…' : '';
  listStatus.hidden = !on;
}

function renderResults() {
  var matched = filteredItems();
  var shown = Math.min(visibleLimit, matched.length);
  cards.replaceChildren();
  for (var i = 0; i < shown; i++) cards.appendChild(renderCard(matched[i]));
  renderActiveTag();

  var filtering = filtersActive();
  if (!items.length) {
    listTools.hidden = true;
    resultCount.textContent = '';
    empty.hidden = false;
    emptyText.textContent = '還沒有收藏。';
    emptyAdd.hidden = false;
    clearFiltersBtn.hidden = true;
    showMoreBtn.hidden = true;
    return;
  }

  listTools.hidden = false;
  resultCount.textContent = filtering ? (matched.length + ' / ' + items.length + ' 則') : (items.length + ' 則');
  if (!matched.length) {
    empty.hidden = false;
    emptyText.textContent = '沒有符合的收藏。';
    emptyAdd.hidden = true;
    clearFiltersBtn.hidden = false;
  } else {
    empty.hidden = true;
  }
  if (shown < matched.length) {
    showMoreBtn.hidden = false;
    showMoreBtn.textContent = '顯示更多（還有 ' + (matched.length - shown) + ' 則）';
  } else {
    showMoreBtn.hidden = true;
  }
}

function refreshItems() {
  return callApi('list').then(function (data) {
    items = (Array.isArray(data.items) ? data.items : []).map(function (item) {
      item._search = '';
      searchText(item);
      return item;
    });
    itemsLoaded = true;
    return items;
  });
}

function showList() {
  var token = ++renderToken;
  setView('list');
  clearBanner();
  sortSelect.value = sortMode;
  if (!itemsLoaded) {
    setListLoading(true);
    listTools.hidden = true;
    empty.hidden = true;
    showMoreBtn.hidden = true;
    cards.replaceChildren();
  } else {
    setListLoading(false);
    renderFilterChips();
    renderResults();
  }
  Promise.all([
    refreshItems(),
    refreshCategories().catch(function () { return categories; }),
  ]).then(function () {
    if (token !== renderToken) return;
    setListLoading(false);
    renderFilterChips();
    renderResults();
  }).catch(function (err) {
    if (token !== renderToken) return;
    setListLoading(false);
    console.error(err && (err.stack || err.message || err));
    showBanner(err);
  });
}

function clearItemForm() {
  itemForm.reset();
  itemUrl.value = '';
  itemTitle.value = '';
  itemSummary.value = '';
  itemNote.value = '';
  itemCategory.value = '';
  var categorySearch = document.getElementById('category-search');
  if (categorySearch) categorySearch.value = '';
  itemTags.value = '';
  renderCategoryPicker();
  previewStatus.hidden = true;
  previewStatus.textContent = '';
  clearFormMessage();
  useFormMeta = false;
  editingId = null;
}

function fillItemForm(item) {
  itemUrl.value = item.url || '';
  itemTitle.value = item.title || '';
  itemSummary.value = item.summary || '';
  itemNote.value = item.note || '';
  writeCategoryField(categoryNames(item));
  itemTags.value = Array.isArray(item.tags) ? item.tags.join(', ') : '';
  renderCategoryPicker();
  previewStatus.hidden = true;
  clearFormMessage();
  useFormMeta = true;
}

function readFields() {
  return {
    url: itemUrl.value.trim(),
    title: itemTitle.value.trim(),
    summary: itemSummary.value.trim(),
    note: itemNote.value.trim(),
    category: itemCategory.value.trim(),
    tags: parseTags(itemTags.value),
  };
}

function showForm(id) {
  var token = ++renderToken;
  setView('form');
  clearBanner();
  clearFormMessage();
  var load = refreshCategories().catch(function () { return categories; }).then(function () {
    return itemsLoaded ? items : refreshItems().catch(function () { return items; });
  });
  load.then(function () {
    if (token !== renderToken) return;
    renderCategoryPicker();
    if (!id) {
      clearItemForm();
      formHeading.textContent = '新增收藏';
      saveBtn.textContent = '儲存';
      formDelete.hidden = true;
      editingId = null;
      applySharedDraft();
      return;
    }
    var item = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) item = items[i];
    }
    if (!item) {
      showBanner({ code: 'not_found' });
      location.hash = '#/';
      return;
    }
    fillItemForm(item);
    formHeading.textContent = '編輯收藏';
    saveBtn.textContent = '儲存變更';
    formDelete.hidden = false;
    editingId = id;
  });
}

function showSettings() {
  ++renderToken;
  setView('settings');
  clearBanner();
  settingsMessage.hidden = true;
  secretKeyInput.value = localStorage.getItem(STORAGE_KEY) || '';
  secretKeyInput.type = 'password';
  toggleKey.textContent = '顯示金鑰';
  clearSettingsBtn.hidden = !hasSettings();
  if (pendingShare()) {
    settingsMessage.hidden = false;
    settingsMessage.className = 'banner ok';
    settingsMessage.textContent = '貼上金鑰後，會打開這次分享的新增頁。';
  }
}

function renderRoute() {
  hideConfirm();
  if (!hasSettings() && location.hash !== '#/settings') {
    location.hash = '#/settings';
    return;
  }
  var hash = location.hash || '#/';
  if (hash === '#/settings') showSettings();
  else if (hash === '#/add') showForm(null);
  else if (hash.indexOf('#/edit/') === 0) showForm(decodeURIComponent(hash.slice('#/edit/'.length)));
  else showList();
}

function openConfirm(item) {
  pendingDelete = item;
  confirmText.textContent = '要刪除「' + (item.title || '這則收藏') + '」嗎？';
  confirmBox.hidden = false;
  confirmCancelBtn.focus();
}

function onPreview() {
  var url = itemUrl.value.trim();
  previewStatus.hidden = false;
  if (!isHttpUrl(url)) {
    previewStatus.textContent = errorMessage({ code: 'invalid_url' });
    return;
  }
  previewBtn.disabled = true;
  previewStatus.textContent = '讀取中…';
  callApi('preview', { url: url }).then(function (data) {
    var preview = data.preview || {};
    itemTitle.value = preview.title || '';
    itemSummary.value = preview.summary || '';
    useFormMeta = true;
    var platform = PLATFORM_LABEL[preview.platform] || PLATFORM_LABEL.web;
    if (preview.fetched && (preview.title || preview.summary)) {
      previewStatus.textContent = '已填入標題與摘要，可以修改。平台：' + platform + '。';
    } else {
      previewStatus.textContent = '讀不到標題與摘要，可以自己填。平台：' + platform + '。';
    }
  }).catch(function (err) {
    previewStatus.textContent = errorMessage(err);
  }).then(function () {
    previewBtn.disabled = false;
  });
}

function onSaveItem(event) {
  event.preventDefault();
  var fields = readFields();
  if (!isHttpUrl(fields.url)) {
    showFormMessage(errorMessage({ code: 'invalid_url' }), false);
    return;
  }
  saveBtn.disabled = true;
  var done = function () {
    saveBtn.disabled = false;
  };
  if (editingId) {
    callApi('update', {
      id: editingId,
      url: fields.url,
      title: fields.title,
      summary: fields.summary,
      note: fields.note,
      category: fields.category,
      tags: fields.tags,
    }).then(function () {
      location.hash = '#/';
    }).catch(function (err) {
      showFormMessage(errorMessage(err), false);
    }).then(done);
    return;
  }
  callApi('add', {
    url: fields.url,
    note: fields.note,
    category: fields.category,
    tags: fields.tags,
  }).then(function (result) {
    if (result.duplicate) {
      showFormMessage('這個連結已經收藏過了，沒有再新增一筆。', true);
      return null;
    }
    if (useFormMeta && result.item && (result.item.title !== fields.title || result.item.summary !== fields.summary)) {
      return callApi('update', {
        id: result.item.id,
        title: fields.title,
        summary: fields.summary,
      });
    }
    return result;
  }).then(function (result) {
    if (result) location.hash = '#/';
  }).catch(function (err) {
    showFormMessage(errorMessage(err), false);
  }).then(done);
}

function openList() {
  if ((location.hash || '#/') !== '#/') location.hash = '#/';
  else showList();
}

var EXPORT_COLUMNS = ['id', 'url', 'platform', 'title', 'summary', 'note', 'category', 'tags', 'createdAt', 'updatedAt', 'image'];

function exportDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function exportCell(item, key) {
  var value = item ? item[key] : '';
  if (key === 'tags') {
    if (Array.isArray(value)) return value.join(', ');
    return value == null ? '' : String(value);
  }
  if (key === 'category' && Array.isArray(value)) return value.join('; ');
  return value == null ? '' : String(value);
}

function csvEscape(value) {
  var text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function buildCsv(list) {
  var lines = [EXPORT_COLUMNS.join(',')];
  (list || []).forEach(function (item) {
    lines.push(EXPORT_COLUMNS.map(function (key) {
      return csvEscape(exportCell(item, key));
    }).join(','));
  });
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function buildJson(list) {
  var rows = (list || []).map(function (item) {
    var row = {};
    EXPORT_COLUMNS.forEach(function (key) {
      if (key === 'tags') {
        row.tags = Array.isArray(item.tags) ? item.tags.slice() : parseTags(item.tags);
      } else if (key === 'category' && Array.isArray(item.category)) {
        row.category = item.category.slice();
      } else {
        row[key] = item[key] == null ? '' : item[key];
      }
    });
    return row;
  });
  return JSON.stringify(rows, null, 2) + '\n';
}

function downloadText(filename, mime, text) {
  var blob = new Blob([text], { type: mime });
  var link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(link.href); }, 1500);
}

function showExportMessage(text) {
  var message = document.getElementById('export-message');
  if (!message) return;
  message.hidden = false;
  message.textContent = text;
}

function exportItems(kind) {
  if (!itemsLoaded) {
    showExportMessage('請先回到清單讀取收藏，再匯出。');
    return;
  }
  var date = exportDate();
  if (kind === 'csv') {
    downloadText('mnemosyne-' + date + '.csv', 'text/csv;charset=utf-8', buildCsv(items));
  } else {
    downloadText('mnemosyne-' + date + '.json', 'application/json;charset=utf-8', buildJson(items));
  }
  showExportMessage('已下載 ' + items.length + ' 則。');
}

var CATEGORY_SWATCHES = [
  '#e74c3c', '#e67e22', '#f1c40f', '#7cb342',
  '#2e7d32', '#00897b', '#3d8195', '#5dade2',
  '#2980b9', '#8e44ad', '#d81b60', '#f48fb1',
  '#90a4ae', '#b0bec5', '#37474f', '#1c1c1c',
];
var categoryDialog = document.getElementById('category-dialog');
var categoryForm = document.getElementById('category-form');
var newCatName = document.getElementById('new-cat-name');
var newCatParent = document.getElementById('new-cat-parent');
var newCatHex = document.getElementById('new-cat-hex');
var catPreview = document.getElementById('cat-preview');
var categoryDialogMessage = document.getElementById('category-dialog-message');

function updateCategoryPreview() {
  var name = newCatName.value.trim();
  var color = /^#[0-9a-fA-F]{6}$/.test(newCatHex.value.trim()) ? newCatHex.value.trim() : '#3d8195';
  catPreview.textContent = name || '例如：科技、設計...';
  catPreview.style.background = color;
  catPreview.style.color = chipTextColor(color);
  var swatches = document.getElementById('swatches');
  Array.prototype.forEach.call(swatches.children, function (button) {
    button.className = 'swatch' + (button.getAttribute('data-color') === color.toLowerCase() ? ' is-on' : '');
  });
}

function renderSwatches() {
  var box = document.getElementById('swatches');
  box.replaceChildren();
  CATEGORY_SWATCHES.forEach(function (color) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.style.background = color;
    button.setAttribute('data-color', color);
    button.setAttribute('aria-label', color);
    button.addEventListener('click', function () {
      newCatHex.value = color;
      updateCategoryPreview();
    });
    box.appendChild(button);
  });
  updateCategoryPreview();
}

function openCategoryDialog() {
  newCatName.value = '';
  newCatHex.value = '#3d8195';
  categoryDialogMessage.hidden = true;
  newCatParent.replaceChildren();
  var none = document.createElement('option');
  none.value = '';
  none.textContent = '未分類';
  newCatParent.appendChild(none);
  orderedCategoryRows('').forEach(function (row) {
    var option = document.createElement('option');
    option.value = row.name;
    option.textContent = (row.depth ? '· '.repeat(row.depth) : '') + row.name;
    newCatParent.appendChild(option);
  });
  newCatParent.value = '';
  renderSwatches();
  categoryDialog.hidden = false;
  newCatName.focus();
}

document.getElementById('new-category').addEventListener('click', openCategoryDialog);
document.getElementById('category-search').addEventListener('input', renderCategoryPicker);
document.getElementById('cat-cancel').addEventListener('click', function () {
  categoryDialog.hidden = true;
});
categoryDialog.addEventListener('click', function (event) {
  if (event.target === categoryDialog) categoryDialog.hidden = true;
});
newCatName.addEventListener('input', updateCategoryPreview);
newCatHex.addEventListener('input', updateCategoryPreview);
categoryForm.addEventListener('submit', function (event) {
  event.preventDefault();
  var name = newCatName.value.trim();
  var color = newCatHex.value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    categoryDialogMessage.hidden = false;
    categoryDialogMessage.className = 'banner';
    categoryDialogMessage.textContent = '請用 # 開頭的 6 碼顏色。';
    return;
  }
  var button = document.getElementById('cat-create');
  button.disabled = true;
  callApi('addCategory', {
    name: name,
    parent: newCatParent.value,
    color: color,
  }).then(function (data) {
    if (data.category) categories.push(data.category);
    var createdName = data.category ? data.category.name : name;
    var nextChosen = categoryNames({ category: itemCategory.value });
    if (nextChosen.indexOf(createdName) === -1) nextChosen.push(createdName);
    writeCategoryField(nextChosen);
    categoryDialog.hidden = true;
    renderCategoryPicker();
    renderFilterChips();
  }).catch(function (err) {
    categoryDialogMessage.hidden = false;
    categoryDialogMessage.className = 'banner';
    categoryDialogMessage.textContent = errorMessage(err);
  }).then(function () {
    button.disabled = false;
  });
});

navBack.addEventListener('click', function () { openList(); });
navAdd.addEventListener('click', function () { location.hash = '#/add'; });
navSettings.addEventListener('click', function () { location.hash = '#/settings'; });
document.getElementById('empty-add').addEventListener('click', function () { location.hash = '#/add'; });
clearFiltersBtn.addEventListener('click', function () {
  query = '';
  searchInput.value = '';
  platformFilter = '';
  categoryFilter = '';
  tagFilter = '';
  visibleLimit = PAGE_SIZE;
  renderFilterChips();
  renderResults();
});
searchInput.addEventListener('input', function () {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () {
    query = searchInput.value;
    visibleLimit = PAGE_SIZE;
    renderResults();
  }, 120);
});
searchInput.addEventListener('search', function () {
  clearTimeout(searchTimer);
  query = searchInput.value;
  visibleLimit = PAGE_SIZE;
  renderResults();
});
sortSelect.addEventListener('change', function () {
  sortMode = sortSelect.value;
  if (sortMode !== 'newest' && sortMode !== 'oldest' && sortMode !== 'title') sortMode = 'newest';
  localStorage.setItem(STORAGE_SORT, sortMode);
  sortSelect.value = sortMode;
  visibleLimit = PAGE_SIZE;
  renderResults();
});
function onFilterChip(event, current, assign) {
  var button = event.target.closest('button');
  if (!button) return;
  var value = button.getAttribute('data-value') || '';
  assign(value && value === current ? '' : value);
  visibleLimit = PAGE_SIZE;
  renderFilterChips();
  renderResults();
}
platformFilters.addEventListener('click', function (event) {
  onFilterChip(event, platformFilter, function (value) { platformFilter = value; });
});
categoryFilters.addEventListener('click', function (event) {
  onFilterChip(event, categoryFilter, function (value) { categoryFilter = value; });
});
showMoreBtn.addEventListener('click', function () {
  visibleLimit += PAGE_SIZE;
  renderResults();
});
previewBtn.addEventListener('click', onPreview);
itemTitle.addEventListener('input', function () { useFormMeta = true; });
itemSummary.addEventListener('input', function () { useFormMeta = true; });
itemForm.addEventListener('submit', onSaveItem);
formDelete.addEventListener('click', function () {
  var item = null;
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === editingId) item = items[i];
  }
  if (item) openConfirm(item);
});

document.getElementById('export-csv').addEventListener('click', function () {
  exportItems('csv');
});
document.getElementById('export-json').addEventListener('click', function () {
  exportItems('json');
});

settingsForm.addEventListener('submit', function (event) {
  event.preventDefault();
  var key = secretKeyInput.value.trim();
  if (!key) {
    settingsMessage.hidden = false;
    settingsMessage.className = 'banner';
    settingsMessage.textContent = '請填金鑰。';
    return;
  }
  localStorage.removeItem('mnemosyne.execUrl');
  localStorage.setItem(STORAGE_KEY, key);
  if (pendingShare()) openSharedAdd();
  else openList();
});

clearSettingsBtn.addEventListener('click', function () {
  localStorage.removeItem('mnemosyne.execUrl');
  localStorage.removeItem(STORAGE_KEY);
  items = [];
  itemsLoaded = false;
  secretKeyInput.value = '';
  clearSettingsBtn.hidden = true;
  settingsMessage.hidden = false;
  settingsMessage.className = 'banner ok';
  settingsMessage.textContent = '已清除這台裝置上的金鑰。';
  setHeader();
});

toggleKey.addEventListener('click', function () {
  var show = secretKeyInput.type === 'password';
  secretKeyInput.type = show ? 'text' : 'password';
  toggleKey.textContent = show ? '隱藏金鑰' : '顯示金鑰';
});

confirmCancelBtn.addEventListener('click', hideConfirm);
confirmBox.addEventListener('click', function (event) {
  if (event.target === confirmBox) hideConfirm();
});
confirmDeleteBtn.addEventListener('click', function () {
  if (!pendingDelete) return;
  var id = pendingDelete.id;
  var returnToList = location.hash.indexOf('#/edit/') === 0;
  confirmDeleteBtn.disabled = true;
  callApi('delete', { id: id }).then(function () {
    hideConfirm();
    if (returnToList) location.hash = '#/';
    else showList();
  }).catch(function (err) {
    hideConfirm();
    showBanner(err);
  }).then(function () {
    confirmDeleteBtn.disabled = false;
  });
});

localStorage.removeItem('mnemosyne.execUrl');
rememberShareFromLocation();

window.addEventListener('hashchange', renderRoute);

if (!hasSettings()) {
  if (location.hash !== '#/settings') location.hash = '#/settings';
  else renderRoute();
} else if (pendingShare()) {
  openSharedAdd();
} else if (!location.hash || location.hash === '#') {
  location.hash = '#/';
} else {
  renderRoute();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  });
}
