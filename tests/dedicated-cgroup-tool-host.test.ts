import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,renameSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {assertDedicatedCgroupReady,startDedicatedToolHost} from '../packages/tool-host/src/enforced.js';
import {SqliteEventStore} from '../packages/event-store-sqlite/src/index.js';

const budget={maxMemoryBytes:64*1024*1024,maxPids:12,maxCpuMillicores:250};
const leaf='/supervisor/agent-worker';
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'cgroup-dedicated-'));
  const root=join(dir,'cgroup');
  const parent=join(root,'supervisor'),worker=join(parent,'agent-worker');
  mkdirSync(worker,{recursive:true});
  for(const folder of [root,parent,worker]){
    writeFileSync(join(folder,'memory.max'),folder===worker?String(budget.maxMemoryBytes):'max');
    writeFileSync(join(folder,'pids.max'),folder===worker?String(budget.maxPids):'max');
    writeFileSync(join(folder,'cpu.max'),folder===worker?'25000 100000':'max 100000');
    writeFileSync(join(folder,'cgroup.events'),'populated 0\nfrozen 0\n');
    writeFileSync(join(folder,'cgroup.procs'),'');
    writeFileSync(join(folder,'cgroup.kill'),'');
  }
  return {root,worker,dir,done:()=>rmSync(dir,{recursive:true,force:true})};
}
function dbFixture(){
  const dir=mkdtempSync(join(tmpdir(),'dedicated-entry-'));
  const folder=join(dir,'state');mkdirSync(folder);
  const path=join(folder,'kernel.sqlite');
  const db=new SqliteEventStore(path);db.close();
  return {path,done:()=>rmSync(dir,{recursive:true,force:true})};
}

test('M3 dedicated: only empty descendant leaf with direct finite quotas is admitted',()=>{
  const f=fixture();
  try{
    assert.deepEqual(assertDedicatedCgroupReady('/supervisor',leaf,budget,f.root),{
      relativePath:leaf,memoryBytes:budget.maxMemoryBytes,pids:budget.maxPids,
      cpuMillicores:budget.maxCpuMillicores,
    });
  }finally{f.done();}
});

test('M3 dedicated: parent quota NEVER substitutes for unbounded worker leaf',()=>{
  const f=fixture();
  try{
    writeFileSync(join(f.worker,'memory.max'),'max');
    assert.throws(()=>assertDedicatedCgroupReady('/supervisor',leaf,budget,f.root),{
      code:'HOST_CGROUP_UNAVAILABLE',
    });
  }finally{f.done();}
});

test('M3 dedicated: occupied worker group cannot be repurposed or mass-killed',()=>{
  const f=fixture();
  try{
    writeFileSync(join(f.worker,'cgroup.events'),'populated 1\nfrozen 0\n');
    assert.throws(()=>assertDedicatedCgroupReady('/supervisor',leaf,budget,f.root),{
      code:'HOST_CGROUP_BUDGET_UNSATISFIED',
    });
    writeFileSync(join(f.worker,'cgroup.events'),'populated 0\nfrozen 0\n');
    writeFileSync(join(f.worker,'cgroup.procs'),'123\n');
    assert.throws(()=>assertDedicatedCgroupReady('/supervisor',leaf,budget,f.root),{
      code:'HOST_CGROUP_BUDGET_UNSATISFIED',
    });
  }finally{f.done();}
});

test('M3 dedicated: no cgroup.kill means supervisor cannot guarantee subtree teardown',()=>{
  const f=fixture();
  try{
    rmSync(join(f.worker,'cgroup.kill'));
    assert.throws(()=>assertDedicatedCgroupReady('/supervisor',leaf,budget,f.root),{
      code:'HOST_CGROUP_UNAVAILABLE',
    });
  }finally{f.done();}
});

test('M3 dedicated: mismatched ancestry and parent/self cgroup are prohibited',()=>{
  const f=fixture();
  try{
    for(const path of ['/supervisor','/','/other/leaf','/supervisor/agent-worker/child/..',
      '/supervisor//agent-worker']){
      assert.throws(()=>assertDedicatedCgroupReady('/supervisor',path,budget,f.root),
        /cgroup|worker/i,path);
    }
  }finally{f.done();}
});

test('M3 dedicated: leaf symlink outside cgroup2 mount cannot gain trust',()=>{
  const f=fixture();
  try{
    renameSync(f.worker,f.worker+'-actual');
    symlinkSync('/etc',f.worker);
    assert.throws(()=>assertDedicatedCgroupReady('/supervisor',leaf,budget,f.root),{
      code:'HOST_CGROUP_UNAVAILABLE',
    });
  }finally{f.done();}
});

test('M3 dedicated: any one of leaf CPU/memory/PID over budget is a denial',()=>{
  const f=fixture();
  try{
    for(const [file,content] of [
      ['cpu.max','50000 100000'],
      ['memory.max',String(128*1024*1024)],
      ['pids.max','30'],
    ] as const){
      const path=join(f.worker,file);
      const original=readFileSync(path,'utf8');
      writeFileSync(path,content);
      assert.throws(()=>assertDedicatedCgroupReady('/supervisor',leaf,budget,f.root),{
        code:'HOST_CGROUP_BUDGET_UNSATISFIED',
      },file);
      writeFileSync(path,original);
    }
  }finally{f.done();}
});

test('M3 dedicated: caller must specify trusted sandbox and dedicated path',async()=>{
  const f=dbFixture();
  try{
    await assert.rejects(startDedicatedToolHost({
      databasePath:f.path,requiredBudget:budget,dedicatedCgroupRelativePath:leaf,
    } as never),{code:'HOST_CGROUP_BUDGET_UNSATISFIED'});
    await assert.rejects(startDedicatedToolHost({
      databasePath:f.path,requiredBudget:budget,
      sandbox:{binaryPath:'/usr/bin/bwrap',runtimeReadOnlyDirectories:['/usr']},
    } as never),{code:'HOST_CGROUP_BUDGET_UNSATISFIED'});
  }finally{f.done();}
});

test('M3 dedicated: without delegated child cgroup, real entry fails before model or Host',async t=>{
  if(process.platform!=='linux')return t.skip('Linux required');
  const f=dbFixture();
  try{
    await assert.rejects(startDedicatedToolHost({
      databasePath:f.path,requiredBudget:budget,
      sandbox:{binaryPath:'/usr/bin/bwrap',runtimeReadOnlyDirectories:['/usr']},
      dedicatedCgroupRelativePath:'/definitely-nonexistent-kernel-owned-leaf',
    }),/cgroup|worker/i);
  }finally{f.done();}
});

test('M3 dedicated: trusted helper refuses to spawn a command before joining a real cgroup',()=>{
  if(process.platform!=='linux')return;
  const f=dbFixture();
  try{
    const executable=fileURLToPath(new URL('../packages/tool-host/src/cgroup-launcher.js',import.meta.url));
    const marker=join(f.path+'.not-executed');
    const script='import {writeFileSync} from "node:fs";writeFileSync(process.argv[1],"oops");';
    // A request to migrate to the process's own cgroup is invalid. It must
    // never execute the executable that follows it on argv.
    const child=spawnSync(process.execPath,[
      executable,'/',JSON.stringify(budget),process.execPath,
      '--input-type=module','-e',script,marker,
    ],{encoding:'utf8',timeout:3000,env:{}});
    assert.notEqual(child.status,0);
    assert.equal(existsSync(marker),false);
  }finally{f.done();}
});
