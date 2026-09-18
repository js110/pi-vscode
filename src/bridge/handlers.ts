import type * as vscode from "vscode";
import {
  captureSelection,
  captureSelectionStatus,
  getEditorInfo,
  getSelectionStatus,
  serializeCodeAction,
  serializeDiagnostic,
  serializeHover,
  serializeLocation,
  serializeLocationLike,
  serializePosition,
  serializeRange,
  serializeSymbol,
} from "./serialize";
import type { BridgeDiagnosticSummary, BridgeEditorInfo, BridgeState } from "./types";
import type { VscodeApis } from "./vscode-apis";
import {
  assertWritePathInWorkspace,
  createRange,
  getFileUri,
  getWorkspaceFolders,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readRequiredPosition,
  readRequiredString,
  readSelection,
  readWorkspaceEditEntries,
} from "./utils";

export function createHandler(api: VscodeApis) {
  return async function handleRpc(
    method: string,
    params: Record<string, unknown>,
    state: BridgeState,
  ): Promise<unknown> {
    switch (method) {
      case "getEditorState": {
        const activeEditor = api.getActiveEditor();
        return {
          workspaceFolders: getWorkspaceFolders(),
          activeEditor: activeEditor ? getEditorInfo(activeEditor) : undefined,
          currentSelection: captureSelection(activeEditor),
          latestSelection: state.latestSelection,
          openEditors: getOpenEditors(api),
        };
      }
      case "getStatus":
        return getStatus(api, state);
      case "getCurrentSelection":
        return captureSelection(api.getActiveEditor()) ?? state.latestSelection;
      case "getLatestSelection":
        return state.latestSelection;
      case "getDiagnostics":
        return getDiagnosticsResult(api, readOptionalString(params.filePath));
      case "getOpenEditors":
        return getOpenEditors(api);
      case "getWorkspaceFolders":
        return getWorkspaceFolders();
      case "openFile":
        return openFile(api, params);
      case "checkDocumentDirty":
        return checkDocumentDirty(api, params);
      case "saveDocument":
        return saveDocument(api, params);
      case "getDocumentSymbols":
        return getDocumentSymbols(api, params);
      case "getDefinitions":
        return getLocationResults(api, params, "vscode.executeDefinitionProvider", "definitions");
      case "getTypeDefinitions":
        return getLocationResults(api, params, "vscode.executeTypeDefinitionProvider", "typeDefinitions");
      case "getImplementations":
        return getLocationResults(api, params, "vscode.executeImplementationProvider", "implementations");
      case "getDeclarations":
        return getLocationResults(api, params, "vscode.executeDeclarationProvider", "declarations");
      case "getHover":
        return getHover(api, params);
      case "getWorkspaceSymbols":
        return getWorkspaceSymbols(api, params);
      case "getReferences":
        return getReferences(api, params);
      case "getCodeActions":
        return getCodeActions(api, params, state);
      case "executeCodeAction":
        return executeCodeAction(api, params, state);
      case "applyWorkspaceEdit":
        return applyWorkspaceEdit(api, params);
      case "formatDocument":
        return formatDocument(api, params);
      case "formatRange":
        return formatRange(api, params);
      case "getNotifications":
        return getNotifications(params, state);
      case "clearNotifications":
        return clearNotifications(state);
      case "showNotification":
        return showNotification(api, params);
      case "reportTerminalSession":
        return reportTerminalSession(params, state);
      default:
        throw new Error(`Unknown bridge method: ${method}`);
    }
  };
}

function reportTerminalSession(params: Record<string, unknown>, state: BridgeState) {
  const terminalId = readRequiredString(params.terminalId, "terminalId");
  const sessionFile = readRequiredString(params.sessionFile, "sessionFile");
  state.reportTerminalSession(terminalId, sessionFile);
  return { received: true };
}

function getStatus(api: VscodeApis, state: BridgeState) {
  const activeEditor = api.getActiveEditor();
  const fallbackSelection = state.latestSelection;
  const fallbackUri = fallbackSelection ? api.Uri.parse(fallbackSelection.fileUri) : undefined;

  return {
    workspaceFolders: getWorkspaceFolders(),
    activeEditor: activeEditor
      ? getEditorInfo(activeEditor)
      : fallbackSelection
        ? getEditorInfoFromSelection(api, fallbackSelection)
        : undefined,
    selection: activeEditor
      ? captureSelectionStatus(activeEditor)
      : fallbackSelection
        ? getSelectionStatus(fallbackSelection)
        : undefined,
    diagnostics: activeEditor
      ? getDiagnosticSummary(api, api.getDiagnostics(activeEditor.document.uri))
      : fallbackUri
        ? getDiagnosticSummary(api, api.getDiagnostics(fallbackUri))
        : getDiagnosticSummary(api, []),
  };
}

