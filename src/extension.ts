import {
  Disposable,
  ExtensionContext,
  Terminal,
  commands,
  window,
  workspace,
  debug,
  env,
  Uri,
  Extension,
  extensions,
} from "vscode";
import { AWClient, IAppEditorEvent } from "../aw-client-js/src/aw-client";
import { hostname } from "os";
import { API, GitExtension, Repository } from "./git";
import { basename, relative } from "path";

export function activate(context: ExtensionContext) {
  console.log("[ActivityWatch Enhanced] Extension activated");
  const controller = new ActivityWatch();
  controller.init();
  context.subscriptions.push(controller);

  const reloadCommand = commands.registerCommand("extension.reload", () =>
    controller.init()
  );
  context.subscriptions.push(reloadCommand);
}

class ActivityWatch {
  private _disposable: Disposable;
  private _client: AWClient;
  private _git: API | undefined;

  private _bucket: {
    id: string;
    hostName: string;
    clientName: string;
    eventType: string;
  };
  private _bucketCreated: boolean = false;

  // Config
  private _pulseTime: number = 20;
  private _maxHeartbeatsPerSec: number = 1;

  // State tracking for change detection
  private _lastFilePath: string = "";
  private _lastHeartbeatTime: number = 0;
  private _lastBranch: string = "";
  private _lastTerminalName: string = "";
  private _isDebugging: boolean = false;

  // Cache PID -> cwd for terminals without shellIntegration
  private _pidCwdCache: Map<number, { cwd: string; time: number }> = new Map();

  constructor() {
    this._bucket = {
      id: "",
      hostName: hostname(),
      clientName: "aw-watcher-vscode",
      eventType: "app.editor.activity",
    };
    this._bucket.id = `${this._bucket.clientName}_${this._bucket.hostName}`;
    this._client = new AWClient(this._bucket.clientName, { testing: false });

    const subscriptions: Disposable[] = [];

    // Editor events
    window.onDidChangeTextEditorSelection(this._onEvent, this, subscriptions);
    window.onDidChangeActiveTextEditor(this._onEvent, this, subscriptions);

    // Terminal events
    window.onDidChangeActiveTerminal(
      this._onTerminalEvent,
      this,
      subscriptions
    );
    window.onDidOpenTerminal(this._onTerminalEvent, this, subscriptions);
    window.onDidCloseTerminal(this._onTerminalEvent, this, subscriptions);

    // Debug events
    debug.onDidStartDebugSession(
      () => {
        this._isDebugging = true;
        this._onEvent();
      },
      this,
      subscriptions
    );
    debug.onDidTerminateDebugSession(
      () => {
        this._isDebugging = false;
        this._onEvent();
      },
      this,
      subscriptions
    );

    // Window focus events
    window.onDidChangeWindowState(this._onEvent, this, subscriptions);

    this._disposable = Disposable.from(...subscriptions);
  }

  public init() {
    this._client
      .ensureBucket(
        this._bucket.id,
        this._bucket.eventType,
        this._bucket.hostName
      )
      .then((res) => {
        console.log(
          res.alreadyExist
            ? "[ActivityWatch Enhanced] Bucket already exists"
            : "[ActivityWatch Enhanced] Created bucket"
        );
        this._bucketCreated = true;
      })
      .catch((err) => {
        this._handleError(
          "Couldn't create Bucket. Is the ActivityWatch server running?",
          true
        );
        this._bucketCreated = false;
        console.error(err);
      });

    this.initGit().then((res) => (this._git = res));
    this.loadConfigurations();
  }

  private async initGit() {
    try {
      const extension = extensions.getExtension(
        "vscode.git"
      ) as Extension<GitExtension>;
      if (!extension) {
        return undefined;
      }
      const gitExtension = extension.isActive
        ? extension.exports
        : await extension.activate();
      return gitExtension.getAPI(1);
    } catch (_err) {
      console.warn("[ActivityWatch Enhanced] Git extension not available");
      return undefined;
    }
  }

