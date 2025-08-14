import { strict as assert } from 'assert';
import { createPreview, extractSymbolsFromLine, findAllWordHits, escapeRegExp } from '../core/analysis';

describe('core/analysis', () => {
  it('escapeRegExp escapes special characters', () => {
    const s = 'a+b*c?^$()[]{}|.';
    const escaped = escapeRegExp(s);
    const re = new RegExp(escaped);
    assert.ok(re.test(s));
  });

  it('findAllWordHits finds identifier-boundary matches only', () => {
    const line = 'foo fooBar barfoo foo';
    const hits = findAllWordHits(line, 'foo');
    // positions: 0 and at the last 'foo'
    assert.deepEqual(hits, [0, line.lastIndexOf('foo')]);
  });

  it('createPreview highlights around the hit', () => {
    const line = '0123456789abcdefghijABCDEFGHIJklmnopqrstuvwxyz';
    const start = 12; // inside the string
    const prev = createPreview(line, start, 3);
    // Should contain the exact hit
    assert.ok(prev.includes(line.substr(start, 3)));
  });

  it('extractSymbolsFromLine returns unique non-keyword identifiers, excluding target', () => {
    const line = 'const discountedPrice = calculateDiscount(totalPrice);';
    const syms = extractSymbolsFromLine(line, 'calculateDiscount');
    // Should include variables but not keywords or excluded symbol
    assert.ok(syms.includes('discountedPrice'));
    assert.ok(syms.includes('totalPrice'));
    assert.ok(!syms.includes('const'));
    assert.ok(!syms.includes('calculateDiscount'));
  });
});
