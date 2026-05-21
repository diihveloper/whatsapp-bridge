const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['baseUrl', 'token'], (v) => {
  $('baseUrl').value = v.baseUrl || 'http://127.0.0.1:4477';
  $('token').value = v.token || '';
});

$('save').addEventListener('click', () => {
  const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:4477';
  const token = $('token').value.trim();
  chrome.storage.local.set({ baseUrl, token }, () => {
    $('status').textContent = 'Saved. Reload the WhatsApp Web tab.';
    setTimeout(() => ($('status').textContent = ''), 4000);
  });
});
