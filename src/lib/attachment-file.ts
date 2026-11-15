import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';

/**
 * A local file prepared for a Priority attachment row.
 *
 * Priority's OData service carries an attachment's bytes INSIDE the row: EXTFILENAME holds a
 * data URI (`data:application/pdf;base64,…`). Reads return it that way (verified live 7.11.2026
 * on a final AINVOICES document), and the same shape is what Priority's REST documentation gives for
 * uploading a file. So a file the caller holds can be attached without it first being placed
 * somewhere Priority's server can reach.
 */
export interface AttachmentFile {
  name: string;
  suffix: string;
  mime: string;
  bytes: number;
  sha256: string;
  dataUri: string;
}

/** Base64 grows a file by a third and the whole row travels in one JSON request. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  msg: 'application/vnd.ms-outlook',
  eml: 'message/rfc822',
};

/** Leading bytes that a file of this type must start with (cheap proof it is what it claims). */
const MAGIC: Record<string, number[][]> = {
  pdf: [[0x25, 0x50, 0x44, 0x46]],
  png: [[0x89, 0x50, 0x4e, 0x47]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  xlsx: [[0x50, 0x4b]],
  docx: [[0x50, 0x4b]],
};

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function prepare(bytes: Buffer, fileName: string, suffixOverride?: string): AttachmentFile {
  const name = basename(fileName);
  const suffix = (suffixOverride ?? extname(name).slice(1)).toLowerCase();
  const mime = MIME[suffix];
  if (!mime)
    throw new Error(
      `Unsupported file type ".${suffix || '?'}". Supported: ${Object.keys(MIME).join(', ')}.`,
    );
  if (bytes.length === 0) throw new Error('The file is empty.');
  if (bytes.length > MAX_ATTACHMENT_BYTES)
    throw new Error(
      `The file is ${bytes.length} bytes; the limit is ${MAX_ATTACHMENT_BYTES} (10 MB).`,
    );
  const magic = MAGIC[suffix];
  if (magic && !magic.some((m) => m.every((b, i) => bytes[i] === b)))
    throw new Error(`The content is not a valid .${suffix} file (wrong leading bytes).`);
  return {
    name,
    suffix,
    mime,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    dataUri: `data:${mime};base64,${bytes.toString('base64')}`,
  };
}

/** Read a file from the machine this server runs on. */
export async function attachmentFromPath(path: string, suffix?: string): Promise<AttachmentFile> {
  if (!isAbsolute(path)) throw new Error('localPath must be an absolute path.');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`No readable file at ${path}.`);
  if (info.size > MAX_ATTACHMENT_BYTES)
    throw new Error(
      `The file is ${info.size} bytes; the limit is ${MAX_ATTACHMENT_BYTES} (10 MB).`,
    );
  return prepare(await readFile(path), path, suffix);
}

/** Decode base64 file content handed over in the tool call (also accepts a whole data URI). */
export function attachmentFromBase64(
  content: string,
  fileName: string,
  suffix?: string,
): AttachmentFile {
  const encoded = content.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error('fileContent is not complete base64 (it may have been cut off in transit).');
  return prepare(Buffer.from(encoded, 'base64'), fileName, suffix);
}

/** What Priority stored in EXTFILENAME, without the bytes: a data URI's size and hash, or a path. */
export function describeStoredFile(value: unknown): {
  kind: 'inline' | 'path' | 'empty';
  mime?: string;
  bytes?: number;
  sha256?: string;
  path?: string;
} {
  if (typeof value !== 'string' || !value) return { kind: 'empty' };
  const match = /^data:([^;,]+)(?:;[^;,]+=[^;,]*)*;base64,([A-Za-z0-9+/=\r\n]*)$/.exec(value);
  if (!match) return { kind: 'path', path: value.startsWith('data:') ? '[data URI]' : value };
  const bytes = Buffer.from(match[2].replace(/[\r\n]/g, ''), 'base64');
  return {
    kind: 'inline',
    mime: match[1].toLowerCase(),
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
  };
}

/** Replace an inline file in an attachment row with a short description (never echo megabytes). */
export function redactAttachmentRow(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.EXTFILENAME !== 'string' || !row.EXTFILENAME.startsWith('data:')) return row;
  const stored = describeStoredFile(row.EXTFILENAME);
  return {
    ...row,
    EXTFILENAME: `[file stored in Priority: ${stored.mime ?? 'unknown type'}, ${stored.bytes ?? '?'} bytes]`,
    storedFile: stored,
  };
}
