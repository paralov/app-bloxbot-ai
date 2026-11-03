import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { OPENCODE_ISOLATION_ENV } from "../../../electron/opencodeConfig";

export const PASSWORD = "live-test";

export async function startServer(bin: string, home: string, password = PASSWORD) {
  const workspace = join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  const child = spawn(bin, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: workspace,
    env: {
      ...process.env,
      ...OPENCODE_ISOLATION_ENV,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
    },
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    const read = (chunk: Buffer) => {
      output += chunk;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match?.[1]) resolve(match[1]);
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("exit", () => reject(new Error(`OpenCode exited: ${output}`)));
  });
  return { child, baseUrl, workspace };
}

/** Streams scripted OpenAI-style replies, so these need no model and no free quota. */
export async function startScriptedProvider(replies: ReadonlyArray<object>) {
  let next = 0;
  const bodies: string[] = [];
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      // OpenCode's title request has no tools, and mustn't use up the scripted replies.
      const isChat = body.includes('"tools"');
      if (isChat) bodies.push(body);
      const delta = isChat ? replies[Math.min(next++, replies.length - 1)] : { content: "A title" };
      // A scripted failure, like a rate limit or a rejected key.
      if ("httpStatus" in (delta as object)) {
        const { httpStatus, ...body } = delta as { httpStatus: number };
        res.writeHead(httpStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (choice: object) =>
        res.write(
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, ...choice }] })}\n\n`,
        );
      chunk({ delta: { role: "assistant", ...delta }, finish_reason: null });
      // Stays streaming, for stopping a reply partway through.
      if ("hold" in (delta as object)) return;
      chunk({
        delta: {},
        finish_reason: "tool_calls" in (delta as object) ? "tool_calls" : "stop",
      });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  return {
    provider,
    requests: () => next,
    bodies,
    url: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
  };
}

export const shellCall = (command: string) => ({
  tool_calls: [
    {
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "shell", arguments: JSON.stringify({ command }) },
    },
  ],
});
