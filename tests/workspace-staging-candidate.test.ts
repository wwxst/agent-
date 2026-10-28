/**
 * Research candidate for split execution: trusted ledger stays OUTSIDE the
 * untrusted Bubblewrap process; project code sees only a copied stage.
 * This does NOT implement approval, durable receipt, seccomp, cgroup, or
 * a production runner API. These tests are stage-isolation observations.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {buildBubblewrapLaunch,type LinuxBubblewrapSandbox} from '../packages/tool-host/src/sandbox.js';

const compiledRoot=fileURLToPath(new URL('../',import.meta.url));
const worker=fileURLToPath(new URL('../packages/tool-host/src/worker.js',import.meta.url));
const nodeBinary=realpathSync(process.execPath);
const nodeRoot=dirname(dirname(nodeBinary));
const runtime=()=>{
  const dirs=['/usr',nodeRoot].filter((v,i,a)=>a.indexOf(v)===i);
  return dirs.filter(v=>!dirs.some(other=>other!==v && realpathSync(v).startsWith(realpathSync(other)+'/')));
};
const sandbox=():LinuxBubblewrapSandbox=>({
  binaryPath:'/usr/bin/bwrap',runtimeReadOnlyDirectories:runtime(),
});
function supported():boolean {
  if(process.platform!=='linux'||!existsSync('/usr/bin/bwrap'))return false;
  const result=spawnSync('/usr/bin/bwrap',
    ['--unshare-all','--unshare-user','--die-with-parent','--ro-bind','/','/','--','/usr/bin/true'],
    {encoding:'utf8',timeout:2500});
  return result.status===0;
}
function fixture() {
  const home=mkdtempSync(join(tmpdir(),'workspace-staging-proof-'));
  const original=join(home,'original'),stage=join(home,'stage'),dbDir=join(home,'journal');
  const originals=join(original,'src'),originalSpecs=join(original,'spec');
  const stagedSrc=join(stage,'src'),stagedSpecs=join(stage,'spec');
  for(const p of [originals,originalSpecs,stagedSrc,stagedSpecs,dbDir])mkdirSync(p,{recursive:true});
  const originalSource=join(originals,'calc.mjs');
  const originalProtected=join(originalSpecs,'protected.txt');
  const originalAlias=join(originals,'protected-alias.txt');
  const stagedSource=join(stagedSrc,'calc.mjs');
  const stagedProtected=join(stagedSpecs,'protected.txt');
  const stagedAlias=join(stagedSrc,'protected-alias.txt');
  const spec=join(stagedSpecs,'calc.test.mjs');
  const db=join(dbDir,'events.sqlite');
  writeFileSync(originalSource,'export const add=(a,b)=>a-b;\n');
  writeFileSync(originalProtected,'protected-original');
  linkSync(originalProtected,originalAlias);
  // Byte copies; do NOT preserve hardlink identity from original repo.
  copyFileSync(originalSource,stagedSource);
  copyFileSync(originalProtected,stagedProtected);
  copyFileSync(originalAlias,stagedAlias);
  writeFileSync(spec,[
    "import assert from 'node:assert/strict';",
    "import {test} from 'node:test';",
    "import {add} from '../src/calc.mjs';",
    "test('addition',()=>assert.equal(add(2,3),5));",
    '',
  ].join('\n'));
  writeFileSync(db,'DURABLE_LEDGER_SENTINEL');
  return {home,original,stage,dbDir,db,originalSource,originalProtected,
    originalAlias,stagedSrc,stagedSource,stagedProtected,stagedAlias,spec,
    done:()=>rmSync(home,{recursive:true,force:true})};
}
type Fixture=ReturnType<typeof fixture>;
function stageLauncher(f:Fixture) {
  // Derive from the current trusted base recipe for parity, but REMOVE the
  // SQLite rw bind. This argv surgery is RESEARCH-ONLY; production needs
  // a dedicated workspace launcher instead of reusing DB Host launcher.
  const base=buildBubblewrapLaunch(sandbox(),f.db,compiledRoot,worker);
  const cut=base.argv.lastIndexOf('--');
  assert.ok(cut>0);
  const a=[...base.argv.slice(0,cut)];
  const dbBind=a.findIndex((x,i)=>x==='--bind'&&a[i+1]===f.dbDir&&a[i+2]===f.dbDir);
  assert.ok(dbBind>=0,'existing Host recipe must include the DB rw bind');
  a.splice(dbBind,3);
  assert.equal(a.includes(f.dbDir),false,'database must be entirely absent from new argv');
  a.push('--ro-bind',f.stage,f.stage,'--bind',f.stagedSrc,f.stagedSrc,
    '--chdir',f.stage,'--',nodeBinary);
  const run=(args:readonly string[])=>spawnSync(base.executable,[...a,...args],{
    encoding:'utf8',env:{},timeout:7000,
  });
  return {run,argv:a};
}

test('WORKSPACE-STAGE-01: staged process cannot read/write Host ledger or original, even with original hardlinks',t=>{
  if(!supported())return t.skip('Bubblewrap/user namespaces unavailable');
  const f=fixture();
  try{
    const {run,argv}=stageLauncher(f);
    assert.equal(argv.includes(f.db),false);
    const script="import * as fs from 'node:fs';"
      +"const [db,orig,protectedPath,alias,spec]=process.argv.slice(1);"
      +"const deny=fn=>{try{fn();return false;}catch{return true;}};"
      +"const blockedDbRead=deny(()=>fs.readFileSync(db));"
      +"const blockedDbWrite=deny(()=>fs.writeFileSync(db,'tamper'));"
      +"const blockedOriginalWrite=deny(()=>fs.writeFileSync(orig,'tamper'));"
      +"const blockedSpecWrite=deny(()=>fs.writeFileSync(protectedPath,'tamper'));"
      +"const blockedNewHardlink=deny(()=>fs.linkSync(protectedPath,alias+'.another'));"
      +"fs.writeFileSync(alias,'modified-copy');"
      +"console.log(JSON.stringify({blockedDbRead,blockedDbWrite,blockedOriginalWrite,"
      +"blockedSpecWrite,blockedNewHardlink,specRead:fs.readFileSync(spec,'utf8').includes('addition')}));";
    const r=run(['--input-type=module','-e',script,
      f.db,f.originalSource,f.stagedProtected,f.stagedAlias,f.spec]);
    assert.equal(r.status,0,r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()),{
      blockedDbRead:true,blockedDbWrite:true,blockedOriginalWrite:true,
      blockedSpecWrite:true,blockedNewHardlink:true,specRead:true,
    });
    assert.equal(readFileSync(f.db,'utf8'),'DURABLE_LEDGER_SENTINEL');
    assert.equal(readFileSync(f.originalSource,'utf8'),'export const add=(a,b)=>a-b;\n');
    assert.equal(readFileSync(f.originalProtected,'utf8'),'protected-original');
    assert.equal(readFileSync(f.stagedProtected,'utf8'),'protected-original');
    assert.equal(readFileSync(f.stagedAlias,'utf8'),'modified-copy');
  }finally{f.done();}
});

test('WORKSPACE-STAGE-02: staged code can fail, fix and pass actual Node tests without modifying real repository',t=>{
  if(!supported())return t.skip('Bubblewrap/user namespaces unavailable');
  const f=fixture();
  try{
    const {run}=stageLauncher(f);
    const before=run(['--test',f.spec]);
    assert.equal(before.status,1,before.stdout+'\n'+before.stderr);
    const patch="import * as fs from 'node:fs';const [file,expected,next]=process.argv.slice(1);"
      +"const old=fs.readFileSync(file,'utf8');if(old.split(expected).length!==2)process.exit(22);"
      +"fs.writeFileSync(file,old.replace(expected,next));";
    const change=run(['--input-type=module','-e',patch,f.stagedSource,'a-b','a+b']);
    assert.equal(change.status,0,change.stderr);
    const after=run(['--test',f.spec]);
    assert.equal(after.status,0,after.stdout+'\n'+after.stderr);
    assert.equal(readFileSync(f.stagedSource,'utf8'),'export const add=(a,b)=>a+b;\n');
    assert.equal(readFileSync(f.originalSource,'utf8'),'export const add=(a,b)=>a-b;\n');
    assert.equal(readFileSync(f.db,'utf8'),'DURABLE_LEDGER_SENTINEL');
  }finally{f.done();}
});
