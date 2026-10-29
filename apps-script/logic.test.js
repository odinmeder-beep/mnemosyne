/**
 * Run: node --test apps-script/logic.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const logic = require('./logic.js');

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-02-01T00:00:00.000Z';

function sampleItem(overrides) {
  return Object.assign(
    {
      id: 'id-1',
      url: 'https://example.com/a',
      platform: 'web',
      title: 'Title',
      summary: 'Summary',
      note: '',
      category: '',
      tags: ['news'],
      createdAt: NOW,
      updatedAt: NOW,
    },
    overrides || {}
  );
}

test('detectPlatform maps hosts and leaves everything else as web', () => {
  const cases = [
    ['https://www.threads.net/@someone/post/abc', 'threads'],
    ['https://threads.net/@someone', 'threads'],
    ['https://www.threads.com/@someone/post/abc', 'threads'],
    ['https://threads.com.evil.example/', 'web'],
    ['https://www.instagram.com/p/abc/', 'instagram'],
    ['https://instagr.am/p/abc', 'instagram'],
    ['https://m.facebook.com/story.php?id=1', 'facebook'],
    ['https://fb.com/page', 'facebook'],
    ['https://www.fb.watch/abc', 'facebook'],
    ['https://fb.me/abc', 'facebook'],
    ['https://x.com/user/status/1', 'x'],
    ['https://twitter.com/user/status/1', 'x'],
    ['https://mobile.twitter.com/user', 'x'],
    ['https://www.example.com/twitter.com', 'web'],
    ['https://nottwitter.com/x', 'web'],
    ['https://twitter.com.evil.example/', 'web'],
    ['https://example.com/path', 'web'],
    ['javascript:alert(1)', 'web'],
    ['', 'web'],
    [null, 'web'],
  ];
  for (const [url, platform] of cases) {
    assert.equal(logic.detectPlatform(url), platform, String(url));
  }
});

test('normalizeUrl canonicalizes http(s) links and rejects the rest', () => {
  assert.equal(logic.normalizeUrl(' https://Example.com/a/ '), 'https://example.com/a');
  assert.equal(logic.normalizeUrl('https://example.com'), 'https://example.com/');
  assert.equal(logic.normalizeUrl('https://example.com/'), 'https://example.com/');
  assert.equal(logic.normalizeUrl('https://example.com/a/#section'), 'https://example.com/a');
  assert.equal(logic.normalizeUrl('https://example.com/a/?q=1'), 'https://example.com/a?q=1');
  assert.equal(logic.normalizeUrl('https://user:secret@example.com/a'), 'https://example.com/a');
  assert.equal(logic.normalizeUrl('HTTPS://X.COM/Ab'), 'https://x.com/Ab');
  assert.equal(logic.normalizeUrl('javascript:alert(1)'), '');
  assert.equal(logic.normalizeUrl('ftp://example.com/a'), '');
  assert.equal(logic.normalizeUrl(''), '');
  assert.equal(logic.normalizeUrl('not a url'), '');
  assert.equal(logic.normalizeUrl('https://example.com/' + 'a'.repeat(5000)), '');
});

test('extractMeta prefers Open Graph, then Twitter, then title and description', () => {
  const full = `
    <html><head>
      <title>Title Tag</title>
      <meta name="description" content="meta desc">
      <meta name="twitter:title" content="twitter title">
      <meta name="twitter:description" content="twitter desc">
      <meta property="og:site_name" content="Site Name">
      <meta property="og:title" content="og title">
      <meta property="og:description" content="og desc">
    </head></html>`;
  assert.deepEqual(logic.extractMeta(full), { title: 'og title', summary: 'og desc' });

  const swapped = '<meta content="Swapped &amp; ready" property="og:title"><meta content="Desc &#39;here&#39;" property="og:description">';
  assert.deepEqual(logic.extractMeta(swapped), { title: 'Swapped & ready', summary: "Desc 'here'" });

  const quoted = "<meta property='og:title' content='Single &quot;Q&quot;'>";
  assert.equal(logic.extractMeta(quoted).title, 'Single "Q"');

  const embedded = '<meta property="og:title" content="hello name=description">';
  assert.equal(logic.extractMeta(embedded).title, 'hello name=description');

  const threadsStyle =
    '<meta property="og:title" content="Instagram&#xff08;&#064;instagram&#xff09; &#x2022; Threads&#xff0c;&#x66a2;&#x6240;&#x6b32;&#x8a00;">';
  assert.equal(logic.extractMeta(threadsStyle).title, 'Instagram（@instagram） • Threads，暢所欲言');

  const multiline = '<meta\n  property="og:title"\n  content="Multi line">';
  assert.equal(logic.extractMeta(multiline).title, 'Multi line');

  const twitterOnly = '<meta name="twitter:title" content="T"><meta name="twitter:description" content="D"><title>Other</title>';
  assert.deepEqual(logic.extractMeta(twitterOnly), { title: 'T', summary: 'D' });

  const fallback = '<html><head><title>  Foo\n  &amp; Bar  </title><meta name="description" content="About"></head></html>';
  assert.deepEqual(logic.extractMeta(fallback), { title: 'Foo & Bar', summary: 'About' });

  const emptyOg = '<meta property="og:title" content=""><meta property="og:title" content="Second"><title>Tag</title>';
  assert.equal(logic.extractMeta(emptyOg).title, 'Second');

  assert.deepEqual(logic.extractMeta(''), { title: '', summary: '' });
  assert.deepEqual(logic.extractMeta(null), { title: '', summary: '' });
  assert.deepEqual(logic.extractMeta('<html><<not really'), { title: '', summary: '' });
});

test('extractMeta ignores markup past the scan window', () => {
  const pad = 'x'.repeat(logic.MAX_HTML_CHARS);
  assert.equal(logic.extractMeta(pad + '<title>Too Late</title>').title, '');
  assert.equal(logic.extractMeta('<title>Early</title>' + pad).title, 'Early');
});

test('previewFromFetch keeps platform and blanks meta when the fetch fails', () => {
  const html = '<meta property="og:title" content="Headline"><meta property="og:description" content="Deck">';
  assert.deepEqual(logic.previewFromFetch('https://x.com/post/1', 200, html), {
    url: 'https://x.com/post/1',
    platform: 'x',
    title: 'Headline',
    summary: 'Deck',
    fetched: true,
  });
  assert.deepEqual(logic.previewFromFetch('https://www.threads.net/@a/post/b/', 403, html), {
    url: 'https://www.threads.net/@a/post/b',
    platform: 'threads',
    title: '',
    summary: '',
    fetched: false,
  });
  const titleOnly = logic.previewFromFetch('https://example.com/story', 200, '<title>Example Domain</title>');
  assert.equal(titleOnly.title, 'Example Domain');
  assert.equal(titleOnly.summary, '');
  assert.equal(titleOnly.fetched, true);
  assert.equal(logic.previewFromFetch('https://example.com', 200, '').fetched, true);
  assert.equal(logic.previewFromFetch('https://example.com', 0, html).fetched, false);
  assert.equal(logic.previewFromFetch('notaurl', 200, html).url, '');
});

test('rowToItem and itemToRow round-trip tags and ISO times', () => {
  const item = sampleItem({ tags: ['hello world', 'later'] });
  const row = logic.itemToRow(item);
  assert.deepEqual(row, [
    'id-1',
    'https://example.com/a',
    'web',
    'Title',
    'Summary',
    '',
    '',
    'hello world, later',
    NOW,
    NOW,
  ]);
  assert.deepEqual(logic.rowToItem(row), item);

  const fromSheet = logic.rowToItem([
    'id-2',
    'https://example.com/b',
    'web',
    'T',
    'S',
    'N',
    'C',
    'a, b',
    new Date('2026-01-02T03:04:05.000Z'),
    new Date('2026-01-02T04:00:00.000Z'),
  ]);
  assert.equal(fromSheet.createdAt, '2026-01-02T03:04:05.000Z');
  assert.equal(fromSheet.updatedAt, '2026-01-02T04:00:00.000Z');
  assert.deepEqual(fromSheet.tags, ['a', 'b']);
  assert.equal(logic.rowToItem(['only-id']).url, '');
  assert.deepEqual(logic.parseTags('a,b'), ['a', 'b']);
  assert.equal(logic.serializeTags(['a', 'b']), 'a, b');
});

test('authorize accepts only an exact configured key', () => {
  assert.equal(logic.authorize('correct-horse', 'correct-horse'), true);
  assert.equal(logic.authorize('correct-horsE', 'correct-horse'), false);
  assert.equal(logic.authorize('nope', 'correct-horse'), false);
  assert.equal(logic.authorize('', ''), false);
  assert.equal(logic.authorize('correct-horse', ''), false);
  assert.equal(logic.authorize('', 'correct-horse'), false);
  assert.equal(logic.authorize(null, 'correct-horse'), false);
  assert.equal(logic.authorize(undefined, null), false);
});

test('parseAddFields and buildNewItem fill platform, tags, and blank meta', () => {
  const parsed = logic.parseAddFields({
    url: 'https://twitter.com/a/status/1/',
    note: '  later  ',
    tags: ['閱讀', 'news, later'],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.url, 'https://twitter.com/a/status/1');
  assert.equal(parsed.fields.note, 'later');
  assert.equal(parsed.fields.category, '');
  assert.deepEqual(parsed.fields.tags, ['閱讀', 'news', 'later']);

  const item = logic.buildNewItem(parsed.fields, { title: '', summary: '' }, NOW, 'uuid-1');
  assert.equal(item.platform, 'x');
  assert.equal(item.title, '');
  assert.equal(item.summary, '');
  assert.equal(item.createdAt, NOW);
  assert.equal(item.updatedAt, NOW);
  assert.deepEqual(item.tags, ['閱讀', 'news', 'later']);

  assert.equal(logic.parseAddFields({ url: 'https://example.com', note: 1 }).error, 'bad_request');
  assert.equal(logic.parseAddFields({ url: 'https://example.com', tags: [1] }).error, 'bad_request');
  assert.equal(logic.parseAddFields({ url: 'ftp://example.com' }).error, 'invalid_url');
  assert.equal(logic.parseAddFields({}).error, 'invalid_url');
});

test('findDuplicate matches normalized URLs', () => {
  const items = [sampleItem({ url: 'https://example.com/a' })];
  assert.equal(logic.findDuplicate(items, 'https://example.com/a/').id, 'id-1');
  assert.equal(logic.findDuplicate(items, 'https://example.com/a#x').id, 'id-1');
  assert.equal(logic.findDuplicate(items, 'https://example.com/b'), null);
  assert.equal(logic.findDuplicate(items, 'not a url'), null);
});

test('applyUpdate edits provided user fields and bumps updatedAt', () => {
  const original = sampleItem();
  const renamed = logic.applyUpdate(original, { note: '  keep  ', tags: 'a, b' }, LATER);
  assert.equal(renamed.ok, true);
  assert.equal(renamed.item.note, 'keep');
  assert.deepEqual(renamed.item.tags, ['a', 'b']);
  assert.equal(renamed.item.createdAt, NOW);
  assert.equal(renamed.item.updatedAt, LATER);
  assert.equal(renamed.item.id, 'id-1');
  assert.equal(original.note, '');
  assert.deepEqual(original.tags, ['news']);

  const moved = logic.applyUpdate(original, { url: 'https://www.instagram.com/p/abc/' }, LATER);
  assert.equal(moved.item.url, 'https://www.instagram.com/p/abc');
  assert.equal(moved.item.platform, 'instagram');

  const forced = logic.applyUpdate(original, { url: 'https://x.com/a', platform: 'web' }, LATER);
  assert.equal(forced.item.platform, 'web');

  const ignored = logic.applyUpdate(original, { id: 'other', createdAt: LATER, note: 'x' }, LATER);
  assert.equal(ignored.item.id, 'id-1');
  assert.equal(ignored.item.createdAt, NOW);

  assert.equal(logic.applyUpdate(original, { url: 'nope' }, LATER).error, 'invalid_url');
  assert.equal(original.url, 'https://example.com/a');
  assert.equal(logic.applyUpdate(original, { action: 'update', id: 'id-1' }, LATER).error, 'bad_request');
  assert.equal(logic.applyUpdate(original, { title: 1 }, LATER).error, 'bad_request');
  assert.deepEqual(logic.applyUpdate(original, { tags: [] }, LATER).item.tags, []);
});

test('sortNewestFirst orders by createdAt without mutating the input', () => {
  const items = [
    sampleItem({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
    sampleItem({ id: 'new', createdAt: '2026-03-01T00:00:00.000Z' }),
    sampleItem({ id: 'mid', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z' }),
    sampleItem({ id: 'blank', createdAt: '' }),
  ];
  const sorted = logic.sortNewestFirst(items);
  assert.deepEqual(sorted.map((item) => item.id), ['new', 'mid', 'old', 'blank']);
  assert.equal(items[0].id, 'old');
});

test('the key is read from script properties and is not hard-coded', () => {
  const files = ['Code.gs', 'logic.js', 'appsscript.json', 'logic.test.js', 'fetch-samples.js'];
  const combined = files.map((name) => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n');
  assert.equal(combined.includes("getProperty('MNEMOSYNE_KEY')"), true);
  assert.equal(/MNEMOSYNE_KEY['"]?\s*[:=]\s*['"][^'"]+['"]/.test(combined), false);
});
