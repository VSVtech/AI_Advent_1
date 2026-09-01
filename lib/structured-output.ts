import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';
import { isCollection, isMap, isScalar, parseDocument } from 'yaml';

import type { ChatOutputFormat } from '@/lib/chat-types';

export type StructuredOutputFormat = Exclude<ChatOutputFormat, 'text'>;

const xmlStructureParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasStructuredXmlRoot(content: string): boolean {
  const document = xmlStructureParser.parse(content) as unknown;
  if (!isRecord(document)) return false;

  const rootKeys = Object.keys(document).filter((key) => key !== '?xml');
  if (rootKeys.length !== 1 || rootKeys[0] !== 'response') return false;

  const root = document.response;
  if (!isRecord(root)) return false;

  const directText = root['#text'];
  if (typeof directText === 'string' && directText.trim()) return false;
  if (
    Array.isArray(directText) &&
    directText.some((value) => typeof value === 'string' && value.trim())
  ) {
    return false;
  }

  return Object.keys(root).some(
    (key) =>
      !key.startsWith('@_') &&
      !key.startsWith('#') &&
      !key.startsWith('?'),
  );
}

export function isStructuredOutputFormat(
  format: ChatOutputFormat,
): format is StructuredOutputFormat {
  return format !== 'text';
}

export function validateStructuredOutput(
  content: string,
  format: StructuredOutputFormat,
): boolean {
  const trimmed = content.trim();

  if (
    !trimmed ||
    trimmed.startsWith('```') ||
    trimmed.endsWith('```')
  ) {
    return false;
  }

  if (format === 'json') {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      );
    } catch {
      return false;
    }
  }

  if (format === 'xml') {
    if (/<!DOCTYPE|<!ENTITY/i.test(trimmed)) {
      return false;
    }

    try {
      const isValidSyntax = SyntaxValidator.validate(trimmed, {
        docType: {
          maxEntityCount: 0,
          maxEntitySize: 0,
        },
        invalidCharSequence: {
          attrLt: true,
          comment: true,
          tagValue: true,
        },
        multipleRoots: false,
      }) === true;

      return isValidSyntax && hasStructuredXmlRoot(trimmed);
    } catch {
      return false;
    }
  }

  try {
    const document = parseDocument(trimmed, {
      logLevel: 'error',
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    const root = document.contents;

    if (document.errors.length > 0 || !isCollection(root)) return false;

    if (isMap(root) && root.items.length === 1) {
      const rootKey = root.items[0]?.key;

      if (
        isScalar(rootKey) &&
        typeof rootKey.value === 'string' &&
        rootKey.value.trim().toLowerCase() === 'yaml'
      ) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}