  public loadConfigurations() {
    const config = workspace.getConfiguration("aw-watcher-vscode");
    const maxHeartbeatsPerSec = config.get<number>("maxHeartbeatsPerSec");
    if (maxHeartbeatsPerSec) {
      this._maxHeartbeatsPerSec = maxHeartbeatsPerSec;
    }
  }

  public dispose() {
    this._disposable.dispose();
  }

  // Resolve cwd for a terminal PID via lsof (macOS/Linux).
  // The terminal's processId is its shell PID — lsof gives the cwd directly.
  // Returns cached result if fresh enough (10s TTL).
  private _getTerminalCwd(pid: number): string {
    const cached = this._pidCwdCache.get(pid);
    const now = Date.now();
    if (cached && now - cached.time < 10000) {
      return cached.cwd;
    }

    try {
      const { execFileSync } = require("child_process");

      if (process.platform === "win32") {
        // Windows: use PowerShell to get process working directory
        const out: string = execFileSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `(Get-Process -Id ${pid}).Path | Split-Path`,
          ],
          { timeout: 2000, encoding: "utf-8" }
        );
        const cwd = out.trim();
        if (cwd) {
          this._pidCwdCache.set(pid, { cwd, time: now });
          return cwd;
        }
      } else {
        // macOS/Linux: use lsof
        const lsofOut: string = execFileSync(
          "lsof",
          ["-p", String(pid), "-Fn"],
          { timeout: 2000, encoding: "utf-8" }
        );
        const lines = lsofOut.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (
            lines[i] === "fcwd" &&
            i + 1 < lines.length &&
            lines[i + 1].startsWith("n")
          ) {
            const cwd = lines[i + 1].substring(1);
            if (cwd && cwd !== "/" && !cwd.startsWith("/dev")) {
              this._pidCwdCache.set(pid, { cwd, time: now });
              return cwd;
            }
          }
        }
      }
    } catch (_) {
      /* ignore */
    }

    return "";
  }

  private _onTerminalEvent() {
    if (!this._bucketCreated) {
      return;
    }

    const terminal = window.activeTerminal;
    if (!terminal) return;

    // Use terminal object identity via index to distinguish same-named terminals
    const terminals = window.terminals;
    const termIndex = terminals.indexOf(terminal);
    const termKey = `${terminal.name || ""}|${termIndex}`;

    if (termKey !== this._lastTerminalName) {
      this._lastTerminalName = termKey;
      this._onEvent();
    }
  }

  private async _onEvent() {
    if (!this._bucketCreated) {
      return;
    }

    // Only send heartbeats from the focused VS Code window.
    // Multiple windows share the same bucket — unfocused windows
    // interleave different project data and break pulse merging.
    const isFocused = window.state.focused;
    if (!isFocused && this._lastHeartbeatTime > 0) {
      const timeSinceLast = new Date().getTime() - this._lastHeartbeatTime;
      if (timeSinceLast > 2000) {
        return;
      }
    }

    try {
      const heartbeat = await this._createHeartbeat();
      const filePath = heartbeat.data.file || "";
      const curTime = new Date().getTime();
      const branch = heartbeat.data.branch || "";

      if (
        filePath !== this._lastFilePath ||
        branch !== this._lastBranch ||
        this._lastHeartbeatTime + 1000 / this._maxHeartbeatsPerSec < curTime
      ) {
        this._lastFilePath = filePath;
        this._lastBranch = branch;
        this._lastHeartbeatTime = curTime;
        this._sendHeartbeat(heartbeat);
      }
    } catch (err: unknown) {
      this._handleError(String(err));
    }
  }

  private _sendHeartbeat(event: IAppEditorEvent) {
    return this._client
      .heartbeat(this._bucket.id, this._pulseTime, event)
      .then(() =>
        console.log("[ActivityWatch Enhanced] Heartbeat:", event.data.file)
      )
      .catch(({ err }: { err: unknown }) => {
        console.error("[ActivityWatch Enhanced] Heartbeat error:", err);
      });
  }

  private async _createHeartbeat(): Promise<IAppEditorEvent> {
    const editor = window.activeTextEditor;
    const projectName = this._getProjectName();
    const projectPath = this._getProjectFolder();
    const filePath = this._getFilePath();
    const branch = this._getCurrentBranch() || "unknown";

    const data: Record<string, unknown> = {
      language: this._getFileLanguage() || "unknown",
      project: projectName || "unknown",
      file: filePath || "unknown",
      branch: branch,
      // PR #39: editor identification (dynamic, supports Cursor/Windsurf/etc.)
      editor: env.appName || "VS Code",
    };

    // PR #36: workspace name (from .code-workspace file)
    const wsName = workspace.name;
    if (wsName) {
      data.workspace = wsName;
    }

    // Relative file path
    if (filePath && projectPath) {
      const relPath = relative(projectPath, filePath);
      if (relPath && !relPath.startsWith("..")) {
        data.relative_path = relPath;
      }
    }

    // Cursor position
    if (editor?.selection) {
      data.cursor_line = editor.selection.active.line + 1;
      data.cursor_col = editor.selection.active.character + 1;
      data.lines_in_file = editor.document.lineCount;
    }

    // Git status
    const gitInfo = this._getGitInfo();
    if (gitInfo) {
      if (gitInfo.dirty_count !== undefined) {
        data.git_dirty_count = gitInfo.dirty_count;
      }
      if (gitInfo.remote_url) {
        data.git_remote = gitInfo.remote_url;
      }
    }

    // Debugging state
    if (this._isDebugging || debug.activeDebugSession) {
      data.is_debugging = true;
      const session = debug.activeDebugSession;
      if (session) {
        data.debug_type = session.type;
      }
    }

    // Open editors
    const openEditors = this._getOpenEditorFiles();
    if (openEditors.length > 0) {
      data.open_files = openEditors.join(";");
      data.open_file_count = openEditors.length;
    }

    // Active terminal
    const terminal = window.activeTerminal;
    if (terminal) {
      data.active_terminal = terminal.name;
      const termCwd = await this._resolveTerminalCwd(terminal);
      if (termCwd) {
        data.terminal_cwd = termCwd;
        const desc =
          termCwd.split("/").pop() || termCwd.split("\\").pop() || "";
        if (desc) {
          data.terminal_description = desc;
          data.active_terminal_label = `${terminal.name} ${desc}`;
        }
      }
    }
    data.terminal_count = window.terminals.length;

    // All terminal labels
    if (window.terminals.length > 0) {
      const termLabels: string[] = [];
      for (const t of window.terminals) {
        const name = t.name || "";
        let label = name;
        const cwdStr = await this._resolveTerminalCwd(t);
        if (cwdStr) {
          const dirName =
            cwdStr.split("/").pop() || cwdStr.split("\\").pop() || "";
          if (dirName) label = `${name} ${dirName}`;
        }
        if (label) termLabels.push(label);
      }
      if (termLabels.length > 0) {
        data.terminal_names = termLabels.join(";");
      }
    }

    // Window focus state
    data.is_focused = window.state.focused;

    // Workspace folders (multi-root)
    const folders = workspace.workspaceFolders;
    if (folders && folders.length > 1) {
      data.workspace_folders = folders.map((f) => f.name).join(";");
    }

    return {
      timestamp: new Date(),
      duration: 0,
      data: data as IAppEditorEvent["data"],
    };
  }

  private async _resolveTerminalCwd(terminal: Terminal): Promise<string> {
    // Try shellIntegration first (VS Code 1.93+)
    try {
      const si = (terminal as unknown as Record<string, unknown>).shellIntegration as
        | { cwd?: string | { fsPath?: string; path?: string } }
        | undefined;
      if (si?.cwd) {
        const cwd = si.cwd;
        const cwdStr =
          typeof cwd === "string" ? cwd : cwd.fsPath || cwd.path || "";
        if (cwdStr) return cwdStr;
      }
    } catch (_) {
      /* ignore */
    }

    // Fallback: resolve cwd from terminal PID
    if (terminal.processId) {
      try {
        const pid = await Promise.race([
          terminal.processId,
          new Promise<number | undefined>((r) => setTimeout(() => r(undefined), 500)),
        ]);
        if (pid) {
          return this._getTerminalCwd(pid);
        }
      } catch (_) {
        /* ignore */
      }
    }

    return "";
  }

  private _getProjectName(): string | undefined {
    const fileUri = this._getActiveFileUri();
    if (!fileUri) {
      const folders = workspace.workspaceFolders;
      if (folders && folders.length > 0) {
        return folders[0].name;
      }
      return undefined;
    }
    const workspaceFolder = workspace.getWorkspaceFolder(fileUri);
    return workspaceFolder?.name;
  }

  private _getProjectFolder(): string | undefined {
    const fileUri = this._getActiveFileUri();
    if (!fileUri) {
      const folders = workspace.workspaceFolders;
      if (folders && folders.length > 0) {
        return folders[0].uri.fsPath;
      }
      return undefined;
    }
    const workspaceFolder = workspace.getWorkspaceFolder(fileUri);
    return workspaceFolder?.uri.fsPath;
  }

  private _getActiveFileUri(): Uri | undefined {
    return window.activeTextEditor?.document.uri;
  }

  private _getFilePath(): string | undefined {
    return window.activeTextEditor?.document.fileName;
  }

  private _getFileLanguage(): string | undefined {
    return window.activeTextEditor?.document.languageId;
  }

  private _getCurrentBranch(): string | undefined {
    if (!this._git) {
      return undefined;
    }

    const fileUri = this._getActiveFileUri();
    if (fileUri && this._git.getRepository) {
      const repo = this._git.getRepository(fileUri);
      if (repo) {
        return repo.state.HEAD?.name;
      }
    }

    return this._git.repositories[0]?.state?.HEAD?.name;
  }

  private _getGitInfo(): {
    dirty_count?: number;
    remote_url?: string;
  } | null {
    if (!this._git || !this._git.repositories.length) {
      return null;
    }

    let repo: Repository | undefined;
    const fileUri = this._getActiveFileUri();
    if (fileUri && this._git.getRepository) {
      repo = this._git.getRepository(fileUri) || undefined;
    }
    if (!repo) {
      repo = this._git.repositories[0];
    }
    if (!repo) {
      return null;
    }

    const result: { dirty_count?: number; remote_url?: string } = {};
    const state = repo.state;
    result.dirty_count =
      (state.workingTreeChanges?.length || 0) +
      (state.indexChanges?.length || 0);

    const origin = state.remotes?.find((r) => r.name === "origin");
    if (origin?.fetchUrl) {
      let url = origin.fetchUrl;
      const sshMatch = url.match(/git@([^:]+):(.+?)(?:\.git)?$/);
      if (sshMatch) {
        url = `${sshMatch[1]}/${sshMatch[2]}`;
      }
      result.remote_url = url;
    }

    return result;
  }

  private _getOpenEditorFiles(): string[] {
    const files: string[] = [];
    for (const editor of window.visibleTextEditors) {
      const path = editor.document.fileName;
      if (path) {
        files.push(basename(path));
      }
    }
    return files;
  }

  private _handleError(err: string, isCritical = false): undefined {
    if (isCritical) {
      console.error("[ActivityWatch Enhanced]", err);
      window.showErrorMessage(`[ActivityWatch Enhanced] ${err}`);
    } else {
      console.warn("[ActivityWatch Enhanced]", err);
    }
    return;
  }
}
