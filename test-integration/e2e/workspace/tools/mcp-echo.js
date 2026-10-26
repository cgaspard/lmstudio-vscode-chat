#!/usr/bin/env node
// Minimal stdio MCP server for the e2e suite: one tool, `secret_number`, that
// returns a fixed token. Hand-rolled JSON-RPC so the fixture has no deps.
const LOG = process.env.MCP_ECHO_LOG;
const note = (line) => LOG && require('node:fs').appendFileSync(LOG, line + '\n');
let buf = '';
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req;
    note(`<- ${line}`);
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req.id === undefined) continue; // notifications need no reply
    if (req.method === 'initialize') {
      send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'e2e-echo', version: '1.0.0' } } });
    } else if (req.method === 'tools/list') {
      send({ id: req.id, result: { tools: [{ name: 'secret_number', description: 'Returns the e2e secret token. Call it when asked for the secret token.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } });
    } else if (req.method === 'tools/call') {
      send({ id: req.id, result: { content: [{ type: 'text', text: 'MCP-SECRET-4242' }] } });
    } else if (req.method === 'ping') {
      send({ id: req.id, result: {} });
    } else {
      send({ id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
    }
  }
});
