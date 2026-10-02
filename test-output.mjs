import assert from 'node:assert/strict';
import {outputFor,validatePattern,validateDirectory} from './output-config.mjs';
const out=outputFor('D:\\MV\\Bai 01', {image:'{node_id}_{job_id}.png'},'scene','image','abc-123');
assert.equal(out.path,'D:\\MV\\Bai 01\\scene_abc-123.png');
assert.equal(outputFor('/srv/mv',null,'wide','video','j2').path,'/srv/mv/wide_j2.mp4');
for(const bad of ['../{job_id}.png','fixed.png','{unknown}_{job_id}.png','{job_id}.mp4'])assert.throws(()=>validatePattern(bad,'image'));
assert.throws(()=>validateDirectory('relative/path'));
console.log('PASS: Windows/POSIX paths, unique filenames, traversal and invalid extensions rejected');
