import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { createBridgeState } from "../../../bridge/state";
import { createHandler } from "../../../bridge/handlers";
import { createVscodeApis } from "../../../bridge/vscode-apis";
import type { BridgeState } from "../../../bridge/types";

const V = vscode as any;

const env = vi.hoisted(() => {
  const activeEditor = { current: undefined as any };
  const visibleEditors: any[] = [];
  const textDocuments: any[] = [];
  const executeHandler = { fn: null as ((command: string, ...args: any[]) => any) | null };
  const diagnosticsByUri = new Map<string, any[]>();
  const appliedEdits: any[] = [];
  const shownMessages: { type: string; message: string }[] = [];
  return { activeEditor, visibleEditors, textDocuments, executeHandler, diagnosticsByUri, appliedEdits, shownMessages };
});

vi.mock("vscode", () => {
  class FakeUri {
    fsPath: string;
    scheme: string;
    constructor(fsPath: string) {
      this.fsPath = fsPath;
      this.scheme = "file";
    }
    toString() {
      return `file://${this.fsPath}`;
    }
    static file(fsPath: string) {
      return new FakeUri(fsPath);
    }
    static parse(value: string) {
      return new FakeUri(value.replace(/^file:\/\//, ""));
    }
  }

  class FakePosition {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }

  class FakeRange {
    start: FakePosition;
    end: FakePosition;
    constructor(a: FakePosition | number, b: FakePosition | number, c?: number, d?: number) {
      if (a instanceof FakePosition && b instanceof FakePosition) {
        this.start = a;
        this.end = b;
      } else {
        this.start = new FakePosition(a as number, b as number);
        this.end = new FakePosition(c ?? 0, d ?? 0);
      }
    }
    intersection() {
      return this;
    }
  }

  class FakeSelection extends FakeRange {
    isEmpty = false;
  }

  class FakeWorkspaceEdit {
    replaced: [FakeUri, FakeRange, string][] = [];
    replace(uri: FakeUri, range: FakeRange, newText: string) {
      this.replaced.push([uri, range, newText]);
    }
  }

  class FakeCodeAction {
    title: string;
    edit?: any;
    command?: { command: string; arguments?: any[] };
    disabled?: any;
    isPreferred = false;
    kind?: { value: string };
    diagnostics?: any[];
    constructor(title: string) {
      this.title = title;
    }
  }

  class FakeLocation {
    constructor(
      public uri: FakeUri,
      public range: FakeRange,
    ) {}
  }

  class FakeDocumentSymbol {
    children: FakeDocumentSymbol[] = [];
    constructor(
      public name: string,
      public detail: string,
      public kind: number,
      public range: FakeRange,
      public selectionRange: FakeRange,
    ) {}
  }

  class FakeMarkdownString {
    constructor(public value: string) {}
  }

  function makeDocument(uri: any, languageId: string, text = "") {
    return {
      uri,
      languageId,
      isDirty: false,
      getText: (_selection?: any) => text,
      save: async () => true,
    };
  }

  function makeEditor(document: any) {
    return {
      document,
      selection: new FakeSelection(0, 0, 0, 0),
      viewColumn: 1,
      revealRange: () => undefined,
    };
  }

  return {
    Uri: FakeUri,
    Position: FakePosition,
    Range: FakeRange,
    Selection: FakeSelection,
    WorkspaceEdit: FakeWorkspaceEdit,
    CodeAction: FakeCodeAction,
    Location: FakeLocation,
    DocumentSymbol: FakeDocumentSymbol,
    MarkdownString: FakeMarkdownString,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    SymbolKind: { Function: 12, Class: 5, 12: "Function", 5: "Class" },
    TextEditorRevealType: { InCenter: 1 },
    window: {
      get activeTextEditor() {
        return env.activeEditor.current;
      },
      get visibleTextEditors() {
        return env.visibleEditors;
      },
      showInformationMessage: async (message: string) => {
        env.shownMessages.push({ type: "info", message });
        return undefined;
      },
      showWarningMessage: async (message: string) => {
        env.shownMessages.push({ type: "warning", message });
        return undefined;
      },
      showErrorMessage: async (message: string) => {
        env.shownMessages.push({ type: "error", message });
        return undefined;
      },
      showTextDocument: async (document: any) => makeEditor(document),
    },
    workspace: {
      workspaceFolders: [{ name: "ws", uri: new FakeUri("/ws") }],
      get textDocuments() {
        return env.textDocuments;
      },
      openTextDocument: async (uri: any) =>
        env.textDocuments.find((doc) => doc.uri.toString() === uri.toString()) ??
        makeDocument(uri, "typescript"),
      applyEdit: async (edit: any) => {
        env.appliedEdits.push(edit);
        return true;
      },
      getConfiguration: () => ({ get: () => undefined }),
    },
    languages: {
      getDiagnostics: (uri?: any) =>
        uri
          ? env.diagnosticsByUri.get(uri.toString()) ?? []
          : [...env.diagnosticsByUri.entries()].map(([fileUri, diagnostics]) => [new FakeUri((fileUri as string).replace(/^file:\/\//, "")), diagnostics]),
    },
    commands: {
      executeCommand: async (command: string, ...args: any[]) => {
        if (!env.executeHandler.fn) throw new Error(`No executeCommand handler for: ${command}`);
        return env.executeHandler.fn(command, ...args);
      },
    },
  };
});

function makeDoc(uri: any, languageId: string, text = "") {
  return {
    uri,
    languageId,
    isDirty: false,
    getText: (_selection?: any) => text,
    save: async () => true,
  };
}

function makeStackedEditor(document: any) {
  return {
    document,
    selection: new V.Selection(0, 0, 0, 0),
    viewColumn: 1,
    revealRange: () => undefined,
  };
}

function makeSelectionFake(doc: any, start: any, end: any) {
  return { document: doc, selection: new V.Selection(start, end) };
}

function makeState(): BridgeState {
  return createBridgeState(undefined);
}

beforeEach(() => {
  env.activeEditor.current = undefined;
  env.visibleEditors.length = 0;
  env.textDocuments.length = 0;
  env.diagnosticsByUri.clear();
  env.appliedEdits.length = 0;
  env.shownMessages.length = 0;
  env.executeHandler.fn = null;
});

describe("bridge handleRpc", () => {
  it("rejects unknown methods", async () => {
    const handleRpc = createHandler(createVscodeApis());
    await expect(handleRpc("nope", {}, makeState())).rejects.toThrow(/Unknown bridge method/);
  });

  it("getEditorState returns workspace, active editor, selection, open editors", async () => {
    const doc = makeDoc(new V.Uri("/ws/a.ts"), "typescript", "const a = 1;");
    const editor = makeStackedEditor(doc);
    env.activeEditor.current = editor;
    env.visibleEditors.push(editor);
    env.textDocuments.push(doc);

    const result = (await createHandler(createVscodeApis())("getEditorState", {}, makeState())) as any;
    expect(result.workspaceFolders[0].name).toBe("ws");
    expect(result.activeEditor.fileUri).toContain("/ws/a.ts");
    expect(result.currentSelection.filePath).toBe("/ws/a.ts");
    expect(result.openEditors).toHaveLength(1);
  });

  it("getStatus counts diagnostics and falls back to latest selection", async () => {
    const state = makeState();
    state.latestSelection = {
      text: "hello",
      isEmpty: false,
      filePath: "/ws/b.ts",
      fileUri: "file:///ws/b.ts",
      languageId: "typescript",
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    };
    const doc = makeDoc(new V.Uri("/ws/b.ts"), "typescript", "hello");
    env.activeEditor.current = makeSelectionFake(doc, new V.Position(0, 0), new V.Position(0, 5));
    env.diagnosticsByUri.set("file:///ws/b.ts", [
      { severity: 0, message: "boom", source: "ts", code: "x", range: new V.Range(0, 0, 0, 5) },
      { severity: 1, message: "warn", source: "ts", code: "w", range: new V.Range(0, 0, 0, 1) },
    ]);

    const result = (await createHandler(createVscodeApis())("getStatus", {}, state)) as any;
    expect(result.diagnostics).toEqual({ errors: 1, warnings: 1, infos: 0, hints: 0 });
    expect(result.activeEditor.filePath).toBe("/ws/b.ts");
  });

  it("getCurrentSelection falls back to latest selection without an editor", async () => {
    const state = makeState();
    state.latestSelection = { text: "x", filePath: "/ws/c.ts", fileUri: "file:///ws/c.ts", languageId: "typescript", isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const result = await createHandler(createVscodeApis())("getCurrentSelection", {}, state);
    expect(result).toEqual(state.latestSelection);
  });

  it("getLatestSelection returns the recorded selection", async () => {
    const state = makeState();
    state.latestSelection = {} as any;
    expect(await createHandler(createVscodeApis())("getLatestSelection", {}, state)).toEqual(state.latestSelection);
  });

  it("getDiagnostics returns per-file diagnostics and the global list", async () => {
    env.diagnosticsByUri.set("file:///ws/d.ts", [
      { severity: 2, message: "info", source: "ts", code: "i", range: new V.Range(0, 0, 0, 1) },
    ]);
    const handleRpc = createHandler(createVscodeApis());

    const single = (await handleRpc("getDiagnostics", { filePath: "/ws/d.ts" }, makeState())) as any;
    expect(single).toHaveLength(1);
    expect(single[0].diagnostics[0].severity).toBe(2);

    const all = (await handleRpc("getDiagnostics", {}, makeState())) as any;
    expect(all).toHaveLength(1);
    expect(all[0].filePath).toBe("/ws/d.ts");
  });

  it("getOpenEditors lists visible and text documents", async () => {
    const doc = makeDoc(new V.Uri("/ws/e.ts"), "typescript");
    env.visibleEditors.push(makeStackedEditor(doc));
    env.textDocuments.push(makeDoc(new V.Uri("/ws/f.ts"), "python"));

    const result = (await createHandler(createVscodeApis())("getOpenEditors", {}, makeState())) as any;
    expect(result.map((e: any) => e.filePath)).toEqual(["/ws/e.ts", "/ws/f.ts"]);
  });

  it("getWorkspaceFolders returns the folders", async () => {
    const result = (await createHandler(createVscodeApis())("getWorkspaceFolders", {}, makeState())) as any;
    expect(result[0]).toMatchObject({ index: 0, name: "ws", filePath: "/ws" });
  });

  it("openFile opens the document, applies the selection, and reports it", async () => {
    const doc = makeDoc(new V.Uri("/ws/a.ts"), "typescript", "const x = 1;");
    env.textDocuments.push(doc);

    const result = (await createHandler(createVscodeApis())(
      "openFile",
      { filePath: "/ws/a.ts", selection: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } },
      makeState(),
    )) as any;
    expect(result.opened).toBe(true);
    expect(result.filePath).toBe("/ws/a.ts");
    expect(result.selection.start).toEqual({ line: 0, character: 6 });
  });

  it("checkDocumentDirty reports open and dirty state", async () => {
    const dirtyDoc = makeDoc(new V.Uri("/ws/d.ts"), "typescript");
    dirtyDoc.isDirty = true;
    env.textDocuments.push(dirtyDoc);

    const handleRpc = createHandler(createVscodeApis());
    const result = (await handleRpc("checkDocumentDirty", { filePath: "/ws/d.ts" }, makeState())) as any;
    expect(result).toEqual({ filePath: "/ws/d.ts", fileUri: "file:///ws/d.ts", isOpen: true, isDirty: true });

    const missing = (await handleRpc("checkDocumentDirty", { filePath: "/ws/gone.ts" }, makeState())) as any;
    expect(missing.isOpen).toBe(false);
  });

  it("saveDocument saves and reports wasDirty", async () => {
    const dirtyDoc = makeDoc(new V.Uri("/ws/d.ts"), "typescript");
    dirtyDoc.isDirty = true;
    let saved = false;
    dirtyDoc.save = async () => {
      saved = true;
      dirtyDoc.isDirty = false;
      return true;
    };
    env.textDocuments.push(dirtyDoc);

    const result = (await createHandler(createVscodeApis())("saveDocument", { filePath: "/ws/d.ts" }, makeState())) as any;
    expect(saved).toBe(true);
    expect(result.wasDirty).toBe(true);
    expect(result.isDirty).toBe(false);
  });

  it("getDocumentSymbols serializes document symbols", async () => {
    env.executeHandler.fn = () => [new V.DocumentSymbol("foo", "fn", 12, new V.Range(0, 0, 0, 3), new V.Range(0, 0, 0, 3))];
    const result = (await createHandler(createVscodeApis())("getDocumentSymbols", { filePath: "/ws/a.ts" }, makeState())) as any;
    expect(result.symbols[0]).toMatchObject({ name: "foo", kind: "Function" });
  });

  it("resolves definitions/typeDefs/implementations/declarations via executeCommand", async () => {
    env.executeHandler.fn = () => [new V.Location(new V.Uri("/ws/def.ts"), new V.Range(0, 0, 0, 1))];
    const handleRpc = createHandler(createVscodeApis());
    for (const method of ["getDefinitions", "getTypeDefinitions", "getImplementations", "getDeclarations"]) {
      const result = (await handleRpc(method, { filePath: "/ws/a.ts", position: { line: 0, character: 0 } }, makeState())) as any;
      const key = method === "getDefinitions" ? "definitions" : method === "getTypeDefinitions" ? "typeDefinitions" : method === "getImplementations" ? "implementations" : "declarations";
      expect(result[key][0].filePath).toBe("/ws/def.ts");
    }
  });

  it("serializes location links as well as locations", async () => {
    env.executeHandler.fn = () => [{ targetUri: new V.Uri("/ws/link.ts"), targetRange: new V.Range(0, 0, 0, 1), targetSelectionRange: new V.Range(0, 0, 0, 1) }];
    const result = (await createHandler(createVscodeApis())("getDefinitions", { filePath: "/ws/a.ts", position: { line: 0, character: 0 } }, makeState())) as any;
    expect(result.definitions[0].targetSelectionRange).toBeDefined();
  });

  it("getHover returns serialized hovers", async () => {
    env.executeHandler.fn = () => [{ contents: ["hello"], range: new V.Range(0, 0, 0, 5) }];
    const result = (await createHandler(createVscodeApis())("getHover", { filePath: "/ws/a.ts", position: { line: 0, character: 1 } }, makeState())) as any;
    expect(result.hovers[0].contents).toEqual([{ kind: "markdown", value: "hello" }]);
  });

  it("getWorkspaceSymbols serializes symbol information", async () => {
    env.executeHandler.fn = () => [{ name: "search", containerName: "ws", kind: 5, tags: [], location: new V.Location(new V.Uri("/ws/s.ts"), new V.Range(0, 0, 0, 1)) }];
    const result = (await createHandler(createVscodeApis())("getWorkspaceSymbols", { query: "sea" }, makeState())) as any;
    expect(result.query).toBe("sea");
    expect(result.symbols[0].name).toBe("search");
  });

  it("getReferences serializes references", async () => {
    env.executeHandler.fn = () => [new V.Location(new V.Uri("/ws/r.ts"), new V.Range(0, 0, 0, 1))];
    const result = (await createHandler(createVscodeApis())("getReferences", { filePath: "/ws/a.ts", position: { line: 0, character: 0 } }, makeState())) as any;
    expect(result.references[0].fileUri).toContain("/ws/r.ts");
  });

  it("getCodeActions serializes code actions and caches them", async () => {
    const action = new V.CodeAction("Refactor");
    action.edit = new V.WorkspaceEdit();
    env.executeHandler.fn = () => [action];
    env.diagnosticsByUri.set("file:///ws/a.ts", [
      { severity: 0, message: "err", source: "ts", code: "x", range: new V.Range(0, 0, 0, 1) },
    ]);

    const state = makeState();
    const result = (await createHandler(createVscodeApis())("getCodeActions", { filePath: "/ws/a.ts", selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }, state)) as any;
    expect(result.actions[0].kind).toBe("codeAction");
    expect(result.actions[0].hasEdit).toBe(true);
    expect(state.codeActions.size).toBe(1);
  });

  it("executeCodeAction runs the cached action edit + command and deletes it", async () => {
    const action = new V.CodeAction("Fix");
    action.edit = new V.WorkspaceEdit();
    action.command = { command: "workbench.action.some", arguments: [1] };
    const state = makeState();
    const actionId = state.cacheCodeAction(action as any, "/ws/a.ts");
    const executed: string[] = [];
    env.executeHandler.fn = (command: string) => {
      executed.push(command);
      return undefined;
    };

    const result = (await createHandler(createVscodeApis())("executeCodeAction", { actionId }, state)) as any;
    expect(result).toMatchObject({ actionId, title: "Fix", editApplied: true, commandExecuted: true });
    expect(executed).toEqual(["workbench.action.some"]);
    expect(env.appliedEdits).toHaveLength(1);
    expect(state.codeActions.size).toBe(0);
  });

  it("executeCodeAction rejects an unknown id", async () => {
    const handleRpc = createHandler(createVscodeApis());
    await expect(handleRpc("executeCodeAction", { actionId: "nope" }, makeState())).rejects.toThrow(/Unknown or expired code action/);
  });

  it("applyWorkspaceEdit rewrites inside the workspace", async () => {
    const result = (await createHandler(createVscodeApis())(
      "applyWorkspaceEdit",
      { edits: [{ filePath: "/ws/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "X" }] },
      makeState(),
    )) as any;
    expect(result.applied).toBe(true);
    expect(result.edits[0].filePath).toBe("/ws/a.ts");
    expect(env.appliedEdits).toHaveLength(1);
  });

  it("rejects applyWorkspaceEdit writes outside the workspace", async () => {
    const handleRpc = createHandler(createVscodeApis());
    await expect(
      handleRpc("applyWorkspaceEdit", { edits: [{ filePath: "/elsewhere/x.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "X" }] }, makeState()),
    ).rejects.toThrow(/outside the workspace/);
  });

  it("formatDocument and formatRange run the providers and apply edits", async () => {
    env.executeHandler.fn = () => [{ range: new V.Range(0, 0, 0, 3), newText: "new" }];
    const handleRpc = createHandler(createVscodeApis());

    const formatted = (await handleRpc("formatDocument", { filePath: "/ws/a.ts" }, makeState())) as any;
    expect(formatted.editCount).toBe(1);
    expect(formatted.applied).toBe(true);

    const ranged = (await handleRpc("formatRange", {
      filePath: "/ws/a.ts",
      selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    }, makeState())) as any;
    expect(ranged.editCount).toBe(1);
    expect(ranged.range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 3 } });
  });

  it("getNotifications filters by since and clamps the limit", async () => {
    const state = makeState();
    state.enqueue("selection_changed", { x: 1 });
    state.enqueue("document_saved", { y: 2 });
    const handleRpc = createHandler(createVscodeApis());

    const all = (await handleRpc("getNotifications", {}, state)) as any;
    expect(all.notifications).toHaveLength(2);

    const except = (await handleRpc("getNotifications", { limit: 1 }, state)) as any;
    expect(except.notifications).toHaveLength(1);
    expect(except.latestTimestamp).toEqual(state.notifications.at(-1)?.timestamp);
  });

  it("clearNotifications empties the queue and reports the count", async () => {
    const state = makeState();
    state.enqueue("selection_changed", { x: 1 });
    const result = (await createHandler(createVscodeApis())("clearNotifications", {}, state)) as any;
    expect(result.cleared).toBe(1);
    expect(state.notifications).toHaveLength(0);
  });

  it("showNotification shows info/warning/error and rejects invalid types", async () => {
    const handleRpc = createHandler(createVscodeApis());
    for (const type of ["info", "warning", "error"]) {
      const result = await handleRpc("showNotification", { message: `m-${type}`, type }, makeState());
      expect(result).toMatchObject({ shown: true, type });
    }
    expect(env.shownMessages).toEqual([
      { type: "info", message: "m-info" },
      { type: "warning", message: "m-warning" },
      { type: "error", message: "m-error" },
    ]);

    await expect(handleRpc("showNotification", { message: "x", type: "bogus" }, makeState())).rejects.toThrow(/Invalid notification type/);
  });

  it("reportTerminalSession forwards to the callback", async () => {
    const seen: [string, string][] = [];
    const state = createBridgeState(undefined, (terminalId, sessionFile) => seen.push([terminalId, sessionFile]));
    const result = (await createHandler(createVscodeApis())("reportTerminalSession", { terminalId: "t1", sessionFile: "/ws/s.json" }, state)) as any;
    expect(result).toEqual({ received: true });
    expect(seen).toEqual([["t1", "/ws/s.json"]]);
  });
});