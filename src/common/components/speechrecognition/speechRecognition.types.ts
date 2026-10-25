export type RecognitionEngineType = 'webSpeechApi' | 'audioRecorder';

export interface IRecognitionEngine {
  engineType: RecognitionEngineType;
  start: () => void;
  stop: (reason: SpeechDoneReason, sendOnDone: boolean) => void;
  dispose: () => void;
  isBetweenBeginEnd: () => boolean;
  updateConfiguration: (language: string, softStopTimeout: number, onResultCallback: SpeechResultCallback) => void;
}

export const PLACEHOLDER_INTERIM_TRANSCRIPT = 'Listening...';

export interface SpeechResult {
  transcript: string; // finalized text
  interimTranscript: string; // provisional text or recording status
  done: boolean; // no updates after the final result
  doneReason: SpeechDoneReason;
  flagSendOnDone: boolean | undefined;
}

export type SpeechResultCallback = (result: SpeechResult) => void;

export function createSpeechRecognitionResults(): SpeechResult {
  return {
    transcript: '',
    interimTranscript: PLACEHOLDER_INTERIM_TRANSCRIPT,
    done: false,
    doneReason: undefined,
    flagSendOnDone: undefined,
  };
}

export type SpeechDoneReason =
  | undefined
  | 'manual'
  | 'continuous-deadline'
  | 'api-unknown-timeout'
  | 'api-error'
  | 'api-no-speech'
  | 'cancelled'
  | 'switch-engine'
  | 'react-unmount';

export interface SpeechRecognitionState {
  isAvailable: boolean;
  isActive: boolean; // includes pending permission and transcription
  isStarting: boolean;
  isProcessing: boolean;
  hasAudio: boolean;
  hasSpeech: boolean;
  errorMessage: string | null;
  currentEngine: RecognitionEngineType;
}
