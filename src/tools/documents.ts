import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import {
  type AttachmentFile,
  MAX_ATTACHMENT_BYTES,
  attachmentFromBase64,
  attachmentFromPath,
  describeStoredFile,
  redactAttachmentRow,
} from '../lib/attachment-file.js';
import { attachmentSubformOf } from '../lib/forms.js';
import { resolveRecordKey } from '../lib/record-key.js';
import { previewOrBlock, textResult, unavailableHere } from '../lib/write-guard.js';
import { verifyLineCreate, verifyWrite } from '../lib/write-verification.js';

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
          attachments: result.value.map(redactAttachmentRow),
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
          attachment: redactAttachmentRow(match),
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
    `צירוף מסמך לרשומה. Attach a file to a Priority document (supplier invoice, import file, order…).

THREE WAYS to give the file — exactly one:
  • localPath — absolute path of a file ON THE MACHINE THIS SERVER RUNS ON (where a bot saved the
    PDF). The server reads it and sends the bytes to Priority. Preferred: nothing large passes
    through the tool call.
  • fileContent — the file as base64 (or a data URI) plus 'fileName'. For small files only; long
    base64 is easily cut off in transit, and a cut-off file is rejected.
  • filePath — a location Priority's own server can already reach (share path / URL). Stores a
    pointer only; no bytes are sent.

How it works: Priority's OData service keeps an attachment's bytes inside the row — EXTFILENAME
holds a data URI (data:application/pdf;base64,…). The tool builds that from the file. Limit
${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB; pdf, jpg, png, tif, xlsx, docx, msg, eml, txt, csv, xml; a .pdf must really be a PDF.
EXTFILEDES is the display name (≤32 chars; defaults to the file name).

For a composite-keyed parent pass 'keys', e.g. PINVOICES { IVNUM:'T123', DEBIT:'D', IVTYPE:'P' }.
The attachments sub-form is discovered from the parent form (EXTFILES_SUBFORM on most forms).

After a real write the tool reads the new row back and compares the SHA-256 of what Priority
stored with the file that was sent: 'attached' is true only when the bytes match
(fileContentVerified). A filePath pointer can only be verified as a row. The file itself is never
echoed in previews or results — only its size and hash.

⚠️ WRITE. dryRun=true (default) previews the endpoint, name, size and hash; nothing is sent.`,
    {
      entityType: z.string().min(1).describe('Parent form type (e.g. "PINVOICES", "IMPFILES")'),
      entityKey: z.string().min(1).optional().describe('Parent record key (e.g. the IMPFNUM)'),
      keys: z
        .record(z.string(), z.union([z.string(), z.number().finite()]))
        .optional()
        .describe('Named parent key fields; exactly one of entityKey or keys'),
      localPath: z
        .string()
        .optional()
        .describe('Absolute path of the file on the machine running this server (preferred)'),
      fileContent: z
        .string()
        .optional()
        .describe('The file as base64 or a data URI (small files); requires fileName'),
      fileName: z
        .string()
        .optional()
        .describe('File name with extension, for fileContent (e.g. "invoice-1234.pdf")'),
      filePath: z
        .string()
        .optional()
        .describe("Pointer only: a path/URL Priority's server can already reach → EXTFILENAME"),
      description: z
        .string()
        .optional()
        .describe('Display name → EXTFILEDES (mandatory in Priority, max 32 chars)'),
      suffix: z.string().optional().describe('File extension → SUFFIX (derived when omitted)'),
      subform: z
        .string()
        .optional()
        .describe('Override the attachments sub-form name (normally auto-detected)'),
      fileUrl: z.string().optional().describe('Deprecated alias for filePath'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      try {
        const key = await resolveRecordKey(
          client,
          params.entityType,
          params.entityKey,
          params.keys,
          params.dryRun === true,
        );
        // fileName used to be an alias for filePath; it still is when no content comes with it.
        const pointer =
          params.filePath ?? params.fileUrl ?? (params.fileContent ? undefined : params.fileName);
        const given = [params.localPath, params.fileContent, pointer].filter(
          (v) => v !== undefined && v !== '',
        ).length;
        if (given !== 1) {
          return textResult({
            error:
              "Give the file exactly one way: localPath (a file on this server's machine), fileContent + fileName (base64), or filePath (a location Priority's server can reach).",
          });
        }
        let file: AttachmentFile | undefined;
        try {
          if (params.localPath) file = await attachmentFromPath(params.localPath, params.suffix);
          else if (params.fileContent) {
            if (!params.fileName)
              return textResult({ error: 'fileContent requires fileName (with its extension).' });
            file = attachmentFromBase64(params.fileContent, params.fileName, params.suffix);
          }
        } catch (error) {
          return textResult({
            error: `The file cannot be attached: ${error instanceof Error ? error.message : String(error)}`,
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
        const endpoint = client.resolveSubformUrl(params.entityType, key, subform);

        if (file) {
          const description = (params.description ?? file.name).slice(0, 32);
          const body = {
            [EXTFILES_FIELDS.path]: file.dataUri,
            [EXTFILES_FIELDS.description]: description,
            [EXTFILES_FIELDS.suffix]: file.suffix,
          };
          const fileInfo = {
            name: file.name,
            mime: file.mime,
            bytes: file.bytes,
            sha256: file.sha256,
          };
          const gate = previewOrBlock(
            config,
            params.dryRun,
            `ATTACH FILE TO ${params.entityType} ${JSON.stringify(key)}`,
            {
              method: 'POST',
              endpoint,
              subform,
              subformResolvedBy: source,
              body: {
                ...body,
                [EXTFILES_FIELDS.path]: `data:${file.mime};base64,[${file.bytes} bytes, not shown]`,
              },
              file: fileInfo,
            },
          );
          if (gate) return gate;

          const expected = { EXTFILEDES: description, sha256: file.sha256, bytes: file.bytes };
          const outcome = await verifyWrite(
            () => client.addLine<Record<string, unknown>>(params.entityType, key, subform, body),
            async (result) => {
              const id = (result as Record<string, unknown> | undefined)?.EXTFILENUM;
              if (typeof id !== 'number' && typeof id !== 'string')
                throw new Error(
                  'POST returned no EXTFILENUM; list the attachments before retrying.',
                );
              const row = await client.getSubformRow<Record<string, unknown>>(
                params.entityType,
                key,
                subform,
                { EXTFILENUM: id },
                undefined,
                { cache: false },
              );
              const stored = describeStoredFile(row.EXTFILENAME);
              return {
                EXTFILENUM: row.EXTFILENUM,
                EXTFILEDES: row.EXTFILEDES,
                SUFFIX: row.SUFFIX,
                FILESIZE: row.FILESIZE,
                CURDATE: row.CURDATE,
                storedAs: stored.kind,
                sha256: stored.sha256,
                bytes: stored.bytes,
              };
            },
            expected,
          );
          // The POST response repeats the whole file; keep only its identity.
          const created = outcome.result as Record<string, unknown> | undefined;
          const result = textResult({
            attached: outcome.verified,
            fileContentVerified: outcome.verified,
            entity: params.entityType,
            entityKey: key,
            subform,
            file: fileInfo,
            ...outcome,
            result: created ? { EXTFILENUM: created.EXTFILENUM } : undefined,
            storedRow: outcome.verification.observed ?? null,
            note: outcome.verified
              ? 'Priority stored the file; the bytes read back match the file that was sent.'
              : "Not verified. Do not attach again before listing the document's attachments (priority_list_attachments) — a row may already exist.",
          });
          return outcome.verified ? result : { ...result, isError: true as const };
        }

        // Pointer-only row: a location Priority's server can already reach.
        const path = pointer as string;
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
          note: 'Pointer only: the readback verifies the attachment row, not that Priority can open the path. To send the file itself use localPath or fileContent.',
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
