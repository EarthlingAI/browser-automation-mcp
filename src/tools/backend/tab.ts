/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import url from 'url';

import { EventEmitter } from 'events';
import { asLocator } from '../../utils/isomorphic/locatorGenerators';
import { ManualPromise } from '../../utils/isomorphic/manualPromise';
import { debug } from '../../utilsBundle';

import { eventsHelper } from '../../server/utils/eventsHelper';
import { disposeAll } from '../../server/utils/disposable';
import { waitForCompletion, eventWaiter, safeTitle } from './utils';
import { raceAgainstDeadline } from '../../utils/isomorphic/timeoutRunner';
import { monotonicTime } from '../../utils/isomorphic/time';
import { LogFile } from './logFile';
import { ModalState } from './tool';
import { handleDialog } from './dialogs';
import { uploadFile } from './files';

import type { Disposable } from '../../server/utils/disposable';
import type { Context, ContextConfig } from './context';
import type * as playwright from 'playwright-core';

const TabEvents = {
  modalState: 'modalState'
};

type TabEventsInterface = {
  [TabEvents.modalState]: [modalState: ModalState];
};

type Download = {
  download: playwright.Download;
  finished: boolean;
  outputFile: string;
};

type ConsoleLogEntry = {
  type: 'console';
  wallTime: number;
  message: ConsoleMessage;
};

type DownloadStartLogEntry = {
  type: 'download-start';
  wallTime: number;
  download: Download;
};

type DownloadFinishLogEntry = {
  type: 'download-finish';
  wallTime: number;
  download: Download;
};

type RequestLogEntry = {
  type: 'request';
  wallTime: number;
  request: playwright.Request;
};

type EventEntry = ConsoleLogEntry | DownloadStartLogEntry | DownloadFinishLogEntry | RequestLogEntry;


export type TabHeader = {
  title: string;
  url: string;
  current: boolean;
  console: { total: number, warnings: number, errors: number };
};

type TabSnapshot = {
  ariaSnapshot: string;
  ariaSnapshotDiff?: string;
  modalStates: ModalState[];
  events: EventEntry[];
  consoleLink?: string;
};

export class Tab extends EventEmitter<TabEventsInterface> {
  readonly context: Context;
  readonly page: playwright.Page;
  private _lastHeader: TabHeader = { title: 'about:blank', url: 'about:blank', current: false, console: { total: 0, warnings: 0, errors: 0 } };
  private _downloads: Download[] = [];
  private _requests: playwright.Request[] = [];
  private _onPageClose: (tab: Tab) => void;
  private _modalStates: ModalState[] = [];
  private _initializedPromise: Promise<void>;
  private _needsFullSnapshot = false;
  private _recentEventEntries: EventEntry[] = [];
  private _consoleLog: LogFile;
  private _disposables: Disposable[];
  readonly actionTimeoutOptions: { timeout?: number; };
  readonly navigationTimeoutOptions: { timeout?: number; };
  readonly expectTimeoutOptions: { timeout?: number; };

  constructor(context: Context, page: playwright.Page, onPageClose: (tab: Tab) => void) {
    super();
    this.context = context;
    this.page = page;
    this._onPageClose = onPageClose;
    const p = page;
    this._disposables = [
      eventsHelper.addEventListener(p, 'console', event => this._handleConsoleMessage(messageToConsoleMessage(event))),
      eventsHelper.addEventListener(p, 'pageerror', error => this._handleConsoleMessage(pageErrorToConsoleMessage(error))),
      eventsHelper.addEventListener(p, 'request', request => this._handleRequest(request)),
      eventsHelper.addEventListener(p, 'response', response => this._handleResponse(response)),
      eventsHelper.addEventListener(p, 'requestfailed', request => this._handleRequestFailed(request)),
      eventsHelper.addEventListener(p, 'close', () => this._onClose()),
      eventsHelper.addEventListener(p, 'filechooser', chooser => {
        this.setModalState({
          type: 'fileChooser',
          description: 'File chooser',
          fileChooser: chooser,
          clearedBy: { tool: uploadFile.schema.name, skill: 'upload' }
        });
      }),
      eventsHelper.addEventListener(p, 'dialog', dialog => this._dialogShown(dialog)),
      eventsHelper.addEventListener(p, 'download', download => {
        void this._downloadStarted(download);
      }),
    ];
    (page as any)[tabSymbol] = this;
    const wallTime = Date.now();
    this._consoleLog = new LogFile(this.context, wallTime, 'console', 'Console');
    this._initializedPromise = this._initialize();
    this.actionTimeoutOptions = { timeout: context.config.timeouts?.action ?? 30_000 };
    this.navigationTimeoutOptions = { timeout: context.config.timeouts?.navigation ?? 30_000 };
    this.expectTimeoutOptions = { timeout: context.config.timeouts?.expect };
  }

