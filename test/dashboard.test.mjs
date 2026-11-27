import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, hour, model } from '../archive.mjs';
import { serveGallery } from '../gallery.mjs';
import { createScheduler } from '../monitor.mjs';

const account = { id: 'a'.repeat(20), name: 'Example', enabled: true, present: true };
const second = { ...account, id: 'b'.repeat(20) };
const token = 'a'.repeat(32);
const now = new Date(2026, 10, 23, 10, 0).getTime();
const responseHeaders = { 'x-magpie-provider': 'codex', 'x-magpie-model': 'codex/' + model };
const reply = text => Response.json({ status: 'completed', output: [{ type: 'message',
  content: [{ type: 'output_text', text }] }] }, { headers: responseHeaders });

async function until(predicate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw Error('Timed out waiting for fixture');
}

test('bounded overview, filtered cursor pages, legacy records, embedded reads and full details', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pelican-pages-'));
  const store = new Archive(root);
  const server = serveGallery(store, { hostname: '127.0.0.1', port: 0 });
  const get = (path, init) => fetch(new URL(path, server.url), init);
  const add = (id, index, status, accountId = account.id) => store.rememberRun('', {
    id, accountId, status, startedAt: new Date(now - index * hour).toISOString(), inputPrompt: 'archived prompt',
    title: id, ...status === 'failed' && { modelOutcome: 'success', artworkOutcome: 'failed' }
  });
  try {
    store.saveInfo({ accounts: [account, second] });
    for (let index = 0; index < 1000; index++) add('run-' + index, index, index % 2 ? 'failed' : 'success');
    add('unassigned', 0, 'success', null);
    add('other', 0, 'success', second.id);
    const overview = await (await get('/api/status?summary=1')).json();
    expect(overview.runs).toBeUndefined();
    expect(JSON.stringify(overview).length).toBeLessThan(12000);
    expect(overview.historyStats.total).toBe(1);
    expect(overview.accounts.find(entry => entry.id === account.id).stats).toMatchObject({
      total: 1000, saved: 500, modelTotal: 1000, modelSuccess: 1000, artworkTotal: 1000, artworkSuccess: 500
    });
    const pageUrl = '/api/runs?account='+account.id+'&filter=failed&limit=2';
    const first = await (await get(pageUrl)).json();
    expect(first.items.map(run => run.id)).toEqual(['run-1','run-3']);
    expect(first.items[0].inputPrompt).toBeUndefined();
    add('newer', -1, 'failed');
    const next = await (await get(pageUrl+'&cursor='+first.nextCursor)).json();
    expect(next.items.map(run => run.id)).toEqual(['run-5','run-7']);
    expect(next.featured.id).toBe('run-0');
    expect((await (await get('/api/runs?account=history')).json()).items[0].id).toBe('unassigned');
    expect((await get(pageUrl+'&cursor=other')).status).toBe(400);
    expect((await get(pageUrl,{headers:{Origin:'null'}})).status).toBe(403);
    const embed = await (await get('/?embedded=1')).text();
    const key = embed.match(/data-view="([^"]+)"/)[1];
    const detail = await get('/api/runs/run-999?view='+key,{headers:{Origin:'null'}});
    expect(detail.headers.get('Access-Control-Allow-Origin')).toBe('null');
    expect((await detail.json()).inputPrompt).toBe('archived prompt');
    expect((await (await get('/api/status')).json()).legacyRuns).toHaveLength(1);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test('manual checks survive quiet hours and restart, coalesce retries and preserve a paused schedule', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pelican-manual-'));
  let store = new Archive(root), clock = now, calls = 0, scheduler;
  const server = serveGallery(store, { hostname: '127.0.0.1', port: 0 });
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { calls++; return reply('<html><svg></svg></html>'); } });
  const create = () => createScheduler(store, async () => [{ account, login: 'fixture' }], () => clock);
  try {
    store.planDispatches(clock, { accounts: [account] });
    store.setMonitoringPaused(account.id, true, clock);
    store.setQuietHours({ enabled:true, start:590, end:630 }, clock);
    const key = (await (await fetch(server.url)).text()).match(/name="monitor-control" content="([^"]+)"/)[1];
    const submit = (key, requestId) => fetch(new URL('/api/accounts/'+account.id+'/check',server.url),
      { method:'POST',body:new URLSearchParams({key,requestId}) });
    expect((await submit('invalid', token)).status).toBe(403);
    expect((await submit(key, token)).status).toBe(202);
    expect((await submit(key, 'b'.repeat(32))).status).toBe(202);
    expect(store.info.manualChecks).toHaveLength(1);
    scheduler = create();
    const target = {addr:'127.0.0.1:'+gateway.port};
    await scheduler(target);
    expect(calls).toBe(0);
    scheduler.dispose();
    store = new Archive(root); scheduler = create(); clock += hour;
    await scheduler(target);
    await until(() => [...store.records.values()][0]?.status === 'success');
    const run = [...store.records.values()][0];
    expect(run.trigger).toBe('manual');
    expect(store.info.monitoringFromSlot[account.id]).toBeNull();
    expect(store.info.nextByAccount[account.id]).toBeUndefined();
    expect(store.info.manualChecks).toHaveLength(0);
    expect(store.dailyChecks.size).toBe(0);
    expect(store.lastResumeAt.size).toBe(0);
    expect((await fetch(new URL(run.svg,server.url))).status).toBe(200);
    store.requestManual(account.id,token,clock);
    await scheduler(target);
    expect(calls).toBe(1);
    store.planDispatches(clock,{accounts:[{...account,enabled:false}]});
    expect(store.requestManual(account.id,'d'.repeat(32),clock)).toBe(false);
  } finally { scheduler?.dispose(); gateway.stop(true); server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test('request failures, invalid artwork, successful saves, interruptions and unknown older failures have independent totals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pelican-outcomes-'));
  const store = new Archive(root);
  let calls = 0, release;
  const gateway = Bun.serve({ hostname:'127.0.0.1',port:0,async fetch() {
    calls++;
    if (calls===1) return Response.json({}, { status:503 });
    if (calls===2) return reply('No artwork in this reply');
    if (calls===4) await new Promise(resolve => { release=resolve; });
    return reply('<html><svg></svg></html>');
  } });
  const scheduler = createScheduler(store, async () => [{ account,login:'fixture' }], () => now);
  try {
    store.planDispatches(now,{accounts:[account]});
    const due = store.info.nextByAccount[account.id];
    for (let index=1; index<=4; index++) {
      store.requestManual(account.id,String(index).repeat(32),now);
      await scheduler({addr:'127.0.0.1:'+gateway.port});
      if(index===4){
        await until(()=>Boolean(release));
        store.setQuietHours({enabled:true,start:590,end:630},now);
        scheduler.refreshQuietHours(now);
        release();
      }
      await until(()=>[...store.records.values()].every(run=>run.status!=='running'));
      if(index<4)expect(store.info.nextByAccount[account.id]).toBe(due);
    }
    store.rememberRun('',{id:'old',accountId:account.id,status:'failed',startedAt:new Date(now).toISOString(),note:'Unknown'});
    expect(store.history(account.id).stats).toMatchObject({total:5,modelSuccess:2,modelTotal:3,artworkSuccess:1,artworkTotal:2,
      activeInterruptions:1,interrupted:1,saved:1});
  } finally { release?.(); scheduler.dispose(); gateway.stop(true); rmSync(root,{recursive:true,force:true}); }
});