function getEditorInfoFromSelection(api: VscodeApis, selection: BridgeState["latestSelection"]): BridgeEditorInfo {
  const openDocument = api.getTextDocuments().find(
    (document) => document.uri.toString() === selection?.fileUri,
  );
  return {
    filePath: selection?.filePath ?? "",
    fileUri: selection?.fileUri ?? "",
    languageId: openDocument?.languageId ?? selection?.languageId ?? "",
    isDirty: openDocument?.isDirty ?? false,
    isActive: false,
  };
}

function getDiagnosticSummary(
  api: VscodeApis,
  diagnostics: readonly vscode.Diagnostic[],
): BridgeDiagnosticSummary {
  const summary = { errors: 0, warnings: 0, infos: 0, hints: 0 };
  for (const diagnostic of diagnostics) {
    switch (diagnostic.severity) {
      case api.DiagnosticSeverity.Error:
        summary.errors++;
        break;
      case api.DiagnosticSeverity.Warning:
        summary.warnings++;
        break;
      case api.DiagnosticSeverity.Information:
        summary.infos++;
        break;
      case api.DiagnosticSeverity.Hint:
        summary.hints++;
        break;
    }
  }
  return summary;
}

function getOpenEditors(api: VscodeApis) {
  const seen = new Map<string, ReturnType<typeof getEditorInfo>>();
  for (const editor of api.getVisibleEditors()) {
    if (editor.document.uri.scheme !== "file") continue;
    seen.set(editor.document.uri.toString(), getEditorInfo(editor));
  }
  for (const document of api.getTextDocuments()) {
    if (document.uri.scheme !== "file") continue;
    if (seen.has(document.uri.toString())) continue;
    seen.set(document.uri.toString(), {
      filePath: document.uri.fsPath,
      fileUri: document.uri.toString(),
      languageId: document.languageId,
      isDirty: document.isDirty,
      isActive: api.getActiveEditor()?.document.uri.toString() === document.uri.toString(),
    });
  }
  return [...seen.values()];
}

function getDiagnosticsResult(api: VscodeApis, filePath?: string) {
  const entries = filePath
    ? [[getFileUri(filePath), api.getDiagnostics(getFileUri(filePath))] as const]
    : api.getDiagnostics();

  return entries.map(([uri, diagnostics]) => ({
    filePath: uri.fsPath,
    fileUri: uri.toString(),
    diagnostics: diagnostics.map((diagnostic) => serializeDiagnostic(diagnostic)),
  }));
}

async function openFile(api: VscodeApis, params: Record<string, unknown>) {
  const uri = getFileUri(readRequiredString(params.filePath, "filePath"));
  const document = await api.openTextDocument(uri);
  const editor = await api.showTextDocument(document, {
    preview: readOptionalBoolean(params.preview) ?? false,
    preserveFocus: readOptionalBoolean(params.preserveFocus) ?? false,
  });

  const selection = readSelection(params.selection);
  if (selection) {
    const range = new api.Range(selection.start, selection.end);
    editor.selection = new api.Selection(range.start, range.end);
    editor.revealRange(range, api.TextEditorRevealType.InCenter);
  }

  return {
    opened: true,
    filePath: document.uri.fsPath,
    fileUri: document.uri.toString(),
    selection: captureSelection(editor),
  };
}

function checkDocumentDirty(api: VscodeApis, params: Record<string, unknown>) {
  const uri = getFileUri(readRequiredString(params.filePath, "filePath"));
  const document = api
    .getTextDocuments()
    .find((entry) => entry.uri.toString() === uri.toString());
  return {
    filePath: uri.fsPath,
    fileUri: uri.toString(),
    isOpen: !!document,
    isDirty: document?.isDirty ?? false,
  };
}

async function saveDocument(api: VscodeApis, params: Record<string, unknown>) {
  const uri = getFileUri(assertWritePathInWorkspace(readRequiredString(params.filePath, "filePath")));
  const document =
    api.getTextDocuments().find((entry) => entry.uri.toString() === uri.toString()) ??
    (await api.openTextDocument(uri));
  return {
    filePath: document.uri.fsPath,
    fileUri: document.uri.toString(),
    wasDirty: document.isDirty,
    saved: await document.save(),
    isDirty: document.isDirty,
  };
}

