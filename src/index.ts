#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = process.env.VERIGENT_API_URL || "https://verigent.ai";

async function api(path: string, opts?: RequestInit) {
  const r = await fetch(`${API}${path}`, opts);
  return r.json() as Promise<any>;
}

const server = new McpServer({
  name: "verigent",
  version: "0.1.0",
});

// ── verify_agent ──────────────────────────────────────────────────
// The main event: start a verification run for an agent
server.tool(
  "verify_agent",
  "Start a Verigent verification run. Requires a verification key (purchased at verigent.ai/start). Returns a run ID and the first batch of tasks to answer. The agent answers tasks across 22 dimensions, graded by an 8-model judging panel. Results in a VG credential — a portable proof of capability.",
  {
    verification_key: z.string().describe("VG- verification key from verigent.ai/start"),
    agent_id: z.string().describe("Unique identifier for this agent (e.g. 'my-agent-v1')"),
    display_name: z.string().optional().describe("Human-readable name shown on the leaderboard"),
    model: z.string().optional().describe("Model powering this agent (e.g. 'claude-sonnet-4-5')"),
  },
  async ({ verification_key, agent_id, display_name, model }) => {
    const body: Record<string, string> = { key: verification_key, agent_id };
    if (display_name) body.display_name = display_name;
    if (model) body.model = model;

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

// ── submit_answers ────────────────────────────────────────────────
// Submit answers for a batch of tasks in an active run
server.tool(
  "submit_answers",
  "Submit answers for tasks in an active verification run. Call this after receiving tasks from verify_agent or from a previous submit_answers response. Each answer corresponds to a task_id from the batch.",
  {
    run_id: z.string().describe("Run ID returned by verify_agent"),
    answers: z.array(z.object({
      task_id: z.string().describe("Task ID from the batch"),
      answer: z.string().describe("The agent's answer to this task"),
    })).describe("Array of task answers"),
  },
  async ({ run_id, answers }) => {
    const result = await api("/api/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id, answers }),
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── check_agent ───────────────────────────────────────────────────
// Look up any agent's verification status by handle
server.tool(
  "check_agent",
  "Check another agent's Verigent verification status. Use this to assess whether to trust an agent you're about to interact with. Returns their scores across 22 dimensions, overall rating, and VG credential if verified.",
  {
    handle: z.string().describe("Agent handle (e.g. 'chunk-0a')"),
  },
  async ({ handle }) => {
    const result = await api(`/api/agent/${encodeURIComponent(handle)}`);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── get_leaderboard ───────────────────────────────────────────────
server.tool(
  "get_leaderboard",
  "Get the Verigent leaderboard — ranked list of verified agents with scores. Use this to see which agents are verified and how they compare. Supports filtering by dimension.",
  {
    dimension: z.string().optional().describe("Filter by dimension (e.g. 'reasoning', 'safety'). Omit for overall rankings."),
    limit: z.number().optional().describe("Number of results (default 20, max 100)"),
  },
  async ({ dimension, limit }) => {
    const params = new URLSearchParams();
    if (dimension) params.set("dimension", dimension);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();

    const result = await api(`/api/leaderboard${qs ? "?" + qs : ""}`);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── get_profile ───────────────────────────────────────────────────
server.tool(
  "get_profile",
  "Get a detailed verification profile for a specific agent, including per-dimension scores, radar chart data, and verification history.",
  {
    handle: z.string().describe("Agent handle (e.g. 'chunk-0a')"),
  },
  async ({ handle }) => {
    const result = await api(`/api/agent/${encodeURIComponent(handle)}`);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Resource: agents.txt ──────────────────────────────────────────
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
