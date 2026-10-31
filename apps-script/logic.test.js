/**
 * Run: node --test apps-script/logic.test.js
 * URL is removed first. Apps Script V8 has no URL global, and these tests
 * must fail if parsing starts calling it again.
 */
delete globalThis.URL;

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
      category: [],
      tags: ['news'],
      createdAt: NOW,
      updatedAt: NOW,
      image: '',
    },
    overrides || {}
  );
}

test('parsing runs with the URL global removed', () => {
  assert.equal(typeof URL, 'undefined');
  assert.equal(logic.normalizeUrl('https://www.bbc.com/news'), 'https://www.bbc.com/news');
  assert.equal(logic.detectPlatform('https://www.bbc.com/news'), 'web');
  assert.equal(logic.normalizeUrl('https://www.bbc.com:443/news/'), 'https://www.bbc.com/news');
  assert.equal(logic.normalizeUrl('https://example.com:8443/a/'), 'https://example.com:8443/a');
  assert.equal(logic.normalizeUrl('https://example.com?q=1#section'), 'https://example.com/?q=1');
});

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
  assert.deepEqual(logic.extractMeta(full), { title: 'og title', summary: 'og desc', image: '' });

  const swapped = '<meta content="Swapped &amp; ready" property="og:title"><meta content="Desc &#39;here&#39;" property="og:description">';
  assert.deepEqual(logic.extractMeta(swapped), { title: 'Swapped & ready', summary: "Desc 'here'", image: '' });

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
  assert.deepEqual(logic.extractMeta(twitterOnly), { title: 'T', summary: 'D', image: '' });

  const fallback = '<html><head><title>  Foo\n  &amp; Bar  </title><meta name="description" content="About"></head></html>';
  assert.deepEqual(logic.extractMeta(fallback), { title: 'Foo & Bar', summary: 'About', image: '' });

  const emptyOg = '<meta property="og:title" content=""><meta property="og:title" content="Second"><title>Tag</title>';
  assert.equal(logic.extractMeta(emptyOg).title, 'Second');

  assert.deepEqual(logic.extractMeta(''), { title: '', summary: '', image: '' });
  assert.deepEqual(logic.extractMeta(null), { title: '', summary: '', image: '' });
  assert.deepEqual(logic.extractMeta('<html><<not really'), { title: '', summary: '', image: '' });
});

test('extractMeta reads og:image, then twitter:image, then image_src', () => {
  const page = 'https://example.com/news/story';
  assert.equal(
    logic.extractMeta('<meta property="og:image" content="https://cdn.example/og.jpg">', page).image,
    'https://cdn.example/og.jpg'
  );
  assert.equal(
    logic.extractMeta('<meta name="twitter:image" content="https://cdn.example/tw.jpg">', page).image,
    'https://cdn.example/tw.jpg'
  );
  assert.equal(
    logic.extractMeta(
      '<meta property="og:image" content="https://cdn.example/og.jpg"><meta name="twitter:image" content="https://cdn.example/tw.jpg">',
      page
    ).image,
    'https://cdn.example/og.jpg'
  );
  assert.equal(
    logic.extractMeta('<meta property="og:image" content="/images/pic.jpg">', page).image,
    'https://example.com/images/pic.jpg'
  );
  assert.equal(
    logic.extractMeta('<meta property="og:image" content="images/pic.jpg">', page).image,
    'https://example.com/news/images/pic.jpg'
  );
  assert.equal(
    logic.extractMeta('<link rel="image_src" href="//cdn.example/x.jpg">', page).image,
    'https://cdn.example/x.jpg'
  );
  assert.equal(logic.extractMeta('<title>No image</title>', page).image, '');
});

