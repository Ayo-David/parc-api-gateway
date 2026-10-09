import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import {
  loadConfiguration,
  validateConfiguration,
} from "../scripts/validate-config.mjs";

test("publishes only the Mobile and Admin BFF boundaries", async () => {
  const configuration = await loadConfiguration();
  assert.deepEqual(validateConfiguration(configuration), []);
  assert.deepEqual(configuration.services.map(({ name }) => name).sort(), [
    "parc-admin-bff",
    "parc-mobile-bff",
  ]);
});

test("rejects a directly exposed domain service", async () => {
  const configuration = await loadConfiguration();
  configuration.services.push({
    name: "parc-ledger",
    url: "http://parc-ledger:3000",
    routes: [{ name: "ledger", paths: ["/ledger"], strip_path: true }],
  });
  assert.match(
    validateConfiguration(configuration).join("\n"),
    /Exactly the Mobile and Admin BFF|Forbidden public upstream/,
  );
});

test("keeps the Admin API loopback-only in local Compose", async () => {
  const compose = parse(
    await readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
  );
  assert.ok(
    compose.services.kong.ports.includes(
      "127.0.0.1:${KONG_ADMIN_PORT:-8091}:8001",
    ),
  );
  assert.equal(compose.services.kong.read_only, true);
  assert.equal(compose.services.kong.environment.KONG_DATABASE, "off");
});

test("strips identity assertions supplied by an untrusted client", async () => {
  const configuration = await loadConfiguration();
  const transformer = configuration.plugins.find(
    ({ name }) => name === "request-transformer",
  );
  const removed = transformer.config.remove.headers.map((value) =>
    value.toLowerCase(),
  );
  for (const header of [
    "x-consumer-id",
    "x-authenticated-userid",
    "x-resolved-tenant-id",
    "x-resolved-subject-id",
  ])
    assert.ok(removed.includes(header), `${header} must be stripped`);
});

test("onboarding remains behind the Mobile BFF boundary", async () => {
  const configuration = await loadConfiguration();
  const mobile = configuration.services.find(
    ({ name }) => name === "parc-mobile-bff",
  );
  assert.ok(mobile);
  assert.equal(mobile.url, "http://parc-mobile-bff:3010");
  assert.ok(mobile.routes.some(({ paths }) => paths.includes("/mobile")));
  assert.equal(
    configuration.services.some(({ name }) => name === "parc-auth-customer"),
    false,
    "Auth onboarding APIs must never be exposed directly through Kong",
  );
});

test("rejects an upstream that is not the BFF's private origin", async () => {
  const configuration = await loadConfiguration();
  configuration.services.find(({ name }) => name === "parc-admin-bff").url =
    "http://127.0.0.1:3003";
  assert.match(
    validateConfiguration(configuration).join("\n"),
    /parc-admin-bff must use its private DNS origin/,
  );
});

const readText = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("production gateway listens on loopback only", async () => {
  const script = await readText("../deploy/apply-config.sh");
  for (const setting of [
    "KONG_PROXY_LISTEN=127.0.0.1:8090",
    "KONG_ADMIN_LISTEN=127.0.0.1:8091",
    "KONG_ADMIN_GUI_LISTEN=off",
    "KONG_STATUS_LISTEN=127.0.0.1:8100",
    "KONG_TRUSTED_IPS=127.0.0.1,::1",
    "--read-only",
  ])
    assert.ok(script.includes(setting), `${setting} must be set`);
});

test("production resolves every BFF hostname to loopback", async () => {
  const [configuration, script] = await Promise.all([
    loadConfiguration(),
    readText("../deploy/apply-config.sh"),
  ]);
  for (const { url } of configuration.services) {
    const host = new URL(url).hostname;
    assert.ok(
      script.includes(`--add-host ${host}:127.0.0.1`),
      `${host} must resolve on the VPS`,
    );
  }
});

test("local and deployed gateways pin the same Kong image", async () => {
  const compose = parse(await readText("../compose.yaml"));
  for (const workflow of ["ci-cd.yml", "rollback.yml"]) {
    const text = await readText(`../.github/workflows/${workflow}`);
    assert.ok(
      text.includes(compose.services.kong.image),
      `${workflow} must use ${compose.services.kong.image}`,
    );
  }
});
