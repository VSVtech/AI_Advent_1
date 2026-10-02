import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import ts from 'typescript';

export const hash = (text) => createHash('sha256').update(text).digest('hex');

// The explicit manifest is the boundary: no recursive indexing of private data.
export async function loadDocuments(root, manifest) {
  const realRoot = await realpath(root);
  const sources = [...new Set(manifest.files)];
  if (!sources.length) throw new Error('Корпус документов пуст.');
  const documents = [];
  for (const source of sources.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (
      typeof source !== 'string' ||
      isAbsolute(source) ||
      source
        .split(/[\\/]/u)
        .some((part) => part.startsWith('.') || part === 'node_modules')
    ) {
      throw new Error('Манифест содержит недопустимый путь.');
    }
    const path = await realpath(resolve(root, source));
    const rel = relative(realRoot, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error('Документ находится вне корпуса.');
    if (!['.md', '.txt', '.ts', '.tsx', '.js', '.mjs'].includes(extname(path)))
      throw new Error('Формат документа пока не поддерживается.');
    const buffer = await readFile(path);
    if (buffer.length > 2_000_000)
      throw new Error(`Документ слишком большой: ${source}`);
    const text = new TextDecoder('utf-8', { fatal: true })
      .decode(buffer)
      .replace(/\r\n?/gu, '\n');
    if (!text.trim()) continue;
    const title =
      extname(path) === '.md'
        ? (/^#\s+(.+)$/mu.exec(text)?.[1] ?? basename(source))
        : basename(source);
    documents.push({
      source,
      file: basename(source),
      title,
      text,
      document_id: hash(source),
      content_hash: hash(text),
      sections: sectionsOf(text, source, title),
    });
  }
  if (!documents.length) throw new Error('В корпусе нет текста.');
  return documents;
}

export function sectionsOf(text, source, title) {
  const boundaries = [{ start: 0, section: title, scope: title }];
  if (extname(source) === '.md') {
    let offset = 0;
    let fence = null;
    const headings = [];
    for (const line of text.split('\n')) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length)
          fence = null;
      } else if (!fence) {
        const heading = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
        if (heading) {
          const depth = heading[1].length;
          headings.length = depth - 1;
          headings[depth - 1] = heading[2];
          boundaries.push({
            start: offset,
            section: headings.filter(Boolean).join(' / '),
            scope: headings.filter(Boolean).join(' / '),
          });
        }
      }
      offset += line.length + 1;
    }
  } else if (/\.[cm]?[jt]sx?$/u.test(source)) {
    const ast = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      const name =
        statement.name?.getText(ast) ??
        (ts.isVariableStatement(statement)
          ? statement.declarationList.declarations
              .map((item) => item.name.getText(ast))
              .join(', ')
          : null);
      const section = name ? `${title} / ${name}` : `${title} / declarations`;
      boundaries.push({
        start: statement.getFullStart(),
        section,
        scope:
          ts.isVariableStatement(statement) || ts.isImportDeclaration(statement)
            ? `${title} / declarations`
            : section,
      });
    }
  }
  const unique = [
    ...new Map(boundaries.map((item) => [item.start, item])).values(),
  ].sort((a, b) => a.start - b.start);
  return unique
    .map((item, i) => ({ ...item, end: unique[i + 1]?.start ?? text.length }))
    .filter((item) => item.end > item.start);
}

export function documentSummary(document) {
  return {
    source: document.source,
    title: document.title,
    document_id: document.document_id,
    content_hash: document.content_hash,
    characters: document.text.length,
    words: document.text.trim().split(/\s+/u).length,
    lines: document.text.split('\n').length,
  };
}
