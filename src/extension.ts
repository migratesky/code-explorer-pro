import * as vscode from 'vscode';
import * as path from 'path';
import { createPreview, extractSymbolsFromLine, findAllWordHits, findAllTextHits } from './core/analysis';
import { findReferencesParallel } from './core/parallelSearch';

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

// Streaming variant: same search flow, but emits batches as files are processed.
async function findReferencesByTextStream(
  symbol: string,
  logger: vscode.OutputChannel,
  onBatch: (batch: ReferenceLineNode[]) => void
): Promise<ReferenceLineNode[]> {
  const cfg = vscode.workspace.getConfiguration('codeExplorerPro');
  const includeGlob = cfg.get<string>('includeGlob', '**/*');
  const exclude = cfg.get<string>('excludeGlob', '**/{node_modules,dist,out,build,.git,.venv,venv,.tox,.cache}/**');
  const excludeFolders = cfg.get<string[]>('excludeFolders', []);
  const maxSearchMs = cfg.get<number>('maxSearchMs', 15000);
  const verbose = cfg.get<boolean>('verboseLogging', false);
  const matchMode = cfg.get<'word' | 'text'>('matchMode', 'text');
  const maxLinesPerFile = cfg.get<number>('maxLinesPerFile', 10000);
  const progressEvery = cfg.get<number>('progressEvery', 50);
  const excludeFileExtensions = cfg.get<string[]>('excludeFileExtensions', []);

  logger.appendLine(`[SEARCH] Streamed scan for text="${symbol}" include="${includeGlob}" exclude="${exclude}"`);
  console.log(`${timestamp()} [info] [SEARCH] streamed text="${symbol}"`);
  const t0 = Date.now();

  // Create word regex for word-based matching
  const wordRegex = matchMode === 'word' ? new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(symbol)}(?![A-Za-z0-9_])`, 'g') : undefined;

  let files: vscode.Uri[] = [];
  try {
    files = await vscode.workspace.findFiles(includeGlob, exclude);
    files = files.filter(f => !excludeFileExtensions.some(ext => f.fsPath.endsWith(ext)));    
    //filter exclude folders
    files = files.filter(f => !excludeFolders.some(g => vscode.workspace.asRelativePath(f).match(g)));
  } catch (e) {
    logger.appendLine(`[ERROR] findFiles failed: ${String(e)}`);
    return [];
  }

  // Prioritize active file
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri && activeUri.scheme === 'file') {
    const hasActive = files.some(u => u.fsPath === activeUri.fsPath);
    if (!hasActive) {
      files.unshift(activeUri);
    } else {
      files = [activeUri, ...files.filter(u => u.fsPath !== activeUri.fsPath)];
    }
  }
  
  // Use the optimized parallel search implementation
  return findReferencesParallel(symbol, files, logger, onBatch, {
    matchMode,
    maxSearchMs,
    maxLinesPerFile,
    progressEvery,
    verbose,
    wordRegex
  });
}

export function deactivate() {
  // noop
}

/**
 * Helper function to escape special regex characters
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class ReferencesProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: TreeNode[] = [];
  private cache = new Map<string, ReferenceLineNode[]>();
  private view?: vscode.TreeView<TreeNode>;
  private selectionHandler?: vscode.Disposable;

  constructor(private logger: vscode.OutputChannel) {}
  
  // TreeDataProvider interface implementation is implemented below

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
    this.logger.appendLine(`[FIND] Recursive references`);
    console.log(`${timestamp()} [info] Find recursive references`);
    
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.logger.appendLine(`[ERROR] No active editor`);
      return;
    }
    
    const position = editor.selection.active;
    const document = editor.document;
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      this.logger.appendLine(`[ERROR] No word at cursor position`);
      return;
    }
    
    const symbol = document.getText(wordRange);
    this.logger.appendLine(`[FIND] Symbol: ${symbol}`);
    console.log(`${timestamp()} [info] Symbol: ${symbol}`);
    
    // Show a message in the view while loading
    if (this.view) {
      try { (this.view as any).message = `Searching for "${symbol}"...`; } catch {}
    }
    
    // Clear previous results
    this.roots = [new BusyNode(`Searching "${symbol}"...`)];
    this._onDidChangeTreeData.fire(undefined);
    
    // Focus the tree view immediately
    if (this.view) {
      this.logger.appendLine(`[UI] Revealing tree view`);
      console.log(`${timestamp()} [info] [UI] Revealing tree view`);
      try {
        await this.view.reveal(this.roots[0], { focus: true, select: true });
      } catch (err) {
        this.logger.appendLine(`[ERROR] Failed to reveal tree view: ${String(err)}`);
      }
    }
    
    // Variables to store LSP results
    let symbolReferencesNode: SymbolReferencesNode | undefined;
    let callHierarchyNode: CallHierarchyNode | undefined;
    
    // Variables for incremental aggregation while streaming
    const byFile = new Map<string, ReferenceLineNode[]>();
    const seen = new Set<string>(); // fsPath:line:start
    const activeFsPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const activeDir = activeFsPath ? path.dirname(activeFsPath) : undefined;
    let streamingComplete = false;
    let lastUi = 0;
    const uiThrottleMs = 150; // simple throttle to avoid excessive refreshes
    
    // Try to get symbol references and call hierarchy using LSP
    try {
        // Get symbol references
        const references = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          editor.document.uri,
          position
        );
        
        if (references && references.length > 0) {
          symbolReferencesNode = new SymbolReferencesNode(symbol, references);
          // Convert locations to ReferenceLineNode objects
          for (const location of references) {
            try {
              const doc = await vscode.workspace.openTextDocument(location.uri);
              const line = doc.lineAt(location.range.start.line).text;
              const startCol = location.range.start.character;
              const preview = createPreview(line, startCol, symbol.length);
              const node = new ReferenceLineNode(location, preview, symbol);
              node.symbolChildren = extractSymbolsFromLine(line, symbol).map(s => new InlineSymbolNode(s, node));
              symbolReferencesNode.children.push(node);
            } catch (err) {
              this.logger.appendLine(`[ERROR] Failed to process reference: ${String(err)}`);
            }
          }
        }
        
        // Try to get call hierarchy using the format you suggested
        try {
          // Use let instead of const as suggested
          let callHierarchyItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            editor.document.uri,
            position
          );
          
          this.logger.appendLine(`[CALL_HIERARCHY] prepareCallHierarchy returned ${callHierarchyItems?.length || 0} items`);
          console.log(`${timestamp()} [info] [CALL_HIERARCHY] prepareCallHierarchy returned ${callHierarchyItems?.length || 0} items`);
          
          if (callHierarchyItems && callHierarchyItems.length > 0) {
            this.logger.appendLine(`[CALL_HIERARCHY] First item: ${callHierarchyItems[0].name}, kind: ${callHierarchyItems[0].kind}`);
            
            try {
              // Try the new approach using vscode.provideIncomingCalls
              this.logger.appendLine(`[CALL_HIERARCHY] Attempting to use vscode.provideIncomingCalls`);
              console.log(`${timestamp()} [info] [CALL_HIERARCHY] Attempting to use vscode.provideIncomingCalls`);
              
              try {
                // Log the call hierarchy item details for debugging
                this.logger.appendLine(`[CALL_HIERARCHY] Item details: name=${callHierarchyItems[0].name}, kind=${callHierarchyItems[0].kind}`);
                console.log(`${timestamp()} [info] [CALL_HIERARCHY] Item details: name=${callHierarchyItems[0].name}, kind=${callHierarchyItems[0].kind}`);
                
                // Use vscode.provideIncomingCalls as in your example
                let incomingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
                  'vscode.provideIncomingCalls',
                  callHierarchyItems[0]
                );
                
                this.logger.appendLine(`[CALL_HIERARCHY] provideIncomingCalls executed, got ${incomingCalls?.length || 0} incoming calls`);
                console.log(`${timestamp()} [info] [CALL_HIERARCHY] provideIncomingCalls executed, got ${incomingCalls?.length || 0} incoming calls`);
                
                if (incomingCalls && incomingCalls.length > 0) {
                  callHierarchyNode = new CallHierarchyNode(symbol, incomingCalls);
                  this.logger.appendLine(`[CALL_HIERARCHY] Created CallHierarchyNode with ${incomingCalls.length} calls`);
                } else {
                  // If no incoming calls found with provideIncomingCalls, try executeCallHierarchyIncomingCalls
                  this.logger.appendLine(`[CALL_HIERARCHY] No incoming calls found with provideIncomingCalls, trying executeCallHierarchyIncomingCalls`);
                  console.log(`${timestamp()} [info] [CALL_HIERARCHY] No incoming calls found with provideIncomingCalls, trying executeCallHierarchyIncomingCalls`);
                  
                  try {
                    incomingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
                      'vscode.executeCallHierarchyIncomingCalls',
                      callHierarchyItems[0]
                    );
                    
                    if (incomingCalls && incomingCalls.length > 0) {
                      callHierarchyNode = new CallHierarchyNode(symbol, incomingCalls);
                    } else {
                      this.logger.appendLine(`[CALL_HIERARCHY] No incoming calls found with either method, trying fallback`);
                      console.log(`${timestamp()} [info] [CALL_HIERARCHY] No incoming calls found with either method, trying fallback`);
                      callHierarchyNode = await this.useFallbackCallHierarchy(editor, symbol);
                    }
                  } catch (innerErr) {
                    this.logger.appendLine(`[CALL_HIERARCHY] executeCallHierarchyIncomingCalls failed: ${String(innerErr)}, trying fallback`);
                    console.log(`${timestamp()} [info] [CALL_HIERARCHY] executeCallHierarchyIncomingCalls failed: ${String(innerErr)}, trying fallback`);
                    callHierarchyNode = await this.useFallbackCallHierarchy(editor, symbol);
                  }
                }
              } catch (err) {
                // If the command fails, use the fallback
                this.logger.appendLine(`[CALL_HIERARCHY] provideIncomingCalls failed: ${String(err)}, using fallback`);
                console.log(`${timestamp()} [info] [CALL_HIERARCHY] provideIncomingCalls failed: ${String(err)}, using fallback`);
                
                // Use the fallback approach
                this.logger.appendLine(`[CALL_HIERARCHY] About to call useFallbackCallHierarchy`);
                console.log(`${timestamp()} [info] [CALL_HIERARCHY] About to call useFallbackCallHierarchy`);
                
                const fallbackNode = await this.useFallbackCallHierarchy(editor, symbol);
                
                this.logger.appendLine(`[CALL_HIERARCHY] Fallback returned: ${fallbackNode ? 'results found' : 'no results'}`);
                console.log(`${timestamp()} [info] [CALL_HIERARCHY] Fallback returned: ${fallbackNode ? 'results found' : 'no results'}`);
                
                if (fallbackNode) {
                  callHierarchyNode = fallbackNode;
                }
              }
            } catch (err) {
              this.logger.appendLine(`[CALL_HIERARCHY] Error executing call hierarchy command: ${String(err)}`);
              console.log(`${timestamp()} [error] [CALL_HIERARCHY] Error: ${String(err)}`);
              // Use fallback on error
              const fallbackNode = await this.useFallbackCallHierarchy(editor, symbol);
              if (fallbackNode) {
                callHierarchyNode = fallbackNode;
              }
            }
          } else {
            this.logger.appendLine(`[CALL_HIERARCHY] No call hierarchy items found`);
            // Try fallback approach for no items case
            const fallbackNode = await this.useFallbackCallHierarchy(editor, symbol);
            if (fallbackNode) {
              callHierarchyNode = fallbackNode;
            }
          }
        } catch (err) {
          this.logger.appendLine(`[CALL_HIERARCHY] Error: ${String(err)}`);
          console.log(`${timestamp()} [error] [CALL_HIERARCHY] Error: ${String(err)}`);
        }
      } catch (err) {
        this.logger.appendLine(`[ERROR] Failed to get symbol references or call hierarchy: ${String(err)}`);
      }
    

    // Prepare for UI updates

    const rebuildAndRefresh = () => {
      const groups: FileGroupNode[] = [];
      for (const [fsPath, children] of byFile) {
        const label = vscode.workspace.asRelativePath(fsPath);
        for (const ch of children) {
          const ln = ch.location.range.start.line + 1;
          ch.label = `${ln}  ${ch.preview.trim()}`;
          ch.tooltip = `${vscode.workspace.asRelativePath(ch.location.uri)}:${ln}  ${ch.preview.trim()}`;
        }
        groups.push(new FileGroupNode(label, children, fsPath));
      }
      function groupScore(g: FileGroupNode): number {
        if (!activeFsPath) return 0;
        if (g.fsPath === activeFsPath) return 2;
        if (activeDir && (g.fsPath.startsWith(activeDir + '/') || g.fsPath.startsWith(activeDir + '\\'))) return 1;
        return 0;
      }
      groups.sort((a, b) => {
        const sa = groupScore(a);
        const sb = groupScore(b);
        if (sa !== sb) return sb - sa;
        return String(a.label).localeCompare(String(b.label));
      });
      
      // Prepare the roots array with symbol references and call hierarchy at the top
      const rootNodes: TreeNode[] = [];
      
      // Add symbol references if available
      if (symbolReferencesNode && symbolReferencesNode.children.length > 0) {
        rootNodes.push(symbolReferencesNode);
      }
      
      // Add call hierarchy if available
      if (callHierarchyNode && callHierarchyNode.callItems.length > 0) {
        rootNodes.push(callHierarchyNode);
      }
      
      // Add file groups
      rootNodes.push(...groups);
      
      // Keep spinner visible while streaming, but do not disrupt first group position
      if (!streamingComplete) {
        this.roots = rootNodes.length ? [...rootNodes, new BusyNode(`Searching "${symbol}"...`)] : [new BusyNode(`Searching "${symbol}"...`)];
      } else {
        this.roots = rootNodes;
      }
      this._onDidChangeTreeData.fire(undefined);
    };

    // Begin streaming search
    
    // Perform streaming search, update the tree as batches arrive, but await completion
    const lines = await findReferencesByTextStream(symbol, this.logger, (batch: ReferenceLineNode[]) => {
      for (const node of batch) {
        const fsPath = node.location.uri.fsPath;
        const ln = node.location.range.start.line;
        const col = node.location.range.start.character;
        const uniq = `${fsPath}:${ln}:${col}`;
        if (seen.has(uniq)) continue;
        seen.add(uniq);
        const arr = byFile.get(fsPath) ?? [];
        arr.push(node);
        byFile.set(fsPath, arr);
      }
      const now = Date.now();
      if (now - lastUi >= uiThrottleMs) {
        lastUi = now;
        rebuildAndRefresh();
      }
    });

    // Finalize with complete results
    const finalLines: ReferenceLineNode[] = [];
    for (const arr of byFile.values()) finalLines.push(...arr);
    this.cache.set(symbol, finalLines);
    streamingComplete = true;
    rebuildAndRefresh();
    // Clear message
    if (this.view) {
      try { (this.view as any).message = undefined; } catch {}
    }
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
      // Inline symbol expansion (child of a reference line): return raw reference lines
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
    if (element instanceof SymbolReferencesNode) {
      this.logger.appendLine(`[CHEVRON] Symbol references expand requested`);
      console.log(`${timestamp()} [info] Chevron expand: symbol references`);
      return element.children;
    }
    if (element instanceof CallHierarchyNode) {
      this.logger.appendLine(`[CHEVRON] Call hierarchy expand requested`);
      console.log(`${timestamp()} [info] Chevron expand: call hierarchy`);
      
      // Convert call hierarchy items to ReferenceLineNode objects for display
      const nodes: ReferenceLineNode[] = [];
      for (const call of element.callItems) {
        try {
          const location = call.from.selectionRange;
          const uri = call.from.uri;
          const doc = await vscode.workspace.openTextDocument(uri);
          const line = doc.lineAt(location.start.line).text;
          const startCol = location.start.character;
          const preview = createPreview(line, startCol, call.from.name.length);
          const node = new ReferenceLineNode(
            new vscode.Location(uri, location),
            preview,
            call.from.name
          );
          node.symbolChildren = extractSymbolsFromLine(line, call.from.name)
            .map(s => new InlineSymbolNode(s, node));
          nodes.push(node);
        } catch (err) {
          this.logger.appendLine(`[ERROR] Failed to process call hierarchy item: ${String(err)}`);
        }
      }
      return nodes;
    }
    return [];
  }

  getRoots(): TreeNode[] {
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

  /**
   * Fallback implementation for call hierarchy when the LSP command is not available
   * or doesn't return results. Currently supports Python functions.
   */
  async useFallbackCallHierarchy(
    editor: vscode.TextEditor,
    symbol: string,
    document = editor.document,
    position = editor.selection.active
  ): Promise<CallHierarchyNode | undefined> {
    // Log entry to fallback method
    this.logger.appendLine(`[CALL_HIERARCHY_FALLBACK] Entered fallback method for symbol: ${symbol}`);
    console.log(`${timestamp()} [info] [CALL_HIERARCHY_FALLBACK] Entered fallback method for symbol: ${symbol}`);
    
    // Fallback approach for languages that don't support call hierarchy API
    // For Python/Java functions, we can try to find calls to this function in the text search results
    const fileExt = path.extname(editor.document.fileName).toLowerCase();
    const isPythonFile = fileExt === '.py';
    const isJavaFile = fileExt === '.java';
    const isFunctionOrMethod = symbol.match(/^[a-zA-Z0-9_]+$/) !== null; // Simple check for function-like names
    
    this.logger.appendLine(`[CALL_HIERARCHY_FALLBACK] File type check: fileExt=${fileExt}, isPythonFile=${isPythonFile}, isJavaFile=${isJavaFile}, isFunctionOrMethod=${isFunctionOrMethod}`);
    console.log(`${timestamp()} [info] [CALL_HIERARCHY_FALLBACK] File type check: fileExt=${fileExt}, isPythonFile=${isPythonFile}, isJavaFile=${isJavaFile}, isFunctionOrMethod=${isFunctionOrMethod}`);
    
    if ((isPythonFile || isJavaFile) && isFunctionOrMethod) {
      this.logger.appendLine(`[CALL_HIERARCHY_FALLBACK] Using fallback for ${isPythonFile ? 'Python' : 'Java'} function: ${symbol}`);
      console.log(`${timestamp()} [info] [CALL_HIERARCHY_FALLBACK] Using fallback for ${isPythonFile ? 'Python' : 'Java'} function: ${symbol}`);
      
      // Create a mock call hierarchy using text search results
      // We'll look for patterns like: symbol( or symbol(
      const mockCalls: vscode.CallHierarchyIncomingCall[] = [];
      
      // Search for function calls in the workspace
      const callPattern = `${symbol}\(`; // Look for function_name(
      
      // Determine which file types to search based on current file
      let filePattern = '';
      if (isPythonFile) {
        filePattern = '**/*.py';
        this.logger.appendLine(`[CALL_HIERARCHY_FALLBACK] Searching Python files for: ${callPattern}`);
      } else if (isJavaFile) {
        filePattern = '**/*.java';
        this.logger.appendLine(`[CALL_HIERARCHY_FALLBACK] Searching Java files for: ${callPattern}`);
      }
      
      this.logger.appendLine(`[CALL_HIERARCHY_FALLBACK] Using file pattern: ${filePattern}`);
      console.log(`${timestamp()} [info] [CALL_HIERARCHY_FALLBACK] Using file pattern: ${filePattern}`);
      
      const files = await vscode.workspace.findFiles(filePattern, '**/node_modules/**');
      
      for (const file of files) {
        if (file.fsPath === editor.document.uri.fsPath) continue; // Skip the current file
        
        try {
          const doc = await vscode.workspace.openTextDocument(file);
          const text = doc.getText();
          
          // Find all occurrences of the function call
          const regex = new RegExp(callPattern, 'g');
          let match;
          
          while ((match = regex.exec(text)) !== null) {
            const pos = doc.positionAt(match.index);
            const line = doc.lineAt(pos.line);
            
            // Create a mock call hierarchy item
            const mockItem: vscode.CallHierarchyItem = {
              name: `Call from ${path.basename(file.fsPath)}`,
              kind: vscode.SymbolKind.Function,
              uri: file,
              range: new vscode.Range(pos, pos.translate(0, symbol.length + 1)),
              selectionRange: new vscode.Range(pos, pos.translate(0, symbol.length))
            };
            
            // Create a mock incoming call
            const mockCall: vscode.CallHierarchyIncomingCall = {
              from: mockItem,
              fromRanges: [new vscode.Range(pos, pos.translate(0, symbol.length + 1))]
            };
            
            mockCalls.push(mockCall);
          }
        } catch (err) {
          this.logger?.appendLine(`[CALL_HIERARCHY] Error processing file ${file.fsPath}: ${String(err)}`);
        }
      }
      
      if (mockCalls.length > 0) {
        const newCallHierarchyNode = new CallHierarchyNode(symbol, mockCalls);
        this.logger?.appendLine(`[CALL_HIERARCHY] Created fallback CallHierarchyNode with ${mockCalls.length} calls`);
        return newCallHierarchyNode;
      } else {
        this.logger?.appendLine(`[CALL_HIERARCHY] No calls found with fallback approach`);
      }
    }
    
    return undefined;
  }
}

export type TreeNode = SymbolNode | FileGroupNode | ReferenceLineNode | InlineSymbolNode | BusyNode | SymbolReferencesNode | CallHierarchyNode;

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
  constructor(public readonly label: string, public readonly children: ReferenceLineNode[], public readonly fsPath: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'fileGroup';
    this.iconPath = new vscode.ThemeIcon('file');
    this.tooltip = label;
  }
}

export class ReferenceLineNode extends vscode.TreeItem {
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

export class InlineSymbolNode extends vscode.TreeItem {
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

class BusyNode extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'busy';
    this.iconPath = new vscode.ThemeIcon('sync~spin');
  }
}

class SymbolReferencesNode extends vscode.TreeItem {
  public children: ReferenceLineNode[] = [];
  constructor(public readonly symbol: string, public readonly locations: vscode.Location[]) {
    super('Symbol References', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'symbolReferences';
    this.iconPath = new vscode.ThemeIcon('references');
    this.description = `${locations.length} references`;
    this.tooltip = `${locations.length} references for ${symbol}`;
  }
}

class CallHierarchyNode extends vscode.TreeItem {
  public children: vscode.CallHierarchyItem[] = [];
  constructor(public readonly symbol: string, public readonly callItems: vscode.CallHierarchyIncomingCall[]) {
    super('Call Hierarchy', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'callHierarchy';
    this.iconPath = new vscode.ThemeIcon('call-incoming');
    this.description = `${callItems.length} callers`;
    this.tooltip = `${callItems.length} callers for ${symbol}`;
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
    files = await vscode.workspace.findFiles(includeGlob, exclude);
  } catch (e) {
    logger.appendLine(`[ERROR] findFiles failed: ${String(e)}`);
    return results;
  }

  // Always include the currently active file (scan it first) if available
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri && activeUri.scheme === 'file') {
    const hasActive = files.some(u => u.fsPath === activeUri.fsPath);
    if (!hasActive) {
      files.unshift(activeUri);
    } else {
      // Move it to the front to ensure prioritization in scanning
      files = [activeUri, ...files.filter(u => u.fsPath !== activeUri.fsPath)];
    }
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

// escapeRegExp function is now defined at the top of the file

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
