import type { ASRxBatchResult } from '~/modules/asrx/asrx.types';

import { createSpeechRecognitionResults, type IRecognitionEngine, type SpeechDoneReason, type SpeechRecognitionState, type SpeechResult, type SpeechResultCallback } from './speechRecognition.types';


// Bound each upload and avoid sending prolonged silence to a transcription model.
const _sampleIntervalMs = 50;
const _speechThreshold = 0.01;
const _minSpeechMs = 150;
const _noSpeechTimeoutMs = 30_000;
const _maxRecordingMs = 120_000;
const _transcriptionTimeoutMs = 60_000;

type TranscribeAudio = (audio: Blob, mimeType: string, signal: AbortSignal) => Promise<ASRxBatchResult>;

interface RecordingSession {
  phase: 'starting' | 'recording' | 'processing';
  controller: AbortController;
  results: SpeechResult;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  context?: AudioContext;
  timer?: ReturnType<typeof setInterval>;
  deadline?: ReturnType<typeof setTimeout>;
  chunks: BlobPart[];
  heardSpeech: boolean;
  speaking: boolean;
  speechMs: number;
  startedAt: number;
  lastSpeechAt: number;
}

export function browserAudioRecordingAvailable(): boolean {
  return typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined'
    && typeof AudioContext !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}


/** Records one turn, then transcribes it with the configured ASRx engine. */
export class AudioRecorderEngine implements IRecognitionEngine {
  public readonly engineType = 'audioRecorder';

  private session: RecordingSession | null = null;
  private disposed = false;

  constructor(
    private softStopTimeout: number,
    private onResultCallback: SpeechResultCallback,
    private readonly setState: (state: Partial<SpeechRecognitionState>) => void,
    private readonly transcribe: TranscribeAudio,
  ) {
    setState({
      isAvailable: browserAudioRecordingAvailable(),
      ...(!browserAudioRecordingAvailable() ? { errorMessage: 'Audio recording requires a supported browser and HTTPS or localhost.' } : {}),
    });
  }

  start() {
    if (this.disposed || this.session) return;
    const session: RecordingSession = {
      phase: 'starting',
      controller: new AbortController(),
      results: createSpeechRecognitionResults(),
      chunks: [],
      heardSpeech: false,
      speaking: false,
      speechMs: 0,
      startedAt: Date.now(),
      lastSpeechAt: Date.now(),
    };
    this.session = session;
    this.setState({ isActive: true, isStarting: true, isProcessing: false, hasAudio: false, hasSpeech: false, errorMessage: null });
    this.onResultCallback(session.results);
    void this._startRecording(session);
  }

  stop(reason: SpeechDoneReason, sendOnDone: boolean) {
    const session = this.session;
    if (!session) return;
    if (reason === 'cancelled' || reason === 'switch-engine' || reason === 'react-unmount') {
      this._finish(session, '', reason);
      return;
    }
    if (session.phase === 'processing') return;
    session.results.doneReason = reason;
    session.results.flagSendOnDone = sendOnDone;
    if (session.phase === 'starting') {
      this._finish(session, '', reason);
      return;
    }

    session.phase = 'processing';
    this.setState({ isStarting: false, isProcessing: true, hasAudio: false, hasSpeech: false });
    session.results.interimTranscript = 'Transcribing...';
    this.onResultCallback(session.results);
    session.recorder?.stop();
    this._releaseCapture(session);
  }

  dispose() {
    this.disposed = true;
    if (this.session) this._finish(this.session, '', 'react-unmount');
  }

  isBetweenBeginEnd() {
    return this.session !== null;
  }

  updateConfiguration(_language: string, softStopTimeout: number, onResultCallback: SpeechResultCallback) {
    // ASRx owns the language, prompt and dictionary settings.
    this.softStopTimeout = softStopTimeout;
    this.onResultCallback = onResultCallback;
  }

