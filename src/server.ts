#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { httpHandler } from "./http.js";
import { nativeLogin } from "./native-login.js";
import { SessionStore } from "./session.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { BookOrbitClient } from "./bookorbit-client.js";
import { BookCache } from "./cache.js";
import { BookService } from "./book-service.js";
import { registerTools } from "./tools.js";

/** Load a local .env for convenience when running directly (best-effort). */
function loadDotEnv(): void {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  try {
    (process as NodeJS.Process & { loadEnvFile?: (p: string) => void }).loadEnvFile?.(
      path,
    );
  } catch {
    // ignore malformed/absent .env
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const command = process.argv[2];
  if (command === "login") {
    await nativeLogin(config);
    return;
  }
  if (command) throw new Error("Usage: bookorbit-mcp [login]");
  const sessionStore = config.sessionFile
    ? new SessionStore(config.sessionFile, config.client.baseUrl)
    : undefined;
  for (;;) {
    let session;
    try {
      session = await sessionStore?.load();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (sessionStore && !session?.credentials) {
      if (config.transport !== "http")
        throw new Error("Complete native SSO enrollment with bookorbit-mcp login.");
      await nativeLogin(config);
      session = await sessionStore.load();
    }
    let expired = () => {};
    const client = new BookOrbitClient({
      ...config.client,
      session,
      sessionStore,
      onSessionExpired: () => expired(),
    });
    const service = new BookService(
      client,
      new BookCache(config.cacheMaxMiB * 1024 * 1024),
    );
    const createServer = () => {
      const server = new McpServer({ name: "bookorbit-mcp", version: "0.1.0" });
      registerTools(server, client, service);
      return server;
    };
    if (config.transport !== "http") {
      await createServer().connect(new StdioServerTransport());
      console.error("bookorbit-mcp server ready (stdio).");
      return;
    }
    const restart = await new Promise<boolean>((resolve, reject) => {
      let reenroll = false;
      let stopping = false;
      const allowedHosts = config.allowedHosts ?? [
        `127.0.0.1:${config.port}`,
        `localhost:${config.port}`,
        `[::1]:${config.port}`,
      ];
      const listener = serve({
        fetch: httpHandler(createServer, allowedHosts),
        hostname: config.host,
        port: config.port,
      });
      const shutdown = () => {
        stopping = true;
        listener.close();
      };
      expired = () => {
        if (!stopping) {
          reenroll = true;
          listener.close();
        }
      };
      for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, shutdown);
      listener.on("error", reject);
      listener.on("close", () => {
        for (const signal of ["SIGTERM", "SIGINT"] as const)
          process.off(signal, shutdown);
        resolve(reenroll && !stopping);
      });
      console.error(
        `bookorbit-mcp ready (private HTTP, port ${config.port}). Client authentication belongs to the gateway.`,
      );
    });
    if (!restart) return;
  }
}

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