  async dispose() {
    await disposeAll(this._disposables);
    this._consoleLog.stop();
  }

  static forPage(page: playwright.Page): Tab | undefined {
    return (page as any)[tabSymbol];
  }

  static async collectConsoleMessages(page: playwright.Page): Promise<ConsoleMessage[]> {
    const result: ConsoleMessage[] = [];
    const messages = await page.consoleMessages().catch(() => []);
    for (const message of messages)
      result.push(messageToConsoleMessage(message));
    const errors = await page.pageErrors().catch(() => []);
    for (const error of errors)
      result.push(pageErrorToConsoleMessage(error));
    return result;
  }

  private async _initialize() {
    for (const message of await Tab.collectConsoleMessages(this.page))
      this._handleConsoleMessage(message);
    const requests = await this.page.requests().catch(() => []);
    for (const request of requests.filter(r => r.existingResponse() || r.failure()))
      this._requests.push(request);
    for (const initPage of this.context.config.browser?.initPage || []) {
      try {
        const { default: func } = await import(url.pathToFileURL(initPage).href);
        await func({ page: this.page });
      } catch (e) {
        debug('pw:tools:error')(e);
      }
    }
  }

  modalStates(): ModalState[] {
    return this._modalStates;
  }

  setModalState(modalState: ModalState) {
    this._modalStates.push(modalState);
    this.emit(TabEvents.modalState, modalState);
  }

  clearModalState(modalState: ModalState) {
    this._modalStates = this._modalStates.filter(state => state !== modalState);
  }

  private _dialogShown(dialog: playwright.Dialog) {
    this.setModalState({
      type: 'dialog',
      description: `"${dialog.type()}" dialog with message "${dialog.message()}"`,
      dialog,
      clearedBy: { tool: handleDialog.schema.name, skill: 'dialog-accept or dialog-dismiss' }
    });
  }

  private async _downloadStarted(download: playwright.Download) {
    // Do not trust web names.
    const outputFile = await this.context.outputFile({ suggestedFilename: sanitizeForFilePath(download.suggestedFilename()), prefix: 'download', ext: 'bin' }, { origin: 'code' });
    const entry = {
      download,
      finished: false,
      outputFile,
    };
    this._downloads.push(entry);
    this._addLogEntry({ type: 'download-start', wallTime: Date.now(), download: entry });
    await download.saveAs(entry.outputFile);
    entry.finished = true;
    this._addLogEntry({ type: 'download-finish', wallTime: Date.now(), download: entry });
  }

  private _clearCollectedArtifacts() {
    this._downloads.length = 0;
    this._requests.length = 0;
    this._recentEventEntries.length = 0;
    this._resetLogs();
  }

  private _resetLogs() {
    const wallTime = Date.now();
    this._consoleLog.stop();
    this._consoleLog = new LogFile(this.context, wallTime, 'console', 'Console');
  }

  private _handleRequest(request: playwright.Request) {
    this._requests.push(request);
    // TODO: request start time is not available for fetch() before the
    // response is received, so we use Date.now() as a fallback.
    const wallTime = request.timing().startTime || Date.now();
    this._addLogEntry({ type: 'request', wallTime, request });
  }