  private async _startRecording(session: RecordingSession) {
    try {
      // Resume in the initiating user gesture, before awaiting microphone access.
      const context = session.context = new AudioContext();
      const resumed = context.resume().catch(() => this._fail(session, 'Could not start microphone audio. Please try again.'));
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (this.session !== session) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      session.stream = stream;
      await resumed;
      if (this.session !== session) return;

      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
        .find(type => MediaRecorder.isTypeSupported(type));
      const recorder = session.recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64_000 });
      recorder.ondataavailable = (event) => {
        if (this.session === session && event.data.size) session.chunks.push(event.data);
      };
      recorder.onerror = () => this._fail(session, 'Audio recording failed. Please try again.');
      recorder.onstop = () => { void this._transcribe(session); };
      stream.getTracks().forEach(track => {
        track.onended = () => this._fail(session, 'Microphone disconnected. Please try again.');
      });

      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      session.phase = 'recording';
      session.startedAt = Date.now();
      recorder.start(1000);
      this.setState({ isStarting: false, hasAudio: true });

      session.timer = setInterval(() => {
        if (this.session !== session || session.phase !== 'recording') return;
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const speaking = Math.sqrt(energy / samples.length) >= _speechThreshold;
        const now = Date.now();
        session.speechMs = speaking ? session.speechMs + _sampleIntervalMs : 0;
        if (session.speechMs >= _minSpeechMs) session.heardSpeech = true;
        if (speaking && session.heardSpeech) session.lastSpeechAt = now;
        const detectedSpeech = speaking && session.heardSpeech;
        if (session.speaking !== detectedSpeech) {
          session.speaking = detectedSpeech;
          this.setState({ hasSpeech: detectedSpeech });
        }
        if (!session.heardSpeech && now - session.startedAt >= _noSpeechTimeoutMs)
          this._finish(session, '', 'api-no-speech');
        else if (now - session.startedAt >= _maxRecordingMs
          || (session.heardSpeech && !speaking && now - session.lastSpeechAt >= this.softStopTimeout))
          this.stop('continuous-deadline', false);
      }, _sampleIntervalMs);
    } catch (error) {
      this._fail(session, error instanceof Error ? error.message : 'Microphone access denied or not available.');
    }
  }

  private async _transcribe(session: RecordingSession) {
    if (this.session !== session) return;
    this._releaseCapture(session);
    if (!session.heardSpeech || !session.chunks.length) {
      this._finish(session, '', 'api-no-speech');
      return;
    }
    const mimeType = session.recorder?.mimeType || 'audio/webm';
    const audio = new Blob(session.chunks, { type: mimeType });
    session.chunks = [];
    session.deadline = setTimeout(() => this._fail(session, 'Transcription timed out. Please try again.'), _transcriptionTimeoutMs);
    try {
      const result = await this.transcribe(audio, mimeType, session.controller.signal);
      if (this.session !== session) return;
      if (!result.success) {
        this._fail(session, result.errorText);
        return;
      }
      this._finish(session, result.text, session.results.doneReason);
    } catch (error) {
      this._fail(session, error instanceof Error ? error.message : 'Transcription failed.');
    }
  }

  private _fail(session: RecordingSession, errorMessage: string) {
    if (this.session !== session) return;
    this.setState({ errorMessage });
    this._finish(session, '', 'api-error');
  }

  private _finish(session: RecordingSession, transcript: string, reason: SpeechDoneReason) {
    if (this.session !== session) return;
    this.session = null;
    session.controller.abort();
    if (session.deadline) clearTimeout(session.deadline);
    if (session.recorder) {
      session.recorder.ondataavailable = null;
      session.recorder.onstop = null;
      session.recorder.onerror = null;
      if (session.recorder.state !== 'inactive') session.recorder.stop();
    }
    this._releaseCapture(session);
    if (this.disposed) return;
    this.setState({ isActive: false, isStarting: false, isProcessing: false, hasAudio: false, hasSpeech: false });
    this.onResultCallback({ ...session.results, transcript, interimTranscript: '', done: true, doneReason: reason });
  }

  private _releaseCapture(session: RecordingSession) {
    if (session.timer) clearInterval(session.timer);
    session.stream?.getTracks().forEach(track => {
      track.onended = null;
      track.stop();
    });
    session.stream = undefined;
    if (session.context) void session.context.close().catch(() => {});
    session.context = undefined;
  }
}
