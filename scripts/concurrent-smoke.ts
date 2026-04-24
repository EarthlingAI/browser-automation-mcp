/**
 * concurrent-smoke.ts — two-client concurrency validation for the relay daemon.
 *
 * Spawns the daemon (if not already running) via the same acquire path the MCP
 * uses, then opens two independent `chromium.connectOverCDP` connections with
 * distinct clientIds. Each drives its own tab through navigate + evaluate +
 * title loops concurrently. Asserts no URL cross-contamination, no errors, and
 * tracks per-client latency so regressions show up as latency blow-outs.
 *
 * Usage:
 *   npx tsx scripts/concurrent-smoke.ts
 *   ITERATIONS=20 npx tsx scripts/concurrent-smoke.ts
 *
 * Exit 0 on pass, 1 on any failure.
 */

import http from 'node:http';
import { chromium, type Browser, type Page } from 'playwright-core';

import { acquireDaemon } from '../src/tools/mcp/relay/clientAcquirer';
import { DEFAULT_RELAY_PORT } from '../src/tools/mcp/relay/constants';

const PORT = parseInt(process.env.BROWSER_AUTOMATION_MCP_RELAY_PORT || String(DEFAULT_RELAY_PORT), 10);
const ITERATIONS = parseInt(process.env.ITERATIONS || '8', 10);
const CHANNEL = process.env.BROWSER_CHANNEL || 'chrome';
const MODE = process.env.MODE || 'default';

const URL_A = 'https://example.org/';
const URL_B = 'https://example.net/';

interface IterResult {
  iter: number;
  url: string;
  title: string;
  ms: number;
}

async function discover(): Promise<{ cdpPath: string; pid: number; uuid: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/discover', timeout: 2000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed?.service === 'earthling-cdp-relay') resolve(parsed);
          else reject(new Error(`wrong service at /discover: ${JSON.stringify(parsed)}`));
        } catch (e) { reject(e as Error); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('discover timeout')); });
  });
}

async function makeClient(label: string, cdpPath: string): Promise<{ browser: Browser; page: Page }> {
  const clientId = `smoke-${label}-${process.pid}`;
  const endpoint = `ws://127.0.0.1:${PORT}${cdpPath}?clientId=${encodeURIComponent(clientId)}`;
  log(`[${label}] connecting (clientId=${clientId})`);
  const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error(`[${label}] connected browser has no default context`);
  // Give the daemon a moment to surface a fresh page via the auto-attach lease.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pages = ctx.pages();
    if (pages.length > 0) {
      const page = pages[0];
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return { browser, page };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`[${label}] no page appeared within 10s`);
}

async function runClient(label: string, page: Page, url: string): Promise<IterResult[]> {
  const host = new URL(url).hostname;
  const results: IterResult[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = Date.now();
    await page.goto(url, { timeout: 20_000, waitUntil: 'domcontentloaded' });
    // Force a Runtime.evaluate round-trip per iteration to exercise CDP.
    const title = await page.evaluate(() => document.title);
    const currentUrl = page.url();
    const ms = Date.now() - t0;
    results.push({ iter: i, url: currentUrl, title, ms });
    if (!currentUrl.includes(host))
      throw new Error(`[${label}] iter=${i} CROSS-CONTAMINATION — expected host=${host}, got url=${currentUrl}`);
    log(`[${label}] iter=${i} ${currentUrl} title="${title}" ${ms}ms`);
  }
  return results;
}

