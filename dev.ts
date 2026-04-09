#!/usr/bin/env npx tsx

/**
 * Earthling Browser Automation MCP — Dev Entry Point
 *
 * Runs the MCP server directly from TypeScript source via tsx.
 * No build step required — modify src/ and restart to apply changes.
 *
 * Usage: npx tsx dev.ts --extension
 */

import { program } from './src/utilsBundle';
import { decorateMCPCommand } from './src/tools/mcp/program';

const packageJSON = require('./package.json');
const p = program
	.version('Version ' + packageJSON.version)
	.name('Earthling Browser Automation');

decorateMCPCommand(p);
void program.parseAsync(process.argv);
