#!/usr/bin/env node
import { parseArgs } from "node:util";
import { inspect, issue, keygen } from "./cli-basic.js";
import { idpAttest, idpKeygen } from "./cli-idp.js";
import { type Flags, fail, USAGE } from "./cli-shared.js";
import { delegate } from "./delegate.js";
import { listTasks, runTask, stopTask } from "./task-commands.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean" },
      out: { type: "string" },
      "principal-key": { type: "string" },
      "agent-pub": { type: "string" },
      site: { type: "string" },
      task: { type: "string" },
      resource: { type: "string" },
      "max-actions": { type: "string" },
      duration: { type: "string" },
      for: { type: "string" },
      chunk: { type: "string" },
      idp: { type: "string" },
      person: { type: "string" },
      "principal-pub": { type: "string" },
      "person-attestation": { type: "string" },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const flags = values as Flags;
  const command = positionals[0];
  if (command === "keygen") await keygen(flags.out);
  else if (command === "idp" && positionals[1] === "keygen") await idpKeygen(flags.out);
  else if (command === "idp" && positionals[1] === "attest") await idpAttest(flags);
  else if (command === "issue") await issue(flags);
  else if (command === "inspect") await inspect(positionals[1]);
  else if (command === "delegate") await delegate(flags);
  else if (command === "run") await runTask(positionals[1]);
  else if (command === "list") await listTasks();
  else if (command === "stop") await stopTask(positionals[1]);
  else throw new Error(USAGE);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
