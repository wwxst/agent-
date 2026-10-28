import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {previewWorkspacePatch,validateWorkspacePatch} from '../packages/tool-host/src/workspace-patch.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const good=(text='export const add=(a,b)=>a-b;\n')=>({
  path:'src/calc.mjs',
  expectedSha256:hash(text),
  oldText:'a-b',
  newText:'a+b',
});

test('WORKSPACE-PATCH-01: pure compare-and-swap preview returns digest but never edits source',()=>{
  const original='export const add=(a,b)=>a-b;\n';
  const input=good(original);
  const patch=previewWorkspacePatch(original,validateWorkspacePatch(input));
  assert.equal(patch.baseSha256,hash(original));
  assert.equal(patch.candidate,'export const add=(a,b)=>a+b;\n');
  assert.equal(patch.candidateSha256,hash(patch.candidate));
  assert.equal(original,'export const add=(a,b)=>a-b;\n');
});

test('WORKSPACE-PATCH-02: malicious or ambiguous paths are rejected before any execution',()=>{
  for(const path of ['/etc/passwd','../secret','src/../../passwd','src//a',
    'src/./a','src\\a','src/.git/config','src/a:b','']) {
    assert.throws(()=>validateWorkspacePatch({...good(),path}),{code:'WORKSPACE_PATCH_PATH_DENIED'},path);
  }
  assert.throws(()=>validateWorkspacePatch({...good(),extra:'unsafe'}),{code:'WORKSPACE_PATCH_INVALID'});
});

test('WORKSPACE-PATCH-03: old digest, missing snippet and ambiguous replacement all fail closed',()=>{
  const input=good();
  assert.throws(()=>previewWorkspacePatch('updated',input),{code:'WORKSPACE_PATCH_STALE_BASE'});
  assert.throws(()=>previewWorkspacePatch('no target',{...input,expectedSha256:hash('no target')}),
    {code:'WORKSPACE_PATCH_NO_MATCH'});
  const repeated='a-b;a-b';
  assert.throws(()=>previewWorkspacePatch(repeated,{...input,expectedSha256:hash(repeated)}),
    {code:'WORKSPACE_PATCH_AMBIGUOUS'});
});

test('WORKSPACE-PATCH-04: no-op, empty match, oversized fields and oversized input fail closed',()=>{
  const input=good();
  for(const invalid of [
    {...input,oldText:''},{...input,newText:'a-b'},
    {...input,newText:'x'.repeat(65537)}, {...input,expectedSha256:'bad'},
  ]) assert.throws(()=>validateWorkspacePatch(invalid));
  const large='x'.repeat(256*1024+1);
  assert.throws(()=>previewWorkspacePatch(large,{...input,expectedSha256:hash(large)}),
    {code:'WORKSPACE_PATCH_TOO_LARGE'});
});
