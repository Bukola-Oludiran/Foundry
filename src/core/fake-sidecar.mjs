import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).once("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({
    protocol_version: 1,
    id: request.id,
    result: {
      exitCode: 0,
      stdout: "structured sidecar result",
      stderr: "",
      state: { command: request.params.operation, structured: true },
    },
  })}\n`, () => process.exit(0));
});
