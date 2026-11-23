import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, generationInput, model, sha256 } from '../archive.mjs';
import { createScheduler } from '../monitor.mjs';

test('generation prompts cover supported languages and distinguish Chinese scripts', () => {
  const cases = [
    ['zh-Hans-HK', 'zh-CN', '简体中文'], ['zh-Hant-CN', 'zh-TW', '繁體中文'],
    ['zh-HK', 'zh-TW', '繁體中文'], ['en-GB', 'en', 'English'],
    ['de-AT', 'de', 'Deutsch'], ['ja-JP', 'ja', '日本語'], ['und', 'zh-CN', '简体中文']
  ];
  for (const [tag, language, instruction] of cases) {
    const input = generationInput(tag);
    expect(input.inputLanguage).toBe(language);
    expect(input.inputPrompt).toContain(instruction);
    expect(input.inputPrompt).toContain('SVG');
    expect(input.inputPrompt).toContain('AGENTS.md');
    expect(input.inputSha256).toBe(sha256(input.inputPrompt));
  }
});

test('checks snapshot the language at dispatch and archive exactly what crossed the gateway', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pelican-generation-language-'));
  let host = 'en-US';
  const account = { id: 'a'.repeat(20), name: 'test', enabled: true, present: true };
  const store = new Archive(root, () => host);
  const scheduler = createScheduler(store, async () => [{ account, login: account.id }]);
  const inputs = [];
  const titles = ['Evening Ride', '夕暮れの道', 'Abendfahrt', '黃昏騎行'];
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const title = titles[inputs.length];
    inputs.push((await req.json()).input);
    const text = `<html><head><title>${title}</title></head><body><svg><title>${title}</title></svg></body></html>`;
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] },
      { headers: { 'x-magpie-provider': 'codex', 'x-magpie-model': 'codex/' + model } });
  } });
  try {
    store.saveInfo({ accounts: [account] });
    async function check(language) {
      store.setMonitoringPaused(account.id, true);
      store.setMonitoringPaused(account.id, false);
      await scheduler({ addr: '127.0.0.1:' + gateway.port });
      const runId = [...store.records.keys()].at(-1);
      for (let attempt = 0; attempt < 200 && store.records.get(runId).status === 'running'; attempt++) await Bun.sleep(5);
      const run = store.records.get(runId);
      expect(run.status).toBe('success');
      expect(run.inputLanguage).toBe(language);
      expect(inputs.at(-1)).toBe(generationInput(language).inputPrompt);
      expect(run.inputPrompt).toBe(inputs.at(-1));
      expect(run.inputSha256).toBe(sha256(inputs.at(-1)));
      expect(run.title).toBe(titles[inputs.length - 1]);
      expect(readFileSync(join(root, run.responseText), 'utf8')).toContain(`<title>${run.title}</title>`);
    }
    await check('en');
    host = 'ja-JP';
    await check('ja');
    store.setLanguage('de', 'de-AT');
    await check('de');
    host = 'zh-Hant-HK';
    store.setLanguage('system', 'de-AT');
    await check('zh-TW');
    const status = new Archive(root, () => host).status();
    expect(status.prompt).toBe(inputs[3]);
    expect(status.runs.map(run => run.inputPrompt).sort()).toEqual([...inputs].sort());
  } finally {
    scheduler.dispose();
    gateway.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
