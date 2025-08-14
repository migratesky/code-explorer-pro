import * as assert from 'assert';
import * as vscode from 'vscode';
import { run } from './index';

suite('Code Explorer Pro', () => {
  test('Finds root symbol and expands references', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders && workspaceFolders.length > 0, 'No workspace opened');

    // Open the fixture file
    const uri = vscode.Uri.joinPath(workspaceFolders![0].uri, 'src/a.ts');
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    // Place cursor on calculateDiscount
    const pos = doc.getText().indexOf('calculateDiscount');
    assert.ok(pos >= 0, 'Symbol not found in fixture');
    const position = doc.positionAt(pos + 1);
    editor.selection = new vscode.Selection(position, position);

    // Trigger command
    await vscode.commands.executeCommand('code-explorer-pro.findRecursiveReferences');

    // Fetch roots via hidden command
    const roots = (await vscode.commands.executeCommand('code-explorer-pro._getTreeRoots')) as any[];
    assert.ok(Array.isArray(roots), 'Roots not returned');
    assert.ok(roots.length === 1, 'Expected one root');
    assert.strictEqual(roots[0].label, 'calculateDiscount');

    // Expand the root symbol
    await vscode.commands.executeCommand('code-explorer-pro.expandSymbol', roots[0]);

    // Ask for children through provider by expanding tree indirectly: no direct API, so re-invoke expand and wait
    await new Promise(r => setTimeout(r, 500));

    // After expansion, try to open a location to ensure nodes exist; rely on command failing if none
    // We don't have direct access to children here; just assert that command does not throw
    // Alternatively, we can re-run expansion and expect no errors
    await vscode.commands.executeCommand('code-explorer-pro.expandSymbol', roots[0]);
  });

  test('Summarize expansion returns inline symbols for calculateDiscount', async () => {
    const summary = (await vscode.commands.executeCommand('code-explorer-pro._expandAndSummarize', 'calculateDiscount')) as Array<{ label: string; inlineSymbols: string[] }>;
    assert.ok(Array.isArray(summary), 'No summary returned');
    assert.ok(summary.length >= 1, 'Expected at least one reference line');

    // Check that at least one line includes both totalPrice and discountedPrice as inline symbols
    const hasExpectedInline = summary.some(item => {
      const syms = new Set(item.inlineSymbols);
      return syms.has('totalPrice') && syms.has('discountedPrice');
    });
    assert.ok(hasExpectedInline, 'Inline symbols did not include expected identifiers');
  });

  test('Summarize expansion for variable discountedPrice finds occurrences', async () => {
    const summary = (await vscode.commands.executeCommand('code-explorer-pro._expandAndSummarize', 'discountedPrice')) as Array<{ label: string; inlineSymbols: string[] }>;
    assert.ok(Array.isArray(summary), 'No summary returned');
    assert.ok(summary.length >= 1, 'Expected at least one reference line');
    // Ensure that one of the lines is the assignment line
    const hasAssignment = summary.some(item => String(item.label).includes('discountedPrice = calculateDiscount'));
    assert.ok(hasAssignment, 'Did not find expected assignment reference');
  });
});