  private _handleResponse(response: playwright.Response) {
    const timing = response.request().timing();
    const wallTime = timing.responseStart + timing.startTime;
    this._addLogEntry({ type: 'request', wallTime, request: response.request() });
  }

  private _handleRequestFailed(request: playwright.Request) {
    this._requests.push(request);
    const timing = request.timing();
    const wallTime = timing.responseEnd + timing.startTime;
    this._addLogEntry({ type: 'request', wallTime, request });
  }

  private _handleConsoleMessage(message: ConsoleMessage) {
    const wallTime = message.timestamp;
    this._addLogEntry({ type: 'console', wallTime, message });
    const level = consoleLevelForMessageType(message.type);
    if (level === 'error' || level === 'warning')
      this._consoleLog.appendLine(wallTime, () => message.toString());
  }

  private _addLogEntry(entry: EventEntry) {
    this._recentEventEntries.push(entry);
  }

  private _onClose() {
    this._clearCollectedArtifacts();
    this._onPageClose(this);
  }

  async headerSnapshot(): Promise<TabHeader & { changed: boolean }> {
    let title: string | undefined;
    await this._raceAgainstModalStates(async () => {
      // page.title() can hang on a wedged page AND throw "Execution context
      // was destroyed" synchronously during navigation. Deadline guards the
      // hang; safeTitle guards the throw, falling back to the last successful
      // title, then the URL, then '<navigating>'.
      const outcome = await raceAgainstDeadline(
          () => safeTitle(this.page, this._lastHeader.title),
          monotonicTime() + 1000,
      );
      title = outcome.timedOut ? (this._lastHeader.title || '') : outcome.result;
    });
    const newHeader: TabHeader = {
      title: title ?? '',
      url: this.page.url(),
      current: this.isCurrentTab(),
      console: await this.consoleMessageCount()
    };

    if (!tabHeaderEquals(this._lastHeader, newHeader)) {
      this._lastHeader = newHeader;
      return { ...this._lastHeader, changed: true };
    }
    return { ...this._lastHeader, changed: false };
  }

  isCurrentTab(): boolean {
    return this === this.context.currentTab();
  }

  async waitForLoadState(state: 'load', options?: { timeout?: number }): Promise<void> {
    await this._initializedPromise;
    await this.page.waitForLoadState(state, options).catch(e => debug('pw:tools:error')(e));
  }

  async navigate(url: string) {
    await this._initializedPromise;

    this._clearCollectedArtifacts();

    const { promise: downloadEvent, abort: abortDownloadEvent } = eventWaiter<playwright.Download>(this.page, 'download', 3000);
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', ...this.navigationTimeoutOptions });
      abortDownloadEvent();
    } catch (_e: unknown) {
      const e = _e as Error;
      const mightBeDownload =
        e.message.includes('net::ERR_ABORTED') // chromium
        || e.message.includes('Download is starting'); // firefox + webkit
      if (!mightBeDownload)
        throw e;
      // on chromium, the download event is fired *after* page.goto rejects, so we wait a lil bit
      const download = await downloadEvent;
      if (!download)
        throw e;
      // Make sure other "download" listeners are notified first.
      await new Promise(resolve => setTimeout(resolve, 500));
      return;
    }

