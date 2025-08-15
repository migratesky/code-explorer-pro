import * as assert from 'assert';
import * as vscode from 'vscode';
import { run } from './index';

suite('Code Explorer Pro', () => {
  test('Finds references and groups by file (expanded by default)', async () => {
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

    // Fetch roots via hidden command (file groups)
    const roots = (await vscode.commands.executeCommand('code-explorer-pro._getTreeRoots')) as any[];
    assert.ok(Array.isArray(roots), 'Roots not returned');
    assert.ok(roots.length >= 1, 'Expected at least one file group root');

    // First group should be the active file's group (prioritized)
    const activeRel = vscode.workspace.asRelativePath(doc.uri);
    assert.ok(String(roots[0].label).includes(activeRel.split('/').pop()!), 'First root should be active file group');

    // Let the view render and children attach; then try expanding first child reference line
    await new Promise(r => setTimeout(r, 300));
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
