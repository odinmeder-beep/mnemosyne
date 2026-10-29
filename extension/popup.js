'use strict';

var EXEC_URL = 'https://script.google.com/macros/s/AKfycbzjZvIIGRK6XLs6B8IpI2OQ33YeiheLJ__v-I38ybvX67vVw7h0iSxCKEFtt2zq4X3s5A/exec';
var STORAGE_KEY = 'mnemosyne.key';

var needKey = document.getElementById('need-key');
var form = document.getElementById('save-form');
var urlInput = document.getElementById('url');
var titleInput = document.getElementById('title');
var noteInput = document.getElementById('note');
var tagsInput = document.getElementById('tags');
var searchInput = document.getElementById('category-search');
var categoryList = document.getElementById('categories');
var categoryStatus = document.getElementById('category-status');
var message = document.getElementById('message');
var saveButton = document.getElementById('save');

var apiKey = '';
var categories = [];
var chosen = {};

function showMessage(text, ok) {
  message.hidden = false;
  message.className = ok ? 'banner ok' : 'banner';
  message.textContent = text;
}

function errorText(code) {
  var messages = {
    unauthorized: '金鑰不正確。請到設定確認金鑰。',
    invalid_url: '請貼上以 http 或 https 開頭的網址。',
    unknown_action: '後端還沒有分類功能。請先更新 Apps Script 並部署新版本。',
    not_setup: '試算表還沒建立。請在 Apps Script 執行 setup。',
    network: '連不上後端。',
    bad_response: '後端的回覆無法讀取。',
  };
  return messages[code] || '發生問題，請再試一次。';
}

function isHttpUrl(value) {
  try {
    var parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function parseTags(value) {
  return String(value || '').split(',').map(function (part) {
    return part.trim();
  }).filter(Boolean);
}

function callApi(action, extra) {
  var payload = { key: apiKey, action: action };
  if (extra) {
    Object.keys(extra).forEach(function (name) {
      payload[name] = extra[name];
    });
  }
  return fetch(EXEC_URL, {
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

function orderedRows(query) {
  var needle = String(query || '').trim().toLowerCase();
  var byParent = {};
  categories.forEach(function (cat) {
    var name = cat && cat.name ? String(cat.name).trim() : '';
    if (!name) return;
    var parent = cat.parent ? String(cat.parent).trim() : '';
    if (!byParent[parent]) byParent[parent] = [];
    byParent[parent].push({ name: name, color: cat.color || '#90a4ae', parent: parent });
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

function selectedNames() {
  return Object.keys(chosen).filter(function (name) { return chosen[name]; });
}

function renderCategories() {
  categoryList.replaceChildren();
  orderedRows(searchInput.value).forEach(function (row) {
    var line = document.createElement('label');
    line.className = 'cat-row';
    line.style.paddingLeft = (10 + row.depth * 16) + 'px';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(chosen[row.name]);
    box.addEventListener('change', function () {
      chosen[row.name] = box.checked;
    });
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = row.color || '#90a4ae';
    var label = document.createElement('span');
    label.textContent = row.name;
    line.append(box, dot, label);
    categoryList.appendChild(line);
  });
}

function fillCurrentTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || !isHttpUrl(tab.url)) return;
    if (!urlInput.value) urlInput.value = tab.url;
    if (!titleInput.value) titleInput.value = tab.title || '';
  });
}

function loadCategories() {
  categoryStatus.textContent = '讀取分類…';
  callApi('listCategories').then(function (data) {
    categories = Array.isArray(data.categories) ? data.categories : [];
    categoryStatus.textContent = categories.length ? '' : '還沒有分類。';
    renderCategories();
  }).catch(function (err) {
    categoryStatus.textContent = errorText(err && err.code);
  });
}

document.getElementById('open-options').addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
});

searchInput.addEventListener('input', renderCategories);

form.addEventListener('submit', function (event) {
  event.preventDefault();
  var url = urlInput.value.trim();
  if (!isHttpUrl(url)) {
    showMessage(errorText('invalid_url'), false);
    return;
  }
  var title = titleInput.value.trim();
  saveButton.disabled = true;
  message.hidden = true;
  callApi('add', {
    url: url,
    note: noteInput.value.trim(),
    category: selectedNames(),
    tags: parseTags(tagsInput.value),
  }).then(function (data) {
    if (data.duplicate) {
      showMessage('這個連結已經收藏過了，沒有再新增一筆。', true);
      saveButton.disabled = false;
      return null;
    }
    if (title && data.item && data.item.title !== title) {
      return callApi('update', { id: data.item.id, title: title });
    }
    return data;
  }).then(function (data) {
    if (data) window.close();
  }).catch(function (err) {
    showMessage(errorText(err && err.code), false);
    saveButton.disabled = false;
  });
});

chrome.storage.local.get(STORAGE_KEY, function (stored) {
  apiKey = stored[STORAGE_KEY] || '';
  if (!apiKey) {
    needKey.hidden = false;
    form.hidden = true;
    return;
  }
  needKey.hidden = true;
  form.hidden = false;
  fillCurrentTab();
  loadCategories();
});
