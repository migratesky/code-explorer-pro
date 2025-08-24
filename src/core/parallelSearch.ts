import * as vscode from 'vscode';
import { createPreview, extractSymbolsFromLine } from './analysis';
import { ReferenceLineNode, InlineSymbolNode } from '../extension';

/**
 * Optimized parallel search implementation that categorizes files by size
 * and processes them with appropriate concurrency levels
 */
export async function findReferencesParallel(
  symbol: string,
  files: vscode.Uri[],
  logger: vscode.OutputChannel,
  onBatch: (batch: ReferenceLineNode[]) => void,
  options: {
    matchMode: 'word' | 'text',
    maxSearchMs: number,
    maxLinesPerFile: number,
    progressEvery: number,
    verbose: boolean,
    wordRegex?: RegExp
  }
): Promise<ReferenceLineNode[]> {
  const { matchMode, maxSearchMs, maxLinesPerFile, progressEvery, verbose, wordRegex } = options;
  const results: ReferenceLineNode[] = [];
  const t0 = Date.now();
  
  // Create cancellation token for timeout
  const cts = new vscode.CancellationTokenSource();
  const timeout = setTimeout(() => {
    logger.appendLine(`[ABORT] Parallel search timeout after ${Date.now() - t0}ms, returning partial results (${results.length})`);
    cts.cancel();
  }, maxSearchMs);

  try {
    // Categorize files by size for optimized processing
    const { regularFiles, largeFiles } = await categorizeFiles(files, logger);
    
    // Process regular files with high concurrency
    await processFileGroup(regularFiles, 16, "regular");
    
    // Process large files with lower concurrency to avoid memory issues
    if (largeFiles.length > 0) {
      logger.appendLine(`[INFO] Processing ${largeFiles.length} large files with reduced concurrency`);
      await processFileGroup(largeFiles, 4, "large");
    }
    
    // Return all results
    return results;
  } finally {
    clearTimeout(timeout);
    const totalMs = Date.now() - t0;
    if (verbose) {
      logger.appendLine(`[RESULT] ${results.length} references for ${symbol} in ${totalMs}ms (parallel)`);
    }
    console.log(`${new Date().toISOString()} [info] [RESULT] ${results.length} refs in ${totalMs}ms (parallel)`);
  }
  
  /**
   * Categorize files by size to optimize processing
   */
  async function categorizeFiles(files: vscode.Uri[], logger: vscode.OutputChannel): Promise<{
    regularFiles: vscode.Uri[],
    largeFiles: vscode.Uri[]
  }> {
    const largeFileSizeThreshold = 1024 * 1024; // 1MB
    const regularFiles: vscode.Uri[] = [];
    const largeFiles: vscode.Uri[] = [];
    
    // Process files in batches to avoid overwhelming the system
    const batchSize = 100;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      const fileSizePromises = batch.map(async (uri) => {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          return { uri, size: stat.size };
        } catch (e) {
          logger.appendLine(`[WARN] Failed to get size for ${uri.fsPath}: ${String(e)}`);
          return { uri, size: 0 };
        }
      });
      
      const fileSizes = await Promise.all(fileSizePromises);
      
      for (const { uri, size } of fileSizes) {
        if (size > largeFileSizeThreshold) {
          largeFiles.push(uri);
        } else {
          regularFiles.push(uri);
        }
      }
    }
    
    logger.appendLine(`[INFO] Categorized files: ${regularFiles.length} regular, ${largeFiles.length} large`);
    return { regularFiles, largeFiles };
  }
  
  /**
   * Process a group of files with specified concurrency
   */
  async function processFileGroup(fileGroup: vscode.Uri[], concurrency: number, groupType: string) {
    let idx = 0;
    let processed = 0;
    const totalFiles = fileGroup.length;
    
    if (totalFiles === 0) return;
    
    // Create worker function
    async function worker() {
      while (!cts.token.isCancellationRequested) {
        const myIdx = idx++;
        if (myIdx >= totalFiles) break;
        
        const uri = fileGroup[myIdx];
        const localBatch = await processFile(uri);
        
        processed++;
        if (processed % progressEvery === 0 || verbose) {
          const elapsed = Date.now() - t0;
          logger.appendLine(`[PROGRESS] ${groupType} files: ${processed}/${totalFiles} results=${results.length} elapsedMs=${elapsed}`);
        }
        
        // Emit batch for this file if there were new results
        if (localBatch.length > 0) {
          try {
            onBatch(localBatch);
          } catch (err) {
            logger.appendLine(`[WARN] onBatch error: ${String(err)}`);
          }
        }
        
        if (Date.now() - t0 > maxSearchMs) {
          logger.appendLine(`[ABORT] Search timeout during processing after ${Date.now() - t0}ms, returning partial results (${results.length})`);
          break;
        }
      }
    }
    
    // Create and run workers
    const workers = Array.from({ length: Math.min(concurrency, totalFiles) }, () => worker());
    await Promise.all(workers);
  }
  
  /**
   * Process a single file to find references
   */
  async function processFile(uri: vscode.Uri): Promise<ReferenceLineNode[]> {
    const localBatch: ReferenceLineNode[] = [];
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
          if (!wordRegex) continue;
          wordRegex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = wordRegex.exec(line)) !== null) {
            const startCol = m.index;
            const range = new vscode.Range(
              new vscode.Position(lineNum, startCol),
              new vscode.Position(lineNum, startCol + symbol.length)
            );
            const preview = createPreview(line, startCol, symbol.length);
            const node = new ReferenceLineNode(new vscode.Location(uri, range), preview, symbol);
            node.symbolChildren = extractSymbolsFromLine(line, symbol).map(s => new InlineSymbolNode(s, node));
            results.push(node);
            localBatch.push(node);
            fileHits++;
          }
        } else {
          let from = 0;
          while (true) {
            const idxFound = line.indexOf(symbol, from);
            if (idxFound === -1) break;
            const startCol = idxFound;
            const range = new vscode.Range(
              new vscode.Position(lineNum, startCol),
              new vscode.Position(lineNum, startCol + symbol.length)
            );
            const preview = createPreview(line, startCol, symbol.length);
            const node = new ReferenceLineNode(new vscode.Location(uri, range), preview, symbol);
            node.symbolChildren = extractSymbolsFromLine(line, symbol).map(s => new InlineSymbolNode(s, node));
            results.push(node);
            localBatch.push(node);
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
    
    return localBatch;
  }
}

/**
 * Helper function to escape special regex characters
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
