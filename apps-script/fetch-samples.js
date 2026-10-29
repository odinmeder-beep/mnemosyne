/**
 * Fetch a few public pages and run them through extractMeta / previewFromFetch.
 * Dev-only. Do not paste this file into Apps Script.
 *
 * Run: node apps-script/fetch-samples.js
 */
const logic = require('./logic.js');

const headers = {
  'User-Agent': logic.FETCH_REQUEST.userAgent,
  Accept: logic.FETCH_REQUEST.accept,
  'Accept-Language': logic.FETCH_REQUEST.acceptLanguage,
};

function findArticle(pageUrl, html) {
  const patterns = [
    /https:\/\/www\.bbc\.com\/news\/articles\/[a-z0-9]+/i,
    /https:\/\/www\.bbc\.com\/zhongwen\/articles\/[a-z0-9]+/i,
    /https:\/\/www\.theguardian\.com\/[a-z0-9-]+\/\d{4}\/[a-z]{3}\/\d{1,2}\/[a-z0-9-]+/i,
    /https:\/\/www\.reuters\.com\/[a-z0-9-]+\/[a-z0-9/-]*-\d{4}-\d{2}-\d{2}\//i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[0];
  }
  if (String(pageUrl).includes('bbc.com')) {
    const relative = html.match(/\/news\/articles\/[a-z0-9]+/i);
    if (relative) return 'https://www.bbc.com' + relative[0];
  }
  return '';
}

function findStatus(html) {
  const absolute = html.match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/);
  if (absolute) return absolute[0].replace('://twitter.com', '://x.com');
  const relative = html.match(/\/([A-Za-z0-9_]{1,30})\/status\/(\d+)/);
  if (relative) return 'https://x.com/' + relative[1] + '/status/' + relative[2];
  return '';
}

async function fetchPage(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(20000),
    });
    const html = await response.text();
    return {
      requestedUrl: url,
      finalUrl: response.url,
      status: response.status,
      contentType: response.headers.get('content-type'),
      bytes: html.length,
      ms: Date.now() - started,
      platform: logic.detectPlatform(url),
      extractMeta: logic.extractMeta(html),
      previewFromFetch: logic.previewFromFetch(url, response.status, html),
      hasOgTitle: /og:title/i.test(html),
      hasTwitterTitle: /twitter:title/i.test(html),
      hasTitleTag: /<title\b/i.test(html),
      html,
    };
  } catch (err) {
    return {
      requestedUrl: url,
      error: err && err.name ? err.name + ': ' + err.message : String(err),
      ms: Date.now() - started,
      platform: logic.detectPlatform(url),
    };
  }
}

function summarize(result) {
  const copy = Object.assign({}, result);
  delete copy.html;
  return copy;
}

async function main() {
  const reports = [];

  const example = await fetchPage('https://example.com/');
  reports.push(summarize(example));

  const bbc = await fetchPage('https://www.bbc.com/news');
  reports.push(summarize(bbc));
  const bbcArticle = !bbc.error && bbc.html ? findArticle(bbc.requestedUrl, bbc.html) : '';
  if (bbcArticle) reports.push(summarize(await fetchPage(bbcArticle)));

  const guardian = await fetchPage('https://www.theguardian.com/international');
  reports.push(summarize(guardian));
  const guardianArticle = !guardian.error && guardian.html ? findArticle(guardian.requestedUrl, guardian.html) : '';
  if (guardianArticle && guardianArticle !== bbcArticle) {
    reports.push(summarize(await fetchPage(guardianArticle)));
  }

  const xProfile = await fetchPage('https://x.com/github');
  reports.push(summarize(xProfile));
  const discoveredStatus = !xProfile.error && xProfile.html ? findStatus(xProfile.html) : '';
  const statusUrl = discoveredStatus || 'https://x.com/github/status/2115480207469560109';
  if (statusUrl) reports.push(summarize(await fetchPage(statusUrl)));

  reports.push(summarize(await fetchPage('https://www.threads.net/@instagram')));
  reports.push(summarize(await fetchPage('https://www.instagram.com/instagram/')));

  console.log(JSON.stringify({ discovered: { bbcArticle, guardianArticle, statusUrl }, reports }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
