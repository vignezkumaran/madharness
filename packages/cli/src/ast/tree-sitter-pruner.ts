import { createRequire } from 'module';
import * as path from 'path';

interface TsNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  childForFieldName(name: string): TsNode | null;
  namedChildren: TsNode[];
}

interface TsLanguage {
  typescript: unknown;
  tsx: unknown;
}

interface TsParser {
  setLanguage(language: unknown): void;
  parse(source: string): { rootNode: TsNode };
}

interface Grammars {
  Parser: new () => TsParser;
  Python: unknown;
  TypeScript: TsLanguage;
}

let grammars: Grammars | null | undefined;

function loadGrammars(): Grammars | null {
  if (grammars !== undefined) return grammars;
  try {
    const require = createRequire(import.meta.url);
    grammars = {
      Parser: require('tree-sitter') as new () => TsParser,
      Python: require('tree-sitter-python'),
      TypeScript: require('tree-sitter-typescript') as TsLanguage,
    };
  } catch {
    grammars = null;
  }
  return grammars;
}

export interface TreeSitterContract {
  content: string;
  language: string;
  classes: string[];
  functions: string[];
}

function nameOf(node: TsNode): string {
  return node.childForFieldName('name')?.text ?? '';
}

function indentation(node: TsNode): string {
  return ' '.repeat(node.startPosition.column);
}

function ensureColon(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(':') || trimmed.endsWith(':')) return `${trimmed} ...`;
  return `${trimmed}: ...`;
}

function pythonSignature(node: TsNode, source: string): string {
  const body = node.childForFieldName('body');
  if (!body) return source.slice(node.startIndex, node.endIndex).trimEnd();
  const signature = source.slice(node.startIndex, body.startIndex).trimEnd();
  return ensureColon(signature);
}

function pythonDecorated(node: TsNode, source: string, classes: string[], functions: string[]): string[] {
  const indent = indentation(node);
  const lines: string[] = [];
  let definition: TsNode | null = null;

  for (const child of node.namedChildren) {
    if (child.type === 'decorator') {
      lines.push(`${indent}${child.text.trimEnd()}`);
    } else if (child.type === 'function_definition' || child.type === 'class_definition') {
      definition = child;
    }
  }

  if (!definition) return lines;
  if (definition.type === 'function_definition') {
    const name = nameOf(definition);
    if (name) functions.push(name);
    lines.push(`${indent}${pythonSignature(definition, source)}`);
  } else {
    const rendered = pythonClass(definition, source, classes, functions);
    lines.push(...rendered);
  }
  return lines;
}

function pythonClass(node: TsNode, source: string, classes: string[], functions: string[]): string[] {
  const name = nameOf(node);
  if (name) classes.push(name);

  const body = node.childForFieldName('body');
  if (!body) return [source.slice(node.startIndex, node.endIndex).trimEnd()];

  const header = source.slice(node.startIndex, body.startIndex).trimEnd();
  const lines: string[] = [header];

  for (const child of body.namedChildren) {
    if (child.type === 'function_definition') {
      const method = nameOf(child);
      if (method) functions.push(method);
      lines.push('');
      lines.push(`${indentation(child)}${pythonSignature(child, source)}`);
      continue;
    }
    if (child.type === 'decorated_definition') {
      lines.push('');
      lines.push(...pythonDecorated(child, source, classes, functions));
      continue;
    }
    if (child.type === 'expression_statement') {
      const assignment = child.namedChildren[0];
      const left = assignment?.namedChildren[0];
      const leftName = left?.text.trim() ?? '';
      const keepsConstant = /^[A-Z_][A-Z0-9_]*$/.test(leftName)
        || (assignment?.type === 'assignment' && child.text.includes(':'));
      if (keepsConstant) lines.push(`${indentation(child)}${child.text.trimEnd()}`);
    }
  }

  return lines;
}

function pythonContract(source: string, parser: TsParser, language: unknown): TreeSitterContract {
  parser.setLanguage(language);
  const root = parser.parse(source).rootNode;
  const classes: string[] = [];
  const functions: string[] = [];
  const lines: string[] = [];

  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'import_statement':
      case 'import_from_statement':
      case 'future_import_statement':
        lines.push(node.text.trimEnd());
        break;

      case 'function_definition': {
        const name = nameOf(node);
        if (name) functions.push(name);
        lines.push('');
        lines.push(pythonSignature(node, source));
        break;
      }

      case 'decorated_definition':
        lines.push('');
        lines.push(...pythonDecorated(node, source, classes, functions));
        break;

      case 'class_definition':
        lines.push('');
        lines.push(...pythonClass(node, source, classes, functions));
        break;

      case 'expression_statement': {
        const assignment = node.namedChildren[0];
        const left = assignment?.namedChildren[0];
        const leftName = left?.text.trim() ?? '';
        const keepsConstant = /^[A-Z_][A-Z0-9_]*$/.test(leftName)
          || (assignment?.type === 'assignment' && node.text.includes(':'));
        if (keepsConstant) lines.push(node.text.trimEnd());
        break;
      }

      default:
        break;
    }
  }

  return {
    content: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    language: 'python',
    classes: Array.from(new Set(classes)),
    functions: Array.from(new Set(functions)),
  };
}

