'use strict';

var DEFAULT_EXEC_URL = 'https://script.google.com/macros/s/AKfycbzjZvIIGRK6XLs6B8IpI2OQ33YeiheLJ__v-I38ybvX67vVw7h0iSxCKEFtt2zq4X3s5A/exec';
var STORAGE_URL = 'mnemosyne.execUrl';
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
var categoryOptions = document.getElementById('category-options');
var previewBtn = document.getElementById('preview-btn');
var previewStatus = document.getElementById('preview-status');
var formMessage = document.getElementById('form-message');
var saveBtn = document.getElementById('save-btn');
var formDelete = document.getElementById('form-delete');
var settingsForm = document.getElementById('settings-form');
var execUrlInput = document.getElementById('exec-url');
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
  return Boolean(localStorage.getItem(STORAGE_URL) && localStorage.getItem(STORAGE_KEY));
}

function isHttpUrl(value) {
  try {
    var parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function errorMessage(err) {
  var code = err && err.code;
  var messages = {
    unauthorized: '金鑰不正確。請到設定確認金鑰。',
    invalid_url: '請貼上以 http 或 https 開頭的網址。',
    not_found: '找不到這則收藏，可能已經刪除。',
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
  var execUrl = localStorage.getItem(STORAGE_URL);
  var key = localStorage.getItem(STORAGE_KEY);
  var payload = { key: key, action: action };
  if (extra) {
    Object.keys(extra).forEach(function (name) {
      payload[name] = extra[name];
    });
  }
  return fetch(execUrl, {
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

function fillCategories() {
  var names = [];
  items.forEach(function (item) {
    var name = item.category ? String(item.category).trim() : '';
    if (name && names.indexOf(name) === -1) names.push(name);
  });
  names.sort();
  categoryOptions.replaceChildren();
  names.forEach(function (name) {
    var option = document.createElement('option');
    option.value = name;
    categoryOptions.appendChild(option);
  });
}

function renderCard(item) {
  var card = document.createElement('article');
  card.className = 'card';

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
  card.append(meta, title);

  if (item.summary) {
    var summary = document.createElement('p');
    summary.className = 'summary';
    summary.textContent = item.summary;
    card.append(summary);
  }
  if (item.note) {
    var note = document.createElement('p');
    note.className = 'note';
    note.textContent = item.note;
    card.append(note);
  }
  if (item.category) {
    var category = document.createElement('p');
    category.className = 'category';
    category.textContent = '分類：' + item.category;
    card.append(category);
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
    card.append(row);
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
  card.append(actions);
  return card;
}

function tagsOf(item) {
  return Array.isArray(item.tags) ? item.tags : [];
}

function categoryName(item) {
  return item.category ? String(item.category).trim() : '';
}

function searchText(item) {
  if (item._search) return item._search;
  item._search = [item.title, item.summary, item.note, item.category]
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
    var category = categoryName(item);
    if (categoryFilter === '__none__') {
      if (category) continue;
    } else if (categoryFilter && category !== categoryFilter) {
      continue;
    }
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

function makeChip(label, count, pressed, value) {
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip' + (pressed ? ' is-on' : '');
  button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  button.setAttribute('data-value', value);
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

  var counts = {};
  var uncategorized = 0;
  items.forEach(function (item) {
    var name = categoryName(item);
    if (!name) uncategorized += 1;
    else counts[name] = (counts[name] || 0) + 1;
  });
  var names = Object.keys(counts).sort(function (a, b) {
    return a.localeCompare(b, 'zh-Hant');
  });
  categoryFilters.replaceChildren();
  categoryFilters.appendChild(makeChip('全部', items.length, categoryFilter === '', ''));
  names.forEach(function (name) {
    categoryFilters.appendChild(makeChip(name, counts[name], categoryFilter === name, name));
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
  refreshItems().then(function () {
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
  itemTags.value = '';
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
  itemCategory.value = item.category || '';
  itemTags.value = Array.isArray(item.tags) ? item.tags.join(', ') : '';
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
  var load = itemsLoaded ? Promise.resolve(items) : refreshItems().catch(function () {
    return items;
  });
  load.then(function () {
    if (token !== renderToken) return;
    fillCategories();
    if (!id) {
      clearItemForm();
      formHeading.textContent = '新增收藏';
      saveBtn.textContent = '儲存';
      formDelete.hidden = true;
      editingId = null;
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
  execUrlInput.value = localStorage.getItem(STORAGE_URL) || DEFAULT_EXEC_URL;
  secretKeyInput.value = localStorage.getItem(STORAGE_KEY) || '';
  secretKeyInput.type = 'password';
  toggleKey.textContent = '顯示金鑰';
  clearSettingsBtn.hidden = !hasSettings();
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

settingsForm.addEventListener('submit', function (event) {
  event.preventDefault();
  var url = execUrlInput.value.trim() || DEFAULT_EXEC_URL;
  var key = secretKeyInput.value.trim();
  if (!isHttpUrl(url)) {
    settingsMessage.hidden = false;
    settingsMessage.className = 'banner';
    settingsMessage.textContent = '請貼上以 http 或 https 開頭的後端網址。';
    return;
  }
  if (!key) {
    settingsMessage.hidden = false;
    settingsMessage.className = 'banner';
    settingsMessage.textContent = '請填金鑰。';
    return;
  }
  localStorage.setItem(STORAGE_URL, url);
  localStorage.setItem(STORAGE_KEY, key);
  openList();
});

clearSettingsBtn.addEventListener('click', function () {
  localStorage.removeItem(STORAGE_URL);
  localStorage.removeItem(STORAGE_KEY);
  items = [];
  itemsLoaded = false;
  execUrlInput.value = DEFAULT_EXEC_URL;
  secretKeyInput.value = '';
  clearSettingsBtn.hidden = true;
  settingsMessage.hidden = false;
  settingsMessage.className = 'banner ok';
  settingsMessage.textContent = '已清除這台裝置上的網址與金鑰。';
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

window.addEventListener('hashchange', renderRoute);

if (!hasSettings()) {
  if (location.hash !== '#/settings') location.hash = '#/settings';
  else renderRoute();
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
