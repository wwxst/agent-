/**
 * Research-only Bubblewrap Workspace candidate, NOT a production Host.
 * It mounts a temporary repo read-only and a narrower edit directory writable;
 * runs actual Node code and tests without any model-supplied shell command.
 * Does not implement approval, durable tool receipts, Seccomp or cgroup budgets.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildBubblewrapLaunch, type LinuxBubblewrapSandbox } from '../packages/tool-host/src/sandbox.js';

const compiledRoot=fileURLToPath(new URL('../',import.meta.url));
const worker=fileURLToPath(new URL('../packages/tool-host/src/worker.js',import.meta.url));
const nodeBinary=realpathSync(process.execPath);
const runtimeRoot=dirname(dirname(nodeBinary));
const runtime=()=>{
  const choices=['/usr',runtimeRoot].filter((v,i,a)=>a.indexOf(v)===i);
  return choices.filter(v=>!choices.some(other=>other!==v
    && realpathSync(v).startsWith(realpathSync(other)+'/')));
};
const sandbox=():LinuxBubblewrapSandbox=>({
  binaryPath:'/usr/bin/bwrap', runtimeReadOnlyDirectories:runtime(),
});
function tmp() {
  const home=mkdtempSync(join(tmpdir(),'workspace-bwrap-proof-'));
  const dbdir=join(home,'db'),workspace=join(home,'workspace');
  const writable=join(workspace,'src'),locked=join(workspace,'spec');
  mkdirSync(dbdir);mkdirSync(writable,{recursive:true});mkdirSync(locked);
  const db=join(dbdir,'events.sqlite');
  const source=join(writable,'calc.mjs'),spec=join(locked,'calc.test.mjs');
  const protectedFile=join(locked,'protected.txt'),secret=join(home,'private-secret.txt');
  writeFileSync(db,'');
  writeFileSync(source,'export const add=(a,b)=>a-b;\n');
  writeFileSync(spec,[
    "import assert from 'node:assert/strict';",
    "import {test} from 'node:test';",
    "import {add} from '../src/calc.mjs';",
    "test('addition',()=>assert.equal(add(2,3),5));",'',
  ].join('\n'));
  writeFileSync(protectedFile,'immutable');
  writeFileSync(secret,'parent-private');
  symlinkSync(secret,join(writable,'link-to-parent-secret'));
  symlinkSync(protectedFile,join(writable,'link-to-readonly-spec'));
  return {home,db,workspace,writable,locked,source,spec,secret,protectedFile,done:()=>rmSync(home,{force:true,recursive:true})};
}
function supported():boolean {
  if(process.platform!=='linux'||!existsSync('/usr/bin/bwrap'))return false;
  const check=spawnSync('/usr/bin/bwrap',[
    '--unshare-all','--unshare-user','--die-with-parent',
    '--ro-bind','/','/','--','/usr/bin/true',
  ],{timeout:2500,encoding:'utf8'});
  return check.status===0;
}
test('WORKSPACE-OS-01: read-only repository must reject direct source mutation',t=>{
  if(!supported())return t.skip('Bubblewrap/user namespaces unavailable');
  const f=tmp();
  try{
    const base=buildBubblewrapLaunch(sandbox(),f.db,compiledRoot,worker);
    const cut=base.argv.lastIndexOf('--');
    assert.ok(cut>=0);
    const script=String.raw`
      import * as fs from 'node:fs';
      const file=process.argv[1];
      let allowed=false;
      try{fs.writeFileSync(file,'violation');allowed=true;}catch{}
      console.log(JSON.stringify({allowed}));
    `;
    const args=[...base.argv.slice(0,cut),
      '--ro-bind',f.workspace,f.workspace,'--',
      nodeBinary,'--input-type=module','-e',script,f.source];
    const out=spawnSync(base.executable,args,{encoding:'utf8',env:{},timeout:6500});
    assert.equal(out.error,undefined);
    assert.equal(out.status,0,out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim()),{allowed:false});
    assert.equal(readFileSync(f.source,'utf8'),'export const add=(a,b)=>a-b;\n');
  }finally{f.done();}
});
test('WORKSPACE-OS-02: writable subdirectory permits actual fail/fix/retest; other mounts stay protected',t=>{
  if(!supported())return t.skip('Bubblewrap/user namespaces unavailable');
  const f=tmp();
  try{
    const base=buildBubblewrapLaunch(sandbox(),f.db,compiledRoot,worker);
    const cut=base.argv.lastIndexOf('--');
    assert.ok(cut>=0);
    // This is intentionally a test-only candidate: the production Host does not
    // accept additional Workspace mounts and its code remains unchanged.
    const pre=[...base.argv.slice(0,cut),'--ro-bind',f.workspace,f.workspace,
      '--bind',f.writable,f.writable,'--',nodeBinary];
    const run=(args:string[])=>spawnSync(base.executable,[...pre,...args],{
      encoding:'utf8',env:{},timeout:7500,
    });
    const inspect=String.raw`
      import * as fs from 'node:fs';
      import * as net from 'node:net';
      const [source,locked,secret,secretLink,lockedLink,compiled]=process.argv.slice(1);
      let sourceReadable=false,lockedReadable=false,secretReadable=false,
        writableSource=false,writableLocked=false,writableLockedThroughLink=false,
        readableSecretThroughLink=false,writableCode=false,networkConnected=false;
      try{sourceReadable=fs.readFileSync(source,'utf8').includes('a-b');}catch{}
      try{lockedReadable=fs.readFileSync(locked,'utf8')==='immutable';}catch{}
      try{fs.readFileSync(secret,'utf8');secretReadable=true;}catch{}
      try{fs.readFileSync(secretLink,'utf8');readableSecretThroughLink=true;}catch{}
      try{fs.writeFileSync(source,fs.readFileSync(source,'utf8'));writableSource=true;}catch{}
      try{fs.writeFileSync(locked,'changed');writableLocked=true;}catch{}
      try{fs.writeFileSync(lockedLink,'changed');writableLockedThroughLink=true;}catch{}
      try{fs.writeFileSync(compiled+'/MUST_NOT_WRITE','no');writableCode=true;}catch{}
      networkConnected=await new Promise(resolve=>{
        const socket=net.connect({host:'127.0.0.1',port:9});
        socket.once('connect',()=>{socket.destroy();resolve(true);});
        socket.once('error',()=>resolve(false));
        socket.setTimeout(500,()=>{socket.destroy();resolve(false);});
      });
      console.log(JSON.stringify({sourceReadable,lockedReadable,secretReadable,
        readableSecretThroughLink,writableSource,writableLocked,
        writableLockedThroughLink,writableCode,networkConnected}));
    `;
    const check=run(['--input-type=module','-e',inspect,
      f.source,f.protectedFile,f.secret,
      join(f.writable,'link-to-parent-secret'),
      join(f.writable,'link-to-readonly-spec'),compiledRoot]);
    assert.equal(check.status,0,check.stderr);
    assert.deepEqual(JSON.parse(check.stdout.trim()),{
      sourceReadable:true,lockedReadable:true,secretReadable:false,
      readableSecretThroughLink:false,writableSource:true,writableLocked:false,
      writableLockedThroughLink:false,writableCode:false,networkConnected:false,
    });
    const patch=String.raw`
      import * as fs from 'node:fs';
      const [file,expected,replacement]=process.argv.slice(1);
      const old=fs.readFileSync(file,'utf8');
      if(old.split(expected).length!==2)process.exit(22);
      fs.writeFileSync(file,old.replace(expected,replacement));
      console.log('patched');
    `;
    const apply=(expected:string,replacement:string)=>{
      const result=run(['--input-type=module','-e',patch,f.source,expected,replacement]);
      assert.equal(result.status,0,result.stderr);
      assert.match(result.stdout,/patched/);
    };
    apply('a-b','a*b');
    const failing=run(['--test',f.spec]);
    assert.equal(failing.status,1,failing.stdout+'\n'+failing.stderr);
    apply('a*b','a+b');
    const passing=run(['--test',f.spec]);
    assert.equal(passing.status,0,passing.stdout+'\n'+passing.stderr);
    assert.equal(readFileSync(f.source,'utf8'),'export const add=(a,b)=>a+b;\n');
    assert.equal(readFileSync(f.protectedFile,'utf8'),'immutable');
  }finally{f.done();}
});