test('pickImageBackfill skips saved images and the empty marker', () => {
  const entries = [
    { item: { id: 'a', image: '' } },
    { item: { id: 'b', image: '  ' } },
    { item: { id: 'c', image: '-' } },
    { item: { id: 'd', image: 'https://cdn.example/a.jpg' } },
    { item: { id: 'e', image: '' } },
  ];
  const plan = logic.pickImageBackfill(entries, 1);
  assert.equal(plan.batch.length, 1);
  assert.equal(plan.batch[0].item.id, 'a');
  assert.equal(plan.remaining, 2);
  assert.equal(logic.pickImageBackfill(entries).batch.length, 3);
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
    image: '',
    fetched: true,
  });
  assert.deepEqual(logic.previewFromFetch('https://www.threads.net/@a/post/b/', 403, html), {
    url: 'https://www.threads.net/@a/post/b',
    platform: 'threads',
    title: '',
    summary: '',
    image: '',
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
    '',
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
  assert.deepEqual(fromSheet.category, ['C']);
  assert.equal(logic.rowToItem(['only-id']).url, '');
  assert.deepEqual(logic.parseTags('a,b'), ['a', 'b']);
  assert.equal(logic.serializeTags(['a', 'b']), 'a, b');

  const multi = sampleItem({ category: ['好吃的😋', 'AI的👩‍💻'] });
  const multiRow = logic.itemToRow(multi);
  assert.equal(multiRow[6], '好吃的😋; AI的👩‍💻');
  assert.deepEqual(logic.rowToItem(multiRow).category, ['好吃的😋', 'AI的👩‍💻']);
  const updated = logic.applyUpdate(multi, { category: '景點的🌸; 好吃的😋 ; 好吃的😋' }, LATER);
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.item.category, ['景點的🌸', '好吃的😋']);
  assert.equal(logic.itemToRow(updated.item)[6], '景點的🌸; 好吃的😋');
  assert.equal(logic.applyUpdate(multi, { category: 1 }, LATER).error, 'bad_request');
  assert.deepEqual(logic.applyUpdate(multi, { category: ['AI的👩‍💻', '好笑的😄'] }, LATER).item.category, ['AI的👩‍💻', '好笑的😄']);
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
  assert.deepEqual(parsed.fields.category, []);
  assert.deepEqual(parsed.fields.tags, ['閱讀', 'news', 'later']);

  const item = logic.buildNewItem(parsed.fields, { title: '', summary: '' }, NOW, 'uuid-1');
  assert.equal(item.platform, 'x');
  assert.equal(item.title, '');
  assert.equal(item.summary, '');
  assert.equal(item.image, '');
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

test('seedCategories keeps distinct item categories and skips names that exist', () => {
  const items = [
    { category: 'AI的👩‍💻' },
    { category: ' AI的👩‍💻 ' },
    { category: '' },
    { category: '  ' },
    { category: '好笑的😄' },
    { category: '好吃的😋' },
    { category: '景點的🌸; 好吃的😋' },
  ];
  const seeded = logic.seedCategories(items, [{ name: '好笑的😄', color: '#111111', parent: '', createdAt: NOW }], NOW);
  assert.deepEqual(seeded.map((row) => row.name), ['AI的👩‍💻', '好吃的😋', '景點的🌸']);
  assert.equal(seeded[0].color, logic.CATEGORY_COLORS[1]);
  assert.equal(seeded[0].parent, '');
  assert.equal(seeded[0].createdAt, NOW);
  assert.equal(logic.seedCategories([{ category: '' }], [], NOW).length, 0);
});

test('planAddCategory rejects duplicate names and unknown parents', () => {
  const existing = [{ name: 'AI的👩‍💻', color: '#3d8195', parent: '', createdAt: NOW }];
  assert.equal(logic.duplicateCategory(existing, ' AI的👩‍💻 '), true);
  assert.equal(logic.duplicateCategory(existing, '其他'), false);
  assert.equal(logic.planAddCategory(existing, { name: 'AI的👩‍💻', color: '#112233' }, LATER).error, 'duplicate');
  assert.equal(logic.planAddCategory(existing, { name: '  ', color: '#112233' }, LATER).error, 'bad_request');
  assert.equal(logic.planAddCategory(existing, { name: '新分類', parent: '沒有', color: '#112233' }, LATER).error, 'bad_request');
  const created = logic.planAddCategory(existing, { name: '新分類', parent: 'AI的👩‍💻', color: '#3D8195' }, LATER);
  assert.equal(created.ok, true);
  assert.equal(created.category.color, '#3d8195');
  assert.equal(created.category.parent, 'AI的👩‍💻');
});

test('itemMatchesCategory includes child categories and planUpdateCategory blocks cycles', () => {
  const categories = [
    { name: '食物', parent: '' },
    { name: '好吃的😋', parent: '食物' },
    { name: '拉麵', parent: '好吃的😋' },
    { name: '景點的🌸', parent: '' },
  ];
  assert.equal(logic.itemMatchesCategory('好吃的😋', '食物', categories), true);
  assert.equal(logic.itemMatchesCategory('拉麵', '食物', categories), true);
  assert.equal(logic.itemMatchesCategory('拉麵', '好吃的😋', categories), true);
  assert.equal(logic.itemMatchesCategory('景點的🌸', '食物', categories), false);
  assert.equal(logic.itemMatchesCategory('景點的🌸; 拉麵', '食物', categories), true);
  assert.equal(logic.itemMatchesCategory('景點的🌸; 其他', '食物', categories), false);
  assert.deepEqual(logic.parseCategoryList(' AI的👩‍💻; 好笑的😄 ; AI的👩‍💻 '), ['AI的👩‍💻', '好笑的😄']);
  assert.equal(logic.serializeCategoryList(['AI的👩‍💻', '好笑的😄']), 'AI的👩‍💻; 好笑的😄');
  assert.equal(logic.serializeCategoryList('好笑的😄; AI的👩‍💻'), '好笑的😄; AI的👩‍💻');
  assert.equal(logic.itemMatchesCategory('食物', '食物', categories), true);
  assert.equal(logic.itemMatchesCategory('', '__none__', categories), true);
  assert.equal(logic.itemMatchesCategory('食物', '__none__', categories), false);
  assert.equal(logic.planUpdateCategory(categories, { name: '食物', parent: '拉麵' }).error, 'bad_request');
  assert.equal(logic.planUpdateCategory(categories, { name: '景點的🌸', color: '#112233' }).category.color, '#112233');
});

test('planRenameCategory and renameCategoryInItems update names, parents, and items with deduplication', () => {
  const categories = [
    { name: '食物', color: '#e74c3c', parent: '', createdAt: NOW },
    { name: '拉麵', color: '#e67e22', parent: '食物', createdAt: NOW },
    { name: '景點', color: '#3d8195', parent: '', createdAt: NOW },
  ];
  assert.equal(logic.planRenameCategory(categories, '', '美食').error, 'bad_request');
  assert.equal(logic.planRenameCategory(categories, '食物', '食物').error, 'bad_request');
  assert.equal(logic.planRenameCategory(categories, '沒有', '美食').error, 'not_found');
  assert.equal(logic.planRenameCategory(categories, '食物', '拉麵').error, 'duplicate');

  const renamed = logic.planRenameCategory(categories, '食物', '美食');
  assert.equal(renamed.ok, true);
  assert.equal(renamed.category.name, '美食');
  assert.equal(renamed.categories.find((c) => c.name === '美食').parent, '');
  assert.equal(renamed.categories.find((c) => c.name === '拉麵').parent, '美食');

  // Test with item objects
  const items = [
    sampleItem({ id: '1', category: ['食物', '拉麵'] }),
    sampleItem({ id: '2', category: '食物; 景點' }),
    sampleItem({ id: '3', category: ['景點'] }),
  ];
  const res1 = logic.renameCategoryInItems(items, '食物', '拉麵', LATER);
  assert.equal(res1.ok, true);
  assert.equal(res1.changed, 2);
  assert.deepEqual(items[0].category, ['拉麵']); // deduplicated!
  assert.deepEqual(items[1].category, ['拉麵', '景點']);
  assert.deepEqual(items[2].category, ['景點']);
  assert.equal(items[0].updatedAt, LATER);

  // Test with sheet row arrays
  const rows = [
    ['1', 'url', 'web', 't', 's', 'n', '食物; 景點', 'tag1', NOW, NOW, ''],
    ['2', 'url', 'web', 't', 's', 'n', '其他', 'tag1', NOW, NOW, ''],
  ];
  const res2 = logic.renameCategoryInItems(rows, '食物', '美食', LATER);
  assert.equal(res2.ok, true);
  assert.equal(res2.changed, 1);
  assert.equal(rows[0][6], '美食; 景點');
  assert.equal(rows[0][9], LATER);
  assert.equal(rows[1][6], '其他');
});

test('planDeleteCategory and deleteCategoryFromItems re-parent children and strip category from items', () => {
  const categories = [
    { name: '根分類', color: '#111', parent: '', createdAt: NOW },
    { name: '中層', color: '#222', parent: '根分類', createdAt: NOW },
    { name: '底層', color: '#333', parent: '中層', createdAt: NOW },
    { name: '獨立', color: '#444', parent: '', createdAt: NOW },
  ];
  assert.equal(logic.planDeleteCategory(categories, '').error, 'bad_request');
  assert.equal(logic.planDeleteCategory(categories, '不存在').error, 'not_found');

  const planned = logic.planDeleteCategory(categories, '中層');
  assert.equal(planned.ok, true);
  assert.equal(planned.categories.length, 3);
  assert.equal(planned.categories.find((c) => c.name === '底層').parent, '根分類');
  assert.equal(planned.categories.find((c) => c.name === '獨立').parent, '');

  const items = [
    sampleItem({ id: '1', category: ['中層', '獨立'] }),
    sampleItem({ id: '2', category: '中層' }),
    sampleItem({ id: '3', category: ['獨立'] }),
  ];
  const res = logic.deleteCategoryFromItems(items, '中層', LATER);
  assert.equal(res.ok, true);
  assert.equal(res.changed, 2);
  assert.deepEqual(items[0].category, ['獨立']);
  assert.deepEqual(items[1].category, []);
  assert.deepEqual(items[2].category, ['獨立']);

  // Row arrays
  const rows = [
    ['1', 'url', 'web', 't', 's', 'n', '中層; 獨立', '', NOW, NOW, ''],
  ];
  logic.deleteCategoryFromItems(rows, '中層', LATER);
  assert.equal(rows[0][6], '獨立');
});

test('renameTagInItems and deleteTagFromItems update and deduplicate tags', () => {
  assert.equal(logic.renameTagInItems([], '', 'new').error, 'bad_request');
  assert.equal(logic.renameTagInItems([], 'tag', 'tag').error, 'bad_request');
  assert.equal(logic.deleteTagFromItems([], '').error, 'bad_request');

  const items = [
    sampleItem({ id: '1', tags: ['old', 'news'] }),
    sampleItem({ id: '2', tags: ['news'] }),
    sampleItem({ id: '3', tags: ['old'] }),
  ];
  // Rename 'old' to 'news' -> item 1 has ['news', 'news'] which should deduplicate to ['news']
  const renRes = logic.renameTagInItems(items, 'old', 'news', LATER);
  assert.equal(renRes.ok, true);
  assert.equal(renRes.changed, 2);
  assert.deepEqual(items[0].tags, ['news']);
  assert.deepEqual(items[1].tags, ['news']);
  assert.deepEqual(items[2].tags, ['news']);

  // Delete 'news'
  const delRes = logic.deleteTagFromItems(items, 'news', LATER);
  assert.equal(delRes.ok, true);
  assert.equal(delRes.changed, 3);
  assert.deepEqual(items[0].tags, []);

  // Row arrays
  const rows = [
    ['1', 'url', 'web', 't', 's', 'n', '', 'tech, ai', NOW, NOW, ''],
  ];
  logic.renameTagInItems(rows, 'tech', 'technology', LATER);
  assert.equal(rows[0][7], 'technology, ai');
  logic.deleteTagFromItems(rows, 'ai', LATER);
  assert.equal(rows[0][7], 'technology');
});

test('the key is read from script properties and is not hard-coded', () => {
  const files = ['Code.gs', 'logic.js', 'appsscript.json', 'logic.test.js', 'fetch-samples.js'];
  const combined = files.map((name) => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n');
  assert.equal(combined.includes("getProperty('MNEMOSYNE_KEY')"), true);
  assert.equal(/MNEMOSYNE_KEY['"]?\s*[:=]\s*['"][^'"]+['"]/.test(combined), false);
});
