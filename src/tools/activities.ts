import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { unavailableHere } from '../lib/write-guard.js';

/**
 * CRM activity tools.
 *
 * NOTE: these were originally pointed at the `PHONEBOOK` form, but on this installation
 * `PHONEBOOK` is the **contacts master** (key FIRMA,NAMEA) — it is NOT a CRM activity/task log
 * and has no per-customer activity rows. No exposed form cleanly represents "activities for a
 * customer": `GENDIARY` (a personal diary) has no CUSTNAME, and `TODOLIST` is a task list whose
 * mapping wasn't verified. Rather than write/return data against the wrong form, each tool
 * returns a clear "not available here" result that names candidate forms to use via the
 * generic tools (priority_list_forms / priority_query). This needs a follow-up once the right
 * activity form is identified for this install.
 */
const ACTIVITIES_NOTE =
  'CRM activities are not wired on this installation: PHONEBOOK is the contacts master (not an ' +
  'activity log), GENDIARY has no CUSTNAME, and TODOLIST is unverified.';
const ACTIVITIES_SUGGESTION =
  'Identify the real activity/task form with priority_list_forms (candidates: GENDIARY, TODOLIST, ' +
  'DOCUMENTS_*), inspect it with priority_describe_form, then read/write it via priority_query / ' +
  'priority_create_record.';

export function registerActivityTools(server: McpServer, _client: PriorityClient, _config: Config) {
  server.tool(
    'priority_list_activities',
    'List CRM activities (calls, meetings, tasks) with optional filters.',
    {
      customerId: z.string().optional().describe('Filter by CUSTNAME'),
      type: z.string().optional().describe('Activity type filter'),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).default(0),
    },
    async () => unavailableHere(ACTIVITIES_NOTE, ACTIVITIES_SUGGESTION),
  );

  server.tool(
    'priority_get_customer_activities',
    `Get full activity history for a specific customer.

Returns all CRM activities (calls, emails, meetings, notes) associated with this customer.`,
    {
      customerId: z.string().min(1).describe('The CUSTNAME'),
      top: z.number().int().min(1).max(500).default(100),
    },
    async () => unavailableHere(ACTIVITIES_NOTE, ACTIVITIES_SUGGESTION),
  );

  server.tool(
    'priority_get_open_tasks',
    `Get open/pending tasks.

Returns tasks that haven't been completed yet, sorted by due date.`,
    {
      assignee: z.string().optional().describe('Filter by assigned user'),
      top: z.number().int().min(1).max(500).default(50),
    },
    async () =>
      unavailableHere(
        ACTIVITIES_NOTE,
        'TODOLIST is exposed on this install — inspect it with priority_describe_form({ form: "TODOLIST" }) and query via priority_query.',
      ),
  );

  // --- Write Tools ---

  server.tool(
    'priority_create_activity',
    `Log a new CRM activity (call, email, meeting) against a customer.

⚠️ WRITE OPERATION. Use dryRun=true (default) to preview.`,
    {
      customerId: z.string().min(1).describe('CUSTNAME'),
      type: z.string().min(1).describe('Activity type (e.g. "Phone Call", "Email", "Meeting")'),
      subject: z.string().min(1).describe('Activity subject/title'),
      details: z.string().optional().describe('Activity notes/details'),
      date: z.string().optional().describe('Activity date (ISO 8601) — defaults to today'),
      dryRun: z.boolean().default(true),
    },
    async () =>
      unavailableHere(
        `${ACTIVITIES_NOTE} Writing to PHONEBOOK would create a CONTACT, not an activity.`,
        ACTIVITIES_SUGGESTION,
      ),
  );

  server.tool(
    'priority_schedule_followup',
    `Schedule a future follow-up task for a customer.

⚠️ WRITE OPERATION. Creates a future-dated task. Use dryRun=true (default) to preview.`,
    {
      customerId: z.string().min(1).describe('CUSTNAME'),
      subject: z.string().min(1).describe('Task subject'),
      dueDate: z.string().min(1).describe('Due date (ISO 8601)'),
      details: z.string().optional(),
      assignTo: z.string().optional().describe('Username to assign the task to'),
      dryRun: z.boolean().default(true),
    },
    async () =>
      unavailableHere(
        `${ACTIVITIES_NOTE} Writing to PHONEBOOK would create a CONTACT, not a task.`,
        ACTIVITIES_SUGGESTION,
      ),
  );
}