test('manual and scheduled checks share three slots and live congestion retains the rest-day appointment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pelican-capacity-'));
  const store = new Archive(root);
  const accounts = ['a','b','c','d'].map(letter => ({...account,id:letter.repeat(20)}));
  let clock = new Date(2026,10,21,8,50).getTime(), calls = 0, active = 0, maximum = 0;
  const releases = [];
  const gateway = Bun.serve({hostname:'127.0.0.1',port:0,async fetch() {
    calls++; active++; maximum=Math.max(maximum,active);
    await new Promise(resolve=>releases.push(resolve));
    active--;
    return reply('<html><svg></svg></html>');
  }});
  const target = {addr:'127.0.0.1:'+gateway.port};
  const scheduler = createScheduler(store,async()=>accounts.map(account=>({account,login:account.id})),()=>clock);
  try {
    store.saveInfo({accounts,calendar:{region:'CN',overrides:{}}});
    store.setQuietHours(store.quietHours,clock,{enabled:true,count:2,distribution:'custom',times:[540,900]});
    clock=new Date(2026,10,21,9,0).getTime();
    store.requestManual(accounts[0].id,token,clock);
    await scheduler(target); await until(()=>calls===3);
    clock+=70000;
    await scheduler(target);
    expect(calls).toBe(3);
    releases.splice(0).forEach(resolve=>resolve());
    await until(()=>[...store.records.values()].every(run=>run.status==='success'));
    await scheduler(target); await until(()=>calls===5);
    releases.splice(0).forEach(resolve=>resolve());
    await until(()=>[...store.records.values()].every(run=>run.status==='success'));
    expect(maximum).toBe(3);
    expect([...store.records.values()].filter(run=>run.trigger==='rest-sample')).toHaveLength(4);
    expect(store.history(accounts[0].id).stats.saved).toBe(2);
  } finally {
    releases.splice(0).forEach(resolve=>resolve());
    scheduler.dispose();gateway.stop(true);rmSync(root,{recursive:true,force:true});
  }
});
