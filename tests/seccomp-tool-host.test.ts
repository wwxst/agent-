import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {
  closeSync,existsSync,fstatSync,mkdirSync,mkdtempSync,
  readFileSync,readSync,realpathSync,rmSync,writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {
  buildHostSeccompBpf,HOST_DENIED_SYSCALLS_X86_64,
  openHostSeccompFilter,seccompBpfInstructions,
} from '../packages/tool-host/src/seccomp.js';
import {buildBubblewrapLaunch,type LinuxBubblewrapSandbox} from '../packages/tool-host/src/sandbox.js';
import {ProcessToolHost} from '../packages/tool-host/src/index.js';
import {ManagedSessionRunner} from '../packages/session-runtime/src/index.js';
import {SqliteEventStore} from '../packages/event-store-sqlite/src/index.js';
import {HostExecutionLedger} from '../packages/tool-host/src/ledger.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const worker=fileURLToPath(new URL('../packages/tool-host/src/worker.js',import.meta.url));
const node=realpathSync(process.execPath);
function tmp(){
  const dir=mkdtempSync(join(tmpdir(),'seccomp-host-'));
  const folder=join(dir,'state');mkdirSync(folder);
  const databasePath=join(folder,'agent.sqlite');
  writeFileSync(databasePath,'');
  return {databasePath,done:()=>rmSync(dir,{force:true,recursive:true})};
}
const runtime=()=>{
  const base=['/usr',dirname(dirname(node))];
  return base.filter((dir,index)=>index===base.findIndex(candidate=>realpathSync(candidate)===realpathSync(dir)))
    .filter(dir=>!base.some(other=>other!==dir&&realpathSync(dir).startsWith(realpathSync(other)+'/')));
};
const profile=():LinuxBubblewrapSandbox=>({
  binaryPath:'/usr/bin/bwrap',
  runtimeReadOnlyDirectories:runtime(),
  seccompPolicy:'network-and-privilege-deny-v1',
});
const supported=()=>process.platform==='linux' && process.arch==='x64';
const probeAvailable=()=>{
  if(!supported()||!existsSync('/usr/bin/bwrap'))return false;
  const check=spawnSync('/usr/bin/bwrap',['--unshare-all','--die-with-parent',
    '--ro-bind','/','/','--proc','/proc','--dev','/dev',
    '--','/usr/bin/true'],{timeout:3000,encoding:'utf8'});
  return check.status===0;
};

test('M3 seccomp: compiled cBPF uses only x86_64 AUDIT_ARCH and explicit x32 rejection',()=>{
  if(!supported())return;
  const program=seccompBpfInstructions(),bytes=buildHostSeccompBpf();
  assert.equal(bytes.length,program.length*8);
  assert.equal(program[0]?.op,0x20);
  assert.equal(program[0]?.value,4);
  assert.equal(program[1]?.value,0xc000003e);
  assert.equal(program[2]?.value,0x80000000);
  assert.equal(program[4]?.op,0x45);
  assert.equal(program[4]?.value,0x40000000);
  assert.equal(program.at(-1)?.value,0x7fff0000);
  for(let i=0;i<program.length;i++){
    const instruction=program[i]!;
    const offset=i*8;
    assert.deepEqual([
      bytes.readUInt16LE(offset),bytes.readUInt8(offset+2),
      bytes.readUInt8(offset+3),bytes.readUInt32LE(offset+4),
    ],[instruction.op,instruction.jt,instruction.jf,instruction.value>>>0]);
  }
});
test('M3 seccomp: denies network and privilege syscalls but retains Node bootstrap and SQLite IO',()=>{
  const names=HOST_DENIED_SYSCALLS_X86_64;
  for(const operation of ['socket','connect','bind','listen','accept','socketpair',
    'ptrace','unshare','setns','mount','bpf','io_uring_setup','process_vm_writev'] as const){
    assert.ok(Number.isSafeInteger(names[operation]));
    const bpf=seccompBpfInstructions();
    const index=bpf.findIndex(x=>x.op===0x15&&x.value===names[operation]);
    assert.ok(index>=6,operation);
    assert.equal(bpf[index+1]?.value,0x00050001);
  }
  const denied=new Set(Object.values(names));
  for(const runtimeSyscall of [0,1,2,3,9,17,18,56,59,202,257]){
    assert.equal(denied.has(runtimeSyscall),false,'Do not deny core Node / SQLite syscall '+runtimeSyscall);
  }
});
test('M3 seccomp: unsupported and forged seccomp profile fail closed before spawn',()=>{
  assert.throws(()=>buildHostSeccompBpf('invalid' as never),
    {code:'HOST_SECCOMP_UNAVAILABLE'});
  const t=tmp();
  try{
    if(supported()){
      assert.throws(()=>buildBubblewrapLaunch({...profile(),
        seccompPolicy:'invalid' as never},t.databasePath,root,worker),
      {code:'HOST_SANDBOX_UNAVAILABLE'});
    }
  }finally{t.done();}
});
test('M3 seccomp: anonymous filter fd contents are stable and never stored as pathname',()=>{
  if(!supported())return;
  const fd=openHostSeccompFilter('network-and-privilege-deny-v1');
  try{
    const expected=buildHostSeccompBpf();
    assert.equal(fstatSync(fd).size,expected.length);
    const read=Buffer.alloc(expected.length);
    assert.equal(readSync(fd,read,0,read.length,0),read.length);
    assert.deepEqual(read,expected);
    assert.match(readFileSync('/proc/self/fdinfo/'+fd,'utf8'),/pos:\s*0/);
  }finally{closeSync(fd);}
});
test('M3 seccomp: opt-in launch must name fd 3 and cannot silently switch modes',()=>{
  if(!supported())return;
  const t=tmp();
  try{
    const launch=buildBubblewrapLaunch(profile(),t.databasePath,root,worker);
    const i=launch.argv.indexOf('--seccomp');
    assert.ok(i>=0);
    assert.equal(launch.argv[i+1],'3');
    assert.ok(i<launch.argv.indexOf('--'));
    assert.equal(launch.argv.filter(x=>x==='--seccomp').length,1);
    const ordinary=buildBubblewrapLaunch({
      binaryPath:'/usr/bin/bwrap',runtimeReadOnlyDirectories:runtime(),
    },t.databasePath,root,worker);
    assert.equal(ordinary.argv.includes('--seccomp'),false);
  }finally{t.done();}
});
test('M3 seccomp: real strict namespace denies socket syscall with EPERM, not just network isolation',async t=>{
  if(!probeAvailable())return t.skip('Kernel Bubblewrap namespace unavailable or unsupported architecture');
  const f=tmp();
  try{
    const launch=buildBubblewrapLaunch(profile(),f.databasePath,root,worker);
    const index=launch.argv.lastIndexOf('--');
    assert.ok(index>=0);
    const script=String.raw`
      import net from 'node:net';
      const server=net.createServer();
      server.once('error',e=>{
        console.log('SOCKET_ERRNO='+e.code);
        process.exitCode=e.code==='EPERM'?0:4;
      });
      server.listen(0,'127.0.0.1',()=>{
        console.log('SOCKET_UNEXPECTEDLY_ALLOWED');
        server.close();
        process.exitCode=5;
      });
    `;
    const fd=openHostSeccompFilter('network-and-privilege-deny-v1');
    let child:ReturnType<typeof spawn>;
    try{
      child=spawn(launch.executable,[...launch.argv.slice(0,index+1),
        node,'--input-type=module','-e',script],{
        env:{},stdio:['ignore','pipe','pipe',fd],
      });
    }finally{closeSync(fd);}
    let output='',errors='';
    child.stdout?.on('data',(part:Buffer)=>{output+=part.toString();});
    child.stderr?.on('data',(part:Buffer)=>{errors+=part.toString();});
    const [exit]=await once(child,'close');
    assert.equal(exit,0,errors);
    assert.match(output,/SOCKET_ERRNO=EPERM/);
    assert.equal(output.includes('SOCKET_UNEXPECTEDLY_ALLOWED'),false);
  }finally{f.done();}
});
test('M3 seccomp: real seccomp-filtered Worker can still persist Host ledger and receipt',async t=>{
  if(!probeAvailable())return t.skip('Kernel Bubblewrap namespace unavailable or unsupported architecture');
  const f=tmp();
  const host=new ProcessToolHost(f.databasePath,4000,profile());
  try{
    await host.waitUntilReady();
    assert.ok(host.verifiedWorkerPid);
    const provider=new FakeProvider([[
      {type:'message_complete',message:{role:'assistant',text:'',toolCalls:[
        {id:'call',name:'read.echo',arguments:{text:'seccomp-proof'}},
      ]},finishReason:'tool_use'},
    ],[{type:'message_complete',message:{role:'assistant',text:'finished',toolCalls:[]},finishReason:'stop'}]]);
    const runner=new ManagedSessionRunner(f.databasePath,provider,lease=>host.createRegistry(lease));
    await runner.createSession('sc-session');
    assert.equal((await runner.runTurn('sc-session','hi','sc-turn')).status,'completed');
    const journal=new SqliteEventStore(f.databasePath),ledger=new HostExecutionLedger(f.databasePath);
    try{
      assert.equal((await journal.read('sc-session')).filter(e=>e.type==='tool.receipt').length,1);
      assert.equal(ledger.inspect('sc-session')[0]?.state,'succeeded');
    }finally{journal.close();ledger.close();}
  }finally{host.close();f.done();}
});
test('M3 seccomp: failing to provide filter fd cannot initialize a strict sandbox',async t=>{
  if(!probeAvailable())return t.skip('Kernel Bubblewrap namespace unavailable or unsupported architecture');
  const f=tmp();
  try{
    const launch=buildBubblewrapLaunch(profile(),f.databasePath,root,worker);
    const result=spawnSync(launch.executable,[...launch.argv],{
      env:{},stdio:['ignore','pipe','pipe'],timeout:3500,encoding:'utf8',
    });
    assert.notEqual(result.status,0,'bwrap must reject an unavailable seccomp fd 3');
  }finally{f.done();}
});
