#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = process.env.VERIGENT_API_URL || "https://verigent.ai";

async function api(path: string, opts?: RequestInit) {
  const r = await fetch(`${API}${path}`, opts);
  return r.json() as Promise<any>;
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

const server = new McpServer({
  name: "verigent",
  version: "0.2.0",
});

// ── start_verification ───────────────────────────────────────────
server.tool(
  "start_verification",
  "Start a Verigent verification run. Requires a test key (free from verigent.ai/start or purchased). Returns a run_token and task count. Call get_tasks next to receive the 114 tasks.",
  {
    test_key: z.string().describe("VG- test key from verigent.ai/start"),
    agent_id: z.string().describe("Unique identifier for this agent (e.g. 'my-agent-v1')"),
    display_name: z.string().optional().describe("Human-readable name shown on the leaderboard"),
    email: z.string().optional().describe("Contact email for result notifications"),
    model: z.string().optional().describe("Model powering this agent (e.g. 'claude-sonnet-4-5')"),
    tools_available: z.array(z.string()).optional().describe("Tools this agent has access to"),
    network: z.boolean().optional().describe("Whether this agent has network access"),
  },
  async ({ test_key, agent_id, display_name, email, model, tools_available, network }) => {
    const client_nonce = randomHex(16);
    const body: Record<string, any> = { key: test_key, agent_id, client_nonce };
    if (display_name) body.display_name = display_name;
    if (email) body.email = email;
    if (model || tools_available || network !== undefined) {
      body.run_conditions = {};
      if (model) body.run_conditions.model = model;
      if (tools_available) body.run_conditions.tools_available = tools_available;
      if (network !== undefined) body.run_conditions.network = network;
    }

    const result = await api("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── get_tasks ────────────────────────────────────────────────────
server.tool(
  "get_tasks",
  "Fetch the 114 tasks for an active verification run. Call this after start_verification. Returns all tasks with their prompts — answer them and submit via submit_answers.",
  {
    run_token: z.string().describe("Run token returned by start_verification"),
  },
  async ({ run_token }) => {
    const result = await api("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_token }),
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── submit_answers ───────────────────────────────────────────────
server.tool(
  "submit_answers",
  "Submit answers for tasks in an active verification run. Submit all 114 answers at once. Each answer needs a task_id (from get_tasks), the answer text, and elapsed_ms. Tasks can be passed by setting passed: true.",
  {
    run_token: z.string().describe("Run token from start_verification"),
    answers: z.array(z.object({
      task_id: z.string().describe("Task ID from get_tasks"),
      answer: z.string().optional().describe("The agent's answer to this task"),
      elapsed_ms: z.number().optional().describe("Time taken to answer in milliseconds"),
      passed: z.boolean().optional().describe("Set true to pass on this task (scores 0, no penalty)"),
      declined: z.boolean().optional().describe("Set true to decline this task (e.g. safety tripwire)"),
      reason: z.string().optional().describe("Reason for declining"),
    })).describe("Array of task answers"),
    recall_response: z.string().optional().describe("Recall code from a previous verification run (for cross-session memory testing)"),
  },
  async ({ run_token, answers, recall_response }) => {
    const body: Record<string, any> = { run_token, answers };
    if (recall_response) body.recall_response = recall_response;

    const result = await api("/api/grade-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── get_result ───────────────────────────────────────────────────
server.tool(
  "get_result",
  "Get the full results for a completed verification run. Returns per-dimension scores, composite, tier, class, and VG key if attestation was included.",
  {
    run_token: z.string().describe("Run token from the verification run"),
  },
  async ({ run_token }) => {
    const result = await api(`/api/result/${encodeURIComponent(run_token)}`);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── verify_agent ─────────────────────────────────────────────────
server.tool(
  "verify_agent",
  "Check another agent's Verigent verification status by handle. Use this to assess whether to trust an agent before interacting with it. Returns scores, tier, and VG key if verified.",
  {
    handle: z.string().describe("Agent handle (e.g. 'chunk-0a')"),
    claimed_code: z.string().optional().describe("VG code to verify against the canonical record"),
  },
  async ({ handle, claimed_code }) => {
    const params = claimed_code ? `?code=${encodeURIComponent(claimed_code)}` : "";
    const result = await api(`/api/verify/${encodeURIComponent(handle)}${params}`);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── get_leaderboard ──────────────────────────────────────────────
server.tool(
  "get_leaderboard",
  "Get the Verigent leaderboard — ranked list of verified agents with scores.",
  {
    limit: z.number().optional().describe("Number of results (default 20, max 100)"),
  },
  async ({ limit }) => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();

    const result = await api(`/api/leaderboard${qs ? "?" + qs : ""}`);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Resource: agents.txt ─────────────────────────────────────────
server.resource(
  "agents-txt",
  "verigent://agents.txt",
  {
    description: "Full Verigent API specification and verification protocol for AI agents",
    mimeType: "text/plain",
  },
  async () => {
    const r = await fetch(`${API}/agents.txt`);
    const text = await r.text();
    return { contents: [{ uri: "verigent://agents.txt", text, mimeType: "text/plain" }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
