// Use a custom uri scheme to store
// vscode does not provide API to modify file content
// so we need to create a virtual file to host replacement preview
// and call the vscode.diff command to display the replacement.
// See relevant comments for TextDocumentContentProvider
// custom scheme comes from https://stackoverflow.com/a/69384899/2198656
import {
  CancellationToken,
  ExtensionContext,
  Position,
  Range,
  TextDocument,
  TextDocumentContentProvider,
  Uri,
  commands,
  window,
  workspace,
  TextEditorRevealType,
  TabInputTextDiff,
} from 'vscode'
import type {
  ChildToParent,
  DisplayResult,
  SearchQuery,
  SgSearch,
} from '../types'
import { parentPort, streamedPromise } from './common'
import { buildCommand, splitByHighLightToken } from './search'
import path from 'path'

const SCHEME = 'sgpreview'
let lastPattern = ''
let lastRewrite = ''

/**
 * NB A file will only have one preview at a time
 * last rewrite will replace older rewrites
 * key: path, value: string content
 **/
const previewContents: Map<string, string> = new Map()

class AstGrepPreviewProvider implements TextDocumentContentProvider {
  // TODO: add cancellation
  provideTextDocumentContent(uri: Uri, _token: CancellationToken): string {
    return previewContents.get(uri.path) || ''
  }
}
const previewProvider = new AstGrepPreviewProvider()

function isSgPreviewUri(uri: Uri) {
  return uri.scheme === SCHEME
}

function cleanupDocument(doc: TextDocument) {
  const uri = doc.uri
  if (!isSgPreviewUri(uri)) {
    return
  }
  previewContents.delete(uri.path)
}

function workspaceUriFromFilePath(filePath: string) {
  const uris = workspace.workspaceFolders
  const { joinPath } = Uri
  if (!uris?.length) {
    return
  }
  return joinPath(uris?.[0].uri, filePath)
}

function locationToRange(
  locations: ChildToParent['previewDiff']['locationsToSelect'],
) {
  const { start, end } = locations
  return new Range(
    new Position(start.line, start.column),
    new Position(end.line, end.column),
  )
}

function openFile({ filePath, locationsToSelect }: ChildToParent['openFile']) {
  const fileUri = workspaceUriFromFilePath(filePath)
  if (!fileUri) {
    return
  }
  const range = locationToRange(locationsToSelect)
  commands.executeCommand('vscode.open', fileUri, {
    selection: range,
    preserveFocus: true,
  })
}

async function previewDiff({
  filePath,
  locationsToSelect,
  inputValue,
  rewrite,
}: ChildToParent['previewDiff']) {
  const fileUri = workspaceUriFromFilePath(filePath)
  if (!fileUri) {
    return
  }
  await generatePreview(fileUri, inputValue, rewrite)
  const previewUri = fileUri.with({ scheme: SCHEME })
  const filename = path.basename(filePath)
  // https://github.com/microsoft/vscode/blob/d63202a5382aa104f5515ea09053a2a21a2587c6/src/vs/workbench/api/common/extHostApiCommands.ts#L422
  await commands.executeCommand(
    'vscode.diff',
    fileUri,
    previewUri,
    `${filename} ↔ ${filename} (Replace Preview)`,
    {
      preserveFocus: true,
    },
  )
  const range = locationToRange(locationsToSelect)
  window.activeTextEditor?.revealRange(range, TextEditorRevealType.InCenter)
}
function closeAllDiffs() {
  console.debug('Search pattern changed. Closing all diffs.')
  const tabs = window.tabGroups.all.flatMap(tg => tg.tabs)
  for (const tab of tabs) {
    const input = tab.input
    if (input instanceof TabInputTextDiff && isSgPreviewUri(input.modified)) {
      window.tabGroups.close(tab)
    }
  }
}

function refreshDiff(query: SearchQuery) {
  try {
    if (query.inputValue !== lastPattern) {
      closeAllDiffs()
      return
    }
    if (query.rewrite === lastRewrite) {
      return
    }
    // TODO: refresh diff content!
    closeAllDiffs()
  } finally {
    // use finally to ensure updated
    lastPattern = query.inputValue
    lastRewrite = query.rewrite
  }
}
parentPort.onMessage('openFile', openFile)
parentPort.onMessage('previewDiff', previewDiff)
parentPort.onMessage('search', refreshDiff)
parentPort.onMessage('commitChange', onCommitChange)

