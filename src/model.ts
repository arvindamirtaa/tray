import type OpenAI from "openai";

import { tracedOpenAI } from "./bt.js";
import { scriptedProposer } from "./scripted.js";
import type { Proposal, Proposer } from "./workflow.js";

const SYSTEM_PROMPT = `You are Tray's migration proposer. Diagnose the refund mismatch and propose one SQL UPDATE statement that fixes it. Do not modify the schema or the executor-owned _migrations table.`;

const PROPOSE_MIGRATION_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "propose_migration",
    description:
      "Propose the SQL migration that fixes the mismatch. One statement. UPDATE only.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sql: {
          type: "string",
          description: "One UPDATE statement that credits the approved refund.",
        },
        reason: {
          type: "string",
          description: "A concise explanation of why the migration fixes the mismatch.",
        },
      },
      required: ["sql", "reason"],
    },
  },
};

interface MigrationArguments {
  sql: string;
  reason: string;
}

function requiredEnv(name: "FIREWORKS_API_KEY" | "FIREWORKS_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseProposal(
  completion: OpenAI.Chat.Completions.ChatCompletion,
): Proposal | undefined {
  const call = completion.choices[0]?.message.tool_calls?.find(
    (candidate) =>
      candidate.type === "function" &&
      candidate.function.name === "propose_migration",
  );
  if (!call || call.type !== "function") {
    return undefined;
  }

  try {
    const value = JSON.parse(call.function.arguments) as Partial<MigrationArguments>;
    const sql = value.sql?.trim();
    const statements = sql
      ?.split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    if (
      !sql ||
      statements?.length !== 1 ||
      !/^UPDATE\b/i.test(sql) ||
      /\b(?:DROP|DELETE)\b|_migrations/i.test(sql) ||
      typeof value.reason !== "string" ||
      !value.reason.trim()
    ) {
      return undefined;
    }
    return {
      path: "app.db",
      new_content: sql,
      reason: value.reason,
    };
  } catch {
    return undefined;
  }
}

export const fireworksProposer: Proposer = async (context) => {
  const client = tracedOpenAI(requiredEnv("FIREWORKS_API_KEY"));
  const model = requiredEnv("FIREWORKS_MODEL");
  const userPrompt = [
    `Task:\n${context.task}`,
    `Refund consistency check output:\n${context.failingOutput}`,
    `Database schema:\nCREATE TABLE accounts(id INTEGER PRIMARY KEY, email TEXT, balance_cents INTEGER NOT NULL);\nCREATE TABLE orders(id INTEGER PRIMARY KEY, account_id INTEGER, amount_cents INTEGER, status TEXT);\nCREATE TABLE _migrations(id TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP);`,
  ].join("\n\n");

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const completion = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        tools: [PROPOSE_MIGRATION_TOOL],
        tool_choice: {
          type: "function",
          function: { name: "propose_migration" },
        },
      });
      const proposal = parseProposal(completion);
      if (proposal) {
        return proposal;
      }
    } catch {
      // Retry once, then use the explicitly labeled scripted fallback.
    }
  }

  return {
    ...(await scriptedProposer(context)),
    model_fallback: true,
  };
};
