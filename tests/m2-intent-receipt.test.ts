import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {SQLiteEventStore} from '../packages/event-store-sqlite/src/index.js';
import {AgentKernel} from '../packages/kernel-core/src/index.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';
import {ConflictError, type ToolCall, type ToolDefinition, type ProviderEvent} from '../packages/contracts/src/index.js';

const createDb = () => {
  const dir=mkdtempSync(join(tmpdir(),'m2-intent-'));
  return {path:join(dir,'events.db'),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
};
const done = (text='ok'): ProviderEvent => ({type:'message_complete',message:{role:'assistant',text,toolCalls:[]},finishReason:'stop'});
const use = (id='call-1',args:unknown={item:1}): ProviderEvent => ({type:'message_complete',
  message:{role:'assistant',text:'reading',toolCalls:[{id,name:'read',arguments:args}]},finishReason:'tool_use'});
const makeRead = (onRun:(args:unknown)=>Promise<string>|string): ToolDefinition => ({
  name:'read',version:'1',risk:'read',concurrency:'parallel',
  parse:(input:unknown)=>{
    if (!input || typeof input!=='object' || Array.isArray(input)) throw new Error('bad args');
    return input;
  }, execute:async(input)=>onRun(input),
});
const makeKernel = (db:SQLiteEventStore,onRun:(args:unknown)=>Promise<string>|string=async()=> 'data')=>{
  const registry=new ToolRegistry();registry.register(makeRead(onRun));
  return new AgentKernel(db,new FakeProvider([[use()],[done('finished')]]),registry);
};
const proposed:ToolCall={id:'call-1',name:'read',arguments:{item:1}};
async function proposedSession(db:SQLiteEventStore,id='s') {
  await db.append(id,0,[{type:'session.created',data:{}}]);
  await db.append(id,1,[{type:'turn.queued',turnId:'t',data:{}},{type:'user.message',turnId:'t',data:{text:'read'}},
    {type:'turn.started',turnId:'t',data:{}},
    {type:'assistant.message',turnId:'t',data:{role:'assistant',text:'',toolCalls:[proposed]}}]);
}

test('M2: runTurn commits command and turn admission together, and exposes exact command replay',async()=>{
  const dbFile=createDb();
  try {
    const db=new SQLiteEventStore(dbFile.path),k=new AgentKernel(db,new FakeProvider([[done()]]),new ToolRegistry());
    const s=await k.createSession('s');
    assert.equal((await k.runTurn(s,'hello','t','request-1')).status,'completed');
    const events=await db.read(s);
    assert.deepEqual(events.slice(1,5).map(e=>e.type),['command.accepted','turn.queued','user.message','turn.started']);
    const replay=await db.acceptCommand(s,0,'request-1','turn.start',{turnId:'t',text:'hello'});
    assert.equal(replay.replayed,true);
    await assert.rejects(db.acceptCommand(s,0,'request-1','turn.start',{turnId:'t',text:'wrong'}),ConflictError);
    assert.deepEqual(await db.read(s),events);
    db.close();
  } finally {dbFile.cleanup();}
});

test('M2: command admission transaction failure does not start Provider or leave half-turn',async()=>{
  const dbFile=createDb();
  try {
    const db=new SQLiteEventStore(dbFile.path);
    let count=0;
    const k=new AgentKernel(db,{id:'fake',async *stream(){count++;yield done();}},new ToolRegistry());
    const s=await k.createSession('s');
    const raw=new DatabaseSync(dbFile.path);
    raw.exec("CREATE TRIGGER break_turn BEFORE INSERT ON events WHEN NEW.type='turn.started' BEGIN SELECT RAISE(ABORT,'turn insert failed'); END;");
    await assert.rejects(k.runTurn(s,'hello','t','request-1'));
    assert.equal(count,0);
    assert.deepEqual((await db.read(s)).map(e=>e.type),['session.created']);
    raw.exec('DROP TRIGGER break_turn');raw.close();
    assert.equal((await k.runTurn(s,'hello','t','request-1')).status,'completed');
    db.close();
  } finally {dbFile.cleanup();}
});

test('M2: tool intent precedes body, local receipt precedes model-facing result',async()=>{
  const dbFile=createDb();
  try {
    const db=new SQLiteEventStore(dbFile.path);
    let observed = false;
    const k=makeKernel(db,async()=>{
      const events=await db.read('s');
      assert.equal(events.filter(e=>e.type==='tool.intent').length,1);
      assert.equal(events.filter(e=>e.type==='tool.local_receipt').length,0);
      observed=true;
      return 'read output';
    });
    const s=await k.createSession('s');
    assert.equal((await k.runTurn(s,'read','t')).status,'completed');
    assert.equal(observed,true);
    const types=(await db.read(s)).map(e=>e.type);
    assert.ok(types.indexOf('assistant.message') < types.indexOf('tool.intent'));
    assert.ok(types.indexOf('tool.intent') < types.indexOf('tool.local_receipt'));
    assert.ok(types.indexOf('tool.local_receipt') < types.indexOf('tool.result'));
    db.close();
    const reopened=new SQLiteEventStore(dbFile.path);
    const records=await reopened.listToolIntents(s);
    assert.equal(records.length,1);
    assert.equal(records[0]?.status,'settled');
    assert.equal(records[0]?.outcome,'succeeded');
    assert.ok(records[0]?.receiptId);
    assert.equal(await reopened.markUnconfirmedToolsUnknown(s,(await reopened.read(s)).length),(await reopened.read(s)).length);
    reopened.close();
  } finally {dbFile.cleanup();}
});

test('M2: failed intent commit stops body before execution and cannot report success',async()=>{
  const dbFile=createDb();
  try {
    const db=new SQLiteEventStore(dbFile.path),raw=new DatabaseSync(dbFile.path);
    raw.exec("CREATE TRIGGER break_intent BEFORE INSERT ON tool_intents BEGIN SELECT RAISE(ABORT,'intent rejected'); END;");
    let count=0;
    const k=makeKernel(db,async()=>{count++;return 'should not run';});
    const s=await k.createSession('s');
    const out=await k.runTurn(s,'read','t');
    assert.equal(out.status,'failed');
    assert.equal(count,0);
    const events=await db.read(s);
    assert.equal(events.filter(e=>e.type==='tool.intent').length,0);
    assert.equal(events.filter(e=>e.type==='tool.result').length,0);
    assert.equal(events.at(-1)?.type,'turn.failed');
    raw.close();db.close();
  } finally {dbFile.cleanup();}
});

test('M2: receipt commit failure leaves pending intent, no fabricated success; reconciliation is idempotent',async()=>{
  const dbFile=createDb();
  try {
    const db=new SQLiteEventStore(dbFile.path),raw=new DatabaseSync(dbFile.path);
    raw.exec("CREATE TRIGGER break_receipt BEFORE UPDATE ON tool_intents WHEN NEW.status='settled' BEGIN SELECT RAISE(ABORT,'receipt write failed'); END;");
    let count=0;
    const k=makeKernel(db,async()=>{count++;return 'read output';});
    const s=await k.createSession('s');
    const out=await k.runTurn(s,'read','t');
    assert.equal(out.status,'failed');assert.equal(count,1);
    const all=await db.read(s);
    assert.equal(all.filter(e=>e.type==='tool.intent').length,1);
    assert.equal(all.filter(e=>e.type==='tool.local_receipt').length,0);
    assert.equal(all.filter(e=>e.type==='tool.result').length,0);
    assert.equal((await db.listToolIntents(s))[0]?.status,'pending');
    raw.exec('DROP TRIGGER break_receipt');raw.close();db.close();
    const reopened=new SQLiteEventStore(dbFile.path);
    const before=(await reopened.read(s)).length;
    const seq=await reopened.markUnconfirmedToolsUnknown(s,before);
    assert.equal(seq,before+1);
    assert.equal(await reopened.markUnconfirmedToolsUnknown(s,seq),seq);
    const rec=(await reopened.listToolIntents(s))[0]!;
    assert.equal(rec.status,'outcome_unknown');
    assert.equal(rec.receiptId,undefined);
    const unknown=(await reopened.read(s)).find(e=>e.type==='tool.outcome_unknown')!;
    assert.deepEqual(unknown.data,{callId:'call-1',reason:'MISSING_HOST_RECEIPT',mayHaveExecuted:true});
    const restarted=makeKernel(reopened,async()=>{count++;return 'unexpected';});
    await assert.rejects(restarted.resumeSession(s),{code:'SESSION_RECOVERY_REQUIRED'});
    assert.equal(count,1);
    reopened.close();
  } finally {dbFile.cleanup();}
});

test('M2: reject forged intent, duplicate call ID, and wrong receipt without appending events',async()=>{
  const dbFile=createDb();
  try {
    const db=new SQLiteEventStore(dbFile.path);
    await proposedSession(db);
    await assert.rejects(db.recordToolIntent('s',5,'t',{...proposed,id:'unproposed'},'1',{}),{code:'UNPROPOSED_TOOL'});
    await assert.rejects(db.recordToolIntent('s',5,'t',{...proposed,arguments:{item:999}},'1',{}),{code:'UNPROPOSED_TOOL'});
    assert.equal(await db.recordToolIntent('s',5,'t',proposed,'1',{item:1}),6);
    await assert.rejects(db.recordToolIntent('s',6,'t',proposed,'1',{item:1}),ConflictError);
    await assert.rejects(db.recordLocalReceipt('s',6,'wrong',{callId:'call-1',name:'read',outcome:'succeeded',content:'x'}),{code:'INVALID_TOOL_RECEIPT'});
    await assert.rejects(db.recordLocalReceipt('s',6,'t',{callId:'call-1',name:'wrong',outcome:'succeeded',content:'x'}),{code:'INVALID_TOOL_RECEIPT'});
    await assert.rejects(db.recordLocalReceipt('s',6,'t',{callId:'call-1',name:'read',outcome:'denied',content:'x'}),{code:'INVALID_TOOL_RECEIPT'});
    assert.equal((await db.read('s')).length,6);
    db.close();
  }finally{dbFile.cleanup();}
});

test('M2: two independent SQLite handles race on one tool intent; loser never records duplicate',async()=>{
  const dbFile=createDb();
  try {
    const a=new SQLiteEventStore(dbFile.path),b=new SQLiteEventStore(dbFile.path);
    await proposedSession(a);
    const first=await a.recordToolIntent('s',5,'t',proposed,'1',{});
    await assert.rejects(b.recordToolIntent('s',5,'t',proposed,'1',{}),ConflictError);
    assert.equal((await a.read('s')).filter(e=>e.type==='tool.intent').length,1);
    assert.equal(first,6);
    a.close();b.close();
  }finally{dbFile.cleanup();}
});

test('M2: failed receipt in parallel batch drains other running body before terminal failure',async()=>{
  const dbFile=createDb();
  try{
    const db=new SQLiteEventStore(dbFile.path),raw=new DatabaseSync(dbFile.path);
    raw.exec("CREATE TRIGGER fail_first BEFORE UPDATE ON tool_intents WHEN NEW.call_id='a' AND NEW.status='settled' BEGIN SELECT RAISE(ABORT,'write failure'); END;");
    let started=0,ended=0;
    const tool:ToolDefinition={...makeRead(async()=>{started++;await new Promise(r=>setTimeout(r,20));ended++;return 'ok';}),name:'read'};
    const registry=new ToolRegistry();registry.register(tool);
    const p=new FakeProvider([[{type:'message_complete',message:{role:'assistant',text:'',toolCalls:[{id:'a',name:'read',arguments:{}},{id:'b',name:'read',arguments:{}}]},finishReason:'tool_use'}]]);
    const k=new AgentKernel(db,p,registry);const s=await k.createSession('s');
    assert.equal((await k.runTurn(s,'read both')).status,'failed');
    assert.equal(started,2);assert.equal(ended,2);
    const recs=await db.listToolIntents(s);
    assert.equal(recs.find(r=>r.callId==='a')?.status,'pending');
    assert.equal(recs.find(r=>r.callId==='b')?.status,'settled');
    raw.close();db.close();
  }finally{dbFile.cleanup();}
});

test('M2: SIGKILL after committed intent leaves recoverable unknown, never an invented receipt', {skip:process.platform==='win32'}, async()=>{
  const {spawn} = await import('node:child_process');
  const dbFile=createDb();
  let child: ReturnType<typeof spawn>|undefined;
  try {
    const source = `
      import {SQLiteEventStore} from './dist/packages/event-store-sqlite/src/index.js';
      const store = new SQLiteEventStore(process.env.M2_RECOVERY_DB);
      await store.append('s',0,[{type:'session.created',data:{}}]);
      await store.append('s',1,[
        {type:'turn.queued',turnId:'t',data:{}},
        {type:'user.message',turnId:'t',data:{text:'read'}},
        {type:'turn.started',turnId:'t',data:{}},
        {type:'assistant.message',turnId:'t',data:{role:'assistant',text:'',toolCalls:[{id:'c',name:'read',arguments:{}}]}}
      ]);
      await store.recordToolIntent('s',5,'t',{id:'c',name:'read',arguments:{}},'1',{});
      process.stdout.write('INTENT_COMMITTED\\n');
      setInterval(()=>{},1000);
    `;
    child=spawn(process.execPath,['--input-type=module','-e',source],{
      cwd:process.cwd(),env:{...process.env,M2_RECOVERY_DB:dbFile.path},stdio:['ignore','pipe','pipe'],
    });
    const processRef=child;
    await Promise.race([
      new Promise<void>((resolve,reject)=>{
        let output='';
        processRef.stdout!.on('data',(x:Buffer)=>{output+=x.toString();if(output.includes('INTENT_COMMITTED\n'))resolve();});
        processRef.on('error',reject);
        processRef.on('exit',(code,signal)=>reject(new Error(`Worker died early ${code}/${signal}`)));
      }),
      new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('Worker commit timeout')),6000)),
    ]);
    assert.equal(processRef.kill('SIGKILL'),true);
    await new Promise<void>(resolve=>processRef.once('exit',()=>resolve()));
    const reopened=new SQLiteEventStore(dbFile.path);
    assert.equal((await reopened.listToolIntents('s'))[0]?.status,'pending');
    assert.equal((await reopened.read('s')).some(e=>e.type==='tool.local_receipt'),false);
    assert.equal(await reopened.markUnconfirmedToolsUnknown('s',6),7);
    assert.equal((await reopened.listToolIntents('s'))[0]?.status,'outcome_unknown');
    assert.equal((await reopened.read('s')).some(e=>e.type==='tool.local_receipt'),false);
    reopened.close();
  } finally {
    if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
    dbFile.cleanup();
  }
});

test('M2: reconciliation event and unknown state roll back together on SQL failure',async()=>{
  const dbFile=createDb();
  try {
    const db=new SQLiteEventStore(dbFile.path);await proposedSession(db);
    await db.recordToolIntent('s',5,'t',proposed,'1',{item:1});
    const raw=new DatabaseSync(dbFile.path);
    raw.exec("CREATE TRIGGER fail_unknown BEFORE UPDATE ON tool_intents WHEN NEW.status='outcome_unknown' BEGIN SELECT RAISE(ABORT,'reconciliation write failure'); END;");
    await assert.rejects(db.markUnconfirmedToolsUnknown('s',6));
    assert.equal((await db.read('s')).length,6);
    assert.equal((await db.listToolIntents('s'))[0]?.status,'pending');
    raw.exec('DROP TRIGGER fail_unknown');raw.close();
    assert.equal(await db.markUnconfirmedToolsUnknown('s',6),7);
    assert.equal((await db.listToolIntents('s'))[0]?.status,'outcome_unknown');
    db.close();
  }finally{dbFile.cleanup();}
});
