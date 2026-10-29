'use strict';

var DEFAULT_EXEC_URL = 'https://script.google.com/macros/s/AKfycbzjZvIIGRK6XLs6B8IpI2OQ33YeiheLJ__v-I38ybvX67vVw7h0iSxCKEFtt2zq4X3s5A/exec';
var STORAGE_URL = 'mnemosyne.execUrl';
var STORAGE_KEY = 'mnemosyne.key';

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

var navBack = document.getElementById('nav-back');
var navAdd = document.getElementById('nav-add');
var navSettings = document.getElementById('nav-settings');
var banner = document.getElementById('banner');
var viewList = document.getElementById('view-list');
var viewForm = document.getElementById('view-form');
var viewSettings = document.getElementById('view-settings');
var listStatus = document.getElementById('list-status');
var empty = document.getElementById('empty');
var cards = document.getElementById('cards');
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
      var chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = tag;
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

function renderCards() {
  cards.replaceChildren();
  empty.hidden = items.length !== 0;
  items.forEach(function (item) {
    cards.appendChild(renderCard(item));
  });
}

function refreshItems() {
  return callApi('list').then(function (data) {
    items = Array.isArray(data.items) ? data.items : [];
    itemsLoaded = true;
    return items;
  });
}

function showList() {
  var token = ++renderToken;
  setView('list');
  clearBanner();
  listStatus.hidden = false;
  listStatus.textContent = '讀取中…';
  empty.hidden = true;
  cards.replaceChildren();
  refreshItems().then(function () {
    if (token !== renderToken) return;
    listStatus.hidden = true;
    renderCards();
  }).catch(function (err) {
    if (token !== renderToken) return;
    listStatus.hidden = true;
    empty.hidden = true;
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

navBack.addEventListener('click', function () { location.hash = '#/'; });
navAdd.addEventListener('click', function () { location.hash = '#/add'; });
navSettings.addEventListener('click', function () { location.hash = '#/settings'; });
document.getElementById('empty-add').addEventListener('click', function () { location.hash = '#/add'; });
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
  var url = execUrlInput.value.trim();
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
  if ((location.hash || '#/') === '#/') showList();
  else location.hash = '#/';
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
