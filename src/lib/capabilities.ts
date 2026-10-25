import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from './capability-definitions.js';
import type { CapabilityStatus } from './capability-store.js';
import { isApiFlagOffError } from './forms.js';
import { knowledgeFor } from './schema-service.js';

export type Availability =
  | 'available'
  | 'api-disabled'
  | 'permission-denied'
  | 'absent'
  | 'procedure-only'
  | 'unknown';
export interface Capability extends ToolDefinition {
  access: 'enabled' | 'blocked';
  writesAllowed: boolean;
  availability: Availability;
  reason: string;
  checkedAt: string | null;
  evidence: 'static' | 'live-read';
}
export function toolAllowed(config: Config, name: string): boolean {
  return (
    !(config.priorityBlockedTools ?? []).includes(name) &&
    (!config.priorityAllowedTools || config.priorityAllowedTools.includes(name))
  );
}
export class CapabilityCatalog {
  constructor(
    private client: PriorityClient,
    private config: Config,
  ) {}

  list(domain?: string, includeUnavailable = true): Capability[] {
    return TOOL_DEFINITIONS.filter(
      (d) =>
        (!domain || d.domain === domain) &&
        (includeUnavailable || d.implementation === 'implemented'),
    ).map((d) => {
      const probes = d.requiredForms.map((f) => {
        const p = knowledgeFor(this.client).capabilities.get(f, 'read');
        return p
          ? {
              checkedAt: p.checkedAt,
              availability: (
                {
                  supported: 'available',
                  unsupported: 'unknown',
                  denied: 'permission-denied',
                  absent: 'absent',
                  'api-disabled': 'api-disabled',
                  unknown: 'unknown',
                } as const
              )[p.status],
            }
          : undefined;
      });
      const fresh =
        probes.length > 0 &&
        probes.every((p) => p && Date.now() - Date.parse(p.checkedAt) < 900000);
      let availability: Availability = d.mode === 'guide' ? 'procedure-only' : 'unknown';
      if (fresh && d.mode !== 'guide') {
        availability =
          probes.find((p) => p?.availability !== 'available')?.availability ?? 'available';
        if (d.implementation === 'unavailable' && availability === 'available')
          availability = 'unknown';
      }
      return {
        ...d,
        access: toolAllowed(this.config, d.name) ? 'enabled' : 'blocked',
        writesAllowed: !this.config.priorityReadOnly && toolAllowed(this.config, d.name),
        availability,
        reason:
          d.mode === 'guide'
            ? 'Priority screen procedure; this tool provides instructions only.'
            : d.implementation === 'unavailable'
              ? 'No validated implementation. Tool response names the missing schema/procedure and evidence needed; readable forms alone do not enable it.'
              : d.requiredForms.length === 0
                ? 'Input-dependent or local capability. Registration does not verify tenant execution.'
                : 'Form readability only; field semantics, write permissions and procedure effects require separate verification.',
        checkedAt: fresh ? probes.map((p) => p?.checkedAt ?? '').sort()[0] : null,
        evidence: fresh ? 'live-read' : 'static',
      };
    });
  }

  async refresh(entries: Capability[], force = false): Promise<void> {
    const store = knowledgeFor(this.client).capabilities;
    const forms = [
      ...new Set(entries.filter((e) => e.access === 'enabled').flatMap((e) => e.requiredForms)),
    ];
    await Promise.all(
      forms.map((form) =>
        store.probe(
          form,
          'read',
          async (): Promise<CapabilityStatus> => {
            try {
              await this.client.request(form, undefined, '?$top=1', { cache: false });
              return 'supported';
            } catch (error) {
              if (isApiFlagOffError(error)) return 'api-disabled';
              if (error instanceof PriorityError && [401, 403].includes(error.statusCode))
                return 'denied';
              if (error instanceof PriorityError && error.statusCode === 404) return 'absent';
              return 'unknown';
            }
          },
          force,
        ),
      ),
    );
  }
}
