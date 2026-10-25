import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { Config } from '../config.js';
import type { MetricsCollector } from '../runtime/metrics.js';
import { createOperation, withOperation } from '../runtime/operation-context.js';
import { definitionFor } from './capability-definitions.js';
import { outputSchemaFor } from './result-contracts.js';
import { policyScopeFor } from './result-handles.js';
import { rememberToolHelp } from './tool-help.js';
import { effectiveTools, operationsDescription, workClassForTool } from './tool-profiles.js';
import { textResult } from './tool-result.js';

type Callback = (...args: unknown[]) => Promise<CallToolResult> | CallToolResult;
/** Add protocol metadata centrally, retaining legacy names/arguments and policy behavior. */
export function toolRegistry(
  server: McpServer,
  config: Config,
  metrics?: MetricsCollector,
): McpServer {
  const visible = new Set(effectiveTools(config.priorityToolProfile ?? 'full', config));
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === Symbol.for('priority.registry.server')) return target;
      if (prop !== 'tool') return Reflect.get(target, prop, receiver);
      return (
        name: string,
        description: string,
        inputSchema: z.ZodRawShape,
        callback: Callback,
      ) => {
        rememberToolHelp(target, name, description);
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
            description:
              prefix +
              (config.priorityToolProfile === 'operations'
                ? operationsDescription(name, description)
                : description),
            inputSchema,
            outputSchema: outputSchemaFor(name),
            annotations: {
              readOnlyHint: definition.mode !== 'write',
              destructiveHint: definition.mode === 'write',
              idempotentHint: definition.mode !== 'write',
              openWorldHint: true,
            },
          },
          async (...args) => {
            const extra = args[1] as { signal?: AbortSignal } | undefined;
            const context = createOperation(name, {
              metrics,
              policyScope: policyScopeFor(config),
              ...(extra?.signal ? { signal: extra.signal } : {}),
              ...(/report|revenue|sales_by_period/.test(name) &&
              typeof (args[0] as { deadlineMs?: number })?.deadlineMs === 'number'
                ? {
                    deadlineAt:
                      Date.now() +
                      Math.min(
                        300000,
                        Math.max(1000, (args[0] as { deadlineMs: number }).deadlineMs),
                      ),
                  }
                : {}),
              workClass: workClassForTool(name),
            });
            return withOperation(context, async () => {
              const started = performance.now();
              let outcome: 'ok' | 'error' | 'cancelled' | 'incomplete' = 'ok';
              try {
                const result = await callback(...args);
                if (result.isError) outcome = 'error';
                const serializationStarted = performance.now();
                let payload: unknown = result.structuredContent;
                if (payload === undefined) {
                  const content = result.content.find((c) => c.type === 'text');
                  try {
                    payload = content?.type === 'text' ? JSON.parse(content.text) : {};
                  } catch {
                    payload = { message: content?.type === 'text' ? content.text : '' };
                  }
                }
                const evidence =
                  payload && typeof payload === 'object'
                    ? (payload as Record<string, unknown>)
                    : {};
                const contracts = [evidence.meta, evidence.search].filter(
                  (value): value is Record<string, unknown> =>
                    Boolean(value) && typeof value === 'object',
                );
                if (
                  context.signal.aborted ||
                  contracts.some(
                    (meta) => meta.stopReason === 'cancelled' || meta.stopReason === 'deadline',
                  )
                )
                  outcome = 'cancelled';
                else if (!result.isError && contracts.some((meta) => meta.complete === false))
                  outcome = 'incomplete';
                const normalized =
                  result.structuredContent !== undefined
                    ? result
                    : { ...result, ...textResult(payload) };
                metrics?.record({
                  phase: 'serialization',
                  durationMs: performance.now() - serializationStarted,
                  bytes: Buffer.byteLength(JSON.stringify(normalized)),
                });
                return normalized;
              } catch (error) {
                outcome = context.signal.aborted ? 'cancelled' : 'error';
                throw error;
              } finally {
                metrics?.record({
                  phase: 'tool',
                  durationMs: performance.now() - started,
                  outcome,
                });
              }
            });
          },
        );
        if (!visible.has(name)) registered.disable();
        return registered;
      };
    },
  });
}
