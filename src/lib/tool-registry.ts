import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { toolAllowed } from './capabilities.js';
import { definitionFor } from './capability-definitions.js';
import { textResult } from './tool-result.js';

type Callback = (...args: unknown[]) => Promise<CallToolResult> | CallToolResult;
/** Add protocol metadata centrally, retaining legacy names/arguments and policy behavior. */
export function toolRegistry(server: McpServer, config: Config): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'tool') return Reflect.get(target, prop, receiver);
      return (
        name: string,
        description: string,
        inputSchema: z.ZodRawShape,
        callback: Callback,
      ) => {
        const definition = definitionFor(name);
        const prefix =
          definition.implementation === 'unavailable'
            ? '[UNAVAILABLE: no validated implementation; returns explanation only] '
            : definition.mode === 'guide'
              ? '[GUIDE ONLY: does not execute a Priority procedure] '
              : '';
        const registered = target.registerTool(
          name,
          {
            description: prefix + description,
            inputSchema,
            outputSchema: z.looseObject({}),
            annotations: {
              readOnlyHint: definition.mode !== 'write',
              destructiveHint: definition.mode === 'write',
              idempotentHint: definition.mode !== 'write',
              openWorldHint: true,
            },
          },
          async (...args) => {
            const result = await callback(...args);
            let payload: unknown = result.structuredContent;
            if (payload === undefined) {
              const content = result.content.find((c) => c.type === 'text');
              try {
                payload = content?.type === 'text' ? JSON.parse(content.text) : {};
              } catch {
                payload = { message: content?.type === 'text' ? content.text : '' };
              }
            }
            return { ...result, ...textResult(payload) };
          },
        );
        if (!toolAllowed(config, name)) registered.disable();
        return registered;
      };
    },
  });
}
