import assert from "node:assert/strict";
import { test } from "node:test";
import {
  POSTHOG_API_HOST,
  requirePostHogProjectToken,
  validatePostHogProjectToken,
} from "./validate-posthog.ts";

const VALID_TOKEN = "phc_abc123";

test("requires a syntactically valid PostHog project token", () => {
  assert.equal(requirePostHogProjectToken(` ${VALID_TOKEN} `), VALID_TOKEN);
  assert.throws(() => requirePostHogProjectToken(undefined), /must be configured/);
  assert.throws(() => requirePostHogProjectToken("not-a-project-token"), /must be configured/);
});

test("validates the project token against the PostHog EU flags endpoint", async () => {
  let requestUrl = "";
  let requestBody = "";

  await validatePostHogProjectToken(VALID_TOKEN, async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    return new Response("{}", { status: 200 });
  });

  assert.equal(requestUrl, `${POSTHOG_API_HOST}/flags/?v=2&config=true`);
  assert.deepEqual(JSON.parse(requestBody), {
    token: VALID_TOKEN,
    distinct_id: "bloxbot-ci-token-validation",
  });
});

test("fails when PostHog rejects the project token", async () => {
  await assert.rejects(
    validatePostHogProjectToken(
      VALID_TOKEN,
      async () =>
        new Response(JSON.stringify({ detail: "The provided API key is invalid." }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    ),
    /HTTP 401: The provided API key is invalid/,
  );
});
