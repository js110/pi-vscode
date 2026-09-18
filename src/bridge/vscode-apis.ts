// Narrow adapter seam between the bridge RPC handlers and the VS Code API.
//
// handlers.ts must never touch `vscode` directly: it routes every call through
// this surface, so the RPC logic is a pure function of (method, params, api)
// and stays testable — the unit tests mock the `vscode` module and drive the
// real adapter (src/test/unit/bridge/handlers.test.ts); a fake adapter can be
// injected the same way. The point of the seam is that handler logic never
// imports the VS Code runtime itself.
import * as vscode from "vscode";

export interface VscodeApis {
  getActiveEditor(): vscode.TextEditor | undefined;
  getVisibleEditors(): readonly vscode.TextEditor[];
  getTextDocuments(): readonly vscode.TextDocument[];
  openTextDocument(uri: vscode.Uri): Promise<vscode.TextDocument>;
  showTextDocument(
    document: vscode.TextDocument,
    options?: { preview?: boolean; preserveFocus?: boolean },
  ): Promise<vscode.TextEditor>;
  applyWorkspaceEdit(edit: vscode.WorkspaceEdit): Promise<boolean>;
  getDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[];
  getDiagnostics(): readonly [vscode.Uri, readonly vscode.Diagnostic[]][];
  executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T | undefined>;
  getConfiguration(
    section: string,
    scope?: vscode.TextDocument | vscode.ConfigurationTarget,
  ): { get<T>(key: string, fallback?: T): T | undefined };
  showInformationMessage(message: string, options?: vscode.MessageOptions): Promise<string | undefined>;
  showWarningMessage(message: string, options?: vscode.MessageOptions): Promise<string | undefined>;
  showErrorMessage(message: string, options?: vscode.MessageOptions): Promise<string | undefined>;
  Uri: { parse(value: string): vscode.Uri };
  Range: new (start: vscode.Position, end: vscode.Position) => vscode.Range;
  Selection: new (start: vscode.Position, end: vscode.Position) => vscode.Selection;
  WorkspaceEdit: new () => vscode.WorkspaceEdit;
  CodeAction: typeof vscode.CodeAction;
  DiagnosticSeverity: typeof vscode.DiagnosticSeverity;
  TextEditorRevealType: typeof vscode.TextEditorRevealType;
}

/** Real implementation backed by the live VS Code API. */
export function createVscodeApis(): VscodeApis {
  return {
    getActiveEditor: () => vscode.window.activeTextEditor,
    getVisibleEditors: () => vscode.window.visibleTextEditors,
    getTextDocuments: () => vscode.workspace.textDocuments,
    openTextDocument: async (uri) => vscode.workspace.openTextDocument(uri),
    showTextDocument: async (document, options) => vscode.window.showTextDocument(document, options),
    applyWorkspaceEdit: async (edit) => vscode.workspace.applyEdit(edit),
    getDiagnostics: ((uri?: vscode.Uri) =>
      uri
        ? vscode.languages.getDiagnostics(uri)
        : vscode.languages.getDiagnostics()) as VscodeApis["getDiagnostics"],
    executeCommand: async <T = unknown>(command: string, ...args: unknown[]) =>
      (await vscode.commands.executeCommand(command, ...args)) as T | undefined,
    getConfiguration: (section, scope) =>
      vscode.workspace.getConfiguration(section, scope as vscode.ConfigurationScope | null | undefined),
    showInformationMessage: async (message, options) =>
      options
        ? vscode.window.showInformationMessage(message, options)
        : vscode.window.showInformationMessage(message),
    showWarningMessage: async (message, options) =>
      options
        ? vscode.window.showWarningMessage(message, options)
        : vscode.window.showWarningMessage(message),
    showErrorMessage: async (message, options) =>
      options
        ? vscode.window.showErrorMessage(message, options)
        : vscode.window.showErrorMessage(message),
    Uri: vscode.Uri,
    Range: vscode.Range,
    Selection: vscode.Selection,
    WorkspaceEdit: vscode.WorkspaceEdit,
    CodeAction: vscode.CodeAction,
    DiagnosticSeverity: vscode.DiagnosticSeverity,
    TextEditorRevealType: vscode.TextEditorRevealType,
  };
}