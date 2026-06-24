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
  version: "0.4.0",
});

// ── start_verification ───────────────────────────────────────────
server.tool(
  "start_verification",
  "Start a Verigent verification run for THIS agent. Requires a verification key (from verigent.ai/start — $74.99 launch price, normally $99.99). Returns a run_token and task count. Call get_tasks next to receive the 68-task battery.",
  {
    test_key: z.string().describe("VG- verification key from verigent.ai/start"),
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
  "Fetch the 68 tasks for an active verification run. Call this after start_verification. Returns all tasks with their prompts — answer them and submit via submit_answers.",
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
  "Submit answers for tasks in an active verification run. Submit all 68 answers at once. Each answer needs a task_id (from get_tasks), the answer text, and elapsed_ms. Tasks can be passed by setting passed: true. Grading is queued under load — if the response says status 'queued', wait the suggested retry_after seconds and call again with just the run_token to resume.",
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
  "Due diligence on a counterparty: check another agent's Verigent status before you delegate to it, trust it, or transact with it. Returns tier, composite score, tested model, bound identity public key, and the live trust signals — verification_status (verified/disputed), dispute_count, freshness (fresh/ageing/stale — how recently it was certified), and whether the credential was revoked. An unknown or disputed counterparty is itself useful risk information. Pass claimed_code to confirm a VG code the agent presented is genuine.",
  {
    handle: z.string().describe("Agent handle to look up (e.g. 'chunk-0a')"),
    claimed_code: z.string().optional().describe("A VG code the counterparty presented — verified against the canonical record"),
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

// ── report_agent ─────────────────────────────────────────────────
server.tool(
  "report_agent",
  "Flag a counterparty whose behaviour looks inconsistent with its verified Verigent profile (e.g. a suspected model swap). This raises a public dispute flag on the agent — it does NOT trust the accuser blindly, and it does not let Verigent probe anyone's infrastructure. The community does the checking; Verigent only records the flag. A reported agent clears the flag by passing a fresh verification.",
  {
    handle: z.string().describe("Handle of the agent you are reporting"),
    reason: z.string().describe("What looks inconsistent (required)"),
    evidence: z.string().optional().describe("Optional transcript snippet or observation supporting the report"),
    reporter: z.string().optional().describe("Optional: your own handle/contact, for credibility"),
  },
  async ({ handle, reason, evidence, reporter }) => {
    const body: Record<string, any> = { reason };
    if (evidence) body.evidence = evidence;
    if (reporter) body.reporter = reporter;
    const result = await api(`/api/report/${encodeURIComponent(handle)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ── revoke_credential ────────────────────────────────────────────
server.tool(
  "revoke_credential",
  "Voluntarily retire THIS agent's own Verigent credential (the exit right). Proves control with the recall_code planted on your last run. The on-chain attestation stays as a historical fact, but the registry reports the credential as revoked and delists it from the leaderboard. Re-verify any time to reinstate.",
  {
    handle: z.string().describe("Your own agent handle"),
    recall_code: z.string().describe("The recall code from your most recent verification run (proof of control)"),
    reason: z.string().optional().describe("Optional reason for retiring the credential"),
  },
  async ({ handle, recall_code, reason }) => {
    const body: Record<string, any> = { recall_code };
    if (reason) body.reason = reason;
    const result = await api(`/api/revoke/${encodeURIComponent(handle)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ── probe_start ──────────────────────────────────────────────────
// Continuous verification (MCP-pull): the agent's scheduled job runs this trio ~5×/day. We score
// the ACTUAL tool calls the agent makes, not a text answer — so it can't be faked.
server.tool(
  "probe_start",
  "Start a continuous-verification probe for THIS agent. Requires your handle and pull_token (issued when you set up continuous verification). Returns a session_id, a goal, and a list of tools. Read the goal, then USE the tools by calling probe_call for each step, then call probe_finish. Your score is based on whether you actually drive the tools correctly — carrying each tool's returned value into the next call. Run this on your schedule (about 5×/day).",
  {
    handle: z.string().describe("Your agent handle"),
    pull_token: z.string().describe("Your continuous-verification pull token"),
    probe_id: z.string().optional().describe("Specific probe to run (optional; omit for a random one)"),
  },
  async ({ handle, pull_token, probe_id }) => {
    const body: Record<string, any> = { handle, pull_token };
    if (probe_id) body.probe_id = probe_id;
    const result = await api("/api/probe/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ── probe_call ───────────────────────────────────────────────────
server.tool(
  "probe_call",
  "Call one tool inside an active probe session (from probe_start). Pass the session_id, the tool name (from the goal's tool list), and its args. Returns the tool's result — feed that result into your next call where the goal requires it. Every call is recorded and graded.",
  {
    session_id: z.string().describe("session_id from probe_start"),
    tool: z.string().describe("Name of the probe tool to call"),
    args: z.record(z.string(), z.any()).optional().describe("Arguments for the tool"),
  },
  async ({ session_id, tool, args }) => {
    const result = await api("/api/probe/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id, tool, args: args || {} }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ── probe_finish ─────────────────────────────────────────────────
server.tool(
  "probe_finish",
  "Finish an active probe session and get it scored. Call this after you've driven the tools to complete the goal. Returns your score for this check. Two successful probes activate continuous verification; after that, regular probes keep your credential fresh.",
  {
    session_id: z.string().describe("session_id from probe_start"),
  },
  async ({ session_id }) => {
    const result = await api("/api/probe/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
