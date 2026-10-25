import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { attachmentSubformOf } from '../lib/forms.js';
import { resolveRecordKey } from '../lib/record-key.js';
import { previewOrBlock, textResult, unavailableHere } from '../lib/write-guard.js';
import { verifyLineCreate } from '../lib/write-verification.js';

/**
 * Attachments live on a per-form sub-form (navigation property), NOT a global EXTFILES entity
 * (EXTFILES is not an entity set on this service — verified: it 404s). Most forms expose
 * EXTFILES_SUBFORM; some use a different name (LOGPART → PARTEXTFILE_SUBFORM) and some expose none
 * at all (CUSTOMERS here). The name is therefore DISCOVERED at runtime from the form's metadata,
 * with this table used only as an instant answer for the forms we have already confirmed.
 */
const ATTACHMENT_SUBFORM: Record<string, string> = {
  LOGPART: 'PARTEXTFILE_SUBFORM',
  IMPFILES: 'EXTFILES_SUBFORM',
};

/**
 * Resolve the attachments sub-form for a form: the known-good name if we have one, otherwise read
 * the form's navigation properties from Priority. `explicit` (a caller-supplied override) always
 * wins, so an unusual form is never a dead end.
 */
async function resolveAttachmentSubform(
  client: PriorityClient,
  form: string,
  explicit?: string,
): Promise<{ subform: string | null; source: string; subforms?: string[] | null }> {
  if (explicit) return { subform: explicit, source: 'caller-supplied' };
  const known = ATTACHMENT_SUBFORM[form];
  if (known) return { subform: known, source: 'known-form table' };
  const { subform, subforms } = await attachmentSubformOf(client, form);
  return {
    subform,
    source: subforms ? 'GetMetadataFor navigation properties' : 'metadata unavailable',
    subforms,
  };
}

/** The EXTFILES columns a caller can meaningfully set (the rest are server-maintained). */
const EXTFILES_FIELDS = {
  path: 'EXTFILENAME', // נתיב הקובץ — MANDATORY
  description: 'EXTFILEDES', // שם קובץ — MANDATORY, max 32 chars
  suffix: 'SUFFIX', // סיומת
} as const;

