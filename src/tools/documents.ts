import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { isCompositeKey } from '../lib/priority-schema.js';
import { textResult, unavailableHere } from '../lib/write-guard.js';

// Attachments live on a per-form sub-form (navigation property), NOT a global EXTFILES entity
// (EXTFILES is not API-queryable top-level here). Most forms use EXTFILES_SUBFORM; a few differ.
const ATTACHMENT_SUBFORM: Record<string, string> = {
  LOGPART: 'PARTEXTFILE_SUBFORM',
};
function attachmentSubform(entityType: string): string {
  return ATTACHMENT_SUBFORM[entityType] ?? 'EXTFILES_SUBFORM';
}

export function registerDocumentTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_attachments',
    `List file attachments for a Priority document (invoice, order, customer, part, etc.).

Reads the parent record's attachments sub-form. NOTE: the entity type matters — attachments are
scoped to that specific document, not matched by key value across all forms.`,
    {
      entityType: z
        .string()
        .min(1)
        .describe('The entity/form type (e.g. "ORDERS", "CUSTOMERS", "LOGPART")'),
      entityKey: z.string().min(1).describe('The entity key value (e.g. the ORDNAME / CUSTNAME)'),
      top: z.number().int().min(1).max(100).default(50),
    },
    async (params) => {
      try {
        // A single-value key predicate 404s on composite-keyed forms (e.g. AINVOICES) — those
        // can't be navigated by one key here.
        if (isCompositeKey(params.entityType)) {
          return unavailableHere(
            `${params.entityType} has a composite key, so its attachments cannot be listed from a single key value here.`,
            `Fetch the document with its dedicated get tool and $expand=${attachmentSubform(params.entityType)} to see attachments inline.`,
          );
        }
        const subform = attachmentSubform(params.entityType);
        const result = await client.listSubform<Record<string, unknown>>(
          params.entityType,
          params.entityKey,
          subform,
          `?$top=${params.top}`,
        );
        return textResult({
          entity: params.entityType,
          entityKey: params.entityKey,
          subform,
          attachments: result.value,
          count: result.value.length,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_attachment_url',
    'Get the file name/description for an attachment on a Priority document.',
    {
      entityType: z.string().min(1).describe('The parent form type (e.g. "ORDERS", "CUSTOMERS")'),
      entityKey: z.string().min(1).describe('The parent record key'),
      fileName: z.string().min(1).describe('The EXTFILENAME of the attachment to look up'),
    },
    // EXTFILES is not a queryable top-level entity here, so there is no global file key to fetch by,
    // and OData does not expose a public download URL (EXTFILENAME is a server-side file path, not a
    // URL). Point callers to list_attachments, which returns the file metadata from the sub-form.
    async () =>
      unavailableHere(
        'Attachment download URLs are not exposed by this Priority OData API — EXTFILENAME is a ' +
          'server-side file path, and there is no queryable global EXTFILES entity to resolve a file key.',
        'Use priority_list_attachments(entityType, entityKey) to list a document’s attachments and their ' +
          'names/descriptions; download the file from the Priority UI.',
      ),
  );

  // --- Write Tools ---

  server.tool(
    'priority_upload_attachment',
    `Upload/attach a file to a Priority document.

⚠️ WRITE OPERATION. NOTE: disabled on this installation — see the response for why.`,
    {
      entityType: z.string().min(1).describe('Entity type (e.g. "ORDERS", "CUSTOMERS")'),
      entityKey: z.string().min(1).describe('Entity key value'),
      fileName: z.string().min(1).describe('File name with extension'),
      fileContent: z.string().optional().describe('Base64-encoded file content'),
      fileUrl: z.string().url().optional().describe('URL to fetch the file from'),
      description: z.string().optional().describe('File description'),
      dryRun: z.boolean().default(true),
    },
    // Disabled: the old code POSTed to a top-level 'EXTFILES' entity (which is NOT API-queryable
    // here) with IV set to the human document key — but IV is an internal numeric record pointer,
    // not the document number. Attachments belong to a parent's EXTFILES_SUBFORM, and file upload
    // over this OData API is not supported on this install (verified: files can't be uploaded via API).
    async () =>
      unavailableHere(
        'Uploading attachments via this Priority OData API is not supported here: EXTFILES is not a ' +
          'writable top-level entity, and binary file upload is not exposed by the API on this install.',
        'Attach the file in the Priority UI. To LIST an existing document’s attachments, use ' +
          'priority_list_attachments(entityType, entityKey).',
      ),
  );
}
