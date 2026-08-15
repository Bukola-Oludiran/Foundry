import { createInterface } from "node:readline";

let activeRequest;
let matchedCancellation = false;

const reply = (response) => process.stdout.write(`${JSON.stringify({ protocol_version: 1, ...response })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "cancel_execution") {
    matchedCancellation = request.params.request_id === activeRequest;
    reply({ id: request.id, result: { cancelled: matchedCancellation } });
    return;
  }
  if (request.params.operation === "build") {
    activeRequest = request.id;
    return;
  }
  reply({
    id: request.id,
    result: {
      exitCode: 0,
      stdout: "cancellation probe",
      stderr: "",
      state: { command: request.params.operation, matchedCancellation },
    },
  });
});
