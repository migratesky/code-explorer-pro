// Pure utilities for analysis, independent of VS Code APIs

export function createPreview(line: string, startCol: number, len: number): string {
  const prefix = line.slice(Math.max(0, startCol - 40), startCol);
  const hit = line.slice(startCol, startCol + len);
  const suffix = line.slice(startCol + len, Math.min(line.length, startCol + len + 40));
  return `${prefix}${hit}${suffix}`;
}

export function extractSymbolsFromLine(line: string, exclude: string): string[] {
  // Heuristic: JS/TS identifiers
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const token = m[0];
    if (token === exclude) continue;
    // Skip keywords/basic noise
    if (JS_TS_KEYWORDS.has(token)) continue;
    set.add(token);
  }
  return Array.from(set).slice(0, 20); // cap children per line
}

export function findAllWordHits(line: string, word: string): number[] {
  if (!word) return [];
  const re = new RegExp(`(^|[^A-Za-z0-9_$])(${escapeRegExp(word)})(?![A-Za-z0-9_$])`, 'g');
  const cols: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const start = m.index + (m[1] ? m[1].length : 0);
    cols.push(start);
  }
  return cols;
}

// Find all occurrences of query as a raw substring (no word boundaries), case-sensitive.
export function findAllTextHits(line: string, query: string): number[] {
  if (!query) return [];
  const hits: number[] = [];
  let from = 0;
  while (from <= line.length - query.length) {
    const idx = line.indexOf(query, from);
    if (idx === -1) break;
    hits.push(idx);
    from = idx + 1; // allow overlapping occurrences
  }
  return hits;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const JS_TS_KEYWORDS = new Set<string>([
  'const','let','var','function','return','if','else','for','while','switch','case','break','continue','class','extends','new','try','catch','finally','throw','import','from','export','default','as','implements','interface','public','private','protected','readonly','static','super','this','typeof','instanceof','in','of','delete','void','yield','await','do','with','package','namespace','enum','type'
]);
