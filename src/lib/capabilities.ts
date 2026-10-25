import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from './capability-definitions.js';
import { isApiFlagOffError } from './forms.js';

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
interface Probe {
  availability: Availability;
  checkedAt: string;
}
export function toolAllowed(config: Config, name: string): boolean {
  return (
    !(config.priorityBlockedTools ?? []).includes(name) &&
    (!config.priorityAllowedTools || config.priorityAllowedTools.includes(name))
  );
}
export class CapabilityCatalog {
  private probes = new Map<string, Probe>();
  private refreshInFlight: Promise<void> | undefined;
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
      const probes = d.requiredForms.map((f) => this.probes.get(f));
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

  async refresh(entries: Capability[]): Promise<void> {
    // Queue refreshes before awaiting, so concurrent callers share the same four-read bound.
    const previous = this.refreshInFlight;
    const forms = [
      ...new Set(entries.filter((e) => e.access === 'enabled').flatMap((e) => e.requiredForms)),
    ];
    let cursor = 0;
    const run = async () => {
      for (;;) {
        const form = forms[cursor++];
        if (!form) return;
        let availability: Availability = 'unknown';
        try {
          await this.client.request(form, undefined, '?$top=1', { cache: false });
          availability = 'available';
        } catch (error) {
          if (isApiFlagOffError(error)) availability = 'api-disabled';
          else if (error instanceof PriorityError && [401, 403].includes(error.statusCode))
            availability = 'permission-denied';
          else if (error instanceof PriorityError && error.statusCode === 404)
            availability = 'absent';
        }
        this.probes.set(form, { availability, checkedAt: new Date().toISOString() });
      }
    };
    const pending = (previous ?? Promise.resolve()).then(async () => {
      await Promise.all(Array.from({ length: Math.min(4, forms.length) }, run));
    });
    this.refreshInFlight = pending;
    try {
      await pending;
    } finally {
      if (this.refreshInFlight === pending) this.refreshInFlight = undefined;
    }
  }
}
