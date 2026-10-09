import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export const configurationPath = new URL("../kong/kong.yml", import.meta.url);

export async function loadConfiguration() {
  return parse(await readFile(configurationPath, "utf8"));
}

export function validateConfiguration(configuration) {
  const errors = [];
  if (configuration?._format_version !== "3.0")
    errors.push("Kong declarative format must be 3.0");

  const services = configuration?.services ?? [];
  // Origins are private hostnames: the parc-edge network locally, --add-host to loopback on the VPS.
  const expected = new Map([
    [
      "parc-mobile-bff",
      { path: "/mobile", url: "http://parc-mobile-bff:3010" },
    ],
    ["parc-admin-bff", { path: "/admin", url: "http://parc-admin-bff:3020" }],
  ]);
  if (services.length !== expected.size)
    errors.push("Exactly the Mobile and Admin BFF services must be public");
  for (const service of services) {
    const expectedPath = expected.get(service.name)?.path;
    if (!expectedPath)
      errors.push(`Forbidden public upstream: ${service.name}`);
    else if (service.url !== expected.get(service.name).url)
      errors.push(`${service.name} must use its private DNS origin`);
    for (const route of service.routes ?? []) {
      if (route.strip_path !== true)
        errors.push(`${route.name} must strip its public BFF prefix`);
      if ((route.paths ?? []).length !== 1 || route.paths[0] !== expectedPath)
        errors.push(`${route.name} has an unexpected public path`);
    }
  }

  const plugins = new Map(
    (configuration?.plugins ?? []).map((plugin) => [plugin.name, plugin]),
  );
  for (const required of [
    "correlation-id",
    "request-transformer",
    "request-size-limiting",
    "rate-limiting",
    "response-transformer",
    "prometheus",
  ])
    if (!plugins.has(required)) errors.push(`Missing edge plugin: ${required}`);
  if (plugins.get("rate-limiting")?.config?.policy !== "local")
    errors.push("DB-less rate limiting must use local policy");

  const removedHeaders = new Set(
    plugins.get("request-transformer")?.config?.remove?.headers ?? [],
  );
  for (const header of [
    "X-Consumer-ID",
    "X-Consumer-Custom-ID",
    "X-Consumer-Username",
    "X-Credential-Identifier",
    "X-Anonymous-Consumer",
  ])
    if (!removedHeaders.has(header))
      errors.push(`Spoofable Kong identity header is not removed: ${header}`);

  return errors;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const errors = validateConfiguration(await loadConfiguration());
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else console.log("Kong route and security invariants are valid.");
}
