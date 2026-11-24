import type { AgentKind } from "../../shared/contracts";
import type { AgentContext, HookTransport } from "./types";
import { assertSafeTransport } from "./context";
import { shellQuote } from "./json-hooks";

function renderTransport(transport: HookTransport): string {
  assertSafeTransport(transport);
  return `
const transport = ${JSON.stringify(transport)};
const http = await import('node:http');

function postJson(payload, timeoutMs = 750) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const target = transport.type === 'http'
      ? {
          hostname: new URL(transport.url).hostname,
          port: new URL(transport.url).port || 80,
          path: new URL(transport.url).pathname + new URL(transport.url).search,
        }
      : { socketPath: transport.socketPath, path: '/v1/agent-events' };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const request = http.request({
      ...target,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        connection: 'close',
      },
      agent: false,
    }, (response) => {
      response.resume();
      response.on('end', finish);
      response.on('error', finish);
    });
    request.on('error', finish);
    request.setTimeout(timeoutMs, () => request.destroy());
    request.end(body);
  });
}
`;
}

export function renderForwarderScript(transport: HookTransport): string {
  return `#!/usr/bin/env node
${renderTransport(transport)}
const agent = process.argv[2];
const allowedAgents = new Set(['kimi-code', 'chatgpt-codex', 'claude-code']);
let input = '';
let oversized = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (input.length + chunk.length > 8 * 1024 * 1024) {
    oversized = true;
    input = '';
    return;
  }
  if (!oversized) input += chunk;
});
process.stdin.on('end', async () => {
  if (oversized || !allowedAgents.has(agent)) return;
  try {
    const payload = JSON.parse(input);
    await postJson({
      source: 'confuse-agent-hook',
      agent,
      sentAt: new Date().toISOString(),
      payload,
    });
  } catch {
    // Observability must never block the Agent lifecycle.
  }
});
`;
}

export function renderDshTransport(transport: HookTransport): string {
  return renderTransport(transport);
}

export function hookCommand(
  context: AgentContext,
  scriptPath: string,
  kind: AgentKind,
): string {
  return `${shellQuote(context.nodePath)} ${shellQuote(scriptPath)} ${shellQuote(kind)}`;
}
