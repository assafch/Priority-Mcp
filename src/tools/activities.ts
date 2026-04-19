import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { ODataBuilder } from '../client/odata-builder.js';
import { toMcpError } from '../client/errors.js';
import { sanitizeODataValue } from '../lib/sanitize.js';
import { checkWriteAllowed, dryRunResult, textResult } from '../lib/write-guard.js';

export function registerActivityTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_activities',
    `List CRM activities (calls, meetings, tasks) with optional filters.`,
    {
      customerId: z.string().optional().describe('Filter by CUSTNAME'),
      type: z.string().optional().describe('Activity type filter'),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).default(0),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().top(params.top).skip(params.skip).orderBy('CURDATE', 'desc');
        if (params.customerId) qb.eq('CUSTNAME', sanitizeODataValue(params.customerId));
        if (params.type) qb.eq('TYPEDES', sanitizeODataValue(params.type));
        if (params.dateFrom) qb.ge('CURDATE', params.dateFrom);
        if (params.dateTo) qb.le('CURDATE', params.dateTo);
        const result = await client.list('PHONEBOOK', qb.build());
        return textResult({ activities: result.value, pagination: { returned: result.value.length, top: params.top, skip: params.skip } });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_customer_activities',
    `Get full activity history for a specific customer.

Returns all CRM activities (calls, emails, meetings, notes) associated with this customer.`,
    {
      customerId: z.string().min(1).describe('The CUSTNAME'),
      top: z.number().int().min(1).max(500).default(100),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .eq('CUSTNAME', params.customerId)
          .orderBy('CURDATE', 'desc')
          .top(params.top);
        const result = await client.list('PHONEBOOK', qb.build());
        return textResult({ customerId: params.customerId, activities: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_open_tasks',
    `Get open/pending tasks.

Returns tasks that haven't been completed yet, sorted by due date.`,
    {
      assignee: z.string().optional().describe('Filter by assigned user'),
      top: z.number().int().min(1).max(500).default(50),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .eq('CLOSED', 'N')
          .orderBy('EXPIRYDATE', 'asc')
          .top(params.top);
        if (params.assignee) qb.contains('OWNERLOGIN', sanitizeODataValue(params.assignee));
        const result = await client.list('PHONEBOOK', qb.build());
        return textResult({ openTasks: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
    },
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
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body: Record<string, unknown> = {
          CUSTNAME: params.customerId,
          TYPEDES: params.type,
          SUBJECT: params.subject,
          CURDATE: params.date ?? new Date().toISOString().split('T')[0],
        };
        if (params.details) body.DETAILS = params.details;

        if (params.dryRun) return dryRunResult('CREATE ACTIVITY', body);

        const result = await client.create('PHONEBOOK', body);
        return textResult({ created: true, activity: result });
      } catch (err) { throw toMcpError(err); }
    },
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
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body: Record<string, unknown> = {
          CUSTNAME: params.customerId,
          SUBJECT: params.subject,
          EXPIRYDATE: params.dueDate,
          TYPEDES: 'Task',
        };
        if (params.details) body.DETAILS = params.details;
        if (params.assignTo) body.OWNERLOGIN = params.assignTo;

        if (params.dryRun) return dryRunResult('SCHEDULE FOLLOWUP', body);

        const result = await client.create('PHONEBOOK', body);
        return textResult({ created: true, task: result });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