    // Cap load event to 5 seconds, the page is operational at this point.
    await this.waitForLoadState('load', { timeout: 5000 });
  }

  async consoleMessageCount(): Promise<{ total: number, errors: number, warnings: number }> {
    await this._initializedPromise;
    const messages = await this.page.consoleMessages({ filter: 'sinceNavigation' });
    const pageErrors = await this.page.pageErrors({ filter: 'sinceNavigation' });
    let errors = pageErrors.length;
    let warnings = 0;
    for (const message of messages) {
      if (message.type() === 'error')
        errors++;
      else if (message.type() === 'warning')
        warnings++;
    }
    return { total: messages.length + pageErrors.length, errors, warnings };
  }

  async consoleMessages(level: ConsoleMessageLevel, all?: boolean): Promise<ConsoleMessage[]> {
    await this._initializedPromise;
    const result: ConsoleMessage[] = [];
    const messages = await this.page.consoleMessages({ filter: all ? 'all' : 'sinceNavigation' });
    for (const message of messages) {
      const cm = messageToConsoleMessage(message);
      if (shouldIncludeMessage(level, cm.type))
        result.push(cm);
    }
    if (shouldIncludeMessage(level, 'error')) {
      const errors = await this.page.pageErrors({ filter: all ? 'all' : 'sinceNavigation' });
      for (const error of errors)
        result.push(pageErrorToConsoleMessage(error));
    }
    return result;
  }

  async clearConsoleMessages() {
    await this._initializedPromise;
    await Promise.all([
      this.page.clearConsoleMessages(),
      this.page.clearPageErrors()
    ]);
  }

  async requests(): Promise<playwright.Request[]> {
    await this._initializedPromise;
    return this._requests;
  }

  async clearRequests() {
    await this._initializedPromise;
    this._requests.length = 0;
  }

  async captureSnapshot(selector: string | undefined, relativeTo: string | undefined): Promise<TabSnapshot> {
    await this._initializedPromise;
    let tabSnapshot: TabSnapshot | undefined;
    // Inner budget is slightly under Response._build's outer SNAPSHOT_TIMEOUT_MS
    // (3000ms) so the inner layer rejects first with a clean message rather
    // than leaving the outer to catch a raw TimeoutError.
    const INNER_SNAPSHOT_TIMEOUT_MS = 2500;
    const modalStates = await this._raceAgainstModalStates(async () => {
      const snapOutcome = await raceAgainstDeadline(
          () => selector ? this.page.locator(selector).snapshotForAI() : this.page.snapshotForAI({ track: 'response' }),
          monotonicTime() + INNER_SNAPSHOT_TIMEOUT_MS,
      );
      if (snapOutcome.timedOut) {
        // Leave tabSnapshot undefined; the outer Response._build renders the
        // "[snapshot unavailable]" sentinel. _needsFullSnapshot is set below
        // so the next capture sends a full snapshot, not a diff.
        debug('pw:tools:error')(`page.snapshotForAI timed out after ${INNER_SNAPSHOT_TIMEOUT_MS}ms`);
        return;
      }
      const snapshot = snapOutcome.result as { full: string, incremental?: string };
      tabSnapshot = {
        ariaSnapshot: truncateSnapshot(snapshot.full),
        ariaSnapshotDiff: this._needsFullSnapshot ? undefined : (snapshot.incremental ? truncateSnapshot(snapshot.incremental) : undefined),
        modalStates: [],
        events: [],
      };
    });
    if (tabSnapshot) {
      tabSnapshot.consoleLink = await this._consoleLog.take(relativeTo);
      tabSnapshot.events = this._recentEventEntries;
      this._recentEventEntries = [];
    }

    // If we failed to capture a snapshot this time, make sure we do a full one next time,
    // to avoid reporting deltas against un-reported snapshot.
    this._needsFullSnapshot = !tabSnapshot;
    return tabSnapshot ?? {
      ariaSnapshot: '',
      ariaSnapshotDiff: '',
      modalStates,
      events: [],
    };
  }

  private _javaScriptBlocked(): boolean {
    return this._modalStates.some(state => state.type === 'dialog');
  }

  private async _raceAgainstModalStates(action: () => Promise<void>): Promise<ModalState[]> {
    if (this.modalStates().length)
      return this.modalStates();

    const promise = new ManualPromise<ModalState[]>();
    const listener = (modalState: ModalState) => promise.resolve([modalState]);
    this.once(TabEvents.modalState, listener);

    return await Promise.race([
      action().then(() => {
        this.off(TabEvents.modalState, listener);
        return [];
      }),
      promise,
    ]);
  }

  async waitForCompletion(callback: () => Promise<void>) {
    await this._initializedPromise;
    await this._raceAgainstModalStates(() => waitForCompletion(this, callback));
  }

  async refLocator(params: { element?: string, ref: string, selector?: string }): Promise<{ locator: playwright.Locator, resolved: string }> {
    await this._initializedPromise;
    return (await this.refLocators([params]))[0];
  }

  async refLocators(params: { element?: string, ref: string, selector?: string }[]): Promise<{ locator: playwright.Locator, resolved: string }[]> {
    await this._initializedPromise;
    return Promise.all(params.map(async param => {
      if (param.selector) {
        const locator = this.page.locator(param.selector);
        if (!await locator.isVisible())
          throw new Error(`Selector ${param.selector} does not match any elements.`);
        return { locator, resolved: asLocator('javascript', param.selector) };
      } else {
        try {
          let locator = this.page.locator(`aria-ref=${param.ref}`);
          if (param.element)
            locator = locator.describe(param.element);
          const resolved = await locator.toCode();
          return { locator, resolved };
        } catch (e) {
          throw new Error(`Ref ${param.ref} not found in the current page snapshot. Try capturing new snapshot.`);
        }
      }
    }));
  }

  async waitForTimeout(time: number) {
    if (this._javaScriptBlocked()) {
      await new Promise(f => setTimeout(f, time));
      return;
    }

    await this.page.evaluate(() => new Promise(f => setTimeout(f, 1000))).catch(() => {});
  }
}

