import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {SqliteWriterLeaseStore,type WriterLease} from '../packages/session-leases-sqlite/src/index.js';
import {SqliteEventStore} from '../packages/event-store-sqlite/src/index.js';
import {TrustedWorkspaceCommitController} from '../packages/tool-host/src/workspace-commit.js';
import type {HostCall} from '../packages/tool-host/src/ledger.js';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const source='export const add=(a,b)=>a-b;\n';
function fixture(){
  const folder=mkdtempSync(join(tmpdir(),'workspace-commit-'));
  const root=join(folder,'workspace'),src=join(root,'src');
  mkdirSync(src,{recursive:true});
  const file=join(src,'calc.mjs'),db=join(folder,'ledger.sqlite');
  writeFileSync(file,source);
  return {folder,root,src,file,db,dispose:()=>rmSync(folder,{force:true,recursive:true})};
}
const input=(sha=digest(source),path='src/calc.mjs')=>({
  path,expectedSha256:sha,oldText:'a-b',newText:'a+b',
});
async function persistedCall(db:string,lease:WriterLease,req:unknown,callId='commit-1'):Promise<HostCall>{
  const journal=new SqliteEventStore(db,lease);
  try{
    await journal.append(lease.sessionId,0,[
      {type:'session.created',data:{}},
      {type:'turn.queued',turnId:'turn-1',data:{}},
      {type:'user.message',turnId:'turn-1',data:{text:'trusted patch'}},
      {type:'turn.started',turnId:'turn-1',data:{}},
      {type:'assistant.message',turnId:'turn-1',data:{
        role:'assistant',text:'trusted instruction',
        toolCalls:[{id:callId,name:'workspace.patch',arguments:req}],
      }},
      {type:'tool.intent',turnId:'turn-1',data:{callId,name:'workspace.patch',step:1}},
    ]);
  }finally{journal.close();}
  return {lease,turnId:'turn-1',callId,name:'workspace.patch',input:req};
}
test('WORKSPACE-COMMIT-01: preview is pure and authorized conditional rename is durably claimed',async()=>{
  const f=fixture(),leases=new SqliteWriterLeaseStore(f.db);
  let checks=0;
  const ctl=new TrustedWorkspaceCommitController(f.db,f.root,()=>{checks++;});
  try{
    const lease=leases.acquire('commit-01','trusted',15_000);assert.ok(lease);
    const plan=ctl.preview(input());
    assert.equal(plan.candidate,'export const add=(a,b)=>a+b;\n');
    assert.equal(readFileSync(f.file,'utf8'),source);
    assert.deepEqual(ctl.inspect('commit-01'),[]);
    const call=await persistedCall(f.db,lease,input());
    const result=ctl.commit(call,new AbortController().signal);
    assert.equal(result.candidateSha256,digest(plan.candidate));
    assert.equal(readFileSync(f.file,'utf8'),plan.candidate);
    assert.equal(ctl.inspect('commit-01')[0]?.state,'succeeded');
    assert.equal(ctl.inspect('commit-01')[0]?.content,digest(plan.candidate));
    assert.equal(checks,4);
    assert.throws(()=>ctl.commit(call,new AbortController().signal),
      {code:'WORKSPACE_PATCH_STALE_BASE'});
    assert.equal(readFileSync(f.file,'utf8'),plan.candidate);
  }finally{ctl.close();leases.close();f.dispose();}
});

test('WORKSPACE-COMMIT-02: path escapes, symlink, hardlink and stale digest fail before STARTED',async()=>{
  const f=fixture(),leases=new SqliteWriterLeaseStore(f.db);
  const ctl=new TrustedWorkspaceCommitController(f.db,f.root,()=>{});
  try{
    const lease=leases.acquire('commit-02','trusted',15000);assert.ok(lease);
    const call=await persistedCall(f.db,lease,input());
    assert.throws(()=>ctl.commit({...call,input:{...input(),path:'../outside'}},
      new AbortController().signal),{code:'WORKSPACE_PATCH_PATH_DENIED'});
    assert.throws(()=>ctl.preview(input('0'.repeat(64))),
      {code:'WORKSPACE_PATCH_STALE_BASE'});
    const target=join(f.src,'alias.mjs');
    symlinkSync(f.file,target);
    assert.throws(()=>ctl.preview(input(digest(source),'src/alias.mjs')),
      {code:'WORKSPACE_UNSAFE_FILE'});
    const hard=join(f.src,'hard.mjs');
    linkSync(f.file,hard);
    assert.throws(()=>ctl.preview(input()),
      {code:'WORKSPACE_UNSAFE_FILE'});
    assert.deepEqual(ctl.inspect('commit-02'),[]);
    assert.equal(readFileSync(f.file,'utf8'),source);
  }finally{ctl.close();leases.close();f.dispose();}
});

test('WORKSPACE-COMMIT-03: missing durable intent, authorization denial and cancellation do not edit',async()=>{
  const f=fixture(),leases=new SqliteWriterLeaseStore(f.db);
  const controller=new TrustedWorkspaceCommitController(f.db,f.root,()=>{});
  try{
    const lease=leases.acquire('commit-03','trusted',15000);assert.ok(lease);
    const noIntent:HostCall={lease,turnId:'none',callId:'nope',
      name:'workspace.patch',input:input()};
    assert.throws(()=>controller.commit(noIntent,new AbortController().signal),
      {code:'HOST_INTENT_MISSING'});
    assert.deepEqual(controller.inspect('commit-03'),[]);
    const call=await persistedCall(f.db,lease,input());
    const aborted=new AbortController();aborted.abort();
    assert.throws(()=>controller.commit(call,aborted.signal),{code:'WORKSPACE_CANCELLED'});
    const deny=new TrustedWorkspaceCommitController(f.db,f.root,()=>{
      throw new Error('approval not granted');
    });
    try{assert.throws(()=>deny.commit(call,new AbortController().signal),
      /approval not granted/);}finally{deny.close();}
    assert.deepEqual(controller.inspect('commit-03'),[]);
    assert.equal(readFileSync(f.file,'utf8'),source);
  }finally{controller.close();leases.close();f.dispose();}
});

test('WORKSPACE-COMMIT-04: revocation after rename yields unknown; replay cannot take duplicate claim',async()=>{
  const f=fixture(),leases=new SqliteWriterLeaseStore(f.db);
  let count=0;
  const controller=new TrustedWorkspaceCommitController(f.db,f.root,()=>{
    if(++count===4)throw new Error('revoked post commit');
  });
  try{
    const lease=leases.acquire('commit-04','trusted',15000);assert.ok(lease);
    const call=await persistedCall(f.db,lease,input());
    assert.throws(()=>controller.commit(call,new AbortController().signal),
      {code:'TOOL_OUTCOME_UNKNOWN'});
    assert.equal(readFileSync(f.file,'utf8'),'export const add=(a,b)=>a+b;\n');
    assert.equal(controller.inspect('commit-04')[0]?.state,'started');
    // Simulate external reconciliation reverting content. Idempotent retry
    // still cannot acquire an old intent; claim uniqueness is independent of bytes.
    writeFileSync(f.file,source);
    assert.throws(()=>controller.commit(call,new AbortController().signal),
      {code:'TOOL_OUTCOME_UNKNOWN'});
    assert.equal(readFileSync(f.file,'utf8'),source);
    assert.equal(controller.inspect('commit-04').length,1);
  }finally{controller.close();leases.close();f.dispose();}
});