async function onCommitChange(payload: ChildToParent['commitChange']) {
  const { filePath, inputValue, rewrite } = payload
  const fileUri = workspaceUriFromFilePath(filePath)
  if (!fileUri) {
    return
  }
  await doChange(fileUri, payload)
  // TODO: we can use Promise.all after preview has onChange event
  await refreshSearchResult(payload.id, fileUri, {
    inputValue,
    rewrite,
    includeFile: filePath,
  })
}

async function doChange(
  fileUri: Uri,
  { changes }: ChildToParent['commitChange'],
) {
  const bytes = await workspace.fs.readFile(fileUri)
  const { receiveResult, conclude } = bufferMaker(bytes)
  for (const { range, replacement } of changes) {
    receiveResult(replacement, range.byteOffset)
  }
  const final = conclude()
  await workspace.fs.writeFile(fileUri, final)
}

async function refreshSearchResult(
  id: number,
  fileUri: Uri,
  query: SearchQuery,
) {
  const command = buildCommand({
    pattern: query.inputValue,
    rewrite: query.rewrite,
    includeFiles: [query.includeFile],
  })
  const bytes = await workspace.fs.readFile(fileUri)
  const { receiveResult, conclude } = bufferMaker(bytes)
  const updatedResults: DisplayResult[] = []
  await streamedPromise(command!, (results: SgSearch[]) => {
    for (const r of results) {
      receiveResult(r.replacement!, r.range.byteOffset)
      updatedResults.push(splitByHighLightToken(r))
    }
  })
  const final = conclude()
  const replaced = new TextDecoder('utf-8').decode(final)
  previewContents.set(fileUri.path, replaced)
  parentPort.postMessage('refreshSearchResult', {
    id,
    updatedResults,
    fileName: query.includeFile,
  })
}

/**
 *  set up replace preview and open file
 **/
export function activatePreview({ subscriptions }: ExtensionContext) {
  subscriptions.push(
    workspace.registerTextDocumentContentProvider(SCHEME, previewProvider),
    workspace.onDidCloseTextDocument(cleanupDocument),
  )
}

interface ReplaceArg {
  bytes: Uint8Array
  uri: Uri
  inputValue: string
  rewrite: string
}

function bufferMaker(bytes: Uint8Array) {
  const encoder = new TextEncoder()
  let newBuffer = new Uint8Array(bytes.byteLength)
  let srcOffset = 0
  let destOffset = 0
  function resizeBuffer() {
    const temp = new Uint8Array(newBuffer.byteLength * 2)
    temp.set(newBuffer)
    newBuffer = temp
  }
  function receiveResult(
    replace: string,
    byteOffset: { start: number; end: number },
  ) {
    // skip overlapping replacement
    if (byteOffset.start < srcOffset) {
      return
    }
    const slice = bytes.slice(srcOffset, byteOffset.start)
    const replacement = encoder.encode(replace)
    const expectedLength =
      destOffset + slice.byteLength + replacement.byteLength
    while (expectedLength > newBuffer.byteLength) {
      resizeBuffer()
    }
    newBuffer.set(slice, destOffset)
    destOffset += slice.byteLength
    newBuffer.set(replacement, destOffset)
    destOffset += replacement.byteLength
    srcOffset = byteOffset.end
  }
  function conclude() {
    const slice = bytes.slice(srcOffset, bytes.byteLength)
    while (destOffset + slice.byteLength > newBuffer.byteLength) {
      resizeBuffer()
    }
    newBuffer.set(slice, destOffset)
    return newBuffer.slice(0, destOffset + slice.byteLength)
  }
  return {
    receiveResult,
    conclude,
  }
}

async function haveReplace({ bytes, uri, inputValue, rewrite }: ReplaceArg) {
  const command = buildCommand({
    pattern: inputValue,
    rewrite: rewrite,
    includeFiles: [uri.fsPath],
  })
  const { receiveResult, conclude } = bufferMaker(bytes)
  await streamedPromise(command!, (results: SgSearch[]) => {
    for (const r of results) {
      receiveResult(r.replacement!, r.range.byteOffset)
    }
  })
  const final = conclude()
  return new TextDecoder('utf-8').decode(final)
}

async function generatePreview(uri: Uri, inputValue: string, rewrite: string) {
  if (previewContents.has(uri.path)) {
    return
  }
  // TODO, maybe we also need a rewrite change event?
  const bytes = await workspace.fs.readFile(uri)
  const replaced = await haveReplace({
    bytes,
    uri,
    inputValue,
    rewrite,
  })
  previewContents.set(uri.path, replaced)
}
