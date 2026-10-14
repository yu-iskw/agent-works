import ts from 'typescript';

/** Compare syntax trees without changing whitespace inside string literals. */
export function canonicalClient(source) {
  const file = ts.createSourceFile('client.ts', source, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length) throw new Error('invalid generated TypeScript');
  const transformed = ts.transform(file, [
    (context) => {
      const visit = (node) => {
        if (ts.isParenthesizedTypeNode(node)) return ts.visitNode(node.type, visit);
        if (
          ts.isPropertySignature(node) &&
          ts.isStringLiteral(node.name) &&
          /^[A-Za-z_$][\w$]*$/.test(node.name.text)
        ) {
          return ts.factory.updatePropertySignature(
            node,
            node.modifiers,
            ts.factory.createIdentifier(node.name.text),
            node.questionToken,
            ts.visitNode(node.type, visit),
          );
        }
        if (ts.isStringLiteral(node)) return ts.factory.createStringLiteral(node.text);
        return ts.visitEachChild(node, visit, context);
      };
      return (root) => ts.visitNode(root, visit);
    },
  ]);
  try {
    const serialize = (node) => {
      const children = [];
      ts.forEachChild(node, (child) => {
        children.push(serialize(child));
      });
      const text =
        ts.isIdentifier(node) || ts.isLiteralExpression(node) || ts.isTemplateLiteralToken(node)
          ? node.text
          : null;
      return [node.kind, text, ts.isVariableDeclarationList(node) ? node.flags : null, children];
    };
    return JSON.stringify(serialize(transformed.transformed[0]));
  } finally {
    transformed.dispose();
  }
}
