// End-to-end jump test against pi's real fullscreen renderer: a started TuiAltScreen
// behind pi's renderer proxy, pi's chat viewport layout, and pi's real message
// components (markdown rendering, OSC 133 markers). Run through test.mjs.
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function transcriptTests({ root, jiti, test, assert }) {
  // Same module instance pi's dist components use (jiti would load a second copy).
  const tui = await import(createRequire(join(root, 'package.json')).resolve('@earendil-works/pi-tui'));
  const { initTheme, theme, getMarkdownTheme } = await import(join(root, 'dist/modes/interactive/theme/theme.js'));
  initTheme('dark');
  const { UserMessageComponent } = await import(join(root, 'dist/modes/interactive/components/user-message.js'));
  const { AssistantMessageComponent } = await import(join(root, 'dist/modes/interactive/components/assistant-message.js'));
  const { SkillInvocationMessageComponent } = await import(join(root, 'dist/modes/interactive/components/skill-invocation-message.js'));
  const { createChatViewport } = await import(join(root, 'dist/modes/interactive/chat-viewport.js'));
  const { createInteractiveTuiReference } = await import(join(root, 'dist/modes/interactive/tui-renderer.js'));
  const { parseSkillBlock } = await import(join(root, 'dist/index.js'));
  const { default: extension } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));
  const anchors = await jiti.import(fileURLToPath(new URL('./anchors.ts', import.meta.url)));

  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  const reply = (text, extra = {}) => ({ role: 'assistant', content: text ? [{ type: 'text', text }] : [], stopReason: 'stop', ...extra });
  const skill = '<skill name="demo" location="/tmp/demo/SKILL.md">\nskill body\n</skill>';
  const messages = [
    ['e1', user('# Auth refactor\nPlease fix the **login** flow — see [the docs](https://example.com/auth) 🚀')],
    ['e2', { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }], stopReason: 'toolUse' }],
    ['e3', { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'file' }] }],
    ['e4', reply('', { stopReason: 'error', errorMessage: 'upstream 500' })], // marked with no text
    ['e5', reply('Done — the *login* flow now uses short-lived `tokens`.\n\n' + 'Details line.\n\n'.repeat(6))],
    ['e6', user(skill)], // skill-only: no user marker
    ['e7', user('## Second topic: caching layer\n' + 'We need a longer explanation that wraps across several rows at narrow widths. '.repeat(3))],
    ['e8', reply('Ack.\n\n' + 'More filler.\n\n'.repeat(8))],
    ['e9', user(`${skill}\n\nskill follow-up question about ümlauts and 日本語`)],
    ['e10', reply('Final summary of everything.\n\n' + 'Tail filler.\n\n'.repeat(10))],
  ];
  const entries = messages.map(([id, message]) => ({ id, type: 'message', parentId: null, timestamp: '2026-09-19T00:00:00Z', message }));

  // The format fingerprints were stored in before this fix (raw text, whitespace-normalized).
  const oldFingerprint = message => anchors.normalize(anchors.textOf(message)).slice(0, 48);
  const topic = (id, heading, anchor) => ({ id, heading, anchor, summary: [], at: 1 });
  const topics = [
    topic('t1', 'Auth refactor', { entryId: 'e1', role: 'user', fingerprint: oldFingerprint(messages[0][1]) }),
    topic('t2', 'Login done', { entryId: 'e5', role: 'assistant', fingerprint: anchors.fingerprintOf(messages[4][1]) }),
    topic('t3', 'Caching', { entryId: 'e7', role: 'user', fingerprint: anchors.fingerprintOf(messages[6][1]) }),
    // Compaction-style copy: original id gone, fingerprint still in context.
    topic('t4', 'Skill follow-up', { entryId: 'gone-e9', role: 'user', fingerprint: oldFingerprint({ role: 'user', content: 'skill follow-up question about ümlauts and 日本語' }) }),
    topic('t5', 'Wrap-up', { entryId: 'e10', role: 'assistant', fingerprint: anchors.fingerprintOf(messages[9][1]) }),
    topic('t6', 'Compacted away', { entryId: 'gone', role: 'user', fingerprint: 'nothing like this exists anywhere' }),
  ];
  const snapshot = { id: 's1', type: 'custom', customType: 'topic-outline', parentId: null,
    data: { version: 2, topics, now: '', overall: '', topicCounter: topics.length, generatedAt: 1, state: 'stale' } };
  const branch = [...entries, snapshot];

  /** Mirrors InteractiveMode.addMessageToChat / renderSessionItems for the roles used here. */
  function buildDocument() {
    const document = new tui.Container();
    document.addChild(new tui.Text('pi header (no marker)', 1, 1));
    const chat = new tui.Container();
    document.addChild(chat);
    for (const [, message] of messages) {
      if (message.role === 'user') {
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
        if (!text) continue;
        if (chat.children.length > 0) chat.addChild(new tui.Spacer(1));
        const block = parseSkillBlock(text);
        if (block) {
          chat.addChild(new SkillInvocationMessageComponent(block, getMarkdownTheme()));
          if (block.userMessage) { chat.addChild(new tui.Spacer(1)); chat.addChild(new UserMessageComponent(block.userMessage)); }
        } else chat.addChild(new UserMessageComponent(text));
      } else if (message.role === 'assistant') {
        chat.addChild(new AssistantMessageComponent(message));
        for (const block of message.content) {
          if (block.type === 'toolCall') chat.addChild(new tui.Text(`read tool\nfile contents`, 1, 1)); // stand-in for ToolExecutionComponent
        }
      }
    }
    return document;
  }

  function fakeTerminal(columns, rows) {
    return { columns, rows, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write() {},
      moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
  }

  function mountFullscreen(columns, rows) {
    const screen = new tui.TuiAltScreen(fakeTerminal(columns, rows), false);
    const box = () => new tui.Container();
    const { root: layoutRoot } = createChatViewport({ document: buildDocument(), pendingMessages: box(), status: box(),
      editor: new tui.Text('editor\n\n'), footer: new tui.Text('footer') });
    screen.setLayoutRoot(layoutRoot);
    screen.start();
    screen.renderNow();
    return screen;
  }

  /** Real extension with a fake pi host whose ctx.ui.custom hands out the given renderer. */
  function host(renderer) {
    const commands = new Map(), hooks = new Map(), peeks = [];
    const bus = { on() { return () => {}; }, emit() {} };
    const pi = { events: bus, on(name, fn) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); },
      registerCommand(name, value) { commands.set(name, value); }, registerShortcut() {}, appendEntry() {} };
    extension(pi);
    let nextJump;
    const ctx = {
      cwd: tmpdir(), mode: 'tui', hasUI: true, isProjectTrusted: () => false,
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
      sessionManager: { buildContextEntries: () => entries, getEntries: () => branch, getBranch: () => branch,
        getSessionId: () => 'test', getSessionFile: () => undefined, getLeafId: () => 'e10' },
      ui: {
        setStatus() {}, notify() {},
        async custom(factory, options) {
          let result;
          factory(renderer, theme, undefined, value => { result = value; });
          if (options?.overlayOptions?.anchor === 'center') { peeks.push(true); return undefined; }
          return result ?? nextJump;
        },
      },
    };
    for (const fn of hooks.get('session_start')) fn({}, ctx);
    return {
      peeks,
      async jump(topicId) { nextJump = { jump: { topicId } }; await commands.get('outline').handler('', ctx); },
      shutdown() { for (const fn of hooks.get('session_shutdown')) fn({}, ctx); },
    };
  }

  const visibleKey = screen => anchors.fingerprintKey(screen.previousScreen.map(anchors.stripAnsi).join('\n'));

  for (const [columns, rows] of [[120, 30], [60, 24], [32, 20]]) {
    test(`fullscreen jump scrolls pi's real transcript to every anchored topic (${columns}x${rows})`, async t => {
      const screen = mountFullscreen(columns, rows);
      const proxy = createInteractiveTuiReference(() => screen);
      const view = screen.getPrimaryScrollView();
      const transcript = view.render(columns);
      const markers = anchors.markerRows(transcript);
      const expected = anchors.markerOrdinalIndex(entries);
      // e1, e4 (error notice), e5, e7, e8, e9 follow-up, e10 — skill-only e6 and tool-call e2 have none.
      assert.equal(markers.length, expected.size);
      assert.deepEqual([...expected.keys()], ['e1', 'e4', 'e5', 'e7', 'e8', 'e9', 'e10']);
      // Root cause: tui.render() only yields the transcript's basis row, not the scroll content.
      t.diagnostic(`tui.render rows=${proxy.render(columns).length} markers=${anchors.markerRows(proxy.render(columns)).length}; transcript rows=${transcript.length} markers=${markers.length}`);
      assert.ok(anchors.markerRows(proxy.render(columns)).length < markers.length);

      const app = host(proxy);
      const home = mkdtempSync(join(tmpdir(), 'topic-outline-home-'));
      const savedHome = process.env.HOME, savedDebug = process.env.PI_TOPIC_OUTLINE_DEBUG;
      process.env.HOME = home; process.env.PI_TOPIC_OUTLINE_DEBUG = '1';
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
      try {
        const targets = { t1: ['e1', 'authrefactor'], t2: ['e5', 'donetheloginflow'], t3: ['e7', 'secondtopiccaching'],
          t4: ['e9', 'skillfollowupquestion'], t5: ['e10', 'finalsummary'] };
        for (const [topicId, [entryId, text]] of Object.entries(targets)) {
          await app.jump(topicId);
          assert.equal(app.peeks.length, 0, `${topicId} must scroll, not peek`);
          const row = markers[expected.get(entryId).ordinal];
          const maxTop = Math.max(0, transcript.length - view.viewportHeight);
          assert.equal(view.scrollTop, Math.min(maxTop, Math.max(0, row - 2)), `${topicId} scroll position`);
          screen.renderNow();
          // Viewport rows (flashes from rapid successive jumps stack over the top-right corner).
          const viewport = anchors.fingerprintKey(transcript.slice(view.scrollTop, view.scrollTop + view.viewportHeight).map(anchors.stripAnsi).join('\n'));
          assert.ok(viewport.includes(text), `${topicId} target text inside the viewport after jump`);
          assert.ok(visibleKey(screen).includes(anchors.fingerprintKey(topics.find(item => item.id === topicId).heading)), `${topicId} flash shown`);
        }
        await app.jump('t6');
        assert.equal(app.peeks.length, 1, 'anchor outside the context falls back to peek');

        const log = readFileSync(join(home, '.pi', 'agent', 'topic-outline-debug.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(log.length, 6);
        assert.deepEqual(log.map(item => item.reason), ['ok', 'ok', 'ok', 'ok', 'ok', 'anchor-not-in-context']);
        assert.ok(log.every(item => item.asFullscreen === true && typeof item.at === 'string'));
        assert.ok(log.slice(0, 5).every(item => item.ordinalFound && item.fingerprintMatched && item.rowsCount === transcript.length));
        const raw = readFileSync(join(home, '.pi', 'agent', 'topic-outline-debug.log'), 'utf8');
        assert.ok(!raw.includes('login') && !raw.includes('Please fix'), 'debug log carries no message text');
      } finally {
        process.env.HOME = savedHome;
        if (savedDebug === undefined) delete process.env.PI_TOPIC_OUTLINE_DEBUG; else process.env.PI_TOPIC_OUTLINE_DEBUG = savedDebug;
        rmSync(home, { recursive: true, force: true });
        app.shutdown();
        screen.stop();
      }
    });
  }

  test('regular (non-fullscreen) renderer falls back to peek', async () => {
    const screen = new tui.TuiMainScreen(fakeTerminal(80, 24), false);
    const app = host(createInteractiveTuiReference(() => screen));
    await app.jump('t1');
    assert.equal(app.peeks.length, 1);
    app.shutdown();
  });
}
