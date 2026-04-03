import * as http from "http";
import * as https from "https";
import { EventBatch } from "./types";

/**
 * HTTP transport to the Ingestion Service.
 *
 * Sends event batches as POST /v1/events/batch.
 * Non-blocking — failures are logged, not thrown.
 * The LocalBuffer is the safety net for failed sends.
 */
export class Transport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number = 5000) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  /**
   * Send an event batch to the Ingestion Service.
   * Returns true if accepted (2xx), false otherwise.
   */
  async send(batch: EventBatch): Promise<boolean> {
    const url = `${this.baseUrl}/v1/events/batch`;
    const body = JSON.stringify(batch);

    try {
      const status = await this.post(url, body);
      return status >= 200 && status < 300;
    } catch {
      // Network error, timeout, etc. — caller should buffer locally.
      return false;
    }
  }

  /**
   * Health check — GET /v1/health
   */
  async healthy(): Promise<boolean> {
    try {
      const status = await this.get(`${this.baseUrl}/v1/health`);
      return status === 200;
    } catch {
      return false;
    }
  }

  private post(url: string, body: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === "https:" ? https : http;

      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          // Consume response body to free socket
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.write(body);
      req.end();
    });
  }

  private get(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === "https:" ? https : http;

      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "GET",
          timeout: this.timeoutMs,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.end();
    });
  }
}
