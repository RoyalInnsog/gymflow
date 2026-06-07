const fs = require('fs');
const babel = require('@babel/core');

const code = fs.readFileSync('./routes/api.js', 'utf8');

const plugin = function({ types: t }) {
  return {
    visitor: {
      CallExpression(path) {
        if (
          t.isIdentifier(path.node.callee, { name: 'runQuery' }) ||
          t.isIdentifier(path.node.callee, { name: 'getQuery' }) ||
          t.isIdentifier(path.node.callee, { name: 'allQuery' })
        ) {
          // If the first argument is a string or template literal
          let sqlArg = path.node.arguments[0];
          
          // Only add req if we are inside a function that has req
          // Check if we are inside a route handler
          let parentFunc = path.findParent((p) => p.isFunctionExpression() || p.isArrowFunctionExpression() || p.isFunctionDeclaration());
          
          let hasReq = false;
          if (parentFunc) {
            hasReq = parentFunc.node.params.some(param => t.isIdentifier(param, { name: 'req' }));
          }
          
          if (hasReq && path.node.arguments.length > 0 && !t.isIdentifier(path.node.arguments[0], { name: 'req' })) {
            // Unshift 'req' to the arguments
            path.node.arguments.unshift(t.identifier('req'));
          }
        }
      }
    }
  };
};

try {
  const result = babel.transformSync(code, {
    plugins: [plugin],
    retainLines: true,
    generatorOpts: {
      retainLines: true,
      compact: false
    }
  });

  fs.writeFileSync('./routes/api_updated.js', result.code);
  console.log('Successfully rewrote api.js to pass req to queries.');
} catch (e) {
  console.error(e);
}
