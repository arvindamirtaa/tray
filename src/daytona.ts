import { Daytona, type Sandbox } from "@daytona/sdk";
import { readFile as readLocalFile } from "node:fs/promises";

const MAX_OUTPUT_BYTES = 4 * 1024;
const EXEC_TIMEOUT_SECONDS = 60;

const FIXTURE_FILES = ["seed.py", "check.py", "apply.py"] as const;

export interface CreatedSandbox {
  sandbox: Sandbox;
  sandboxId: string;
  fixtureDir: string;
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

function requiredApiKey(): string {
  const apiKey = process.env.DAYTONA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("DAYTONA_API_KEY is required");
  }
  return apiKey;
}

export function createDaytonaClient(): Daytona {
  return new Daytona({ apiKey: requiredApiKey() });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateOutput(output: string): string {
  const bytes = Buffer.from(output);
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) {
    return output;
  }
  const prefix = Buffer.from("[output truncated]\n");
  const retainedBytes = MAX_OUTPUT_BYTES - prefix.byteLength;
  return Buffer.concat([
    prefix,
    bytes.subarray(bytes.byteLength - retainedBytes),
  ]).toString("utf8");
}

export async function createSandbox(): Promise<CreatedSandbox> {
  const daytona = createDaytonaClient();
  const sandbox = await daytona.create(
    {
      language: "python",
      autoStopInterval: 0,
      autoPauseInterval: 0,
    },
    { timeout: 120 },
  );

  const home = await sandbox.getUserHomeDir();
  if (!home) {
    throw new Error(`Daytona sandbox ${sandbox.id} did not report a home directory`);
  }

  const fixtureDir = `${home}/fixture`;
  try {
    await sandbox.fs.createFolder(fixtureDir, "755");
    for (const filename of FIXTURE_FILES) {
      const content = await readLocalFile(
        new URL(`../fixture/${filename}`, import.meta.url),
      );
      await sandbox.fs.uploadFile(content, `${fixtureDir}/${filename}`);
    }
    const seeded = await exec(sandbox, "python seed.py 2>&1", fixtureDir);
    if (seeded.exitCode !== 0) {
      throw new Error(`failed to seed refund fixture: ${seeded.output}`);
    }
  } catch (error) {
    await deleteSandboxQuietly(sandbox);
    throw error;
  }

  return { sandbox, sandboxId: sandbox.id, fixtureDir };
}

export async function getSandbox(sandboxId: string): Promise<Sandbox> {
  if (!sandboxId.trim()) {
    throw new Error("sandboxId must not be empty");
  }
  return createDaytonaClient().get(sandboxId);
}

export async function deleteSandboxQuietly(
  sandboxOrId: Sandbox | string,
): Promise<void> {
  const sandboxId = typeof sandboxOrId === "string" ? sandboxOrId : sandboxOrId.id;
  try {
    const sandbox = typeof sandboxOrId === "string"
      ? await getSandbox(sandboxOrId)
      : sandboxOrId;
    await sandbox.delete();
    console.log(`Deleted Daytona sandbox ${sandboxId}`);
  } catch (error) {
    console.warn(
      `Could not delete Daytona sandbox ${sandboxId}: ${errorMessage(error)}`,
    );
  }
}

export async function exec(
  sandbox: Sandbox,
  cmd: string,
  cwd?: string,
): Promise<ExecResult> {
  const response = await sandbox.process.executeCommand(
    cmd,
    cwd,
    undefined,
    EXEC_TIMEOUT_SECONDS,
  );
  return {
    exitCode: response.exitCode,
    output: truncateOutput(response.result ?? response.artifacts?.stdout ?? ""),
  };
}
