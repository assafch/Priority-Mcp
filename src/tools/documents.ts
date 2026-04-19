import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { ODataBuilder } from '../client/odata-builder.js';
import { toMcpError } from '../client/errors.js';
import { sanitizeODataValue } from '../lib/sanitize.js';
import { checkWriteAllowed, dryRunResult, textResult } from '../lib/write-guard.js';

export function registerDocumentTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_attachments',
    `List file attachments for any Priority entity (invoice, order, customer, etc.).

Queries the EXTFILES entity filtered by the parent entity type and key.`,
    {
      entityType: z.string().min(1).describe('The entity type (e.g. "ORDERS", "AINVOICES", "CUSTOMERS")'),
      entityKey: z.string().min(1).describe('The entity key value'),
      top: z.number().int().min(1).max(100).default(50),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .eq('IV', sanitizeODataValue(params.entityKey))
          .top(params.top);
        const result = await client.list('EXTFILES', qb.build());
        return textResult({ entity: params.entityType, entityKey: params.entityKey, attachments: result.value });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_attachment_url',
    `Get the download URL for a specific attachment by its file key.`,
    {
      fileKey: z.string().min(1).describe('The file identifier in EXTFILES'),
    },
    async (params) => {
      try {
        const file = await client.get<Record<string, unknown>>('EXTFILES', params.fileKey);
        return textResult({ fileKey: params.fileKey, url: file['EXTFILENAME'], name: file['EXTFILEDES'] });
      } catch (err) { throw toMcpError(err); }
    },
  );

  // --- Write Tools ---

  server.tool(
    'priority_upload_attachment',
    `Upload/attach a file to a Priority entity (invoice, order, customer, etc.).

⚠️ WRITE OPERATION. Provide either a base64-encoded file or a URL.
Use dryRun=true (default) to preview.`,
    {
      entityType: z.string().min(1).describe('Entity type (e.g. "ORDERS", "CUSTOMERS")'),
      entityKey: z.string().min(1).describe('Entity key value'),
      fileName: z.string().min(1).describe('File name with extension'),
      fileContent: z.string().optional().describe('Base64-encoded file content'),
      fileUrl: z.string().url().optional().describe('URL to fetch the file from'),
      description: z.string().optional().describe('File description'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      if (!params.fileContent && !params.fileUrl) {
        return textResult({ error: 'Provide either fileContent (base64) or fileUrl.' });
      }
      try {
        const body: Record<string, unknown> = {
          IV: params.entityKey,
          EXTFILENAME: params.fileName,
          EXTFILEDES: params.description ?? params.fileName,
        };
        if (params.fileContent) body.CONTENT = params.fileContent;
        if (params.fileUrl) body.FILEURL = params.fileUrl;

        if (params.dryRun) return dryRunResult('UPLOAD ATTACHMENT to ' + params.entityType, { ...body, CONTENT: params.fileContent ? '[base64 data]' : undefined });

        const result = await client.create('EXTFILES', body);
        return textResult({ uploaded: true, attachment: result });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
