// The /compact chip: the summary reaches it whichever of the marker and the
// "compacting done" message arrives first, and a summary wrapped in a
// <template> (models echo OpenCode 2's compaction prompt) is still shown.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, text, attr, waitFor } = helpers;
const marker = (id: string) =>
  post({ type: 'event', event: { type: 'message.part.updated', properties: { part: { id: `${id}:marker:part`, sessionID: 's', messageID: `${id}:marker`, type: 'compaction' } } } } as never);

describe('compaction chip', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await post({ type: 'cleared' });
  });

  it('shows the summary when it arrives after the marker', async () => {
    await marker('c1');
    await waitFor('.compaction-chip', (n) => n === 1);
    await post({ type: 'compacting', active: false, summary: '## Objective\n- keep ZEBRA-9' });
    assert.match(String(await text('.compaction-chip .compaction-body')), /ZEBRA-9/);
    assert.strictEqual(await attr('.compaction-chip .compaction-head', 'disabled'), null, 'the chip expands');
  });

  it('keeps a summary that arrives before its marker', async () => {
    await post({ type: 'cleared' });
    await post({ type: 'compacting', active: false, summary: '## Objective\n- early SUMMARY-FIRST' });
    await marker('c2');
    await waitFor('.compaction-chip', (n) => n === 1);
    assert.match(String(await text('.compaction-chip .compaction-body')), /SUMMARY-FIRST/);
  });

  it('shows a summary the model wrapped in <template>', async () => {
    await post({ type: 'cleared' });
    await marker('c3');
    await waitFor('.compaction-chip', (n) => n === 1);
    await post({ type: 'compacting', active: false, summary: '<template>\n## Objective\n- wrapped TEMPLATE-OK\n</template>' });
    assert.match(String(await text('.compaction-chip .compaction-body')), /TEMPLATE-OK/);
  });

  after(async () => {
    await post({ type: 'cleared' });
  });
});
