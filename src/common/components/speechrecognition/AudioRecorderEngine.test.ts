import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';

import type { ASRxBatchResult } from '~/modules/asrx/asrx.types';

import { AudioRecorderEngine } from './AudioRecorderEngine';
import type { SpeechRecognitionState, SpeechResult } from './speechRecognition.types';


function setup(t: TestContext, options: {
  transcribe?: () => Promise<ASRxBatchResult>;
  getUserMedia?: () => Promise<unknown>;
  supportedMimeType?: string;
} = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1000 });
  const results: SpeechResult[] = [];
  const state: Partial<SpeechRecognitionState> = {};
  let amplitude = 0;
  const track = { onended: null as (() => void) | null, stop: t.mock.fn() };
  const stream = { getTracks: () => [track] };
  const contexts: FakeContext[] = [];
  const recorders: FakeRecorder[] = [];
  const getUserMedia = t.mock.fn(options.getUserMedia ?? (async () => stream));
  const transcribe = t.mock.fn<ConstructorParameters<typeof AudioRecorderEngine>[3]>(options.transcribe ?? (async (): Promise<ASRxBatchResult> => ({ success: true, text: 'Accented English.', model: 'openai/gpt-transcribe' })));

  class FakeContext {
    closed = false;
    constructor() { contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() {
      return { fftSize: 2048, getFloatTimeDomainData(samples: Float32Array) { samples.fill(amplitude); } };
    }
  }

  class FakeRecorder {
    static isTypeSupported(type: string) { return type === (options.supportedMimeType ?? 'audio/webm;codecs=opus'); }
    state = 'inactive';
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_stream: unknown, settings: MediaRecorderOptions) {
      this.mimeType = settings.mimeType || 'audio/webm';
      recorders.push(this);
    }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['recorded speech'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }

  const replacements = {
    window: {},
    navigator: { mediaDevices: { getUserMedia } },
    MediaRecorder: FakeRecorder,
    AudioContext: FakeContext,
  };
  for (const [name, value] of Object.entries(replacements)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }

  const engine = new AudioRecorderEngine(250, result => results.push({ ...result }), update => Object.assign(state, update), transcribe);
  t.after(() => engine.dispose());
  const speak = () => {
    amplitude = 0.05;
    t.mock.timers.tick(150);
    amplitude = 0;
  };
  return { engine, state, results, stream, track, contexts, recorders, getUserMedia, transcribe, speak };
}

test('records until silence, releases the mic, and waits for the final transcript before another turn', async t => {
  const pending = Promise.withResolvers<ASRxBatchResult>();
  const h = setup(t, { transcribe: () => pending.promise });
  h.engine.start();
  assert.equal(h.engine.isBetweenBeginEnd(), true);
  h.engine.start();
  await setImmediate();
  assert.equal(h.getUserMedia.mock.callCount(), 1);
  h.speak();
  assert.equal(h.state.hasSpeech, true);
  t.mock.timers.tick(250);
  await setImmediate();
  assert.equal(h.state.isProcessing, true);
  assert.equal(h.state.isActive, true);
  assert.equal(h.track.stop.mock.callCount(), 1);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.transcribe.mock.callCount(), 1);
  const [audio, mimeType, signal] = h.transcribe.mock.calls[0].arguments;
  assert.ok(audio instanceof Blob);
  assert.equal(audio.type, 'audio/webm;codecs=opus');
  assert.equal(mimeType, audio.type);
  assert.equal(signal.aborted, false);
  h.engine.start();
  assert.equal(h.getUserMedia.mock.callCount(), 1);
  pending.resolve({ success: true, text: 'My English has an accent.', model: 'openai/gpt-transcribe' });
  await setImmediate();
  assert.equal(h.state.isActive, false);
  assert.equal(h.state.isProcessing, false);
  assert.equal(h.engine.isBetweenBeginEnd(), false);
  assert.equal(h.results.at(-1)?.transcript, 'My English has an accent.');
  assert.equal(h.results.at(-1)?.doneReason, 'continuous-deadline');
});

test('manual stop preserves sendOnDone and uses the browser-supported recording format', async t => {
  const h = setup(t, { supportedMimeType: 'audio/mp4' });
  h.engine.start();
  await setImmediate();
  h.speak();
  h.engine.stop('manual', true);
  await setImmediate();
  assert.equal(h.recorders[0].mimeType, 'audio/mp4');
  assert.equal(h.results.at(-1)?.done, true);
  assert.equal(h.results.at(-1)?.doneReason, 'manual');
  assert.equal(h.results.at(-1)?.flagSendOnDone, true);
  assert.equal(h.transcribe.mock.calls[0].arguments[1], 'audio/mp4');
});

