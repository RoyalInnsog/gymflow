const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const path = require('path');

const srcPath = path.join(__dirname, '../../p:/Projects/GYM_Flow/routes/api.js');
// The absolute path might be tricky, let's use the actual absolute path to be safe.
const targetFile = 'p:\\Projects\\GYM_Flow\\routes\\api.js';
const src = fs.readFileSync(targetFile, 'utf8');

const ast = parser.parse(src, { sourceType: 'module' });
const lines = src.split('\n');

const outDir = 'p:\\Projects\\GYM_Flow\\routes\\api';
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// We want to map namespaces to route lists
const groups = {
  members: ['/members', '/attendance', '/memberships'],
  billing: ['/finance', '/subscription', '/plans'],
  marketing: ['/marketing', '/campaigns', '/whatsapp', '/communications', '/templates'],
  settings: ['/settings', '/staff', '/roles', '/branches'],
  analytics: ['/analytics', '/dashboard', '/reports', '/retention'],
  core: ['/onboarding', '/tasks', '/activity-logs', '/notifications', '/equipment', '/backup', '/export', '/crm']
};

function getGroup(routePath) {
  const prefix = '/' + routePath.split('/')[1]; // e.g. /members/123 -> /members
  for (const [groupName, prefixes] of Object.entries(groups)) {
    if (prefixes.includes(prefix)) return groupName;
  }
  return 'misc';
}

const routesByGroup = {};
const routeNodes = [];

traverse(ast, {
  CallExpression(path) {
    if (
      path.node.callee.type === 'MemberExpression' &&
      path.node.callee.object.name === 'router' &&
      ['get', 'post', 'put', 'delete'].includes(path.node.callee.property.name)
    ) {
      // This is a router.METHOD call!
      // But we only want top-level statements. It's usually inside an ExpressionStatement.
      if (path.parentPath.node.type === 'ExpressionStatement') {
        const routeStringNode = path.node.arguments[0];
        if (routeStringNode && routeStringNode.type === 'StringLiteral') {
          const routePath = routeStringNode.value;
          const group = getGroup(routePath);
          
          const startLine = path.parentPath.node.loc.start.line - 1;
          const endLine = path.parentPath.node.loc.end.line - 1;

          routeNodes.push({ group, startLine, endLine, routePath });
        }
      }
    }
  }
});

// We need to extract the exact text for each route, including the preceding comments.
// Babel provides leadingComments on the ExpressionStatement node!
traverse(ast, {
  ExpressionStatement(path) {
    if (
      path.node.expression.type === 'CallExpression' &&
      path.node.expression.callee.type === 'MemberExpression' &&
      path.node.expression.callee.object.name === 'router'
    ) {
      // update the startLine to include leading comments
      const leadingComments = path.node.leadingComments;
      const matchingRoute = routeNodes.find(r => r.endLine === path.node.loc.end.line - 1);
      if (matchingRoute && leadingComments && leadingComments.length > 0) {
        matchingRoute.startLine = leadingComments[0].loc.start.line - 1;
      }
    }
  }
});

// Sort by start line to avoid overlaps
routeNodes.sort((a, b) => a.startLine - b.startLine);

console.log(`Found ${routeNodes.length} routes.`);

// Write out the grouped routes
for (const node of routeNodes) {
  const code = lines.slice(node.startLine, node.endLine + 1).join('\n');
  if (!routesByGroup[node.group]) routesByGroup[node.group] = [];
  routesByGroup[node.group].push(code);
}

// Generate the sub-routers
for (const [groupName, blocks] of Object.entries(routesByGroup)) {
  const content = `const express = require('express');
const router = express.Router();
const { getQuery, runQuery, allQuery } = require('../../database');
const { authorize, requireFeature, checkSubscription, getTaxConfig, computeTax, resolveRenewalDiscount, uid, nextInvoiceNumber } = require('../../lib/apiUtils');

// Temporary aliases for missing dependencies
const { PLANS, isRazorpayConfigured, createOrder, verifyPaymentSignature, fetchOrder, cancelSubscription } = require('../../lib/razorpay');
const { getTodayString, getLastNDaysString, getNextNDaysString } = require('../../lib/dateUtils');
const engine = require('../../lib/membershipEngine');
const whatsappCloud = require('../../services/whatsappCloud.service');
const waSettings = require('../../services/whatsappSettings');
const waAutomations = require('../../services/whatsappAutomations');
const { PLAN_LIMITS, PLAN_PRICES, PURCHASABLE_PLANS, resolvePlan, getPlan } = require('../../lib/billingPlans');
const billing = require('../../lib/billingState');

// ---------------------------------------------------------------------------
// Group: ${groupName}
// ---------------------------------------------------------------------------

${blocks.join('\n\n')}

module.exports = router;
`;
  fs.writeFileSync(path.join(outDir, `${groupName}.js`), content);
}

// Now we need to remove these blocks from api.js and replace them with standard middleware/router imports
// We will collect the lines that are NOT inside any route block
let remainingLines = [];
let currentLine = 0;

for (const node of routeNodes) {
  // Push everything before this route
  while (currentLine < node.startLine) {
    remainingLines.push(lines[currentLine]);
    currentLine++;
  }
  // Skip the route itself
  currentLine = node.endLine + 1;
}
// Push the rest of the file
while (currentLine < lines.length) {
  remainingLines.push(lines[currentLine]);
  currentLine++;
}

// Write the stripped api.js to a temp file so we can inspect it
fs.writeFileSync('p:\\Projects\\GYM_Flow\\routes\\api_stripped.js', remainingLines.join('\n'));

console.log('Done splitting! Extracted groups:', Object.keys(routesByGroup).join(', '));
