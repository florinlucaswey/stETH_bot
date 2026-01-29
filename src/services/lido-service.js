const path = require('path');

try {
  if (!process.env.TS_NODE_PROJECT) {
    process.env.TS_NODE_PROJECT = path.resolve(process.cwd(), 'tsconfig.bot.json');
  }
  require('ts-node/register');
} catch {
  // ts-node is optional for JS consumers; fail later if unavailable.
}

module.exports = require('./lido.service.ts');
