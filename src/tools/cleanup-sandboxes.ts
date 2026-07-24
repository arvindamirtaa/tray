import { createDaytonaClient } from "../daytona.js";

async function main(): Promise<void> {
  const daytona = createDaytonaClient();
  let deleted = 0;

  for await (const sandbox of daytona.list()) {
    console.log(`Deleting Daytona sandbox ${sandbox.id}`);
    await daytona.delete(sandbox);
    deleted += 1;
  }

  console.log(`Deleted ${deleted} Daytona sandbox${deleted === 1 ? "" : "es"}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