function tsSignature(node: TsNode, source: string): string {
  const body = node.childForFieldName('body');
  if (!body) return source.slice(node.startIndex, node.endIndex).trimEnd();
  const signature = source.slice(node.startIndex, body.startIndex).trimEnd();
  return `${signature} { ... }`;
}

function tsClass(node: TsNode, source: string, classes: string[], functions: string[]): string[] {
  const className = nameOf(node);
  if (className) classes.push(className);

  const body = node.childForFieldName('body');
  if (!body) return [source.slice(node.startIndex, node.endIndex).trimEnd()];

  const header = source.slice(node.startIndex, body.startIndex).trimEnd();
  const lines: string[] = [`${header} {`];

  for (const member of body.namedChildren) {
    switch (member.type) {
      case 'method_definition': {
        const method = nameOf(member);
        if (method) functions.push(method);
        lines.push(`${indentation(member)}${tsSignature(member, source)}`);
        break;
      }
      case 'public_field_definition':
      case 'property_signature':
      case 'method_signature':
      case 'abstract_method_signature':
      case 'index_signature':
        lines.push(`${indentation(member)}${member.text.trimEnd()}`);
        break;
      default:
        break;
    }
  }

  lines.push('}');
  return lines;
}

function findArrow(node: TsNode): TsNode | null {
  if (node.type === 'arrow_function') return node;
  for (const child of node.namedChildren) {
    const found = findArrow(child);
    if (found) return found;
  }
  return null;
}

function tsVariable(node: TsNode, source: string, functions: string[]): string | null {
  const arrow = findArrow(node);
  if (arrow) {
    const name = node.namedChildren[0]?.namedChildren[0]?.text ?? '';
    if (name) functions.push(name);
    const body = arrow.childForFieldName('body');
    if (body) {
      const signature = source.slice(node.startIndex, body.startIndex).trimEnd();
      return `${signature} ...`;
    }
  }
  const text = node.text.trimEnd();
  return text.includes('function') || text.includes('=>') || text.length < 240 ? text : null;
}

function tsDeclaration(
  node: TsNode,
  source: string,
  classes: string[],
  functions: string[]
): string[] {
  switch (node.type) {
    case 'class_declaration':
      return tsClass(node, source, classes, functions);

    case 'function_declaration': {
      const name = nameOf(node);
      if (name) functions.push(name);
      return [tsSignature(node, source)];
    }

    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration':
    case 'ambient_declaration':
    case 'module':
      return node.text.trimEnd().split('\n');

    case 'lexical_declaration':
    case 'variable_declaration': {
      const rendered = tsVariable(node, source, functions);
      return rendered ? rendered.split('\n') : [];
    }

    default:
      return [];
  }
}

function tsContract(
  source: string,
  parser: TsParser,
  language: unknown,
  label: string
): TreeSitterContract {
  parser.setLanguage(language);
  const root = parser.parse(source).rootNode;
  const classes: string[] = [];
  const functions: string[] = [];
  const lines: string[] = [];

  for (const node of root.namedChildren) {
    if (node.type === 'import_statement' || node.type === 'import_alias') {
      lines.push(node.text.trimEnd());
      continue;
    }

    if (node.type === 'export_statement') {
      const declaration = node.namedChildren.find((child) =>
        [
          'class_declaration',
          'function_declaration',
          'interface_declaration',
          'type_alias_declaration',
          'enum_declaration',
          'lexical_declaration',
          'variable_declaration',
          'ambient_declaration',
        ].includes(child.type)
      );
      if (!declaration) {
        lines.push(node.text.trimEnd());
        continue;
      }
      const prefix = source.slice(node.startIndex, declaration.startIndex);
      const rendered = tsDeclaration(declaration, source, classes, functions);
      if (rendered.length > 0) lines.push(`${prefix}${rendered[0]}`, ...rendered.slice(1));
      continue;
    }

    const rendered = tsDeclaration(node, source, classes, functions);
    lines.push(...rendered);
  }

  return {
    content: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    language: label,
    classes: Array.from(new Set(classes)),
    functions: Array.from(new Set(functions)),
  };
}

export function treeSitterContract(
  absPath: string,
  source: string
): TreeSitterContract | null {
  const loaded = loadGrammars();
  if (!loaded) return null;

  const ext = path.extname(absPath).toLowerCase();
  const parser = new loaded.Parser();

  try {
    if (ext === '.py') {
      const contract = pythonContract(source, parser, loaded.Python);
      return contract.content.length >= 40 ? contract : null;
    }

    if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
      const contract = tsContract(source, parser, loaded.TypeScript.typescript, 'typescript');
      return contract.content.length >= 40 ? contract : null;
    }

    if (ext === '.tsx') {
      const contract = tsContract(source, parser, loaded.TypeScript.tsx, 'tsx');
      return contract.content.length >= 40 ? contract : null;
    }

    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
      const contract = tsContract(source, parser, loaded.TypeScript.tsx, ext.slice(1));
      return contract.content.length >= 40 ? contract : null;
    }
  } catch {
    return null;
  }

  return null;
}
