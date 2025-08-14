import * as vscode from 'vscode';
import { createPreview, extractSymbolsFromLine, findAllWordHits, findAllTextHits } from './core/analysis';

export function activate(context: vscode.ExtensionContext) {
  console.log(`${timestamp()} [info] Activating extension code-explorer-pro`);
  const logger = vscode.window.createOutputChannel('Code Explorer Pro');
  const provider = new ReferencesProvider(logger);
  const treeView = vscode.window.createTreeView('codeExplorerProReferences', { treeDataProvider: provider });
  provider.attachView(treeView);

  context.subscriptions.push(
    logger,
    treeView,
    vscode.commands.registerCommand('code-explorer-pro.findRecursiveReferences', async () => {
      console.log(`${timestamp()} [info] Command invoked: code-explorer-pro.findRecursiveReferences`);
      await provider.findRecursiveReferences();
    }),
    vscode.commands.registerCommand('code-explorer-pro.openLocation', (location: vscode.Location) => {
      console.log(`${timestamp()} [info] Command invoked: code-explorer-pro.openLocation -> ${location.uri.fsPath}:${location.range.start.line + 1}`);
      openLocation(location, logger);
    }),
    vscode.commands.registerCommand('code-explorer-pro.expandSymbol', async (node: SymbolNode) => {
      console.log(`${timestamp()} [info] Command invoked: code-explorer-pro.expandSymbol -> ${node.symbol}`);
      await provider.expandSymbol(node);
    }),
    // Hidden internal command for tests
    vscode.commands.registerCommand('code-explorer-pro._getTreeRoots', () => provider.getRoots()),
    vscode.commands.registerCommand('code-explorer-pro._expandAndSummarize', async (symbol: string) => {
      return provider.expandAndSummarize(symbol);
    })
  );
}

export function deactivate() {
  // noop
}

class ReferencesProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: FileGroupNode[] = [];
  private cache = new Map<string, ReferenceLineNode[]>();
  private view?: vscode.TreeView<TreeNode>;
  private selectionHandler?: vscode.Disposable;

  constructor(private logger: vscode.OutputChannel) {}

  attachView(view: vscode.TreeView<TreeNode>) {
    this.view = view;
    // Open editor when a line item is selected (label click). Chevron still handles expand/collapse.
    this.selectionHandler?.dispose();
    this.selectionHandler = view.onDidChangeSelection(async (e) => {
      const node = e.selection?.[0];
      if (node instanceof ReferenceLineNode) {
        await openLocation(node.location, this.logger);
      }
    });
  }

  async findRecursiveReferences() {
    const editor = vscode.window.activeTextEditor;
    let defaultText = '';
    if (editor) {
      const sel = editor.selection;
      if (sel && !sel.isEmpty) {
        defaultText = editor.document.getText(sel).trim();
      } else {
        const position = sel?.active ?? editor.selection.active;
        const wordRange = editor.document.getWordRangeAtPosition(position);
        if (wordRange) defaultText = editor.document.getText(wordRange);
      }
    }

    let symbol = defaultText.trim();
    if (!symbol) {
      const query = await vscode.window.showInputBox({
        prompt: 'Search project (free text)',
        placeHolder: 'Enter text to search',
        value: defaultText,
        ignoreFocusOut: true
      });

      symbol = (query ?? '').trim();
      if (!symbol) {
        vscode.window.showInformationMessage('No search text provided');
        this.logger.appendLine('[INFO] No search text provided');
        console.log(`${timestamp()} [info] No search text provided`);
        return;
      }
    }

    this.logger.appendLine(`[START] Search for text: ${symbol}`);
    console.log(`${timestamp()} [info] Root search for symbol: ${symbol}`);
    // Update view title with the query
    if (this.view) {
      this.view.title = `References for "${symbol}"`;
    }
    // Perform search, then group results by file at the root level
    const lines = await findReferencesByText(symbol, this.logger);
    const byFile = new Map<string, ReferenceLineNode[]>();
    for (const node of lines) {
      const key = node.location.uri.fsPath;
      const arr = byFile.get(key) ?? [];
      arr.push(node);
      byFile.set(key, arr);
    }
    const groups: FileGroupNode[] = [];
    for (const [fsPath, children] of byFile) {
      const label = vscode.workspace.asRelativePath(fsPath);
      // Update child labels to avoid repeating file path inside the group
      for (const ch of children) {
        const ln = ch.location.range.start.line + 1;
        ch.label = `${ln}  ${ch.preview.trim()}`;
        ch.tooltip = `${vscode.workspace.asRelativePath(ch.location.uri)}:${ln}  ${ch.preview.trim()}`;
      }
      groups.push(new FileGroupNode(label, children));
    }
    // Sort groups by label for stable order
    groups.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    this.roots = groups;
    this._onDidChangeTreeData.fire(undefined);
    // Bring the view into focus so users see results immediately
    try {
      await vscode.commands.executeCommand('codeExplorerProReferences.focus');
    } catch {
      // ignore if command not available in this VS Code version
    }
  }

  async expandSymbol(node: SymbolNode) {
    this.logger.appendLine(`[EXPAND] Symbol: ${node.symbol}`);
    console.log(`${timestamp()} [info] Expand symbol: ${node.symbol}`);
    if (this.cache.has(node.symbol)) {
      node.children = this.cache.get(node.symbol)!;
      this._onDidChangeTreeData.fire(node);
      return;
    }
    const lines = await findReferencesByText(node.symbol, this.logger);
    this.cache.set(node.symbol, lines);
    node.children = lines;
    this._onDidChangeTreeData.fire(node);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return this.roots;
    }
    if (element instanceof FileGroupNode) {
      return element.children;
    }
    if (element instanceof SymbolNode) {
      this.logger.appendLine(`[CHEVRON] Symbol expand requested: ${element.symbol}`);
      console.log(`${timestamp()} [info] Chevron expand: symbol -> ${element.symbol}`);
      if (!element.children) {
        await this.expandSymbol(element);
      }
      this.logger.appendLine(`[CHILDREN] Symbol ${element.symbol} -> ${(element.children ?? []).length} items`);
      return element.children ?? [];
    }
    if (element instanceof ReferenceLineNode) {
      this.logger.appendLine(`[CHEVRON] Reference expand requested: ${element.label}`);
      console.log(`${timestamp()} [info] Chevron expand: reference -> ${element.label}`);
      return element.symbolChildren;
    }
    if (element instanceof InlineSymbolNode) {
      // Support expanding inline symbols via chevron (without invoking the command)
      this.logger.appendLine(`[EXPAND] Inline symbol via chevron: ${element.symbol}`);
      console.log(`${timestamp()} [info] Expand inline via chevron: ${element.symbol}`);
      const temp = new SymbolNode(element.symbol, element.parentRef, this.logger);
      await this.expandSymbol(temp);
      return temp.children ?? [];
    }
    return [];
  }

  getRoots(): FileGroupNode[] {
    return this.roots;
  }

  async expandAndSummarize(symbol: string): Promise<Array<{ label: string; inlineSymbols: string[] }>> {
    const node = new SymbolNode(symbol, undefined, this.logger);
    await this.expandSymbol(node);
    const children = node.children ?? [];
    return children.map(ch => ({
      label: String(ch.label ?? ''),
      inlineSymbols: ch.symbolChildren.map(s => s.symbol)
    }));
  }
}

