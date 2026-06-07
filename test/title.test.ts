import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveTitle } from '../src/core/title';

test('deriveTitle capitalizes and keeps a short prompt intact', () => {
  assert.equal(deriveTitle('fix the parser bug'), 'Fix the parser bug');
  assert.equal(deriveTitle('hello'), 'Hello');
});

test('deriveTitle returns empty for blank input', () => {
  assert.equal(deriveTitle(''), '');
  assert.equal(deriveTitle('   '), '');
  // @ts-expect-error — guard against undefined sneaking in at runtime
  assert.equal(deriveTitle(undefined), '');
});

test('deriveTitle strips fenced code, inline code and URLs', () => {
  assert.equal(deriveTitle('```js\nconst x=1\n``` explain this code'), 'Explain this code');
  assert.equal(deriveTitle('check https://example.com/foo now'), 'Check now');
  assert.equal(deriveTitle('use the `fetch` api'), 'Use the fetch api');
});

test('deriveTitle limits to the first 8 words', () => {
  const title = deriveTitle('one two three four five six seven eight nine ten');
  assert.equal(title, 'One two three four five six seven eight');
  assert.ok(!title.includes('nine'));
});

test('deriveTitle trims trailing punctuation', () => {
  assert.equal(deriveTitle('hello world.'), 'Hello world');
  assert.equal(deriveTitle('what is this:'), 'What is this');
});

test('deriveTitle truncates very long titles with an ellipsis', () => {
  const title = deriveTitle('x'.repeat(60));
  assert.ok(title.endsWith('…'));
  assert.equal(title.length, 53); // 52 chars + ellipsis
});
