/**
 * Dev shim for utilsBundleImpl.
 * Re-exports vendored packages directly from node_modules instead of the
 * esbuild mega-bundle that upstream Playwright produces at build time.
 */

/* eslint-disable import/order */

import colorsLibrary from 'colors/safe';
export const colors = colorsLibrary;

import debugLibrary from 'debug';
export const debug = debugLibrary;

import * as iniLibrary from 'ini';
export const ini = iniLibrary;

import * as diffLibrary from 'diff';
export const diff = diffLibrary;

import dotenvLibrary from 'dotenv';
export const dotenv = dotenvLibrary;

export { getProxyForUrl } from 'proxy-from-env';

export { HttpsProxyAgent } from 'https-proxy-agent';

import jpegLibrary from 'jpeg-js';
export const jpegjs = jpegLibrary;

const lockfileLibrary = require('./third_party/lockfile');
export const lockfile = lockfileLibrary;

import mimeLibrary from 'mime';
export const mime = mimeLibrary;

import { minimatch as minimatchFn } from 'minimatch';
export const minimatch = minimatchFn;

import openLibrary from 'open';
export const open = openLibrary;

export { PNG } from 'pngjs';

export { program } from 'commander';
export { Option as ProgramOption } from 'commander';

import progressLibrary from 'progress';
export const progress = progressLibrary;

export { SocksProxyAgent } from 'socks-proxy-agent';

// @ts-ignore
import wsLibrary, { WebSocketServer, Receiver, Sender } from 'ws';
export const ws = wsLibrary;
export const wsServer = WebSocketServer;
export const wsReceiver = Receiver;
export const wsSender = Sender;

import yamlLibrary from 'yaml';
export const yaml = yamlLibrary;
