import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  assertEnforcedSandboxPolicy,startDedicatedToolHost,startEnforcedToolHost,
} from '../packages/tool-host/src/enforced.js';
import type {LinuxBubblewrapSandbox} from '../packages/tool-host/src/sandbox.js';
import {ProcessToolHost} from '../packages/tool-host/src/index.js';

const supported=process.platform==='linux'&&process.arch==='x64';
const valid=():LinuxBubblewrapSandbox=>({
  binaryPath:'/usr/bin/bwrap',
  runtimeReadOnlyDirectories:['/usr'],
  seccompPolicy:'network-and-privilege-deny-v1',
});
const quota={maxMemoryBytes:256*1024*1024,maxPids:32,maxCpuMillicores:500};
function scratch(){
  const dir=mkdtempSync(join(tmpdir(),'required-seccomp-'));
  const db=join(dir,'must-not-create.sqlite');
  return {db,clean:()=>rmSync(dir,{recursive:true,force:true})};
}

test('M3 policy: explicit verified x86-64 seccomp is a precondition for secure gateways',()=>{
  if(supported) assert.doesNotThrow(()=>assertEnforcedSandboxPolicy(valid()));
  else assert.throws(()=>assertEnforcedSandboxPolicy(valid()),{
    code:'HOST_SECCOMP_UNAVAILABLE',
  });
});

test('M3 policy: undefined, absent or fake seccomp profile never qualifies as enforced',()=>{
  for(const value of [
    undefined,{}, {seccompPolicy:undefined},
    {seccompPolicy:null},{seccompPolicy:false},
    {seccompPolicy:'none'},{seccompPolicy:'network-only'},
  ]){
    assert.throws(()=>assertEnforcedSandboxPolicy(value as never),{
      code:'HOST_SECCOMP_UNAVAILABLE',
    });
  }
});

test('M3 policy: callers cannot forge the internal dedicated cgroup descriptor',()=>{
  const baseline=valid();
  for(const dedicatedCgroup of [
    undefined, null, {}, {relativePath:'/supervisor/other',budget:quota},
  ]){
    assert.throws(()=>assertEnforcedSandboxPolicy({
      ...baseline,dedicatedCgroup,
    } as never),{code:'HOST_INVALID_OPTIONS'});
  }
});

test('M3 shared resource-gated factory: missing seccomp fails before reading cgroup or creating DB',async()=>{
  const f=scratch();
  try{
    for(const seccompPolicy of [undefined,'bad' as never]){
      await assert.rejects(startEnforcedToolHost({
        databasePath:f.db,
        requiredBudget:quota,
        sandbox:{binaryPath:'/nonexistent/bwrap',
          runtimeReadOnlyDirectories:['/usr'],
          ...(seccompPolicy===undefined?{}:{seccompPolicy})},
      }),{code:'HOST_SECCOMP_UNAVAILABLE'});
      assert.equal(existsSync(f.db),false);
    }
  }finally{f.clean();}
});

test('M3 dedicated resource-gated factory: missing seccomp fails before cgroup delegation',async()=>{
  const f=scratch();
  try{
    await assert.rejects(startDedicatedToolHost({
      databasePath:f.db,
      dedicatedCgroupRelativePath:'/nonexistent/dedicated-worker',
      requiredBudget:quota,
      sandbox:{binaryPath:'/nonexistent/bwrap',runtimeReadOnlyDirectories:['/usr']},
    }),{code:'HOST_SECCOMP_UNAVAILABLE'});
    assert.equal(existsSync(f.db),false);
  }finally{f.clean();}
});

test('M3 shared resource-gated factory refuses any caller-injected cgroup metadata',async()=>{
  const f=scratch();
  try{
    await assert.rejects(startEnforcedToolHost({
      databasePath:f.db,requiredBudget:quota,
      sandbox:{...valid(),dedicatedCgroup:{
        relativePath:'/forged/worker',budget:quota,
      }},
    }),{code:'HOST_INVALID_OPTIONS'});
    assert.equal(existsSync(f.db),false);
  }finally{f.clean();}
});

test('M3 dedicated resource-gated factory refuses pre-provided cgroup metadata',async()=>{
  const f=scratch();
  try{
    await assert.rejects(startDedicatedToolHost({
      databasePath:f.db,dedicatedCgroupRelativePath:'/forged/worker',
      requiredBudget:quota,
      sandbox:{...valid(),dedicatedCgroup:{
        relativePath:'/other/worker',budget:quota,
      }},
    }),{code:'HOST_INVALID_OPTIONS'});
    assert.equal(existsSync(f.db),false);
  }finally{f.clean();}
});

test('M3 policy: malformed resource budget is still rejected before seccomp/file effects',async()=>{
  const f=scratch();
  try{
    await assert.rejects(startEnforcedToolHost({
      databasePath:f.db,requiredBudget:{...quota,maxPids:0},
      sandbox:{binaryPath:'/usr/bin/bwrap',runtimeReadOnlyDirectories:['/usr']},
    }),{code:'HOST_CGROUP_BUDGET_UNSATISFIED'});
    assert.equal(existsSync(f.db),false);
  }finally{f.clean();}
});

test('M3 policy: direct dedicated ProcessToolHost cannot bypass the seccomp requirement',()=>{
  const f=scratch();
  try{
    assert.throws(()=>new ProcessToolHost(f.db,500,{
      binaryPath:'/nonexistent/bwrap',runtimeReadOnlyDirectories:['/usr'],
      dedicatedCgroup:{relativePath:'/forged/worker',budget:quota},
    }),{code:'HOST_SECCOMP_UNAVAILABLE'});
    assert.equal(existsSync(f.db),false);
  }finally{f.clean();}
});
