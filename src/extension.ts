import * as vscode from 'vscode';
import { createPreview, extractSymbolsFromLine, findAllWordHits } from './core/analysis';

export function activate(context: vscode.ExtensionContext) {
  console.log(`${timestamp()} [info] Activating extension code-explorer-pro`);
  const logger = vscode.window.createOutputChannel('Code Explorer Pro');
  const provider = new ReferencesProvider(logger);
  vscode.window.registerTreeDataProvider('codeExplorerProReferences', provider);

  context.subscriptions.push(
    logger,
    vscode.commands.registerCommand('code-explorer-pro.findRecursiveReferences', () => {
      console.log(`${timestamp()} [info] Command invoked: code-explorer-pro.findRecursiveReferences`);
      provider.findRecursiveReferences();
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

  private roots: SymbolNode[] = [];
  private cache = new Map<string, ReferenceLineNode[]>();

  constructor(private logger: vscode.OutputChannel) {}

  findRecursiveReferences() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.logger.appendLine('[WARN] No active editor');
      console.log(`${timestamp()} [warn] No active editor`);
      return;
    }

    const position = editor.selection.active;
    const wordRange = editor.document.getWordRangeAtPosition(position);
    if (!wordRange) {
      vscode.window.showInformationMessage('No symbol at cursor');
      this.logger.appendLine('[INFO] No word range at cursor');
      console.log(`${timestamp()} [info] No symbol found at cursor`);
      return;
    }

    const symbol = editor.document.getText(wordRange);
    this.logger.appendLine(`[START] Root search for symbol: ${symbol}`);
    console.log(`${timestamp()} [info] Root search for symbol: ${symbol}`);
    const root = new SymbolNode(symbol, undefined, this.logger);
    this.roots = [root];
    this._onDidChangeTreeData.fire(undefined);
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
    if (element instanceof SymbolNode) {
      if (!element.children) {
        await this.expandSymbol(element);
      }
      return element.children ?? [];
    }
    if (element instanceof ReferenceLineNode) {
      return element.symbolChildren;
    }
    return [];
  }

  getRoots(): SymbolNode[] {
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

type TreeNode = SymbolNode | ReferenceLineNode | InlineSymbolNode;

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
  const includeGlob = '{**/*.ts,**/*.tsx,**/*.js,**/*.jsx,**/*.mjs,**/*.cjs}';
  const exclude = '**/{node_modules,dist,out,build,.git}/**';
  logger.appendLine(`[SEARCH] Manual scan for symbol="${symbol}" include="${includeGlob}"`);

  const files = await vscode.workspace.findFiles(includeGlob, exclude, 500);
  for (const uri of files) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      for (let lineNum = 0; lineNum < Math.min(doc.lineCount, 5000); lineNum++) {
        const text = doc.lineAt(lineNum).text;
        const matches = findAllWordHits(text, symbol);
        for (const startCol of matches) {
          const range = new vscode.Range(new vscode.Position(lineNum, startCol), new vscode.Position(lineNum, startCol + symbol.length));
          const preview = createPreview(text, range.start.character, symbol.length);
          const node = new ReferenceLineNode(new vscode.Location(uri, range), preview, symbol);
          node.symbolChildren = extractSymbolsFromLine(text, symbol).map(s => new InlineSymbolNode(s, node));
          results.push(node);
        }
      }
    } catch (e) {
      logger.appendLine(`[WARN] Failed to scan ${uri.fsPath}: ${String(e)}`);
    }
  }

  logger.appendLine(`[RESULT] ${results.length} references for ${symbol}`);
  return results;
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
