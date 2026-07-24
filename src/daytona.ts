import { Daytona, type Sandbox } from "@daytona/sdk";

const MAX_OUTPUT_BYTES = 4 * 1024;
const EXEC_TIMEOUT_SECONDS = 60;

const CALC_SOURCE = `def total(items):
    return sum(items[1:])
`;

const TEST_SOURCE = `import unittest
from calc import total

class TestTotal(unittest.TestCase):
    def test_total(self):
        self.assertEqual(total([1, 2, 3]), 6)

if __name__ == "__main__":
    unittest.main()
`;

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
  await sandbox.fs.createFolder(fixtureDir, "755");
  await sandbox.fs.uploadFile(Buffer.from(CALC_SOURCE), `${fixtureDir}/calc.py`);
  await sandbox.fs.uploadFile(
    Buffer.from(TEST_SOURCE),
    `${fixtureDir}/test_calc.py`,
  );

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

export async function readFile(sandbox: Sandbox, path: string): Promise<string> {
  return (await sandbox.fs.downloadFile(path)).toString("utf8");
}

export async function writeFile(
  sandbox: Sandbox,
  path: string,
  content: string,
): Promise<void> {
  await sandbox.fs.uploadFile(Buffer.from(content), path);
}
