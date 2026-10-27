import assert from 'node:assert/strict';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync,readlinkSync,readFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {once} from 'node:events';
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
    for(const flag of ['--unshare-all','--unshare-user','--cap-drop','--die-with-parent','--new-session','--clearenv',
      '--proc','--dev','--tmpfs','--ro-bind','--bind','--chdir']){
      assert.equal(args.includes(flag),true,flag);
    }
    assert.equal(args.includes('--ro-bind') && args.includes('/'),false);
    assert.equal(args.includes('--share-net'),false);
    assert.equal(args[args.indexOf('--cap-drop')+1],'ALL');
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
    for(const forbidden of ['/proc','/sys','/dev','/tmp','/home','/etc','/var','/run']){
      assert.throws(()=>buildBubblewrapLaunch({...config(),runtimeReadOnlyDirectories:[...runtime(),forbidden]},
        t.path,compiledRoot,worker),{code:'HOST_SANDBOX_UNAVAILABLE'},forbidden);
    }
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
    await host.waitUntilReady();
    const proven=host.verifiedWorkerPid;
    assert.ok(proven && proven>1,'Worker PID must be independently attested from /proc');
    assert.notEqual(proven,host.pid,'Worker must not merely be the bwrap launcher');
    for(const namespace of ['mnt','net','pid','user']){
      assert.notEqual(readlinkSync('/proc/'+proven+'/ns/'+namespace),
        readlinkSync('/proc/self/ns/'+namespace));
    }
    const actualArguments=readFileSync('/proc/'+proven+'/cmdline','utf8');
    assert.match(actualArguments,/worker\.js/);
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

test('M3 sandbox: real namespace denies parent-only file, code write and host loopback; permits dedicated SQLite dir',async t=>{
  if(process.platform!=='linux'||!existsSync('/usr/bin/bwrap'))return t.skip('Bubblewrap missing');
  const tmp=temp();
  const secretPath=join(tmp.folder,'parent-only-secret');
  writeFileSync(secretPath,'sensitive-parent-data');
  const listener=createServer();
  let connections=0;
  listener.on('connection',socket=>{connections++;socket.destroy();});
  listener.listen(0,'127.0.0.1');
  try{
    await once(listener,'listening');
    const endpoint=listener.address();
    assert.ok(endpoint && typeof endpoint!=='string');
    const original=buildBubblewrapLaunch(config(),tmp.path,compiledRoot,worker);
    const offset=original.argv.lastIndexOf('--');
    assert.ok(offset>0);
    const probe=String.raw`
      import * as fs from 'node:fs';
      import * as net from 'node:net';
      import {dirname,join} from 'node:path';
      const db=process.argv[1],outside=process.argv[2],codeRoot=process.argv[3],port=Number(process.argv[4]);
      let privateFileReadable=false,codeWritable=false,dbWritable=false;
      try{fs.readFileSync(outside,'utf8');privateFileReadable=true;}catch{}
      try{fs.writeFileSync(join(codeRoot,'MUST_NOT_WRITE_SANDBOX'),'x');codeWritable=true;}catch{}
      try{
        const location=join(dirname(db),'sandbox-scratch-test');
        fs.writeFileSync(location,'ok');dbWritable=fs.readFileSync(location,'utf8')==='ok';fs.unlinkSync(location);
      }catch{}
      const networkConnected=await new Promise(resolve=>{
        const socket=net.connect({host:'127.0.0.1',port});
        socket.once('connect',()=>{socket.destroy();resolve(true);});
        socket.once('error',()=>resolve(false));
        socket.setTimeout(1200,()=>{socket.destroy();resolve(false);});
      });
      console.log(JSON.stringify({privateFileReadable,codeWritable,dbWritable,networkConnected}));
    `;
    const args=[...original.argv.slice(0,offset+1),binary,'--input-type=module','-e',
      probe,tmp.path,secretPath,compiledRoot,String(endpoint.port)];
    const child=spawn(original.executable,args,{env:{},stdio:['ignore','pipe','pipe']});
    let output='',errors='';
    child.stdout.on('data',(part:Buffer)=>{output+=part.toString();});
    child.stderr.on('data',(part:Buffer)=>{errors+=part.toString();});
    let timeout:NodeJS.Timeout|undefined;
    let result:number|null;
    try{
      result=await Promise.race([
        new Promise<number|null>((resolve,reject)=>{
          child.once('close',resolve);
          child.once('error',reject);
        }),
        new Promise<never>((_,reject)=>{
          timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Namespace probe timed out'));},7000);
        }),
      ]);
    }finally{if(timeout)clearTimeout(timeout);}
    if(result!==0){
      if(/creating new namespace failed|Operation not permitted|No permissions/.test(errors))
        return t.skip('Kernel denied strict Bubblewrap user namespace');
      assert.fail('Namespace probe unexpectedly failed: '+errors.slice(0,500));
    }
    const observation=JSON.parse(output.trim()) as Record<string,boolean>;
    assert.deepEqual(observation,{
      privateFileReadable:false,codeWritable:false,dbWritable:true,networkConnected:false,
    });
    assert.equal(connections,0);
  }finally{listener.close();tmp.done();}
});


