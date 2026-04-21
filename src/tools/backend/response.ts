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

import fs from 'fs';
import path from 'path';

import { debug } from '../../utilsBundle';
import { renderModalStates, shouldIncludeMessage } from './tab';
import { scaleImageToFitMessage } from './screenshot';
import { raceAgainstDeadline } from '../../utils/isomorphic/timeoutRunner';
import { monotonicTime } from '../../utils/isomorphic/time';

import type { Tab, TabHeader } from './tab';
import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { Context, FilenameTemplate } from './context';

export const requestDebug = debug('pw:mcp:request');

/**
 * Post-action snapshot budget. The outer Response._build budget is the
 * belt-and-braces ceiling; the inner Tab.captureSnapshot race uses a slightly
 * shorter budget (SNAPSHOT_TIMEOUT_MS - 500) so the inner layer rejects first
 * with a clean message on a wedged page.
 */
const SNAPSHOT_TIMEOUT_MS = 3000;
const HEADER_TIMEOUT_MS = 1500;
const INLINE_SNAPSHOT_MAX_BYTES = 100_000;

type ResolvedFile = {
  fileName: string;
  relativeName: string;
  printableLink: string;
};

type Section = {
  title: string;
  content: string[];
  isError?: boolean;
  codeframe?: 'yaml' | 'js';
};

export class Response {
  private _results: string[] = [];
  private _errors: string[] = [];
  private _code: string[] = [];
  private _context: Context;
  private _includeSnapshot: 'none' | 'full' | 'incremental' = 'none';
  private _includeSnapshotFileName: string | undefined;
  private _includeSnapshotSelector: string | undefined;
  private _isClose: boolean = false;

  readonly toolName: string;
  readonly toolArgs: Record<string, any>;
  private _clientWorkspace: string;
  private _imageResults: { data: Buffer, imageType: 'png' | 'jpeg' }[] = [];

  constructor(context: Context, toolName: string, toolArgs: Record<string, any>, relativeTo?: string) {
    this._context = context;
    this.toolName = toolName;
    this.toolArgs = toolArgs;
    this._clientWorkspace = relativeTo ?? context.options.cwd;
  }

  private _computRelativeTo(fileName: string): string {
    return path.relative(this._clientWorkspace, fileName);
  }

  async resolveClientFile(template: FilenameTemplate, title: string): Promise<ResolvedFile> {
    let fileName: string;
    if (template.suggestedFilename)
      fileName = await this.resolveClientFilename(template.suggestedFilename);
    else
      fileName = await this._context.outputFile(template, { origin: 'llm' });
    const relativeName = this._computRelativeTo(fileName);
    const printableLink = `- [${title}](${relativeName})`;
    return { fileName, relativeName, printableLink };
  }

  async resolveClientFilename(filename: string): Promise<string> {
    return await this._context.workspaceFile(filename, this._clientWorkspace);
  }

  addTextResult(text: string) {
    this._results.push(text);
  }

  async addResult(title: string, data: Buffer | string, file: FilenameTemplate) {
    if (this._context.config.outputMode === 'file' || file.suggestedFilename || typeof data !== 'string') {
      const resolvedFile = await this.resolveClientFile(file, title);
      await this.addFileResult(resolvedFile, data);
    } else {
      this.addTextResult(data);
    }
  }

  async addFileResult(resolvedFile: ResolvedFile, data: Buffer | string | null) {
    if (typeof data === 'string')
      await fs.promises.writeFile(resolvedFile.fileName, data, 'utf-8');
    else if (data)
      await fs.promises.writeFile(resolvedFile.fileName, data);
    this.addTextResult(resolvedFile.printableLink);
  }

  addFileLink(title: string, fileName: string) {
    const relativeName = this._computRelativeTo(fileName);
    this.addTextResult(`- [${title}](${relativeName})`);
  }

  async registerImageResult(data: Buffer, imageType: 'png' | 'jpeg') {
    this._imageResults.push({ data, imageType });
  }

  setClose() {
    this._isClose = true;
  }

  addError(error: string) {
    this._errors.push(error);
  }

  addCode(code: string) {
    this._code.push(code);
  }

  setIncludeSnapshot() {
    this._includeSnapshot = this._context.config.snapshot?.mode || 'incremental';
  }

  setIncludeFullSnapshot(includeSnapshotFileName?: string, selector?: string) {
    this._includeSnapshot = 'full';
    this._includeSnapshotFileName = includeSnapshotFileName;
    this._includeSnapshotSelector = selector;
  }

