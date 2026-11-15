import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const refuse = condition => { if (!condition) throw new Error('private runtime configuration differs'); };

function inspectRuntime(files) {
  const modules = Object.keys(files).filter(name => /^_app\/immutable\/bor-build-configuration-[a-f0-9]{16}\.js$/.test(name));
  refuse(modules.length === 1);
  const module = modules[0];
  const source = files[module];
  const encoded = /^export const buildConfiguration = (.+);\n$/.exec(source);
  refuse(encoded && module.endsWith(createHash('sha256').update(source).digest('hex').slice(0, 16) + '.js'));
  const configuration = JSON.parse(encoded[1]);
  refuse(configuration && typeof configuration === 'object' && !Array.isArray(configuration)
    && Object.keys(configuration).sort().join(',') === 'apiOrigin,demoTestRecipient,mode'
    && Object.values(configuration).every(value => typeof value === 'string'));
  const resolve = (importer, value) => value.startsWith('/') ? value.slice(1)
    : value.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(importer), value)) : undefined;
  const pending = [];
  const inline = new Map();
  for (const [index, script] of [...(files['index.html'] ?? '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(script[1]);
    if (src) { const resolved = resolve('index.html', src[1]); if (resolved) pending.push(resolved); }
    else if (!/\btype\s*=/i.test(script[1]) || /\btype\s*=\s*["'](?:module|text\/javascript)["']/i.test(script[1])) {
      const name = `index.html#${index}`;
      inline.set(name, script[2]); pending.push(name);
    }
  }
  const visited = new Set();
  const syntaxes = new Map();
  const imported = new Map();
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const code = files[name] ?? inline.get(name);
    refuse(typeof code === 'string');
    const syntax = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    refuse(syntax.parseDiagnostics.length === 0);
    syntaxes.set(name, syntax);
    const dependency = value => {
      const resolved = resolve(name, value);
      if (resolved) pending.push(resolved);
      return resolved;
    };
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = dependency(node.moduleSpecifier.text);
        if (target && ts.isImportDeclaration(node)) {
          const bindings = node.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            const names = imported.get(target) ?? new Set();
            for (const binding of bindings.elements) names.add((binding.propertyName ?? binding.name).text);
            imported.set(target, names);
          }
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) dependency(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(syntax);
  }
  refuse(visited.has(module));
  const consumer = prefix => {
    const names = [...visited].filter(name => new RegExp(`^_app/immutable/chunks/${prefix}\\.[A-Za-z0-9_-]+\\.js$`).test(name));
    refuse(names.length === 1);
    const name = names[0], syntax = syntaxes.get(name);
    const locals = new Map(), exports = new Map();
    let alias;
    for (const node of syntax.statements) {
      if (ts.isFunctionDeclaration(node) && node.name) locals.set(node.name.text, node);
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) locals.set(declaration.name.text, declaration);
        }
      }
      if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const item of node.exportClause.elements) exports.set(item.name.text, (item.propertyName ?? item.name).text);
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && resolve(name, node.moduleSpecifier.text) === module) {
        const bindings = node.importClause?.namedBindings;
        refuse(bindings && ts.isNamedImports(bindings));
        const matches = bindings.elements.filter(item => (item.propertyName ?? item.name).text === 'buildConfiguration');
        refuse(matches.length === 1 && !alias); alias = matches[0].name.text;
      }
    }
    refuse(alias);
    const exported = name => locals.get(exports.get(name));
    const used = name => imported.get(names[0])?.has(name) === true;
    return { locals, exported, used, alias };
  };
  const identifier = (node, name) => !!node && ts.isIdentifier(node) && node.text === name;
  const field = (node, alias, property) => !!node && ts.isPropertyAccessExpression(node)
    && identifier(node.expression, alias) && node.name.text === property;
  const returned = fn => {
    refuse(fn && ts.isFunctionDeclaration(fn) && fn.parameters.length === 1
      && ts.isIdentifier(fn.parameters[0].name) && fn.body?.statements.length === 1
      && ts.isReturnStatement(fn.body.statements[0]));
    return { parameter: fn.parameters[0].name.text, value: fn.body.statements[0].expression };
  };
  const api = consumer('bor-api-url');
  refuse(api.used('apiUrl') && api.used('apiFetch'));
  const url = returned(api.exported('apiUrl'));
  refuse(url.value && ts.isTemplateExpression(url.value) && url.value.head.text === ''
    && url.value.templateSpans.length === 2 && url.value.templateSpans.every(span => span.literal.text === '')
    && identifier(url.value.templateSpans[1].expression, url.parameter));
  const origin = url.value.templateSpans[0].expression;
  refuse(ts.isIdentifier(origin) && origin.text !== url.parameter
    && field(api.locals.get(origin.text)?.initializer, api.alias, 'apiOrigin'));
  const handoff = consumer('bor-demo-handoff');
  refuse(handoff.used('handoffRecipient') && handoff.used('demoTestRecipient'));
  const destination = returned(handoff.exported('handoffRecipient'));
  refuse(destination.value && ts.isBinaryExpression(destination.value)
    && destination.value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    && identifier(destination.value.right, destination.parameter) && ts.isIdentifier(destination.value.left)
    && destination.value.left.text !== destination.parameter);
  const recipient = handoff.exported('demoTestRecipient');
  refuse(recipient && ts.isVariableDeclaration(recipient) && identifier(recipient.name, destination.value.left.text));
  const initializer = recipient.initializer;
  refuse(initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)
    && initializer.arguments.length === 2 && field(initializer.arguments[0], handoff.alias, 'mode')
    && field(initializer.arguments[1], handoff.alias, 'demoTestRecipient'));
  const validator = handoff.locals.get(initializer.expression.text);
  refuse(validator && ts.isFunctionDeclaration(validator) && validator.parameters.length === 2
    && ts.isIdentifier(validator.parameters[1].name));
  const final = validator.body?.statements.at(-1);
  refuse(final && ts.isReturnStatement(final) && identifier(final.expression, validator.parameters[1].name.text));
  return configuration;
}

try { console.log(JSON.stringify(inspectRuntime(JSON.parse(readFileSync(0, 'utf8'))))); }
catch { console.error('Private runtime inspection refused.'); process.exitCode = 1; }
