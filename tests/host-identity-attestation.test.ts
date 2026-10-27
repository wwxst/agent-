import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readlinkSync} from 'node:fs';
import {test} from 'node:test';
import {
  attestSandboxWorker,assertWorkerIdentity,validateClaimedNamespaces,
} from '../packages/tool-host/src/host-attestation.js';

const current=()=>({
  mount:readlinkSync('/proc/self/ns/mnt'),
  network:readlinkSync('/proc/self/ns/net'),
  pid:readlinkSync('/proc/self/ns/pid'),
  user:readlinkSync('/proc/self/ns/user'),
});
const denied={code:'HOST_IDENTITY_UNVERIFIED'};
test('M3 Host identity: strict immutable namespace shape, not arbitrary READY strings',()=>{
  const original=current();
  assert.deepEqual(validateClaimedNamespaces(original),original);
  for(const claim of [
    null,undefined,1,'namespace',[],{},
    {...original,mount:'mnt:[invalid]'},
    {...original,pid:'pid:123'},
    {...original,network:'net:[12]\n'},
    {...original,extra:'trusted'},
    {mount:original.mount,network:original.network,pid:original.pid},
  ])assert.throws(()=>validateClaimedNamespaces(claim),denied);
});

test('M3 Host identity: self PID cannot pretend to be a nested sandbox worker',()=>{
  assert.throws(()=>attestSandboxWorker({
    launcherPid:process.pid,
    workerPath:process.argv[1]??'unknown.js',
    nodePath:process.execPath,
    databasePath:process.argv[1]??'unknown.js',
    claimedNamespaces:current(),
  }),denied);
});

test('M3 Host identity: invalid launcher PID and nonexistent trusted code fail closed',()=>{
  for(const launcherPid of [0,-1,1.5,NaN]){
    assert.throws(()=>attestSandboxWorker({
      launcherPid,nodePath:process.execPath,workerPath:'/does-not-exist/worker.js',
      databasePath:'/does-not-exist/db',claimedNamespaces:current(),
    }),denied);
  }
});

test('M3 Host identity: untrusted process outside our launcher family is rejected',()=>{
  assert.throws(()=>attestSandboxWorker({
    launcherPid:process.pid,
    nodePath:process.execPath,workerPath:process.execPath,
    databasePath:process.execPath,claimedNamespaces:current(),
  }),denied);
});

test('M3 Host identity: fabricated process epoch cannot authorize subsequent ToolCall',()=>{
  assert.throws(()=>assertWorkerIdentity({
    pid:process.pid,startTicks:'0',namespaces:current(),
  }),denied);
});
test('M3 Host identity: forged namespace inode cannot authorize subsequent ToolCall',()=>{
  assert.throws(()=>assertWorkerIdentity({
    pid:process.pid,startTicks:'1234',
    namespaces:{...current(),network:'net:[999999999]'},
  }),denied);
});

test('M3 Host identity: killed process cannot retain authorization through PID reuse',async()=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore',env:{}});
  assert.ok(child.pid);
  child.kill('SIGKILL');
  await once(child,'close');
  assert.throws(()=>assertWorkerIdentity({
    pid:child.pid!,startTicks:'1',namespaces:current(),
  }),denied);
});

test('M3 Host identity: /proc gate never accepts fake worker proof from bare Node process',async()=>{
  // Child is an ordinary Node process with no new user/network/mount namespaces.
  // Even a truthful "ready" namespace map cannot grant it sandbox status.
  const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore',env:{}});
  try{
    assert.ok(child.pid);
    assert.throws(()=>attestSandboxWorker({
      launcherPid:child.pid!,
      nodePath:process.execPath,
      workerPath:process.argv[1]??process.execPath,
      databasePath:process.argv[1]??process.execPath,
      claimedNamespaces:current(),
    }),denied);
  }finally{
    child.kill('SIGKILL');
    await once(child,'close');
  }
});