async function getDocumentSymbols(api: VscodeApis, params: Record<string, unknown>) {
  const uri = getFileUri(readRequiredString(params.filePath, "filePath"));
  const result = await api.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
    "vscode.executeDocumentSymbolProvider",
    uri,
  );
  return {
    filePath: uri.fsPath,
    fileUri: uri.toString(),
    symbols: (result ?? []).map((symbol) => serializeSymbol(symbol)),
  };
}

async function getHover(api: VscodeApis, params: Record<string, unknown>) {
  const filePath = readRequiredString(params.filePath, "filePath");
  const position = readRequiredPosition(params.position, "position");
  const uri = getFileUri(filePath);
  const result = await api.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    uri,
    position,
  );
  return {
    filePath: uri.fsPath,
    fileUri: uri.toString(),
    position: serializePosition(position),
    hovers: (result ?? []).map((hover) => serializeHover(hover)),
  };
}

async function getWorkspaceSymbols(api: VscodeApis, params: Record<string, unknown>) {
  const query = readRequiredString(params.query, "query");
  const result = await api.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    query,
  );
  return {
    query,
    symbols: (result ?? []).map((symbol) => serializeSymbol(symbol)),
  };
}

async function getReferences(api: VscodeApis, params: Record<string, unknown>) {
  const filePath = readRequiredString(params.filePath, "filePath");
  const position = readRequiredPosition(params.position, "position");
  const uri = getFileUri(filePath);
  const result = await api.executeCommand<vscode.Location[]>(
    "vscode.executeReferenceProvider",
    uri,
    position,
  );
  return {
    filePath: uri.fsPath,
    fileUri: uri.toString(),
    position: serializePosition(position),
    references: (result ?? []).map((location) => serializeLocation(location)),
  };
}

async function getLocationResults(
  api: VscodeApis,
  params: Record<string, unknown>,
  command: string,
  resultKey: string,
) {
  const filePath = readRequiredString(params.filePath, "filePath");
  const position = readRequiredPosition(params.position, "position");
  const uri = getFileUri(filePath);
  const result = await api.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    command,
    uri,
    position,
  );
  return {
    filePath: uri.fsPath,
    fileUri: uri.toString(),
    position: serializePosition(position),
    [resultKey]: (result ?? []).map((location) => serializeLocationLike(location)),
  };
}

async function getCodeActions(api: VscodeApis, params: Record<string, unknown>, state: BridgeState) {
  const filePath = readRequiredString(params.filePath, "filePath");
  const uri = getFileUri(filePath);
  const selection = readSelection(params.selection);
  const range = selection
    ? new api.Range(selection.start, selection.end)
    : new api.Range(
        readRequiredPosition(params.start, "start"),
        readRequiredPosition(params.end, "end"),
      );
  const diagnostics = api
    .getDiagnostics(uri)
    .filter((diagnostic) => diagnostic.range.intersection(range));
  const result = await api.executeCommand<(vscode.Command | vscode.CodeAction)[]>(
    "vscode.executeCodeActionProvider",
    uri,
    range,
  );
  return {
    filePath: uri.fsPath,
    fileUri: uri.toString(),
    range: serializeRange(range),
    diagnostics: diagnostics.map((diagnostic) => serializeDiagnostic(diagnostic)),
    actions: (result ?? []).map((action) =>
      serializeCodeAction(action, state.cacheCodeAction(action, filePath)),
    ),
  };
}

async function executeCodeAction(api: VscodeApis, params: Record<string, unknown>, state: BridgeState) {
  const actionId = readRequiredString(params.actionId, "actionId");
  const cached = state.codeActions.get(actionId);
  if (!cached) throw new Error(`Unknown or expired code action id: ${actionId}`);

  const { action } = cached;
  let editApplied = false;
  let commandExecuted = false;

  if (action instanceof api.CodeAction) {
    if (action.edit) editApplied = await api.applyWorkspaceEdit(action.edit);
    if (action.command) {
      await api.executeCommand(
        action.command.command,
        ...(action.command.arguments ?? []),
      );
      commandExecuted = true;
    }
  } else {
    await api.executeCommand(action.command, ...(action.arguments ?? []));
    commandExecuted = true;
  }

  state.codeActions.delete(actionId);
  return {
    actionId,
    filePath: cached.filePath,
    title: action.title,
    editApplied,
    commandExecuted,
  };
}

