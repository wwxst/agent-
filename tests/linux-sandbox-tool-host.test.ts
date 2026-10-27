import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {buildBubblewrapLaunch,type LinuxBubblewrapSandbox} from '../packages/tool-host/src/sandbox.js';
import {ProcessToolHost} from '../packages/tool-host/src/index.js';
import {ManagedSessionRunner} from '../packages/session-runtime/src/index.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';
import {SqliteEventStore} from '../packages/event-store-sqlite/src/index.js';
import {HostExecutionLedger} from '../packages/tool-host/src/ledger.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';

const compiledRoot=fileURLToPath(new URL('../',import.meta.url));
const worker=fileURLToPath(new URL('../packages/tool-host/src/worker.js',import.meta.url));
const binary=realpathSync(process.execPath);
const root=dirname(dirname(binary));
function temp(){
  const folder=mkdtempSync(join(tmpdir(),'sandbox-host-'));
  const dbDir=join(folder,'sqlite');
  mkdirSync(dbDir);
  const path=join(dbDir,'events.sqlite');
  writeFileSync(path,'');
  return {folder,path,done:()=>rmSync(folder,{force:true,recursive:true})};
}
const runtime=():readonly string[]=>{
  const values=['/usr',root].filter((value,index,all)=>all.indexOf(value)===index);
  return values.filter(value=>{
    const actual=realpathSync(value);
    return !values.some(other=>other!==value&&actual.startsWith(realpathSync(other)+'/'));
  });
};
const config=():LinuxBubblewrapSandbox=>({
  binaryPath:'/usr/bin/bwrap',runtimeReadOnlyDirectories:runtime(),
});
const inside=(rootPath:string,maybeChild:string)=>{
  const rel=relative(rootPath,maybeChild);
  return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));
};

test('M3 sandbox: Linux namespace argv has no network, no inherited environment and no root bind',()=>{
  if(process.platform!=='linux')return;
  const t=temp();
  try{
    const result=buildBubblewrapLaunch({
      ...config(),binaryPath:process.execPath,
    },t.path,compiledRoot,worker);
    const args=result.argv;
    assert.equal(result.executable,realpathSync(process.execPath));
    for(const flag of ['--unshare-all','--die-with-parent','--new-session','--clearenv',
      '--proc','--dev','--tmpfs','--ro-bind','--bind','--chdir']){
      assert.equal(args.includes(flag),true,flag);
    }
    assert.equal(args.includes('--ro-bind') && args.includes('/'),false);
    assert.equal(args.includes('--share-net'),false);
    assert.equal(args.includes('--ro-bind-try'),false);
    assert.equal(args.includes('--unshare-user-try'),false);
    assert.equal(args.at(-4),'--');
    assert.equal(args.at(-3),binary);
    assert.equal(args.at(-2),worker);
    assert.equal(args.at(-1),realpathSync(t.path));
  }finally{t.done();}
});

test('M3 sandbox: missing launcher and trust configuration fail before worker launch',()=>{
  const t=temp();
  try{
    assert.throws(()=>buildBubblewrapLaunch({...config(),binaryPath:'/nonexistent/bwrap'},
      t.path,compiledRoot,worker),{code:'HOST_SANDBOX_UNAVAILABLE'});
    assert.throws(()=>buildBubblewrapLaunch({...config(),runtimeReadOnlyDirectories:[]},
      t.path,compiledRoot,worker),{code:'HOST_SANDBOX_UNAVAILABLE'});
    assert.throws(()=>buildBubblewrapLaunch({...config(),runtimeReadOnlyDirectories:['/']},
      t.path,compiledRoot,worker),{code:'HOST_SANDBOX_UNAVAILABLE'});
    assert.throws(()=>new ProcessToolHost(t.path,400,{...config(),binaryPath:'/missing/namespace/bwrap'}),
      {code:'HOST_SANDBOX_UNAVAILABLE'});
  }finally{t.done();}
});

