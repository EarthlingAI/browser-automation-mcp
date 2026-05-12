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

import { z as zod } from '../../../mcpBundle';
import type { z } from 'zod';
import type * as mcpServer from './server';

export type ToolSchema<Input extends z.Schema> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  type: 'input' | 'assertion' | 'action' | 'readOnly';
};

export function toMcpTool(tool: ToolSchema<any>): mcpServer.Tool {
  // `type` is the single source of truth — author it on the tool schema and let
  // all four MCP annotation hints derive from it here. `readOnlyHint` in
  // particular gates whether a permission-restricted client (e.g. an agent in a
  // read-only planning phase) is allowed to call the tool at all.
  const readOnly = tool.type === 'readOnly' || tool.type === 'assertion';
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zod.toJSONSchema(tool.inputSchema) as mcpServer.Tool['inputSchema'],
    annotations: {
      title: tool.title,
      readOnlyHint: readOnly,
      // No browser tool deletes data in the MCP sense — it drives a page, it
      // doesn't destroy state — so `destructiveHint` is always false.
      destructiveHint: false,
      idempotentHint: readOnly,
      // Read-only tools reflect the current page, not an open-ended external
      // world; mutating tools touch the live page (open world).
      openWorldHint: !readOnly,
    },
  };
}

export function defineToolSchema<Input extends z.Schema>(tool: ToolSchema<Input>): ToolSchema<Input> {
  return tool;
}
