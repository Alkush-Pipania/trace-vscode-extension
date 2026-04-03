import * as vscode from "vscode";
import { TrackerConfig, EventBatch } from "./types";
import { EventBatcher } from "./events";
import { LocalBuffer } from "./buffer";
import { Transport } from "./transport";
import { Observer } from "./observer";
import { logger } from "./logger";

let observer: Observer | null = null;

export function activate(context: vscode.ExtensionContext): void {
  logger.init(context);
  logger.info("Starting Authorship Tracker extension activation sequence.");
  const config = loadConfig();

  if (!config.enabled) {
    logger.warn("Authorship Tracker disabled via configuration");
    return;
  }

  // ── Wire up the pipeline ────────────────────────────────────────
  //
  // VS Code events
  //   → Observer (classifies AI vs human)
  //     → Debouncer (groups rapid keystrokes, 300ms)
  //       → EventBatcher (collects up to 50 events or 1s)
  //         → Transport (POST to Ingestion Service)
  //         → LocalBuffer (JSONL fallback on failure)

  const transport = new Transport(config.ingestionUrl);
  const buffer = new LocalBuffer();

  const batcher = new EventBatcher(
    (batch: EventBatch) => {
      // Try sending to Ingestion Service first
      transport.send(batch).then((ok) => {
        if (!ok) {
          // Ingestion Service is down — write to local buffer
          buffer.append(batch);
        }
      });
    },
    {
      maxSize: config.batchSize,
      intervalMs: config.batchIntervalMs,
      installationId: config.installationId,
    }
  );

  observer = new Observer(transport, buffer, batcher);
  observer.activate();

  // Register disposable for clean shutdown
  context.subscriptions.push(
    new vscode.Disposable(() => {
      logger.info("Authorship Tracker shutting down.");
      if (observer) {
        observer.deactivate();
        observer = null;
      }
      logger.dispose();
    })
  );

  // ── Status bar indicator ────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.text = "$(eye) Authorship";
  statusBar.tooltip = "Authorship Tracker is active";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── React to config changes ─────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("authorshipTracker")) {
        const newConfig = loadConfig();
        if (!newConfig.enabled && observer) {
          observer.deactivate();
          observer = null;
          statusBar.hide();
        }
        // For URL/timing changes, a reload is required
      }
    })
  );

  console.log(
    `[authorship-tracker] Activated — sending to ${config.ingestionUrl}`
  );
}

export function deactivate(): void {
  if (observer) {
    observer.deactivate();
    observer = null;
  }
}

function loadConfig(): TrackerConfig {
  const cfg = vscode.workspace.getConfiguration("authorshipTracker");
  return {
    enabled: cfg.get<boolean>("enabled", true),
    ingestionUrl: cfg.get<string>("ingestionUrl", "http://localhost:9090"),
    debounceMs: cfg.get<number>("debounceMs", 300),
    batchSize: cfg.get<number>("batchSize", 50),
    batchIntervalMs: cfg.get<number>("batchIntervalMs", 1000),
    installationId: cfg.get<string>("installationId", ""),
  };
}