  async serialize(): Promise<CallToolResult> {
    const redactText = (text: string): string => {
      for (const [secretName, secretValue] of Object.entries(this._context.config.secrets ?? {}))
        text = text.replaceAll(secretValue, `<secret>${secretName}</secret>`);
      return text;
    };

    const sections = await this._build();

    const text: string[] = [];
    for (const section of sections) {
      if (!section.content.length)
        continue;
      text.push(`### ${section.title}`);
      if (section.codeframe)
        text.push(`\`\`\`${section.codeframe}`);
      text.push(...section.content);
      if (section.codeframe)
        text.push('```');
    }

    const content: (TextContent | ImageContent)[] = [
      {
        type: 'text',
        text: sanitizeUnicode(redactText(text.join('\n'))),
      }
    ];

    // Image attachments.
    if (this._context.config.imageResponses !== 'omit') {
      for (const imageResult of this._imageResults) {
        const scaledData = scaleImageToFitMessage(imageResult.data, imageResult.imageType);
        content.push({ type: 'image', data: scaledData.toString('base64'), mimeType: imageResult.imageType === 'png' ? 'image/png' : 'image/jpeg' });
      }
    }

    return {
      content,
      ...(this._isClose ? { isClose: true } : {}),
      ...(sections.some(section => section.isError) ? { isError: true } : {}),
    };
  }

  /**
   * Sentinel placeholder when the post-action snapshot times out. The tool's
   * primary result still returns; this tells the agent the page state is
   * stale without blocking the whole response.
   */
  private _buildSnapshotUnavailableMarker() {
    return {
      ariaSnapshot: '[snapshot unavailable — page unresponsive, call browser_snapshot to retry]',
      ariaSnapshotDiff: undefined,
      modalStates: [],
      events: [],
      consoleLink: undefined,
    };
  }

  /**
   * Race the current tab's headerSnapshot() against a short budget. On
   * timeout, return a placeholder header so the response still renders a
   * Page section with the cached URL.
   */
  private async _buildCurrentHeader(tab: Tab): Promise<TabHeader & { changed: boolean }> {
    const outcome = await raceAgainstDeadline<TabHeader & { changed: boolean }>(
        () => tab.headerSnapshot(),
        monotonicTime() + HEADER_TIMEOUT_MS,
    );
    if (outcome.timedOut) {
      requestDebug(`headerSnapshot: timed out after ${HEADER_TIMEOUT_MS}ms`);
      let url = 'about:unknown';
      try {
        url = tab.page?.url?.() ?? url;
      } catch {}
      return { title: '(unavailable)', url, current: true, console: { total: 0, errors: 0, warnings: 0 }, changed: false };
    }
    return outcome.result;
  }

  private async _build(): Promise<Section[]> {
    const sections: Section[] = [];
    const addSection = (title: string, content: string[], codeframe?: 'yaml' | 'js') => {
      const section = { title, content, isError: title === 'Error', codeframe };
      sections.push(section);
      return content;
    };

    if (this._errors.length)
      addSection('Error', this._errors);

    if (this._results.length)
      addSection('Result', this._results);

    // Code
    if (this._context.config.codegen !== 'none' && this._code.length)
      addSection('Ran Playwright code', this._code, 'js');

    let tabSnapshot: any;
    if (!this._isClose) {
      const snapshotStart = Date.now();
      const currentTab = this._context.currentTab();
      requestDebug(`captureSnapshot: starting (tool=${this.toolName}, includeSnapshot=${this._includeSnapshot})`);
      if (currentTab) {
        // Opportunistic post-action snapshot: race against a 3s budget. On
        // timeout we emit a visible sentinel so the agent knows the page
        // state is stale, and flag the tab so its next snapshot is a full one.
        const snapOutcome = await raceAgainstDeadline(
            () => this._context.currentTabOrDie().captureSnapshot(this._includeSnapshotSelector, this._clientWorkspace),
            monotonicTime() + SNAPSHOT_TIMEOUT_MS,
        );
        if (snapOutcome.timedOut) {
          requestDebug(`captureSnapshot: timed out after ${SNAPSHOT_TIMEOUT_MS}ms`);
          (currentTab as any)._needsFullSnapshot = true;
          tabSnapshot = this._buildSnapshotUnavailableMarker();
        } else {
          tabSnapshot = snapOutcome.result;
          requestDebug(`captureSnapshot: completed in ${Date.now() - snapshotStart}ms`);
        }
      } else {
        tabSnapshot = undefined;
      }
      // Current-tab header only; cross-tab headers are available via
      // browser_list_all_tabs on demand. One wedged non-current tab no longer
      // blocks the response.
      const currentHeader = currentTab
        ? await this._buildCurrentHeader(currentTab)
        : undefined;
      if (currentHeader && (this._includeSnapshot !== 'none' || currentHeader.changed))
        addSection('Page', renderTabMarkdown(currentHeader));
      if (this._context.tabs().length === 0)
        this._isClose = true;
    }

    // Handle modal states.
    if (tabSnapshot?.modalStates.length)
      addSection('Modal state', renderModalStates(this._context.config, tabSnapshot.modalStates));

    // Handle tab snapshot
    if (tabSnapshot && this._includeSnapshot !== 'none') {
      const snapshot = this._includeSnapshot === 'full' ? tabSnapshot.ariaSnapshot : tabSnapshot.ariaSnapshotDiff ?? tabSnapshot.ariaSnapshot;
      const userRequestedFile = this._context.config.outputMode === 'file' || !!this._includeSnapshotFileName;
      if (userRequestedFile) {
        const resolvedFile = await this.resolveClientFile({ prefix: 'page', ext: 'yml', suggestedFilename: this._includeSnapshotFileName }, 'Snapshot');
        await fs.promises.writeFile(resolvedFile.fileName, snapshot, 'utf-8');
        addSection('Snapshot', [resolvedFile.printableLink]);
      } else if (typeof snapshot === 'string' && Buffer.byteLength(snapshot, 'utf8') > INLINE_SNAPSHOT_MAX_BYTES) {
        // Auto-save oversized inline snapshots to disk and leave a pointer.
        const sizeKB = Math.round(Buffer.byteLength(snapshot, 'utf8') / 1024);
        const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        const fileTemplate: FilenameTemplate = { prefix: `snapshots/${ts}_${this.toolName}`, ext: 'md' };
        const resolvedFile = await this.resolveClientFile(fileTemplate, 'Snapshot');
        await fs.promises.writeFile(resolvedFile.fileName, snapshot, 'utf-8');
        addSection('Snapshot', [`[snapshot too large (${sizeKB} KB) — saved to ${resolvedFile.relativeName}. Call browser_snapshot with filename= to request a persistent copy.]`]);
      } else {
        addSection('Snapshot', [snapshot], 'yaml');
      }
    }

    // Handle tab log
    const text: string[] = [];
    if (tabSnapshot?.consoleLink)
      text.push(`- New console entries: ${tabSnapshot.consoleLink}`);
    if (tabSnapshot?.events.filter(event => event.type !== 'request').length) {
      for (const event of tabSnapshot.events) {
        if (event.type === 'console' && this._context.config.outputMode !== 'file' && this._context.config.snapshot?.mode !== 'none') {
          if (shouldIncludeMessage(this._context.config.console?.level, event.message.type))
            text.push(`- ${trimMiddle(event.message.toString(), 100)}`);
        } else if (event.type === 'download-start') {
          text.push(`- Downloading file ${event.download.download.suggestedFilename()} ...`);
        } else if (event.type === 'download-finish') {
          text.push(`- Downloaded file ${event.download.download.suggestedFilename()} to "${this._computRelativeTo(event.download.outputFile)}"`);
        }
      }
    }
    if (text.length)
      addSection('Events', text);
    return sections;
  }
}