export type ConsoleMessage = {
  type: ReturnType<playwright.ConsoleMessage['type']>;
  timestamp: number;
  text: string;
  toString(): string;
};

function messageToConsoleMessage(message: playwright.ConsoleMessage): ConsoleMessage {
  return {
    type: message.type(),
    timestamp: message.timestamp(),
    text: message.text(),
    toString: () => `[${message.type().toUpperCase()}] ${message.text()} @ ${message.location().url}:${message.location().lineNumber}`,
  };
}

function pageErrorToConsoleMessage(errorOrValue: Error | any): ConsoleMessage {
  if (errorOrValue instanceof Error) {
    return {
      type: 'error',
      timestamp: Date.now(),
      text: errorOrValue.message,
      toString: () => errorOrValue.stack || errorOrValue.message,
    };
  }
  return {
    type: 'error',
    timestamp: Date.now(),
    text: String(errorOrValue),
    toString: () => String(errorOrValue),
  };
}

export function renderModalStates(config: ContextConfig, modalStates: ModalState[]): string[] {
  const result: string[] = [];
  if (modalStates.length === 0)
    result.push('- There is no modal state present');
  for (const state of modalStates)
    result.push(`- [${state.description}]: can be handled by ${config.skillMode ? state.clearedBy.skill : state.clearedBy.tool}`);
  return result;
}

type ConsoleMessageType = ReturnType<playwright.ConsoleMessage['type']>;
type ConsoleMessageLevel = 'error' | 'warning' | 'info' | 'debug';
const consoleMessageLevels: ConsoleMessageLevel[] = ['error', 'warning', 'info', 'debug'];

export function shouldIncludeMessage(thresholdLevel: ConsoleMessageLevel | undefined, type: ConsoleMessageType): boolean {
  const messageLevel = consoleLevelForMessageType(type);
  return consoleMessageLevels.indexOf(messageLevel) <= consoleMessageLevels.indexOf(thresholdLevel || 'info');
}

function consoleLevelForMessageType(type: ConsoleMessageType): ConsoleMessageLevel {
  switch (type) {
    case 'assert':
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'count':
    case 'dir':
    case 'dirxml':
    case 'info':
    case 'log':
    case 'table':
    case 'time':
    case 'timeEnd':
      return 'info';
    case 'clear':
    case 'debug':
    case 'endGroup':
    case 'profile':
    case 'profileEnd':
    case 'startGroup':
    case 'startGroupCollapsed':
    case 'trace':
      return 'debug';
    default:
      return 'info';
  }
}

