// Browser audio plumbing for Ask ATLAS.
//
// Two jobs, both deliberately dependency-free:
//
//   · CAPTURE — record the microphone and hand back 16 kHz mono WAV. MediaRecorder
//     gives WebM/Opus, which the Gemini API does not accept inline, so the clip is
//     decoded and re-encoded here. Doing it in the browser (rather than shipping a
//     transcoder into the backend) also means the silence check can run before a
//     megabyte of nothing is uploaded.
//
//   · PLAYBACK — one voice at a time. An answer being read aloud while the previous
//     one is still talking is worse than no audio at all, so playback is funnelled
//     through a single owner that stops whatever came before.

const TARGET_RATE = 16_000

// ── capture ──────────────────────────────────────────────────────────────────

export interface Recording {
  stop: () => Promise<Blob>
  cancel: () => void
  stream: MediaStream
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    .find((m) => MediaRecorder.isTypeSupported(m))
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
  rec.start()

  const release = () => stream.getTracks().forEach((t) => t.stop())

  return {
    stream,
    cancel: () => { try { rec.stop() } catch { /* already stopped */ } release() },
    stop: () => new Promise<Blob>((resolve) => {
      rec.onstop = () => { release(); resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })) }
      try { rec.stop() } catch { release(); resolve(new Blob(chunks)) }
    }),
  }
}

/** Peak-normalised loudness of a clip, 0–1. Used to refuse empty recordings before upload. */
export function loudness(samples: Float32Array): number {
  let sum = 0
  const step = Math.max(1, Math.floor(samples.length / 8000))
  let n = 0
  for (let i = 0; i < samples.length; i += step) { sum += samples[i] * samples[i]; n++ }
  return n ? Math.sqrt(sum / n) : 0
}

/** Recorded blob → { base64 WAV at 16 kHz mono, seconds, loudness }. */
export async function blobToWav(blob: Blob): Promise<{ base64: string; seconds: number; level: number }> {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
  try {
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())

    // Mix to mono first — a stereo mic doubles the payload for no gain in speech.
    const mono = new Float32Array(buffer.length)
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c)
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels
    }

    const ratio = buffer.sampleRate / TARGET_RATE
    const outLength = Math.max(1, Math.floor(mono.length / ratio))
    const out = new Float32Array(outLength)
    for (let i = 0; i < outLength; i++) {
      // Average the source window rather than point-sampling it: decimating by
      // picking every nth sample aliases, and aliased speech transcribes badly.
      const start = Math.floor(i * ratio)
      const end = Math.min(mono.length, Math.floor((i + 1) * ratio))
      let sum = 0
      for (let j = start; j < end; j++) sum += mono[j]
      out[i] = end > start ? sum / (end - start) : 0
    }

    return {
      base64: encodeWav(out, TARGET_RATE),
      seconds: outLength / TARGET_RATE,
      level: loudness(out),
    }
  } finally {
    ctx.close().catch(() => { /* already closed */ })
  }
}

function encodeWav(samples: Float32Array, rate: number): string {
  const bytes = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(bytes)
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  str(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  // Chunked so a long clip cannot blow the argument limit of String.fromCharCode.
  const u8 = new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(bin)
}

// ── playback ─────────────────────────────────────────────────────────────────

let current: { audio: HTMLAudioElement; url: string; id: string } | null = null

export function stopSpeaking() {
  if (!current) return
  current.audio.pause()
  URL.revokeObjectURL(current.url)
  current = null
}

export function speakingId(): string | null {
  return current?.id ?? null
}

/** Play a WAV blob, stopping whatever was playing. Resolves when it finishes. */
export function playWav(blob: Blob, id: string): Promise<void> {
  stopSpeaking()
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  current = { audio, url, id }
  return new Promise<void>((resolve) => {
    const done = () => {
      if (current?.id === id) { URL.revokeObjectURL(url); current = null }
      resolve()
    }
    audio.onended = done
    audio.onerror = done
    audio.play().catch(done)   // autoplay blocked — resolve rather than hang
  })
}
