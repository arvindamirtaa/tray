import type OpenAI from "openai";

import { tracedOpenAI } from "./bt.js";
import { scriptedProposer } from "./scripted.js";
import type { Proposal, Proposer } from "./workflow.js";

const SYSTEM_PROMPT = `You are Tray's patch proposer. Given a failing test and source file, propose the minimal patch. Only modify calc.py. Never modify test files. The new_content argument must contain the complete replacement contents of calc.py, not a diff or patch.`;

const PROPOSE_PATCH_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "propose_patch",
    description: "Propose a complete replacement for calc.py.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          enum: ["calc.py"],
          description: "The only file that may be modified.",
        },
        new_content: {
          type: "string",
          description:
            "The complete replacement contents of calc.py. Do not return a diff.",
        },
        reason: {
          type: "string",
          description: "A concise explanation of why the replacement fixes the test.",
        },
      },
      required: ["path", "new_content", "reason"],
    },
  },
};

function requiredEnv(name: "FIREWORKS_API_KEY" | "FIREWORKS_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseProposal(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  oldContent: string,
): Proposal | undefined {
  const call = completion.choices[0]?.message.tool_calls?.find(
    (candidate) =>
      candidate.type === "function" &&
      candidate.function.name === "propose_patch",
  );
  if (!call || call.type !== "function") {
    return undefined;
  }

  try {
    const value = JSON.parse(call.function.arguments) as Partial<Proposal>;
    const newContent = value.new_content?.trim();
    if (
      value.path !== "calc.py" ||
      !newContent ||
      value.new_content === oldContent ||
      typeof value.reason !== "string" ||
      !value.reason.trim() ||
      !newContent.includes("def total") ||
      newContent.startsWith("---")
    ) {
      return undefined;
    }
    return {
      path: value.path,
      new_content: value.new_content!,
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
    `Failing unittest output:\n${context.failingOutput}`,
    `Current calc.py contents:\n${context.old_content}`,
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
        tools: [PROPOSE_PATCH_TOOL],
        tool_choice: {
          type: "function",
          function: { name: "propose_patch" },
        },
      });
      const proposal = parseProposal(completion, context.old_content);
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

