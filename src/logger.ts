import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

class Logger {
  private outputChannel: vscode.OutputChannel | undefined;
  private logFilePath: string | undefined;

  public init(context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel("Authorship Tracker");
    
    // Bind log drop to the extension folder specifically rather than the running workspace
    this.logFilePath = path.join(context.extensionPath, "authorship-tracker.log");

    this.outputChannel.appendLine("[Authorship Tracker] Logger initialized");
    this.log("INFO", "Logger initialized. Output syncing to file.", { file: this.logFilePath });
  }

  public debug(message: string, data?: any) {
    this.log("DEBUG", message, data);
  }

  public info(message: string, data?: any) {
    this.log("INFO", message, data);
  }

  public warn(message: string, data?: any) {
    this.log("WARN", message, data);
  }

  public error(message: string, error?: any) {
    this.log("ERROR", message, error);
  }

  private log(level: string, message: string, data?: any) {
    if (!this.outputChannel) {
      return;
    }

    const timestamp = new Date().toISOString();
    let logMsg = `[${timestamp}] [${level}] ${message}`;

    if (data !== undefined) {
      if (data instanceof Error) {
        logMsg += `\n${data.stack}`;
      } else if (typeof data === "object") {
        logMsg += `\n${JSON.stringify(data, null, 2)}`;
      } else {
        logMsg += ` ${data}`;
      }
    }

    this.outputChannel.appendLine(logMsg);
    
    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, logMsg + "\n", "utf8");
      } catch (e) {
        // Suppress FS errors
      }
    }
  }

  public dispose() {
    if (this.outputChannel) {
      this.outputChannel.dispose();
      this.outputChannel = undefined;
    }
  }
}

export const logger = new Logger();
