import type { DatabaseIncidentCauseCandidate } from './types.js';

const IDENT = String.raw`(?:\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$#@]*)`;
const QUALIFIED = String.raw`(${IDENT})(?:\s*\.\s*(${IDENT}))?`;

function codeOnly(value: string): string {
  let result = '';
  let index = 0;
  while (index < value.length) {
    const char = value[index]!;
    const next = value[index + 1] ?? '';
    if (char === "'") {
      result += ' ';
      index += 1;
      while (index < value.length) {
        if (value[index] === "'" && value[index + 1] === "'") {
          result += '  ';
          index += 2;
          continue;
        }
        if (value[index] === "'") {
          result += ' ';
          index += 1;
          break;
        }
        result += value[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      result += '  ';
      index += 2;
      while (index < value.length && value[index] !== '\n') {
        result += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      result += '  ';
      index += 2;
      while (index < value.length) {
        if (value[index] === '*' && value[index + 1] === '/') {
          result += '  ';
          index += 2;
          break;
        }
        result += value[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function cleanIdentifier(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

function objectParts(first: string, second?: string): { schema: string | null; name: string } {
  if (second) return { schema: cleanIdentifier(first), name: cleanIdentifier(second) };
  return { schema: null, name: cleanIdentifier(first) };
}

function usableObject(value: { schema: string | null; name: string }): boolean {
  return !value.name.startsWith('#') && !value.name.startsWith('@')
    && !(value.schema?.startsWith('#') || value.schema?.startsWith('@'));
}

function cteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const regex = new RegExp(String.raw`(?:\bwith|,)\s+(${IDENT})\s+as\s*\(`, 'ig');
  for (const match of sql.matchAll(regex)) names.add(cleanIdentifier(match[1]!).toLowerCase());
  return names;
}

function pushUnique(target: DatabaseIncidentCauseCandidate[], candidate: DatabaseIncidentCauseCandidate): void {
  const key = [candidate.kind, candidate.schema ?? '', candidate.table ?? '', candidate.name].join('|').toLowerCase();
  if (!target.some(item => [item.kind, item.schema ?? '', item.table ?? '', item.name].join('|').toLowerCase() === key)) {
    target.push(candidate);
  }
}

function targetTable(sql: string): { schema: string | null; name: string; confidence: 'high' | 'medium'; evidence: string } | null {
  const ctes = cteNames(sql);
  const patterns: Array<{ regex: RegExp; confidence: 'high' | 'medium'; evidence: string }> = [
    { regex: new RegExp(String.raw`\bupdate\s+${QUALIFIED}`, 'ig'), confidence: 'high', evidence: 'UPDATE target' },
    { regex: new RegExp(String.raw`\binsert\s+(?:into\s+)?${QUALIFIED}`, 'ig'), confidence: 'high', evidence: 'INSERT target' },
    { regex: new RegExp(String.raw`\bdelete\s+(?:from\s+)?${QUALIFIED}`, 'ig'), confidence: 'high', evidence: 'DELETE target' },
    { regex: new RegExp(String.raw`\bmerge\s+(?:into\s+)?${QUALIFIED}`, 'ig'), confidence: 'high', evidence: 'MERGE target' },
    { regex: new RegExp(String.raw`\bfrom\s+${QUALIFIED}`, 'ig'), confidence: 'medium', evidence: 'FROM object' },
    { regex: new RegExp(String.raw`\bjoin\s+${QUALIFIED}`, 'ig'), confidence: 'medium', evidence: 'JOIN object' }
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(sql))) {
      const after = sql.slice(match.index + match[0].length);
      if (/^\s*\./.test(after)) continue;
      const parts = objectParts(match[1]!, match[2]);
      if (!usableObject(parts) || ctes.has(parts.name.toLowerCase())) continue;
      return { ...parts, confidence: pattern.confidence, evidence: pattern.evidence };
    }
  }
  return null;
}

function explicitColumns(sql: string, table: { schema: string | null; name: string } | null): DatabaseIncidentCauseCandidate[] {
  if (!table) return [];
  const result: DatabaseIncidentCauseCandidate[] = [];
  const update = /\bset\s+([\s\S]*?)(?:\bwhere\b|\bfrom\b|\boutput\b|;|$)/i.exec(sql);
  if (/\bupdate\b/i.test(sql) && update) {
    for (const assignment of update[1]!.split(',')) {
      const match = new RegExp(String.raw`^\s*(?:${IDENT}\s*\.\s*)?(${IDENT})\s*=`, 'i').exec(assignment);
      if (!match) continue;
      pushUnique(result, {
        kind: 'column',
        schema: table.schema,
        table: table.name,
        name: cleanIdentifier(match[1]!),
        confidence: 'high',
        evidence: 'UPDATE SET column'
      });
    }
  }

  const insertPattern = new RegExp(String.raw`\binsert\s+(?:into\s+)?${QUALIFIED}\s*\(([^)]{1,2000})\)`, 'i');
  const insert = insertPattern.exec(sql);
  if (insert) {
    for (const raw of insert[3]!.split(',').slice(0, 24)) {
      const name = cleanIdentifier(raw);
      if (!/^[A-Za-z_][A-Za-z0-9_$#@]*$/.test(name)) continue;
      pushUnique(result, {
        kind: 'column',
        schema: table.schema,
        table: table.name,
        name,
        confidence: 'high',
        evidence: 'INSERT column list'
      });
    }
  }
  return result;
}

export function extractIncidentCauseCandidates(sqlText: string): DatabaseIncidentCauseCandidate[] {
  const sql = codeOnly(sqlText.slice(0, 8_000));
  const candidates: DatabaseIncidentCauseCandidate[] = [];

  const exec = new RegExp(String.raw`\bexec(?:ute)?\s+(?:@[A-Za-z_][A-Za-z0-9_$#@]*\s*=\s*)?${QUALIFIED}`, 'i').exec(sql);
  if (exec) {
    const object = objectParts(exec[1]!, exec[2]);
    const after = sql.slice((exec.index ?? 0) + exec[0].length);
    if (usableObject(object) && !/^\s*\./.test(after)) {
      pushUnique(candidates, {
        kind: 'procedure',
        schema: object.schema,
        table: null,
        name: object.name,
        confidence: 'high',
        evidence: 'EXEC/EXECUTE statement'
      });
    }
  }

  const table = targetTable(sql);
  if (table) {
    pushUnique(candidates, {
      kind: 'table',
      schema: table.schema,
      table: table.name,
      name: table.name,
      confidence: table.confidence,
      evidence: table.evidence
    });
    for (const column of explicitColumns(sql, table)) pushUnique(candidates, column);
  }
  return candidates.slice(0, 16);
}