test('disposing while microphone permission is pending releases a late stream without callbacks or uploads', async t => {
  const permission = Promise.withResolvers<unknown>();
  const h = setup(t, { getUserMedia: () => permission.promise });
  h.engine.start();
  h.engine.dispose();
  const callbackCount = h.results.length;
  permission.resolve(h.stream);
  await setImmediate();
  assert.equal(h.track.stop.mock.callCount(), 1);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.recorders.length, 0);
  assert.equal(h.transcribe.mock.callCount(), 0);
  assert.equal(h.results.length, callbackCount);
});

test('hangup cancels an in-flight transcription and ignores its late result', async t => {
  const pending = Promise.withResolvers<ASRxBatchResult>();
  const h = setup(t, { transcribe: () => pending.promise });
  h.engine.start();
  await setImmediate();
  h.speak();
  h.engine.stop('manual', false);
  await setImmediate();
  const signal = h.transcribe.mock.calls[0].arguments[2];
  h.engine.stop('cancelled', false);
  assert.equal(signal.aborted, true);
  assert.equal(h.state.isActive, false);
  const callbackCount = h.results.length;
  pending.resolve({ success: true, text: 'Do not send after hangup.', model: 'openai/gpt-transcribe' });
  await setImmediate();
  assert.equal(h.results.length, callbackCount);
  assert.equal(h.results.at(-1)?.doneReason, 'cancelled');
});

test('silence is never uploaded and the microphone is released after the no-speech deadline', async t => {
  const h = setup(t);
  h.engine.start();
  await setImmediate();
  t.mock.timers.tick(30_000);
  await setImmediate();
  assert.equal(h.results.at(-1)?.doneReason, 'api-no-speech');
  assert.equal(h.transcribe.mock.callCount(), 0);
  assert.equal(h.track.stop.mock.callCount(), 1);
  assert.equal(h.state.isActive, false);
});

test('API failures end the turn and allow an explicit retry', async t => {
  const h = setup(t, { transcribe: async () => ({ success: false, errorType: 'asr-unconfigured', errorText: 'Missing OpenAI API key' }) });
  h.engine.start();
  await setImmediate();
  h.speak();
  h.engine.stop('manual', false);
  await setImmediate();
  assert.equal(h.state.errorMessage, 'Missing OpenAI API key');
  assert.equal(h.results.at(-1)?.doneReason, 'api-error');
  assert.equal(h.engine.isBetweenBeginEnd(), false);
  h.engine.start();
  await setImmediate();
  assert.equal(h.state.errorMessage, null);
  assert.equal(h.getUserMedia.mock.callCount(), 2);
});

test('a transcription deadline aborts the request and suppresses its late result', async t => {
  const pending = Promise.withResolvers<ASRxBatchResult>();
  const h = setup(t, { transcribe: () => pending.promise });
  h.engine.start();
  await setImmediate();
  h.speak();
  h.engine.stop('manual', false);
  await setImmediate();
  t.mock.timers.tick(60_000);
  assert.match(h.state.errorMessage ?? '', /timed out/);
  assert.equal(h.transcribe.mock.calls[0].arguments[2].aborted, true);
  const callbackCount = h.results.length;
  pending.resolve({ success: true, text: 'Late.', model: 'openai/gpt-transcribe' });
  await setImmediate();
  assert.equal(h.results.length, callbackCount);
});

test('microphone permission failures close the audio context and release the busy state', async t => {
  const h = setup(t, { getUserMedia: async () => { throw new Error('Permission denied'); } });
  h.engine.start();
  await setImmediate();
  assert.equal(h.state.errorMessage, 'Permission denied');
  assert.equal(h.state.isStarting, false);
  assert.equal(h.state.isActive, false);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.transcribe.mock.callCount(), 0);
});

test('cancelling a recording discards its audio without starting transcription', async t => {
  const h = setup(t);
  h.engine.start();
  await setImmediate();
  h.speak();
  h.engine.stop('cancelled', false);
  await setImmediate();
  assert.equal(h.transcribe.mock.callCount(), 0);
  assert.equal(h.track.stop.mock.callCount(), 1);
  assert.equal(h.results.at(-1)?.transcript, '');
  assert.equal(h.results.at(-1)?.doneReason, 'cancelled');
});

test('changing the pause setting and callback applies to the active recording', async t => {
  const h = setup(t);
  h.engine.start();
  await setImmediate();
  h.speak();
  const updatedResults: SpeechResult[] = [];
  h.engine.updateConfiguration('en-US', 500, result => updatedResults.push({ ...result }));
  t.mock.timers.tick(250);
  await setImmediate();
  assert.equal(h.transcribe.mock.callCount(), 0);
  t.mock.timers.tick(250);
  await setImmediate();
  assert.equal(h.transcribe.mock.callCount(), 1);
  assert.equal(updatedResults.at(-1)?.transcript, 'Accented English.');
});
