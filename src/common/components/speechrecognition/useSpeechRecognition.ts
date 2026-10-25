import * as React from 'react';

import { Is, isBrowser } from '~/common/util/pwaUtils';
import { useUIPreferencesStore } from '~/common/stores/store-ui';

import { CapabilityBrowserSpeechRecognition } from '../useCapabilities';

import { AudioRecorderEngine } from './AudioRecorderEngine';
import { getSpeechRecognitionClass, WebSpeechApiEngine } from './WebSpeechApiEngine';

import type { IRecognitionEngine, RecognitionEngineType, SpeechRecognitionState, SpeechResult, SpeechResultCallback } from './speechRecognition.types';

export { PLACEHOLDER_INTERIM_TRANSCRIPT, type SpeechResult } from './speechRecognition.types';


/// Capability interface

let cachedCapability: CapabilityBrowserSpeechRecognition | null = null;

export const browserSpeechRecognitionCapability = (): CapabilityBrowserSpeechRecognition => {
  if (!cachedCapability) {
    const isBraveBlocked = Is.Browser.Brave; // Brave exposes the API but silently blocks results
    const isApiAvailable = !!getSpeechRecognitionClass() && !isBraveBlocked;
    const isDeviceNotSupported = false;
    cachedCapability = {
      mayWork: isApiAvailable && !isDeviceNotSupported,
      isApiAvailable,
      isDeviceNotSupported,
      warnings: [
        ...Is.OS.iOS ? ['Not tested on this browser/device.'] : [],
        ...isBraveBlocked ? ['Speech recognition is not supported in Brave. Please use Chrome, Edge, or Safari.'] : [],
      ],
    };
  }
  return cachedCapability;
};


/**
 * Hook for speech recognition that supports switching between engines.
 * @param onResultCallback - Callback when a result is received
 * @param softStopTimeout - Timeout for continuous listening
 * @param engineType - The type of capture engine to use
 */
export const useSpeechRecognition = (
  engineType: RecognitionEngineType,
  onResultCallback: SpeechResultCallback,
  softStopTimeout: number,
) => {

  // state
  const [recognitionState, setRecognitionState] = React.useState<SpeechRecognitionState>({
    isAvailable: false,
    isActive: false,
    isStarting: false,
    isProcessing: false,
    hasAudio: false,
    hasSpeech: false,
    errorMessage: null,
    currentEngine: engineType,
  });

  // external state (will update this function when changed)
  const preferredLanguage = useUIPreferencesStore(state => state.preferredLanguage);

  // refs
  const onResultCallbackRef = React.useRef<SpeechResultCallback>(onResultCallback);
  const softStopTimeoutRef = React.useRef<number>(softStopTimeout);
  const preferredLanguageRef = React.useRef<string>(preferredLanguage);
  const engineRef = React.useRef<IRecognitionEngine | null>(null);


  // hooks

  const updateState = React.useCallback((state: Partial<SpeechRecognitionState>) => {
    setRecognitionState((prevState) => ({ ...prevState, ...state }));
  }, []);

  const emitResult = React.useCallback((result: SpeechResult) => {
    if (result.doneReason === 'cancelled' || result.doneReason === 'switch-engine' || result.doneReason === 'react-unmount') return;
    onResultCallbackRef.current(result);
  }, []);

  // Params: update refs when params change
  React.useEffect(() => {
    // detect changes
    if (onResultCallbackRef.current === onResultCallback
      && preferredLanguageRef.current === preferredLanguage
      && softStopTimeoutRef.current === softStopTimeout)
      return;

    // remember local values
    onResultCallbackRef.current = onResultCallback;
    softStopTimeoutRef.current = softStopTimeout;
    preferredLanguageRef.current = preferredLanguage;

    // update the values in the running instance
    engineRef.current?.updateConfiguration(preferredLanguage, softStopTimeout, emitResult);
  }, [emitResult, onResultCallback, preferredLanguage, softStopTimeout]);

  // Recreate the engine if the type changes (and upon load, and destroy it on unmount)
  React.useEffect(() => {
    if (!isBrowser) return;

    // prevent re-creating the engine if it's the same type, and multiple instances
    if (engineRef.current?.engineType === engineType)
      return;

    if (engineRef.current) {
      engineRef.current.dispose();
      engineRef.current = null;
    }

    updateState({
      isAvailable: false,
      isActive: false,
      isStarting: false,
      isProcessing: false,
      hasAudio: false,
      hasSpeech: false,
      errorMessage: null,
      currentEngine: engineType,
    });

    switch (engineType) {
      case 'webSpeechApi':

        // check if the device is supported
        // if (browserSpeechRecognitionCapability().isDeviceNotSupported) {
        //   setErrorMessage('Speech recognition is not supported on this device.');
        //   return;
        // }

        // check if the API is available
        const webSpeechAPI = getSpeechRecognitionClass();
        if (!webSpeechAPI) {
          updateState({ errorMessage: 'Speech recognition API is not available in this browser.' });
          return;
        }

        engineRef.current = new WebSpeechApiEngine(
          webSpeechAPI,
          preferredLanguageRef.current,
          softStopTimeoutRef.current,
          emitResult,
          updateState,
        );
        break;

      case 'audioRecorder':
        engineRef.current = new AudioRecorderEngine(
          softStopTimeoutRef.current,
          emitResult,
          updateState,
          async (audio, mimeType, signal) => {
            const { asrxTranscribeBatch } = await import('~/modules/asrx/protocols/batch/batch.client');
            return asrxTranscribeBatch(audio, mimeType, undefined, { signal });
          },
        );
        break;
    }

    return () => {
      if (engineRef.current) {
        updateState({ isAvailable: false });
        engineRef.current.dispose();
        engineRef.current = null;
      }
    };
  }, [emitResult, engineType, updateState]);


  const startRecognition = React.useCallback(() => {
    if (!engineRef.current) return console.error('startRecognition: Speech recognition is not supported or not initialized.');
    if (engineRef.current.isBetweenBeginEnd()) return console.error('startRecognition: Start recording called while already recording.');

    try {
      updateState({ errorMessage: null });
      engineRef.current.start();
    } catch (error: any) {
      updateState({ errorMessage: 'Issue starting the speech recognition.' });
      console.log('Speech recognition error - clicking too quickly?', error?.message);
    }
  }, [updateState]);

  const stopRecognition = React.useCallback((sendOnDone: boolean) => {
    if (!engineRef.current) return console.error('stopRecognition: Speech recognition is not supported or not initialized.');
    if (!engineRef.current.isBetweenBeginEnd()) return console.error('stopRecognition: Stop recognition called while not recognizing.');
    engineRef.current.stop('manual', sendOnDone);
  }, []);

  const cancelRecognition = React.useCallback(() => {
    if (engineRef.current?.isBetweenBeginEnd())
      engineRef.current.stop('cancelled', false);
  }, []);

  const toggleRecognition = React.useCallback((sendOnDone?: boolean) => {
    if (!engineRef.current) return;

    // start or stop
    if (engineRef.current.isBetweenBeginEnd()) {
      stopRecognition(sendOnDone === true);
      updateState({ errorMessage: null });
    } else
      startRecognition();
  }, [startRecognition, stopRecognition, updateState]);


  return {
    recognitionState,
    startRecognition,
    stopRecognition,
    cancelRecognition,
    toggleRecognition,
  };
};