test('M3 hardening: sandbox executable in writable SQLite folder cannot impersonate Bubblewrap',()=>{
  const t=temp();
  try{
    const launcher=join(dirname(t.path),'bwrap-fake');
    writeFileSync(launcher,'#!/bin/sh\necho unauthorized\n');
    chmodSync(launcher,0o755);
    assert.throws(()=>buildBubblewrapLaunch({...config(),binaryPath:launcher},
      t.path,compiledRoot,worker),{code:'HOST_SANDBOX_UNAVAILABLE'});
    assert.throws(()=>new ProcessToolHost(t.path,1000,
      {...config(),binaryPath:launcher}),{code:'HOST_SANDBOX_UNAVAILABLE'});
  }finally{t.done();}
});

test('M3 hardening: private tmpfs is size capped and invalid safety limits are rejected',()=>{
  const t=temp();
  try{
    const cmd=buildBubblewrapLaunch({...config(),binaryPath:process.execPath,
      privateTmpBytes:2*1024*1024},t.path,compiledRoot,worker);
    const flag=cmd.argv.indexOf('--size');
    assert.ok(flag>=0);
    assert.deepEqual(cmd.argv.slice(flag,flag+6),
      ['--size',String(2*1024*1024),'--perms','0700','--tmpfs','/tmp']);
    for(const privateTmpBytes of [0,1000,-1,128*1024*1024+1,NaN,Infinity,1.5]){
      assert.throws(()=>buildBubblewrapLaunch({...config(),privateTmpBytes},
        t.path,compiledRoot,worker),{code:'HOST_SANDBOX_UNAVAILABLE'});
    }
    for(const startupTimeoutMs of [0,-1,60_001,NaN,1.1]){
      assert.throws(()=>buildBubblewrapLaunch({...config(),startupTimeoutMs},
        t.path,compiledRoot,worker),{code:'HOST_SANDBOX_UNAVAILABLE'});
    }
  }finally{t.done();}
});

test('M3 hardening: actual namespace enforces tmpfs size, not just argv annotation',async t=>{
  if(process.platform!=='linux'||!existsSync('/usr/bin/bwrap'))return t.skip('Bubblewrap missing');
  const probe=spawnSync('/usr/bin/bwrap',['--unshare-all','--unshare-user',
    '--ro-bind','/','/','--proc','/proc','--dev','/dev','--','/usr/bin/true'],
    {encoding:'utf8',timeout:3000});
  if(probe.status!==0)return t.skip('Linux namespaces denied by host policy');
  const tmp=temp();
  try{
    const launcher=buildBubblewrapLaunch({...config(),privateTmpBytes:1024*1024},
      tmp.path,compiledRoot,worker);
    const boundary=launcher.argv.lastIndexOf('--');
    assert.ok(boundary>=0);
    const command=String.raw`
      import {writeFileSync} from 'node:fs';
      try{
        writeFileSync('/tmp/oversize-file',Buffer.alloc(3*1024*1024,0x41));
        process.exitCode=7;
      }catch(error){
        if(error?.code!=='ENOSPC')throw error;
        console.log('TMPFS_ENOSPC');
      }
    `;
    const run=spawnSync(launcher.executable,[...launcher.argv.slice(0,boundary+1),
      binary,'--input-type=module','-e',command],{encoding:'utf8',timeout:6000});
    assert.equal(run.status,0,run.stderr);
    assert.match(run.stdout,/TMPFS_ENOSPC/);
  }finally{tmp.done();}
});

test('M3 hardening: stalled namespace launch has a bounded readiness deadline',async t=>{
  if(process.platform!=='linux'||!existsSync('/usr/bin/bwrap'))return t.skip('Bubblewrap missing');
  const tmp=temp();
  let host:ProcessToolHost|undefined;
  try{
    host=new ProcessToolHost(tmp.path,4000,{...config(),startupTimeoutMs:1});
    const call={
      lease:{sessionId:'s',ownerId:'owner',fenceToken:1,expiresAtMs:0},
      turnId:'t',callId:'c',name:'read.echo',input:{text:'should not execute'},
    };
    await assert.rejects(host.invoke(call,new AbortController().signal),
      {code:'HOST_SANDBOX_UNAVAILABLE'});
    const ledger=new HostExecutionLedger(tmp.path);
    try{assert.equal(ledger.inspect('s').length,0);}
    finally{ledger.close();}
  }finally{host?.close();tmp.done();}
});
