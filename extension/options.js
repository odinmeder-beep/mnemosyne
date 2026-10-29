'use strict';

var STORAGE_KEY = 'mnemosyne.key';
var keyInput = document.getElementById('key');
var message = document.getElementById('message');
var toggle = document.getElementById('toggle');

function showMessage(text, ok) {
  message.hidden = false;
  message.className = ok ? 'banner ok' : 'banner';
  message.textContent = text;
}

chrome.storage.local.get(STORAGE_KEY, function (stored) {
  keyInput.value = stored[STORAGE_KEY] || '';
});

toggle.addEventListener('click', function () {
  var show = keyInput.type === 'password';
  keyInput.type = show ? 'text' : 'password';
  toggle.textContent = show ? '隱藏金鑰' : '顯示金鑰';
});

document.getElementById('options-form').addEventListener('submit', function (event) {
  event.preventDefault();
  var key = keyInput.value.trim();
  if (!key) {
    showMessage('請填金鑰。', false);
    return;
  }
  var payload = {};
  payload[STORAGE_KEY] = key;
  chrome.storage.local.set(payload, function () {
    showMessage('已儲存。', true);
  });
});
