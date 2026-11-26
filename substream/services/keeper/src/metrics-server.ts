import { createServer, type Server } from "node:http";

import { KeeperMetrics, renderPrometheus } from "./metrics";

export interface MetricsServerOptions {
  host: string;
  port: number;
}

function send(
  res: import("node:http").ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

export function createMetricsServer(
  metrics: KeeperMetrics,
  options: MetricsServerOptions,
): Server {
  return createServer((req, res) => {
    let pathname: string;
    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      if (requestUrl.href.length > 512) {
        send(res, 414, "text/plain; charset=utf-8", "URI too long\n");
        return;
      }
      pathname = requestUrl.pathname;
    } catch {
      send(res, 400, "text/plain; charset=utf-8", "Bad request\n");
      return;
    }

    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      send(res, 405, "text/plain; charset=utf-8", "Method not allowed\n");
      return;
    }

    if (pathname === "/health") {
      const snapshot = metrics.snapshot();
      send(
        res,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({
          ok: snapshot.consecutiveFailures === 0,
          ...snapshot,
        }),
      );
      return;
    }

    if (pathname === "/metrics") {
      send(
        res,
        200,
        "text/plain; version=0.0.4; charset=utf-8",
        renderPrometheus(metrics.snapshot()),
      );
      return;
    }

    send(res, 404, "text/plain; charset=utf-8", "Not found\n");
  });
}

export function startMetricsServer(
  metrics: KeeperMetrics,
  options: MetricsServerOptions,
): Promise<Server> {
  const server = createMetricsServer(metrics, options);
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
}
