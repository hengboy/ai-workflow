interface OwnedSection {
  id: string;
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
}

export class OwnershipConflictError extends Error {
  readonly section: string | undefined;
  constructor(reason: string, section?: string) {
    super(reason);
    this.name = 'OwnershipConflictError';
    this.section = section;
  }
}

function parseOwnedSections(contents: string): OwnedSection[] {
  const sections: OwnedSection[] = [];
  const seen = new Set<string>();
  let open: { id: string; start: number; bodyStart: number } | undefined;
  for (const match of contents.matchAll(/<!--\s*ai-workflow:section\b[\s\S]*?(?:-->|$)/g)) {
    const marker = /^<!--[ \t]+ai-workflow:section[ \t]+([^:\s<>]+):(begin|end)[ \t]+-->$/.exec(match[0]);
    if (!marker) throw new OwnershipConflictError('Malformed ownership marker', /ai-workflow:section[ \t]+([^:\s<>]+)/.exec(match[0])?.[1]);
    const id = marker[1];
    if (id === undefined) throw new OwnershipConflictError('Malformed ownership marker');
    if (marker[2] === 'begin') {
      if (open) throw new OwnershipConflictError(`Nested ownership section: ${id}`, id);
      if (seen.has(id)) throw new OwnershipConflictError(`Duplicate ownership section: ${id}`, id);
      seen.add(id);
      let bodyStart = match.index + match[0].length;
      if (contents.startsWith('\r\n', bodyStart)) bodyStart += 2;
      else if (contents.startsWith('\n', bodyStart)) bodyStart += 1;
      open = { id, start: match.index, bodyStart };
    } else {
      if (!open || open.id !== id) throw new OwnershipConflictError(`Unmatched ownership section end: ${id}`, id);
      let end = match.index + match[0].length;
      if (contents.startsWith('\r\n', end)) end += 2;
      else if (contents.startsWith('\n', end)) end += 1;
      sections.push({ id, start: open.start, end, bodyStart: open.bodyStart, bodyEnd: match.index });
      open = undefined;
    }
  }
  if (open) throw new OwnershipConflictError(`Unclosed ownership section: ${open.id}`, open.id);
  return sections;
}

export function validateOwnedSections(contents: string, requireSection = false): void {
  const sections = parseOwnedSections(contents);
  if (requireSection && !sections.some((section) => contents.slice(section.bodyStart, section.bodyEnd).trim() !== '')) {
    throw new Error('Template requires at least one owned section with content');
  }
}

function headingSections(contents: string): Array<{ heading: string; start: number; end: number }> {
  const headings = [...contents.matchAll(/^ {0,3}(#{1,6})[ \t]+([^\r\n]+)(?:\r?\n|$)/gm)].map((match) => ({
    heading: `${match[1]} ${(match[2] ?? '').trim().replace(/[ \t]+#+[ \t]*$/, '')}`,
    start: match.index,
  }));
  return headings.map((heading, index) => ({
    ...heading,
    end: headings[index + 1]?.start ?? contents.length,
  }));
}

export function mergeOwnedSections(target: string, source: string): {
  contents: string;
  warnings: Array<{ reason: string; section?: string }>;
} {
  const sourceSections = parseOwnedSections(source);
  const targetSections = parseOwnedSections(target);
  if (sourceSections.length === 0) throw new Error('Template has no owned sections');
  const sourceById = new Map(sourceSections.map((section) => [section.id, section]));
  const targetIds = new Set(targetSections.map((section) => section.id));
  const edits: Array<{ start: number; end: number; contents: string }> = [];
  const warnings: Array<{ reason: string; section?: string }> = [];
  const additions: string[] = [];
  for (const section of targetSections) {
    const current = sourceById.get(section.id);
    if (current) edits.push({ start: section.bodyStart, end: section.bodyEnd, contents: source.slice(current.bodyStart, current.bodyEnd) });
    else edits.push({ start: section.start, end: section.end, contents: '' });
  }

  const legacySections = headingSections(target).filter((heading) => !targetSections.some((section) => heading.start >= section.start && heading.start < section.end));
  const sourceHeadings = new Map(sourceSections.map((section) => {
    const heading = headingSections(source.slice(section.bodyStart, section.bodyEnd))[0];
    return [section.id, heading?.start === 0 ? heading.heading : undefined];
  }));
  for (const section of sourceSections) {
    if (targetIds.has(section.id)) continue;
    const body = source.slice(section.bodyStart, section.bodyEnd);
    const heading = sourceHeadings.get(section.id);
    const matches = heading ? legacySections.filter((candidate) => candidate.heading === heading) : [];
    if (matches.length > 0) {
      const candidate = matches[0];
      if (candidate === undefined) continue;
      const end = Math.min(candidate.end, targetSections.find((owned) => owned.start > candidate.start)?.start ?? target.length);
      if (matches.length !== 1 || [...sourceHeadings.values()].filter((value) => value === heading).length !== 1
        || target.slice(candidate.start, end) !== body) {
        warnings.push({ reason: 'Unmarked same-heading section differs from the current template or is ambiguous', section: section.id });
        continue;
      }
      edits.push({
        start: candidate.start,
        end,
        contents: source.slice(section.start, section.bodyStart) + target.slice(candidate.start, end) + source.slice(section.bodyEnd, section.end),
      });
    } else if (!heading && targetSections.length === 0 && target !== '') {
      warnings.push({ reason: 'Unmarked content cannot be safely adopted without a matching heading', section: section.id });
    } else {
      additions.push(source.slice(section.start, section.end));
    }
  }

  const parts: string[] = [];
  const unadopted: string[] = [];
  let cursor = 0;
  for (const edit of edits.sort((left, right) => left.start - right.start)) {
    const outside = target.slice(cursor, edit.start);
    parts.push(outside, edit.contents);
    unadopted.push(outside);
    cursor = edit.end;
  }
  parts.push(target.slice(cursor));
  unadopted.push(target.slice(cursor));
  if (targetSections.length === 0 && target.trim() !== '' && warnings.length === 0) {
    let unknown = unadopted.join('');
    const knownOutside: string[] = [];
    let sourceCursor = 0;
    for (const section of sourceSections) {
      knownOutside.push(source.slice(sourceCursor, section.start));
      sourceCursor = section.end;
    }
    knownOutside.push(source.slice(sourceCursor));
    for (const heading of headingSections(source)) {
      if (!heading.heading.startsWith('# ')) continue;
      const lineEnd = source.indexOf('\n', heading.start);
      knownOutside.push(source.slice(heading.start, lineEnd === -1 ? source.length : lineEnd).replace(/\r$/, ''));
    }
    for (const known of knownOutside) if (known !== '') unknown = unknown.replace(known, '');
    if (unknown.trim() !== '') warnings.push({ reason: 'Unknown unmarked legacy prose is preserved; its ownership requires attention' });
  }
  let contents = parts.join('');
  for (const addition of additions) contents += (contents === '' || contents.endsWith('\n') ? '' : '\n') + addition;
  return { contents, warnings };
}
