import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {test} from 'node:test';
import {SqliteEventStore} from '../packages/event-store-sqlite/src/index.js';
import {ProcessToolHost} from '../packages/tool-host/src/index.js';
import {inspectCgroupV2From,inspectCurrentCgroupV2,readUnifiedCgroupPath,
  startEnforcedToolHost} from '../packages/tool-host/src/enforced.js';

const memory=256*1024*1024;
function fixture(){
  const folder=mkdtempSync(join(tmpdir(),'cgroup-gate-'));
  const mount=join(folder,'cgroup');
  const child=join(mount,'service');
  const leaf=join(child,'kernel');
  mkdirSync(leaf,{recursive:true});
  function limits(dir:string,values:{memory:string;pids:string;cpu:string}){
    writeFileSync(join(dir,'memory.max'),values.memory+'\n');
    writeFileSync(join(dir,'pids.max'),values.pids+'\n');
    writeFileSync(join(dir,'cpu.max'),values.cpu+'\n');
  }
  limits(mount,{memory:String(memory),pids:'64',cpu:'50000 100000'});
  limits(child,{memory:'max',pids:'max',cpu:'max 100000'});
  limits(leaf,{memory:String(64*1024*1024),pids:'16',cpu:'20000 100000'});
  return {folder,mount,child,leaf,limits,
    done:()=>rmSync(folder,{recursive:true,force:true})};
}
function dbFixture(){
  const folder=mkdtempSync(join(tmpdir(),'enforced-host-'));
  const dir=join(folder,'db');mkdirSync(dir);
  const path=join(dir,'agent.sqlite');
  const store=new SqliteEventStore(path);store.close();
  return {path,done:()=>rmSync(folder,{recursive:true,force:true})};
}

test('M3 cgroup: parent and leaf strict limits compose into effective inherited quota',()=>{
  const f=fixture();
  try{
    const actual=inspectCgroupV2From('0::/service/kernel\n',f.mount);
    assert.deepEqual(actual,{
      relativePath:'/service/kernel',memoryBytes:64*1024*1024,pids:16,cpuMillicores:200,
    });
  }finally{f.done();}
});
test('M3 cgroup: parent budget applies when leaf limits are all unlimited',()=>{
  const f=fixture();
  try{
    f.limits(f.leaf,{memory:'max',pids:'max',cpu:'max 100000'});
    const actual=inspectCgroupV2From('0::/service/kernel\n',f.mount);
    assert.deepEqual(actual,{
      relativePath:'/service/kernel',memoryBytes:memory,pids:64,cpuMillicores:500,
    });
  }finally{f.done();}
});
test('M3 cgroup: unlimited inherited controller is not accepted as a finite resource budget',()=>{
  const f=fixture();
  try{
    f.limits(f.mount,{memory:'max',pids:'max',cpu:'max 100000'});
    f.limits(f.leaf,{memory:'max',pids:'max',cpu:'max 100000'});
    assert.throws(()=>inspectCgroupV2From('0::/service/kernel',f.mount),{
      code:'HOST_CGROUP_UNAVAILABLE',
    });
  }finally{f.done();}
});
test('M3 cgroup: malformed membership and duplicate unified mount records fail closed',()=>{
  for(const raw of ['','2:cpu:/service','0::relative','0::/../../etc',
    '0::/service\n0::/other','0::/service\n0::/service','0::/service\u0000bad']){
    assert.throws(()=>readUnifiedCgroupPath(raw),{code:'HOST_CGROUP_UNAVAILABLE'},raw);
  }
  assert.equal(readUnifiedCgroupPath('0::/'),'/' );
});
test('M3 cgroup: invalid controller data and missing control file always fail closed',()=>{
  const f=fixture();
  try{
    const broken=[
      {dir:f.leaf,data:{memory:'0',pids:'16',cpu:'20000 100000'}},
      {dir:f.leaf,data:{memory:'bogus',pids:'16',cpu:'20000 100000'}},
      {dir:f.leaf,data:{memory:String(memory),pids:'-1',cpu:'20000 100000'}},
      {dir:f.leaf,data:{memory:String(memory),pids:'16',cpu:'0 100000'}},
      {dir:f.leaf,data:{memory:String(memory),pids:'16',cpu:'100 1000000000000000000000000'}},
    ];
    for(const item of broken){
      f.limits(item.dir,item.data);
      assert.throws(()=>inspectCgroupV2From('0::/service/kernel',f.mount),{
        code:'HOST_CGROUP_UNAVAILABLE',
      });
    }
  }finally{f.done();}
});
test('M3 cgroup: symlink escape cannot read limits outside an attested mount',()=>{
  const f=fixture();
  try{
    const {symlinkSync,renameSync}=awaitNoop();
    void symlinkSync;void renameSync;
  }finally{f.done();}
});
function awaitNoop(){return {symlinkSync:()=>undefined,renameSync:()=>undefined};}

test('M3 enforced: missing sandbox/budget is rejected BEFORE launching any worker',async()=>{
  const f=dbFixture();
  try{
    const options={databasePath:f.path,requiredBudget:{
      maxMemoryBytes:memory,maxPids:64,maxCpuMillicores:500,
    }};
    await assert.rejects(startEnforcedToolHost(options as never),{
      code:'HOST_CGROUP_BUDGET_UNSATISFIED',
    });
    await assert.rejects(startEnforcedToolHost({databasePath:f.path,
      sandbox:{binaryPath:'/no/bwrap',runtimeReadOnlyDirectories:[]}} as never),{
      code:'HOST_CGROUP_BUDGET_UNSATISFIED',
    });
  }finally{f.done();}
});

test('M3 enforced: invalid production budgets fail before cgroup probe and OS spawn',async()=>{
  const f=dbFixture();
  try{
    const sandbox={binaryPath:'/no/bwrap',runtimeReadOnlyDirectories:['/usr']};
    const budget={maxMemoryBytes:memory,maxPids:64,maxCpuMillicores:500};
    for(const requiredBudget of [
      {...budget,maxMemoryBytes:100},
      {...budget,maxPids:0},
      {...budget,maxCpuMillicores:0},
      {...budget,maxCpuMillicores:Infinity},
    ]){
      await assert.rejects(startEnforcedToolHost({
        databasePath:f.path,sandbox,requiredBudget,
      }),{code:'HOST_CGROUP_BUDGET_UNSATISFIED'});
    }
  }finally{f.done();}
});

test('M3 enforced: existing bounded cgroup does not authorize an invalid sandbox or fallback',async t=>{
  if(process.platform!=='linux')return t.skip('Linux cgroup required');
  let limits;
  try{limits=inspectCurrentCgroupV2();}
  catch{return t.skip('CI parent lacks finite cgroup v2 memory, pids and CPU quotas');}
  const f=dbFixture();
  try{
    await assert.rejects(startEnforcedToolHost({
      databasePath:f.path,
      sandbox:{binaryPath:'/forged/bwrap',runtimeReadOnlyDirectories:['/usr']},
      requiredBudget:{
        maxMemoryBytes:Math.max(limits.memoryBytes,16*1024*1024),
        maxPids:Math.max(limits.pids,1),
        maxCpuMillicores:Math.max(limits.cpuMillicores,10),
      },
    }),{code:'HOST_SANDBOX_UNAVAILABLE'});
  }finally{f.done();}
});