const tabSymbol = Symbol('tabSymbol');

function sanitizeForFilePath(s: string) {
  const sanitize = (s: string) => s.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
  const separator = s.lastIndexOf('.');
  if (separator === -1)
    return sanitize(s);
  return sanitize(s.substring(0, separator)) + '.' + sanitize(s.substring(separator + 1));
}

function tabHeaderEquals(a: TabHeader, b: TabHeader): boolean {
  return a.title === b.title &&
      a.url === b.url &&
      a.current === b.current &&
      a.console.errors === b.console.errors &&
      a.console.warnings === b.console.warnings &&
      a.console.total === b.console.total;
}

const DEFAULT_SNAPSHOT_MAX_CHARS = 50_000;
const SIBLING_KEEP = 3;
const SIBLING_THRESHOLD = 5;
const TEXT_TRIM_LIMIT = 300;
const DEPTH_COLLAPSE_INDENT = 16; // indent >= 16 spaces = depth >= 8

interface ParsedLine {
  raw: string;
  indent: number;
  role: string;
  ref: string;
  textLength: number;
}

function parseLine(line: string): ParsedLine {
  const indent = line.length - line.trimStart().length;
  const trimmed = line.trimStart();

  let role = '';
  let ref = '';
  let textLength = 0;

  // Lines start with "- role" in the YAML aria snapshot format
  if (trimmed.startsWith('- ')) {
    const afterDash = trimmed.substring(2);
    // Role is the first word (up to space, quote, or bracket)
    const roleMatch = afterDash.match(/^(\S+?)[\s"[\]:]/);
    role = roleMatch ? roleMatch[1] : afterDash.trim();

    // Extract ref from [ref=eN]
    const refMatch = trimmed.match(/\[ref=(e\d+)\]/);
    if (refMatch)
      ref = refMatch[1];

    // Text content length — everything after the last ": "
    const colonIdx = trimmed.lastIndexOf(': ');
    if (colonIdx !== -1)
      textLength = trimmed.length - colonIdx - 2;
  }

  return { raw: line, indent, role, ref, textLength };
}

function truncateSnapshot(yaml: string, maxChars?: number): string {
  const budget = maxChars ?? (parseInt(process.env.BROWSER_AUTOMATION_MCP_SNAPSHOT_MAX_CHARS ?? '', 10) || DEFAULT_SNAPSHOT_MAX_CHARS);

  // Early exit for small snapshots
  if (yaml.length <= budget)
    return yaml;

  const rawLines = yaml.split('\n');
  const parsed = rawLines.map(parseLine);

  // --- Pass 1: Sibling Collapse ---
  // Mark lines to remove, then rebuild. This correctly handles nested sibling
  // groups at any depth (the old approach only checked the outermost level).
  const removedLines = new Set<number>();
  const insertions: { afterIdx: number; text: string }[] = [];

  // Scan every list item and group consecutive same-indent siblings
  let i = 0;
  while (i < parsed.length) {
    const line = parsed[i];
    if (!line.raw.trimStart().startsWith('- ')) {
      i++;
      continue;
    }

    // Collect consecutive siblings at this indent level
    const siblingGroup: { startIdx: number; endIdx: number; role: string }[] = [];
    let j = i;
    while (j < parsed.length) {
      const sibling = parsed[j];
      if (!sibling.raw.trimStart().startsWith('- ') || sibling.indent !== line.indent)
        break;

      // Find end of this sibling's subtree
      let endIdx = j + 1;
      while (endIdx < parsed.length && (parsed[endIdx].indent > line.indent || (parsed[endIdx].raw.trim() === '' && endIdx + 1 < parsed.length && parsed[endIdx + 1].indent > line.indent)))
        endIdx++;

      siblingGroup.push({ startIdx: j, endIdx, role: sibling.role });
      j = endIdx;
    }

    if (siblingGroup.length > SIBLING_THRESHOLD) {
      // Find dominant role
      const roleCounts = new Map<string, number>();
      for (const s of siblingGroup)
        roleCounts.set(s.role, (roleCounts.get(s.role) ?? 0) + 1);
      const dominantRole = [...roleCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const sameRoleSiblings = siblingGroup.filter(s => s.role === dominantRole);

      if (sameRoleSiblings.length > SIBLING_THRESHOLD) {
        // Mark excess same-role siblings (and their subtrees) for removal
        let keptCount = 0;
        const collapsedCount = sameRoleSiblings.length - SIBLING_KEEP;
        for (const s of siblingGroup) {
          if (s.role === dominantRole) {
            if (keptCount >= SIBLING_KEEP) {
              for (let k = s.startIdx; k < s.endIdx; k++)
                removedLines.add(k);
            }
            keptCount++;
          }
        }
        // Find parent ref for the hint
        let parentRef = '';
        for (let p = i - 1; p >= 0; p--) {
          if (parsed[p].indent === line.indent - 2 && parsed[p].ref) {
            parentRef = parsed[p].ref;
            break;
          }
        }
        const hint = parentRef ? ` [use selector="[ref=${parentRef}]" to see all]` : '';
        const lastSibling = siblingGroup[siblingGroup.length - 1];
        insertions.push({
          afterIdx: lastSibling.endIdx - 1,
          text: ' '.repeat(line.indent) + `- ... ${collapsedCount} more ${dominantRole} elements${hint}`,
        });
      }
    }

    // Advance past this sibling group — process children naturally on next iterations
    i++;
  }

  // Rebuild lines with removals and insertions
  const pass1Lines: string[] = [];
  for (let idx = 0; idx < parsed.length; idx++) {
    if (!removedLines.has(idx))
      pass1Lines.push(parsed[idx].raw);
    const insertion = insertions.find(ins => ins.afterIdx === idx);
    if (insertion)
      pass1Lines.push(insertion.text);
  }

  // --- Pass 2: Text Content Trimming ---
  const pass2Lines = pass1Lines.map(line => {
    const match = line.match(/^(\s*- (?:\S+)(?:\s+"[^"]*")?(?:\s+\[[^\]]*\])*:\s*)(.+)$/);
    if (match && match[2].length > TEXT_TRIM_LIMIT)
      return `${match[1]}${match[2].substring(0, TEXT_TRIM_LIMIT)}... [trimmed, ${match[2].length} chars]`;
    return line;
  });

  // --- Pass 3: Depth Collapsing ---
  const pass3Lines: string[] = [];
  let d = 0;
  while (d < pass2Lines.length) {
    const line = pass2Lines[d];
    const indent = line.length - line.trimStart().length;

    if (indent >= DEPTH_COLLAPSE_INDENT && line.trimStart().startsWith('- ')) {
      // Count descendants
      let count = 0;
      let end = d;
      while (end < pass2Lines.length) {
        const nextIndent = pass2Lines[end].length - pass2Lines[end].trimStart().length;
        if (end > d && nextIndent <= indent)
          break;
        count++;
        end++;
      }
      pass3Lines.push(' '.repeat(indent) + `- ... [${count} nested elements]`);
      d = end;
      continue;
    }

    pass3Lines.push(line);
    d++;
  }

  // --- Pass 4: Character Budget Enforcement ---
  let result = pass3Lines.join('\n');
  if (result.length > budget) {
    const totalK = Math.round(result.length / 1000);
    const budgetK = Math.round(budget / 1000);
    const cutoff = result.lastIndexOf('\n', budget);
    const truncAt = cutoff > 0 ? cutoff : budget;
    result = result.substring(0, truncAt) + `\n[Snapshot truncated — showing first ${budgetK}K of ${totalK}K chars. Use selector parameter for specific sections, or browser_run_code for targeted extraction.]`;
  }

  return result;
}