export function registerDocumentTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_attachments',
    `List file attachments for a Priority document (invoice, order, customer, part, etc.).

Reads the parent record's attachments sub-form, whose name is resolved at runtime (usually
EXTFILES_SUBFORM; LOGPART uses PARTEXTFILE_SUBFORM; some forms expose none). NOTE: the entity type
matters — attachments are scoped to that specific document, not matched by key value across forms.`,
    {
      entityType: z
        .string()
        .min(1)
        .describe('The entity/form type (e.g. "IMPFILES", "ORDERS", "LOGPART")'),
      entityKey: z
        .string()
        .min(1)
        .optional()
        .describe('The entity key value (e.g. the IMPFNUM / ORDNAME)'),
      keys: z
        .record(z.string(), z.union([z.string(), z.number().finite()]))
        .optional()
        .describe('Named parent key fields; exactly one of entityKey or keys'),
      subform: z
        .string()
        .optional()
        .describe('Override the attachments sub-form name (normally auto-detected)'),
      top: z.number().int().min(1).max(100).default(50),
    },
    async (params) => {
      try {
        const key = await resolveRecordKey(
          client,
          params.entityType,
          params.entityKey,
          params.keys,
          'dryRun' in params && params.dryRun === true,
        );
        const { subform, source, subforms } = await resolveAttachmentSubform(
          client,
          params.entityType,
          params.subform,
        );
        if (!subform) {
          return unavailableHere(
            `${params.entityType} does not expose an attachments sub-form on this installation (checked its ${source}).`,
            subforms?.length
              ? `Sub-forms this form does expose: ${subforms.join(', ')}. Pass one explicitly via 'subform' if attachments live under a different name here.`
              : 'Confirm the form name with priority_list_forms, then inspect it with priority_get_entity_metadata.',
          );
        }
        const result = await client.listSubform<Record<string, unknown>>(
          params.entityType,
          key,
          subform,
          `?$top=${params.top}`,
        );
        return textResult({
          entity: params.entityType,
          entityKey: key,
          subform,
          subformResolvedBy: source,
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
    `Get the stored file path / metadata for an attachment on a Priority document.

This OData API exposes no public download URL: EXTFILENAME is the file's path inside Priority's
document store, not a link. This tool returns the attachment row (path, description, size, date)
so you can locate the file; download it from the Priority UI.`,
    {
      entityType: z.string().min(1).describe('The parent form type (e.g. "IMPFILES", "ORDERS")'),
      entityKey: z.string().min(1).optional().describe('The parent record key'),
      keys: z
        .record(z.string(), z.union([z.string(), z.number().finite()]))
        .optional()
        .describe('Named parent key fields; exactly one of entityKey or keys'),
      fileName: z
        .string()
        .min(1)
        .describe('The EXTFILENAME (path) or EXTFILEDES (name) of the attachment to look up'),
      subform: z.string().optional().describe('Override the attachments sub-form name'),
    },
    async (params) => {
      try {
        const key = await resolveRecordKey(
          client,
          params.entityType,
          params.entityKey,
          params.keys,
          'dryRun' in params && params.dryRun === true,
        );
        const { subform } = await resolveAttachmentSubform(
          client,
          params.entityType,
          params.subform,
        );
        if (!subform) {
          return unavailableHere(
            `${params.entityType} does not expose an attachments sub-form on this installation.`,
            'Use priority_list_attachments on a form that does, or confirm the form name with priority_list_forms.',
          );
        }
        const rows = await client.listSubform<Record<string, unknown>>(
          params.entityType,
          key,
          subform,
          '?$top=100',
        );
        const needle = params.fileName.toLowerCase();
        const match = rows.value.find(
          (r) =>
            String(r.EXTFILENAME ?? '')
              .toLowerCase()
              .includes(needle) ||
            String(r.EXTFILEDES ?? '')
              .toLowerCase()
              .includes(needle),
        );
        if (!match) {
          return textResult({
            found: false,
            entity: params.entityType,
            entityKey: key,
            subform,
            attachmentsOnDocument: rows.value.length,
            available: rows.value.map((r) => r.EXTFILEDES ?? r.EXTFILENAME),
          });
        }
        return textResult({
          found: true,
          entity: params.entityType,
          entityKey: key,
          subform,
          attachment: match,
          downloadUrl: null,
          note: 'Priority OData does not expose a download URL — EXTFILENAME is a server-side path inside the document store. Open the document in the Priority UI to download the file.',
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  // --- Write Tools ---

  server.tool(
    'priority_upload_attachment',
    `צירוף מסמך לרשומה. Attach a file to a Priority document (invoice, order, import file, part…).

HOW ATTACHMENTS WORK HERE — read before using. Priority stores the FILE in its own document store
and the OData API records a ROW pointing at it: EXTFILENAME is the file's PATH ("נתיב הקובץ",
mandatory) and EXTFILEDES is its display name ("שם קובץ", mandatory, ≤32 chars). This API carries
no file bytes — the model declares no media/stream entity (verified: 0 entity types with HasStream)
— so pass 'filePath', a location Priority's server can already reach (a UNC/share path, a path
inside the document store, or a URL). Passing base64 'fileContent' is rejected with that explanation
rather than silently creating a broken row.

The attachments sub-form is DISCOVERED at runtime from the parent form's metadata (EXTFILES_SUBFORM
on most forms, PARTEXTFILE_SUBFORM on LOGPART); a form that exposes none is reported as such,
naming the sub-forms it does have. Verified live 2026-07-29: IMPFILES exposes EXTFILES_SUBFORM.

After a real write the tool RE-READS the sub-form and returns the created row, so you can see
exactly what Priority stored (including the EXTFILENUM it assigned).

⚠️ A stored row does not prove the path is accessible or the file bytes exist. Check the file in
the Priority UI; FILESIZE alone is not conclusive evidence of path accessibility.

⚠️ WRITE. dryRun=true (default) previews the exact POST endpoint + body; nothing is sent.`,
    {
      entityType: z.string().min(1).describe('Parent form type (e.g. "IMPFILES", "PORDERS")'),
      entityKey: z.string().min(1).optional().describe('Parent record key (e.g. the IMPFNUM)'),
      keys: z
        .record(z.string(), z.union([z.string(), z.number().finite()]))
        .optional()
        .describe('Named parent key fields; exactly one of entityKey or keys'),
      filePath: z
        .string()
        .optional()
        .describe(
          'Path/URL to the file, reachable by the Priority server → EXTFILENAME (mandatory in Priority)',
        ),
      description: z
        .string()
        .optional()
        .describe('Display name → EXTFILEDES (mandatory in Priority, max 32 chars)'),
      suffix: z
        .string()
        .optional()
        .describe('File extension → SUFFIX (derived from filePath when omitted)'),
      subform: z
        .string()
        .optional()
        .describe('Override the attachments sub-form name (normally auto-detected)'),
      fileName: z.string().optional().describe('Deprecated alias for filePath'),
      fileUrl: z.string().optional().describe('Deprecated alias for filePath'),
      fileContent: z
        .string()
        .optional()
        .describe('NOT SUPPORTED — this API stores a path, not bytes (see the tool description)'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      try {
        const key = await resolveRecordKey(
          client,
          params.entityType,
          params.entityKey,
          params.keys,
          'dryRun' in params && params.dryRun === true,
        );
        const path = params.filePath ?? params.fileUrl ?? params.fileName;
        if (params.fileContent) {
          return unavailableHere(
            'Binary upload is not part of this Priority OData API: the service declares no media/stream entity, and EXTFILES.EXTFILENAME is a PATH into Priority\'s document store ("נתיב הקובץ"), not file content. Creating the row from base64 would record an attachment whose file does not exist.',
            'Put the file somewhere the Priority server can read (document store / share / URL) and pass that location as filePath. To attach bytes directly, use the Priority UI or the Priority Web SDK file-upload endpoint, neither of which is OData.',
          );
        }
        if (!path) {
          return textResult({
            error:
              'filePath is required — it becomes EXTFILENAME (נתיב הקובץ), which Priority marks mandatory.',
          });
        }

        const { subform, source, subforms } = await resolveAttachmentSubform(
          client,
          params.entityType,
          params.subform,
        );
        if (!subform) {
          return unavailableHere(
            `${params.entityType} does not expose an attachments sub-form on this installation (checked its ${source}), so there is nowhere to attach a file.`,
            subforms?.length
              ? `Sub-forms this form exposes: ${subforms.join(', ')}. If attachments live under one of those, pass it as 'subform'.`
              : 'Confirm the form name with priority_list_forms and inspect it with priority_get_entity_metadata.',
          );
        }
        // EXTFILEDES is mandatory and capped at 32 chars — derive a sane one from the path rather
        // than letting Priority reject the row for a missing/oversized display name.
        const baseName = path.split(/[\\/]/).pop() ?? path;
        const description = (params.description ?? baseName).slice(0, 32);
        const suffix = params.suffix ?? baseName.split('.').slice(1).pop()?.slice(0, 4);
        const body: Record<string, unknown> = {
          [EXTFILES_FIELDS.path]: path,
          [EXTFILES_FIELDS.description]: description,
          ...(suffix ? { [EXTFILES_FIELDS.suffix]: suffix } : {}),
        };
        const endpoint = client.resolveSubformUrl(params.entityType, key, subform);

        const gate = previewOrBlock(
          config,
          params.dryRun,
          `ATTACH FILE TO ${params.entityType} ${JSON.stringify(key)}`,
          { method: 'POST', endpoint, subform, subformResolvedBy: source, body },
        );
        if (gate) return gate;

        const outcome = await verifyLineCreate(client, params.entityType, key, subform, body);
        return textResult({
          attached: outcome.verified,
          entity: params.entityType,
          entityKey: key,
          subform,
          ...outcome,
          created: outcome.result,
          storedRow: outcome.verification.observed ?? null,
          fileContentVerified: false,
          note: 'Readback verifies the attachment row only; file bytes and server path accessibility need separate evidence.',
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
