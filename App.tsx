import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ConnectionState, AudioVolume } from './types';
import { base64ToUint8Array, float32ToInt16, pcmToAudioBuffer, uint8ArrayToBase64 } from './utils/audioUtils';

// SVG Icons
const MicIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
  </svg>
);

const StopIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
  </svg>
);

const HangupIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-8 h-8">
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const App: React.FC = () => {
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [volume, setVolume] = useState<AudioVolume>({ input: 0, output: 0 });
  const [error, setError] = useState<string | null>(null);

  // Refs for Audio Contexts and State
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  
  // Animation ref for volume visualization
  const requestRef = useRef<number>();

  const connectToGemini = async () => {
    try {
      setConnectionState(ConnectionState.CONNECTING);
      setError(null);

      // 1. Initialize Microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
      mediaStreamRef.current = stream;

      // 2. Initialize Audio Contexts
      // Input: 16kHz for Gemini
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      inputAudioContextRef.current = inputCtx;
      
      // Output: 24kHz for Gemini
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      outputAudioContextRef.current = outputCtx;

      // 3. Setup Gemini Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
        },
        callbacks: {
          onopen: () => {
            setConnectionState(ConnectionState.CONNECTED);
            
            // Setup Input Processing
            const source = inputCtx.createMediaStreamSource(stream);
            // Buffer size 4096 gives a good balance of latency (approx 250ms at 16k) and stability
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              // Simple volume calculation for visualizer
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              setVolume(prev => ({ ...prev, input: Math.min(1, rms * 5) })); // Boost for visibility

              // Convert to PCM Int16
              const pcmInt16 = float32ToInt16(inputData);
              const pcmUint8 = new Uint8Array(pcmInt16.buffer);
              const base64 = uint8ArrayToBase64(pcmUint8);

              // Send to Gemini
              sessionPromise.then(session => {
                session.sendRealtimeInput({
                  media: {
                    mimeType: 'audio/pcm;rate=16000',
                    data: base64
                  }
                });
              });
            };

            source.connect(processor);
            processor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              const outputCtx = outputAudioContextRef.current;
              if (outputCtx) {
                const rawBytes = base64ToUint8Array(audioData);
                // Convert Uint8Array back to Int16Array for PCM decoding
                const pcmData = new Int16Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength / 2);
                
                const audioBuffer = pcmToAudioBuffer(pcmData, outputCtx, 24000);
                
                // Visualize Output Volume (approximate from one chunk)
                // Just for UI reactivity
                const chanData = audioBuffer.getChannelData(0);
                let sum = 0;
                // Sample a few points for performance
                for(let i=0; i<chanData.length; i+=10) sum += chanData[i] * chanData[i];
                const rms = Math.sqrt(sum / (chanData.length/10));
                setVolume(prev => ({ ...prev, output: Math.min(1, rms * 5) }));

                // Schedule Playback
                // Ensure we don't schedule in the past
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
                
                const source = outputCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outputCtx.destination);
                
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                
                audioSourcesRef.current.add(source);
                source.onended = () => {
                  audioSourcesRef.current.delete(source);
                  // Decay output volume visual
                  setVolume(prev => ({ ...prev, output: 0 }));
                };
              }
            }

            // Handle Interruption
            if (message.serverContent?.interrupted) {
              console.log('Interrupted');
              audioSourcesRef.current.forEach(source => {
                try { source.stop(); } catch(e) {}
              });
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onclose: () => {
            console.log('Connection closed');
            setConnectionState(ConnectionState.DISCONNECTED);
          },
          onerror: (err) => {
            console.error('Connection error:', err);
            setError("Connection failed. Please try again.");
            setConnectionState(ConnectionState.ERROR);
          }
        }
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to connect to microphone");
      setConnectionState(ConnectionState.ERROR);
    }
  };

  const disconnect = useCallback(async () => {
    // 1. Close Session
    if (sessionPromiseRef.current) {
       await sessionPromiseRef.current.then(session => session.close()).catch(() => {});
       sessionPromiseRef.current = null;
    }

    // 2. Stop Microphone
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // 3. Close Audio Contexts
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }

    // 4. Reset Audio Ref
    scriptProcessorRef.current = null;
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    
    setConnectionState(ConnectionState.DISCONNECTED);
    setVolume({ input: 0, output: 0 });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-slate-900 text-white overflow-hidden relative">
      
      {/* Background Ambience */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
         <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"></div>
         <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse delay-1000"></div>
      </div>

      <div className="z-10 flex flex-col items-center gap-8 w-full max-w-md">
        
        {/* Header */}
        <div className="text-center space-y-2">
           <h1 className="text-2xl font-semibold tracking-tight">Gemini Live</h1>
           <p className="text-slate-400 text-sm">Real-time conversational AI</p>
        </div>

        {/* Visualizer Orb */}
        <div className="relative flex items-center justify-center h-64 w-64">
           {connectionState === ConnectionState.CONNECTED ? (
             <div className="relative flex items-center justify-center">
                {/* Output (AI) Glow */}
                <div 
                  className="absolute bg-white rounded-full mix-blend-overlay transition-all duration-75 ease-out"
                  style={{
                    width: `${120 + volume.output * 200}px`,
                    height: `${120 + volume.output * 200}px`,
                    opacity: 0.1 + volume.output * 0.5,
                    filter: 'blur(20px)'
                  }}
                />
                <div 
                  className="absolute bg-blue-400 rounded-full mix-blend-overlay transition-all duration-75 ease-out"
                  style={{
                    width: `${100 + volume.output * 150}px`,
                    height: `${100 + volume.output * 150}px`,
                    opacity: 0.2 + volume.output * 0.4,
                    filter: 'blur(10px)'
                  }}
                />
                
                {/* Input (User) Core */}
                <div 
                  className="relative bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full shadow-[0_0_40px_rgba(79,70,229,0.3)] transition-all duration-100"
                  style={{
                    width: `${80 + volume.input * 40}px`,
                    height: `${80 + volume.input * 40}px`,
                    transform: `scale(${1 + volume.input * 0.1})`
                  }}
                />
             </div>
           ) : (
             <div className="w-32 h-32 rounded-full bg-slate-800 border-2 border-slate-700 flex items-center justify-center shadow-xl">
                <div className="w-24 h-24 rounded-full bg-slate-700/50 animate-pulse"></div>
             </div>
           )}
        </div>

        {/* Status Text */}
        <div className="h-8 flex items-center justify-center">
          {connectionState === ConnectionState.CONNECTING && (
            <span className="text-slate-400 text-sm animate-pulse">Connecting...</span>
          )}
          {connectionState === ConnectionState.CONNECTED && (
             <span className="text-blue-400 text-sm font-medium px-3 py-1 bg-blue-500/10 rounded-full border border-blue-500/20">
               Live Session Active
             </span>
          )}
          {connectionState === ConnectionState.ERROR && (
            <span className="text-red-400 text-sm">{error || "Error"}</span>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-6">
           {connectionState === ConnectionState.DISCONNECTED || connectionState === ConnectionState.ERROR ? (
             <button 
               onClick={connectToGemini}
               className="group relative flex items-center justify-center w-16 h-16 rounded-full bg-white text-slate-900 hover:scale-105 transition-all shadow-[0_0_20px_rgba(255,255,255,0.3)] hover:shadow-[0_0_30px_rgba(255,255,255,0.5)]"
             >
                <MicIcon />
             </button>
           ) : (
             <button 
               onClick={disconnect}
               className="flex items-center justify-center w-16 h-16 rounded-full bg-red-500/20 text-red-500 border border-red-500/50 hover:bg-red-500 hover:text-white transition-all hover:scale-105"
             >
                <HangupIcon />
             </button>
           )}
        </div>
        
        {connectionState === ConnectionState.DISCONNECTED && (
           <p className="text-slate-500 text-xs mt-4">Press the microphone to start talking</p>
        )}

      </div>
    </div>
  );
};

export default App;