async function applyWorkspaceEdit(api: VscodeApis, params: Record<string, unknown>) {
  const edits = readWorkspaceEditEntries(params.edits);
  for (const edit of edits) {
    assertWritePathInWorkspace(edit.filePath);
  }
  const workspaceEdit = new api.WorkspaceEdit();
  for (const edit of edits) {
    workspaceEdit.replace(getFileUri(edit.filePath), createRange(edit.range), edit.newText);
  }
  return {
    applied: await api.applyWorkspaceEdit(workspaceEdit),
    edits: edits.map((edit) => ({ filePath: getFileUri(edit.filePath).fsPath, range: edit.range })),
  };
}

async function formatDocument(api: VscodeApis, params: Record<string, unknown>) {
  const uri = getFileUri(assertWritePathInWorkspace(readRequiredString(params.filePath, "filePath")));
  const options = (await getFormattingOptions(api, uri)) ?? {};
  const result =
    (await api.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider",
      uri,
      options,
    )) ?? [];

  return applyFormattingEdits(api, uri, result);
}

async function formatRange(api: VscodeApis, params: Record<string, unknown>) {
  const uri = getFileUri(assertWritePathInWorkspace(readRequiredString(params.filePath, "filePath")));
  const selection = readSelection(params.selection);
  const range = selection
    ? new api.Range(selection.start, selection.end)
    : new api.Range(
        readRequiredPosition(params.start, "start"),
        readRequiredPosition(params.end, "end"),
      );
  const options = (await getFormattingOptions(api, uri)) ?? {};
  const result =
    (await api.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatRangeProvider",
      uri,
      range,
      options,
    )) ?? [];

  return applyFormattingEdits(api, uri, result, range);
}

function getNotifications(params: Record<string, unknown>, state: BridgeState) {
  const since = readOptionalNumber(params.since);
  const limit = Math.max(1, Math.min(readOptionalNumber(params.limit) ?? 20, 100));
  const notifications = state.notifications.filter((entry) =>
    since ? entry.timestamp > since : true,
  );
  return {
    notifications: notifications.slice(-limit),
    latestTimestamp: state.notifications.at(-1)?.timestamp,
  };
}

function clearNotifications(state: BridgeState) {
  const cleared = state.notifications.length;
  state.notifications.length = 0;
  return { cleared };
}

async function showNotification(api: VscodeApis, params: Record<string, unknown>) {
  const message = readRequiredString(params.message, "message");
  const type = readOptionalString(params.type) ?? "info";
  const modal = readOptionalBoolean(params.modal) ?? false;

  switch (type) {
    case "info":
      await api.showInformationMessage(message, { modal });
      break;
    case "warning":
      await api.showWarningMessage(message, { modal });
      break;
    case "error":
      await api.showErrorMessage(message, { modal });
      break;
    default:
      throw new Error(`Invalid notification type: ${type}`);
  }

  return { shown: true, type, modal, message };
}

async function getFormattingOptions(api: VscodeApis, uri: vscode.Uri) {
  const document =
    api.getTextDocuments().find((entry) => entry.uri.toString() === uri.toString()) ??
    (await api.openTextDocument(uri));

  return {
    insertSpaces: getEditorInsertSpaces(api, document),
    tabSize: getEditorTabSize(api, document),
  };
}

async function applyFormattingEdits(api: VscodeApis, uri: vscode.Uri, edits: vscode.TextEdit[], range?: vscode.Range) {
  const workspaceEdit = new api.WorkspaceEdit();
  for (const edit of edits) workspaceEdit.replace(uri, edit.range, edit.newText);

  return {
    filePath: uri.fsPath,
    fileUri: uri.toString(),
    range: range ? serializeRange(range) : undefined,
    editCount: edits.length,
    edits: edits.map((edit) => ({ range: serializeRange(edit.range), newText: edit.newText })),
    applied: edits.length > 0 ? await api.applyWorkspaceEdit(workspaceEdit) : true,
  };
}

function getEditorInsertSpaces(api: VscodeApis, document: vscode.TextDocument) {
  return api.getConfiguration("editor", document).get<boolean>("insertSpaces") ?? true;
}

function getEditorTabSize(api: VscodeApis, document: vscode.TextDocument) {
  return api.getConfiguration("editor", document).get<number>("tabSize") ?? 2;
}