export function renderTabMarkdown(tab: TabHeader): string[] {
  const lines = [`- Page URL: ${tab.url}`];
  if (tab.title)
    lines.push(`- Page Title: ${tab.title}`);
  if (tab.console.errors || tab.console.warnings)
    lines.push(`- Console: ${tab.console.errors} errors, ${tab.console.warnings} warnings`);
  return lines;
}

export function renderTabsMarkdown(tabs: TabHeader[]): string[] {
  if (!tabs.length)
    return ['No open tabs. Navigate to a URL to create one.'];

  const lines: string[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const current = tab.current ? ' (current)' : '';
    lines.push(`- ${i}:${current} [${tab.title}](${tab.url})`);
  }
  return lines;
}

function trimMiddle(text: string, maxLength: number) {
  if (text.length <= maxLength)
    return text;
  return text.slice(0, Math.floor(maxLength / 2)) + '...' + text.slice(- 3 - Math.floor(maxLength / 2));
}

/**
 * Sanitizes a string to ensure it only contains well-formed Unicode.
 * Replaces lone surrogates with U+FFFD using String.prototype.toWellFormed().
 */
function sanitizeUnicode(text: string): string {
  if ((String.prototype as any).toWellFormed)
    return text.toWellFormed();
  return text;
}

function parseSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const sectionHeaders = text.split(/^### /m).slice(1); // Remove empty first element

  for (const section of sectionHeaders) {
    const firstNewlineIndex = section.indexOf('\n');
    if (firstNewlineIndex === -1)
      continue;

    const sectionName = section.substring(0, firstNewlineIndex);
    const sectionContent = section.substring(firstNewlineIndex + 1).trim();
    sections.set(sectionName, sectionContent);
  }

  return sections;
}

export function parseResponse(response: CallToolResult) {
  if (response.content?.[0].type !== 'text')
    return undefined;
  const text = response.content[0].text;

  const sections = parseSections(text);
  const error = sections.get('Error');
  const result = sections.get('Result');
  const code = sections.get('Ran Playwright code');
  const tabs = sections.get('Open tabs');
  const page = sections.get('Page');
  const snapshot = sections.get('Snapshot');
  const events = sections.get('Events');
  const modalState = sections.get('Modal state');
  const codeNoFrame = code?.replace(/^```js\n/, '').replace(/\n```$/, '');
  const isError = response.isError;
  const attachments = response.content.length > 1 ? response.content.slice(1) : undefined;

  return {
    result,
    error,
    code: codeNoFrame,
    tabs,
    page,
    snapshot,
    events,
    modalState,
    isError,
    attachments,
    text,
  };
}
