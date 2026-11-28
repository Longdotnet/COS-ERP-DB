import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolvePath } from '../../main/sandbox.js';
import type { Root } from '../../shared/types.js';

const MAX_BYTES = 512 * 1024 * 1024;

// A bounded lexical inspection of generated SQLCMD payloads, not a T-SQL parser.
// Count statement-leading lines and never read raw values into the result.
export async function auditMigrationScript(file: string, roots: readonly Root[], signal?: AbortSignal) {
  const target = await resolvePath(roots, file);
  const handle = await fs.open(target.real, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Migration audit requires a regular file <= 512 MiB.');
    const bom = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bom,0,4,0);
    const utf16 = bytesRead >= 2 && bom[0] === 255 && bom[1] === 254;
    if (bytesRead >= 2 && bom[0] === 254 && bom[1] === 255) throw new Error('Convert UTF-16BE to UTF-8 or UTF-16LE before auditing.');
    const digest = createHash('sha256');
    let lines = 0, inserts = 0, batches = 0, includes = 0, maxLine = 0, bytes = 0;
    let prefix = '', lineLength = 0;
    const finish = () => {
      lines++;
      if (/^\s*INSERT\s+(?:INTO\s+)?\S/i.test(prefix)) inserts++;
      if (/^\s*GO(?:\s|$)/i.test(prefix)) batches++;
      if (/^\s*:r(?:\s|$)/i.test(prefix)) includes++;
      maxLine = Math.max(maxLine,lineLength);
      prefix = ''; lineLength = 0;
    };
    const decoder = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8', { fatal: true });
    const consume = (value: string) => {
        let start = 0;
        while(start < value.length) {
          const end = value.indexOf('\n',start);
          const part = value.slice(start,end === -1 ? undefined : end);
          lineLength += part.length;
          if(prefix.length < 512) prefix += part.slice(0,512-prefix.length);
          if(end === -1) break;
          finish(); start = end + 1;
        }
    };
    const buffer = Buffer.allocUnsafe(256 * 1024);
    while(true) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer,0,buffer.length,bytes);
      if(!bytesRead) break;
      bytes += bytesRead;
      if(bytes > MAX_BYTES) throw new Error('File exceeded migration audit limit while reading.');
      const chunk = buffer.subarray(0,bytesRead);
      digest.update(chunk);
      consume(decoder.decode(chunk,{ stream:true }));
    }
    consume(decoder.decode());
    if(lineLength) finish();
    const final = await handle.stat();
    if(final.size !== stat.size || final.mtimeMs !== stat.mtimeMs || bytes !== stat.size) throw new Error('Migration file changed during audit; retry.');
    return {
      path: target.virtual, bytes, sha256: digest.digest('hex'), lines, insertLeadingLines: inserts, goLeadingLines: batches,
      sqlcmdIncludeLines: includes, longestLineChars: maxLine,
      findings: [
        ...(inserts >= 10000 ? [{ code:'MANY_INSERT_LINES', severity:'review', message:'Large INSERT-line count. Check whether the payload uses individual INSERTs; benchmark batching before running.' }] : []),
        ...(includes ? [{ code:'SQLCMD_INCLUDE', severity:'review', message:'Requires checking SQLCMD mode, include paths and same-session temp-table requirements.' }] : []),
        ...(maxLine > 1024 * 1024 ? [{ code:'LONG_LINE', severity:'review', message:'Very long SQL line; check client and SQL Server batch limits.' }] : [])
      ],
      limitations:['Line-prefix heuristics may count comments or multiline strings; not a SQL syntax or safety validator.', 'Includes are not expanded. No statements are executed. Hash covers this file only, not migrated table data.']
    };
  } finally { await handle.close(); }
}
