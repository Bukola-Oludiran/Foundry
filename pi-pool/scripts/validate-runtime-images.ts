import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const runtime = resolve("runtime");
const lock = JSON.parse(
  readFileSync(resolve(runtime, "images/images.lock.json"), "utf8"),
) as {
  lock_version: number;
  images: Record<string, string>;
  targets: Record<string, string>;
};
let failures = 0;
const check = (condition: unknown, label: string) => {
  console.log(`${condition ? "OK " : "BAD"} ${label}`);
  if (!condition) failures++;
};

check(lock.lock_version === 1, "uses a versioned runtime image lock");
check(
  Object.values(lock.images).every((image) =>
    /^[^\s]+@sha256:[a-f0-9]{64}$/.test(image),
  ),
  "pins every runtime base image by SHA-256",
);
for (const [target, relativePath] of Object.entries(lock.targets)) {
  const dockerfile = readFileSync(resolve("..", relativePath), "utf8");
  check(
    [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].every((match) =>
      Object.values(lock.images).includes(match[1] ?? ""),
    ),
    `${target} uses only locked base images`,
  );
  check(
    !/\b(latest|privileged)\b/i.test(dockerfile),
    `${target} has no floating or privileged mode`,
  );
}
const compose = readFileSync(
  resolve(runtime, "docker-compose.controller.yml"),
  "utf8",
);
check(
  /internal:\s*true/.test(compose),
  "keeps the controller control network internal",
);
check(
  !/\bports:/.test(compose),
  "publishes no controller host ports by default",
);
check(
  /cap_drop:\s*\[ALL\]/.test(compose),
  "drops controller container capabilities",
);
check(
  /FOUNDRY_DOCKER_GID:\?/.test(compose) &&
    /no-new-privileges:true/.test(compose),
  "requires explicit socket-group authority and no-new-privileges",
);

if (failures) process.exit(1);