function log(...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}]`, ...args);
}

type TabInfo = { tabId: number; title: string; url: string; active: boolean; lease: 'you' | 'busy' | 'free'; ownerId?: string };

async function cdpCall(browser: Browser, method: string, params: any = {}): Promise<any> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    return await cdp.send(method as any, params);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function listTabs(browser: Browser): Promise<TabInfo[]> {
  const res = await cdpCall(browser, 'Earthling.listTabsAnnotated', {});
  return Array.isArray(res) ? res : (res?.tabs ?? []);
}

async function runLeaseChurn(info: { cdpPath: string }): Promise<void> {
  const CHURN_ITERATIONS = parseInt(process.env.ITERATIONS || '30', 10);
  const endpoint = (label: string) => `ws://127.0.0.1:${PORT}${info.cdpPath}?clientId=${encodeURIComponent(`churn-${label}-${process.pid}`)}`;

  log(`Lease-churn mode: 2 actors + 1 observer × ${CHURN_ITERATIONS} iters`);
  const browserA = await chromium.connectOverCDP(endpoint('A'), { isLocal: true });
  const browserB = await chromium.connectOverCDP(endpoint('B'), { isLocal: true });
  const browserObs = await chromium.connectOverCDP(endpoint('obs'), { isLocal: true });

  try {
    const seedTabs = await listTabs(browserObs);
    // Exclude about:blank — those may be daemon-auto-opened blanks tied to
    // another client's _autoOpenedBlanks set, which invariant #19 closes on
    // release. Picking one as a churn target leads to "No tab with given id"
    // mid-loop. Real tabs only.
    const candidates = seedTabs.filter(t =>
      !t.url.startsWith('chrome:')
      && !t.url.startsWith('edge:')
      && !t.url.startsWith('devtools:')
      && t.url !== 'about:blank'
      && t.url !== '');
    if (candidates.length < 2)
      throw new Error(`lease-churn needs ≥2 non-internal tabs; found ${candidates.length}`);
    const [tabX, tabY] = candidates;
    log(`Target tabs: X=${tabX.tabId} (${tabX.url}), Y=${tabY.tabId} (${tabY.url})`);

    let observerStop = false;
    const observations: { t: number; tabs: Map<number, string> }[] = [];
    const observerLoop = (async () => {
      while (!observerStop) {
        try {
          const tabs = await listTabs(browserObs);
          const m = new Map<number, string>();
          for (const t of tabs) m.set(t.tabId, t.lease === 'you' ? 'you' : t.lease === 'busy' ? `busy:${t.ownerId ?? '?'}` : 'free');
          observations.push({ t: Date.now(), tabs: m });
        } catch (e) {
          // ignore transient errors
        }
        await new Promise(r => setTimeout(r, 50));
      }
    })();

    const actor = async (label: string, browser: Browser, tabId: number) => {
      const results: { iter: number; ms: number }[] = [];
      for (let i = 0; i < CHURN_ITERATIONS; i++) {
        const t0 = Date.now();
        await cdpCall(browser, 'Earthling.switchToTab', { tabId, force: true });
        await cdpCall(browser, 'Earthling.releaseTab', { tabId });
        results.push({ iter: i, ms: Date.now() - t0 });
        if (i % 10 === 0) log(`[${label}] iter=${i} switch+release=${results.at(-1)!.ms}ms`);
      }
      return results;
    };

    const [resA, resB] = await Promise.all([
      actor('A', browserA, tabX.tabId),
      actor('B', browserB, tabY.tabId),
    ]);

    observerStop = true;
    await observerLoop;

    log(`Observer captured ${observations.length} list snapshots`);
    const ownerIdA = `churn-A-${process.pid}`;
    const ownerIdB = `churn-B-${process.pid}`;
    let seenBusyA = 0, seenBusyB = 0, seenFree = 0;
    for (const snap of observations) {
      const sx = snap.tabs.get(tabX.tabId);
      const sy = snap.tabs.get(tabY.tabId);
      if (sx?.startsWith('busy')) { if (sx.includes(ownerIdA)) seenBusyA++; }
      if (sy?.startsWith('busy')) { if (sy.includes(ownerIdB)) seenBusyB++; }
      if (sx === 'free' || sy === 'free') seenFree++;
    }
    log(`Observations: busy-A(X)=${seenBusyA}, busy-B(Y)=${seenBusyB}, free(either)=${seenFree}`);

    const avg = (r: { ms: number }[]) => (r.reduce((s, v) => s + v.ms, 0) / r.length).toFixed(0);
    log(`A: ${CHURN_ITERATIONS} iters, avg=${avg(resA)}ms; B: ${CHURN_ITERATIONS} iters, avg=${avg(resB)}ms`);

    if (seenBusyA === 0 && seenBusyB === 0)
      throw new Error('Observer never saw either target as busy — lease bookkeeping may be broken');

    log('PASS — lease-churn invariants held');
  } finally {
    await browserA.close().catch(() => {});
    await browserB.close().catch(() => {});
    await browserObs.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  log(`Ensuring daemon (port=${PORT}, channel=${CHANNEL}, mode=${MODE})…`);
  await acquireDaemon(PORT, CHANNEL);
  const info = await discover();
  log(`Daemon up: pid=${info.pid} cdpPath=${info.cdpPath} uuid=${info.uuid}`);

  if (MODE === 'lease-churn') {
    await runLeaseChurn(info);
    return;
  }

  // Parallel connect — second client exercises the Issue #4 auto-open-blank-tab path.
  const [a, b] = await Promise.all([
    makeClient('A', info.cdpPath),
    makeClient('B', info.cdpPath),
  ]);
  log(`A initial url: ${a.page.url()}`);
  log(`B initial url: ${b.page.url()}`);

  if (a.page === b.page)
    throw new Error('Both clients received the same Page object — lease isolation failed');

  const startWall = Date.now();
  const [resA, resB] = await Promise.all([
    runClient('A', a.page, URL_A),
    runClient('B', b.page, URL_B),
  ]);
  const wallMs = Date.now() - startWall;

  const stats = (name: string, res: IterResult[]) => {
    const times = res.map(r => r.ms);
    const avg = times.reduce((s, v) => s + v, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    return `${name}: ${res.length} iters, min=${min}ms avg=${avg.toFixed(0)}ms max=${max}ms final=${res.at(-1)!.url}`;
  };

  log('');
  log('=== Results ===');
  log(stats('A', resA));
  log(stats('B', resB));
  log(`Wall clock (concurrent): ${wallMs}ms`);

  if (!a.page.url().includes('example.org')) throw new Error('A did not end on example.org');
  if (!b.page.url().includes('example.net')) throw new Error('B did not end on example.net');

  // Close order matters: close each Browser individually so per-client cleanup runs.
  await a.browser.close().catch(e => log(`A close error: ${e}`));
  await b.browser.close().catch(e => log(`B close error: ${e}`));

  log('');
  log('PASS — concurrent multi-client validated');
}

main().catch(e => {
  console.error('FAIL:', e?.stack || e);
  process.exit(1);
});