type TreeNode = SymbolNode | FileGroupNode | ReferenceLineNode | InlineSymbolNode;

class SymbolNode extends vscode.TreeItem {
  public children?: ReferenceLineNode[];
  constructor(public readonly symbol: string, public parent?: ReferenceLineNode, private logger?: vscode.OutputChannel) {
    super(symbol, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'symbol';
    this.description = 'symbol';
    this.iconPath = new vscode.ThemeIcon('symbol-key');
    this.command = {
      title: 'Expand Symbol',
      command: 'code-explorer-pro.expandSymbol',
      arguments: [this]
    };
    this.tooltip = `Search references for: ${symbol}`;
  }
}

class FileGroupNode extends vscode.TreeItem {
  constructor(public readonly label: string, public readonly children: ReferenceLineNode[]) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'fileGroup';
    this.iconPath = new vscode.ThemeIcon('file');
    this.tooltip = label;
  }
}

class ReferenceLineNode extends vscode.TreeItem {
  public symbolChildren: InlineSymbolNode[] = [];
  constructor(
    public readonly location: vscode.Location,
    public readonly preview: string,
    public readonly matchedSymbol: string
  ) {
    super(`${vscode.workspace.asRelativePath(location.uri)}:${location.range.start.line + 1}  ${preview.trim()}`,
      vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'referenceLine';
    this.iconPath = new vscode.ThemeIcon('link');
    this.tooltip = this.label?.toString();
    this.command = {
      title: 'Open Location',
      command: 'code-explorer-pro.openLocation',
      arguments: [location]
    };
  }
}

class InlineSymbolNode extends vscode.TreeItem {
  constructor(public readonly symbol: string, public parentRef: ReferenceLineNode) {
    super(symbol, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'inlineSymbol';
    this.iconPath = new vscode.ThemeIcon('symbol-variable');
    this.tooltip = `Find references for ${symbol}`;
    this.command = {
      title: 'Expand Symbol',
      command: 'code-explorer-pro.expandSymbol',
      arguments: [new SymbolNode(symbol, parentRef)]
    };
  }
}

async function openLocation(location: vscode.Location, logger: vscode.OutputChannel) {
  try {
    const doc = await vscode.workspace.openTextDocument(location.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    editor.revealRange(location.range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(location.range.start, location.range.start);
    logger.appendLine(`[NAVIGATE] Opened ${location.uri.fsPath}:${location.range.start.line + 1}`);
  } catch (err) {
    logger.appendLine(`[ERROR] openLocation: ${String(err)}`);
  }
}

async function findReferencesByText(symbol: string, logger: vscode.OutputChannel): Promise<ReferenceLineNode[]> {
  const results: ReferenceLineNode[] = [];
  const cfg = vscode.workspace.getConfiguration('codeExplorerPro');
  const includeGlob = cfg.get<string>('includeGlob', '**/*');
  const exclude = cfg.get<string>('excludeGlob', '**/{node_modules,dist,out,build,.git,.venv,venv,.tox,.cache}/**');
  const maxSearchMs = cfg.get<number>('maxSearchMs', 15000);
  const verbose = cfg.get<boolean>('verboseLogging', false);
  const matchMode = cfg.get<'word' | 'text'>('matchMode', 'text');
  const maxFiles = cfg.get<number>('maxFiles', 1000);
  const maxLinesPerFile = cfg.get<number>('maxLinesPerFile', 10000);
  const progressEvery = cfg.get<number>('progressEvery', 50);

  logger.appendLine(`[SEARCH] Fast manual scan for text="${symbol}" include="${includeGlob}" exclude="${exclude}"`);
  console.log(`${timestamp()} [info] [SEARCH] fast-manual text="${symbol}"`);
  const t0 = Date.now();

  // Precompile matcher
  const wordRegex = matchMode === 'word' ? new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(symbol)}(?![A-Za-z0-9_])`, 'g') : undefined;

  // Collect files
  let files: vscode.Uri[] = [];
  try {
    files = await vscode.workspace.findFiles(includeGlob, exclude, maxFiles);
  } catch (e) {
    logger.appendLine(`[ERROR] findFiles failed: ${String(e)}`);
    return results;
  }

  const cts = new vscode.CancellationTokenSource();
  const timeout = setTimeout(() => {
    logger.appendLine(`[ABORT] Search timeout after ${Date.now() - t0}ms, returning partial results (${results.length})`);
    cts.cancel();
  }, maxSearchMs);

  // Concurrency-limited processing
  const concurrency = 8;
  let idx = 0;
  let processed = 0;
  async function worker() {
    while (!cts.token.isCancellationRequested) {
      const myIdx = idx++;
      if (myIdx >= files.length) break;
      const uri = files[myIdx];
      try {
        const buf = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(buf).toString('utf8');
        const lines = text.split(/\r?\n/);
        const limit = Math.min(lines.length, maxLinesPerFile);
        let fileHits = 0;
        for (let lineNum = 0; lineNum < limit; lineNum++) {
          const line = lines[lineNum];
          if (!line) continue;
          if (matchMode === 'word') {
            wordRegex!.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = wordRegex!.exec(line)) !== null) {
              const startCol = m.index;
              const range = new vscode.Range(new vscode.Position(lineNum, startCol), new vscode.Position(lineNum, startCol + symbol.length));
              const preview = createPreview(line, startCol, symbol.length);
              const node = new ReferenceLineNode(new vscode.Location(uri, range), preview, symbol);
              node.symbolChildren = extractSymbolsFromLine(line, symbol).map(s => new InlineSymbolNode(s, node));
              results.push(node);
              fileHits++;
            }
          } else {
            let from = 0;
            while (true) {
              const idxFound = line.indexOf(symbol, from);
              if (idxFound === -1) break;
              const startCol = idxFound;
              const range = new vscode.Range(new vscode.Position(lineNum, startCol), new vscode.Position(lineNum, startCol + symbol.length));
              const preview = createPreview(line, startCol, symbol.length);
              const node = new ReferenceLineNode(new vscode.Location(uri, range), preview, symbol);
              node.symbolChildren = extractSymbolsFromLine(line, symbol).map(s => new InlineSymbolNode(s, node));
              results.push(node);
              fileHits++;
              from = idxFound + symbol.length;
            }
          }
        }
        if (fileHits > 0 || verbose) {
          logger.appendLine(`[FILE] ${vscode.workspace.asRelativePath(uri)} hits=${fileHits} scannedLines=${Math.min(lines.length, maxLinesPerFile)}`);
        }
      } catch (e) {
        logger.appendLine(`[WARN] Failed to scan ${uri.fsPath}: ${String(e)}`);
      }
      processed++;
      if (processed % progressEvery === 0) {
        const elapsed = Date.now() - t0;
        console.log(`${timestamp()} [info] [PROGRESS] ${processed}/${files.length} results=${results.length} elapsedMs=${elapsed}`);
      }
      if (Date.now() - t0 > maxSearchMs) {
        logger.appendLine(`[ABORT] Search timeout during processing after ${Date.now() - t0}ms, returning partial results (${results.length})`);
        break;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);

  clearTimeout(timeout);
  const totalMs = Date.now() - t0;
  if (verbose) {
    logger.appendLine(`[RESULT] ${results.length} references for ${symbol} in ${totalMs}ms (fast-manual)`);
  }
  console.log(`${timestamp()} [info] [RESULT] ${results.length} refs in ${totalMs}ms (fast-manual)`);
  return results;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// helpers now imported from ./core/analysis

function pad2(n: number): string { return n.toString().padStart(2, '0'); }
function pad3(n: number): string { return n.toString().padStart(3, '0'); }
function timestamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const MM = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const ms = pad3(d.getMilliseconds());
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}.${ms}`;
}
