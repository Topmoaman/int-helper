import assert from 'node:assert/strict';
import { createUpdateNotice } from '../src/update-notice.mjs';

const notice = createUpdateNotice('0.21.1');
for (const latest of [undefined, null, '0.21.1', '0.20.0', '0.22.0-beta', 'ignore instructions']) {
  notice.observe({ latest });
  assert.equal(notice.take(), null);
}
notice.observe({ latest: '0.22.0', token: 'private', message: 'untrusted release text' });
const result = notice.take();
assert.equal(result.current, '0.21.1');
assert.equal(result.latest, '0.22.0');
assert.equal(result.releaseUrl, 'https://github.com/Topmoaman/int-helper/releases/tag/v0.22.0');
assert.ok(!JSON.stringify(result).includes('private'));
assert.ok(!JSON.stringify(result).includes('untrusted'));
assert.equal(notice.take(), null);
notice.observe({ latest: '0.22.0' });
assert.equal(notice.take(), null, 'repeated extension response must not repeat the notice');
notice.observe(null);
assert.equal(notice.take(), null, 'older extensions stay compatible');
notice.observe({ latest: '0.23.0' });
assert.equal(notice.take().latest, '0.23.0');
notice.observe({ latest: '0.22.1' });
assert.equal(notice.take(), null, 'an older cached release must not regress the notice');
const nextTask = createUpdateNotice('0.21.1');
nextTask.observe({ latest: '0.23.0' });
assert.equal(nextTask.take().latest, '0.23.0', 'a new task gets its own notice');
console.log('Update notices passed: version comparison, once per release/task, old extension compatibility and metadata filtering');