test('M3 sandbox: writable SQLite directory cannot overlap readonly runtime or application',()=>{
  const t=temp();
  try{
    assert.throws(()=>buildBubblewrapLaunch({...config(),runtimeReadOnlyDirectories:[dirname(t.path)]},
      t.path,compiledRoot,worker),{code:'HOST_SANDBOX_UNAVAILABLE'});
    assert.throws(()=>buildBubblewrapLaunch({...config(),runtimeReadOnlyDirectories:[compiledRoot]},
      t.path,compiledRoot,worker),{code:'HOST_SANDBOX_UNAVAILABLE'});
    assert.throws(()=>buildBubblewrapLaunch(config(),t.path,dirname(t.path),worker),
      {code:'HOST_SANDBOX_UNAVAILABLE'});
  }finally{t.done();}
});

test('M3 sandbox: compiled worker cannot escape the read-only trusted code root',()=>{
  const t=temp();
  try{
    assert.throws(()=>buildBubblewrapLaunch({...config(),binaryPath:process.execPath},
      t.path,compiledRoot,process.execPath),{code:'HOST_SANDBOX_UNAVAILABLE'});
    assert.ok(inside(compiledRoot,worker));
  }finally{t.done();}
});

test('M3 sandbox: dynamic linker aliases may only target explicit readonly runtime mounts',()=>{
  if(process.platform!=='linux')return;
  const t=temp();
  try{
    const argv=buildBubblewrapLaunch({...config(),binaryPath:process.execPath},
      t.path,compiledRoot,worker).argv;
    const pairs:string[]=[];
    for(let i=0;i<argv.length-2;i++)if(argv[i]==='--symlink')pairs.push(argv[i+2]!);
    for(const alias of pairs)assert.ok(['/bin','/lib','/lib64','/sbin'].includes(alias));
    assert.equal(argv.includes('--bind') && argv.includes(dirname(t.path)),true);
    assert.equal(argv.some(v=>v.includes('NODE_OPTIONS')),false);
  }finally{t.done();}
});

test('M3 sandbox: invalid bubblewrap launch cannot switch over to the unfenced legacy Host',async()=>{
  const t=temp();
  try{
    assert.throws(()=>new ProcessToolHost(t.path,400,{
      binaryPath:'/tmp/invalid/bwrap',runtimeReadOnlyDirectories:['/usr'],
    }),{code:'HOST_SANDBOX_UNAVAILABLE'});
    const journal=new SqliteEventStore(t.path);
    try{assert.equal(await journal.read('session').then(r=>r.length),0);}
    finally{journal.close();}
  }finally{t.done();}
});

test('M3 sandbox: actual bwrap namespace worker uses durable Host ledger if supported',async(t)=>{
  if(process.platform!=='linux'||!existsSync('/usr/bin/bwrap'))return t.skip('Bubblewrap missing');
  const probe=spawnSync('/usr/bin/bwrap',['--unshare-all','--die-with-parent',
    '--ro-bind','/','/','--proc','/proc','--dev','/dev',
    '--','/usr/bin/true'],{encoding:'utf8',timeout:2000});
  if(probe.status!==0) return t.skip('Linux user namespaces denied by host policy');
  const tmp=temp(),host=new ProcessToolHost(tmp.path,3000,config());
  try{
    const provider=new FakeProvider([[
      {type:'message_complete',message:{role:'assistant',text:'',toolCalls:[
        {id:'call',name:'read.echo',arguments:{text:'sandbox output'}},
      ]},finishReason:'tool_use'},
    ],[ {type:'message_complete',message:{role:'assistant',text:'done',toolCalls:[]},finishReason:'stop'} ]]);
    const runner=new ManagedSessionRunner(tmp.path,provider,lease=>host.createRegistry(lease));
    await runner.createSession('session');
    assert.equal((await runner.runTurn('session','hello','turn')).status,'completed');
    const journal=new SqliteEventStore(tmp.path),ledger=new HostExecutionLedger(tmp.path);
    try{
      const events=await journal.read('session');
      assert.equal(events.filter(e=>e.type==='tool.receipt').length,1);
      assert.equal(ledger.inspect('session')[0]?.state,'succeeded');
    }finally{journal.close();ledger.close();}
  }finally{host.close();tmp.done();}
});
