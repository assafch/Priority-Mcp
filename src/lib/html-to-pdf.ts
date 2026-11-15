import { execFile as execFileCb } from 'node:child_process';
import { constants, accessSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/**
 * Last-resort conversion when Priority's document procedure returns HTML even though PDF was
 * requested. Priority's own PDF (documentOptions pdf:1) is the path we ask for first; this only
 * runs when the downloaded file is HTML. Headless Chrome prints that HTML, which keeps the
 * official layout, Hebrew, and CSS. A pure-JS HTML renderer does not.
 */

const CHROME_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function resolveChromeBinary(explicit?: string): string {
  if (explicit) {
    if (!exists(explicit)) {
      throw new Error(
        `PRIORITY_CHROME_PATH does not exist (${explicit}). Priority returned HTML and PDF conversion needs Chrome or Chromium.`,
      );
    }
    return explicit;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.startsWith('/') && exists(candidate)) return candidate;
    const resolved = which(candidate);
    if (resolved) return resolved;
  }
  throw new Error(
    'No Chrome/Chromium binary found. Priority returned HTML instead of PDF. Install Google Chrome, or set PRIORITY_CHROME_PATH to the browser binary. The tool already asks Priority for PDF (documentOptions pdf:1); this conversion is only the fallback.',
  );
}

function exists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(name: string): string | undefined {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const full = join(dir, name);
    if (exists(full)) return full;
  }
  return undefined;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Point relative images and stylesheets at the generated file's directory, not the temp folder. */
export function htmlWithBase(html: string, pageUrl: string | undefined): string {
  if (!pageUrl) return html;
  let base: string;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return html;
    base = new URL('.', url).href;
  } catch {
    return html;
  }
  if (/<base\s/i.test(html)) return html;
  const tag = `<base href="${escapeAttr(base)}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (match) => `${match}${tag}`);
  return `<!DOCTYPE html><html><head>${tag}</head><body>${html}</body></html>`;
}

export interface HtmlToPdfOptions {
  chromePath?: string;
  /** Test seam. Defaults to child_process.execFile. */
  execFileImpl?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  timeoutMs?: number;
}

/**
 * Write the HTML to a temp file and print it with headless Chrome.
 * The Priority file URL is not placed on the command line (it often carries a token).
 */
export async function convertHtmlToPdf(
  input: { html: Buffer; pageUrl?: string },
  options: HtmlToPdfOptions = {},
): Promise<Buffer> {
  const chrome = resolveChromeBinary(options.chromePath);
  const dir = mkdtempSync(join(tmpdir(), 'priority-print-'));
  const htmlPath = join(dir, 'document.html');
  const pdfPath = join(dir, 'document.pdf');
  try {
    const html = htmlWithBase(input.html.toString('utf8'), input.pageUrl);
    writeFileSync(htmlPath, html, 'utf8');
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      htmlPath,
    ];
    const run =
      options.execFileImpl ??
      ((file, cmd) => execFile(file, cmd, { timeout: options.timeoutMs ?? 90_000 }));
    await run(chrome, args);
    return readFileSync(pdfPath);
  } catch (err) {
    if (err instanceof Error && /No Chrome|PRIORITY_CHROME_PATH/.test(err.message)) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Headless Chrome could not convert Priority's HTML printout to PDF: ${detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
