import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OpenAICompatibleProvider } from '../packages/model-providers/src/openai-compatible.js';
import { ProcessToolHost } from '../packages/tool-host/src/index.js';
import { HostExecutionLedger } from '../packages/tool-host/src/ledger.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';
import { ManagedSessionRunner } from '../packages/session-runtime/src/index.js';

const event=(obj:unknown)=>'data: '+JSON.stringify(obj)+'\n\n';
const chunk=(delta:unknown,finish_reason:string|null=null)=>({choices:[{index:0,delta,finish_reason}]});

test('M1 provider: mocked OpenAI SSE crosses fenced Runner, child Host, Intent and Receipt',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'provider-host-')),path=join(dir,'state.sqlite');
  const host=new ProcessToolHost(path);
  const requests:Record<string,unknown>[]=[];
  let n=0;
  try{
    const provider=new OpenAICompatibleProvider({model:'mock',apiKey:'fake-test-value',
      fetcher: (async(_url,init)=>{
        requests.push(JSON.parse(String(init?.body)) as Record<string,unknown>);
        const text=n++===0
          ? event(chunk({tool_calls:[{index:0,id:'call-1',function:{name:'read.echo',arguments:'{"text":"safe"}'}}]}))
            +event(chunk({},'tool_calls'))+'data: [DONE]\n\n'
          : event(chunk({content:'final'}))+event(chunk({},'stop'))+'data: [DONE]\n\n';
        return new Response(text,{headers:{'content-type':'text/event-stream'}});
      }) as typeof fetch,
    });
    const runner=new ManagedSessionRunner(path,provider,lease=>host.createRegistry(lease));
    await runner.createSession('s');
    const result=await runner.runTurn('s','echo only','t');
    assert.equal(result.status,'completed');
    assert.equal(result.assistant?.text,'final');
    assert.equal(n,2);
    const modelTools=requests[0]?.tools as Array<{function:{name:string}}>;
    assert.deepEqual(modelTools.map(x=>x.function.name),['read.echo','read.sleep']);
    const second=requests[1]?.messages as Array<Record<string,unknown>>;
    assert.equal(second.at(-1)?.role,'tool');
    assert.equal(second.at(-1)?.content,'safe');
    const journal=new SqliteEventStore(path),ledger=new HostExecutionLedger(path);
    try{
      const events=await journal.read('s');
      assert.equal(events.filter(x=>x.type==='tool.intent').length,1);
      assert.equal(events.filter(x=>x.type==='tool.receipt').length,1);
      assert.equal(events.filter(x=>x.type==='tool.result').length,1);
      assert.equal(ledger.inspect('s')[0]?.state,'succeeded');
      assert.equal(JSON.stringify(events).includes('fake-test-value'),false);
    }finally{ledger.close();journal.close();}
  }finally{host.close();rmSync(dir,{recursive:true,force:true});}
});
