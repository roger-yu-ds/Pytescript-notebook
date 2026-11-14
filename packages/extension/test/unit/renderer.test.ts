import assert from "node:assert/strict";
import { test } from "node:test";
import { createMarkdown } from "../../renderer/answer.ts";

test("code blocks get Copy, and runnable languages get Insert as cell", () => {
  const html = createMarkdown(true).render("```ts\nconst x: number = 1;\n```\n\n```bash\nls\n```");
  const blocks = html.split('<div class="pt-code">').slice(1);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /data-action="copy"/);
  assert.match(blocks[0], /data-action="insert" data-lang="typescript"/);
  assert.match(blocks[0], /hljs-keyword/);
  assert.doesNotMatch(blocks[1], /data-action="insert"/);
});

test("no Insert button without renderer messaging", () => {
  assert.doesNotMatch(createMarkdown(false).render("```py\nprint(1)\n```"), /data-action="insert"/);
});

test("raw HTML in answers is escaped, and the copy source is exact", () => {
  const html = createMarkdown(true).render('<img src=x onerror=alert(1)>\n\n```sql\nselect \'<b>\' as x\n```');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<textarea class="pt-src" hidden>select &#39;&lt;b&gt;&#39; as x\n<\/textarea>/);
});
