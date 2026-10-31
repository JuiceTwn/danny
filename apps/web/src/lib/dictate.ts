// Records from the microphone for voice typing. Tap to start, tap to stop: no holding a button.

/** Longest recording. The server accepts two minutes; stop a little before that. */
export const MAX_SECONDS = 110;

export class DictateError extends Error {}

export const canRecord = () => typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

// Safari records MP4/AAC, Chrome and Firefox record WebM/Opus. Take the first one this browser can make.
const pickType = () => ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

export type Recording = {
  /** Stop and return what was said. */
  stop(): Promise<{ blob: Blob; seconds: number }>;
  /** Stop and throw it away. */
  cancel(): void;
};

export async function startRecording(onLimit: () => void): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    const name = (err as DOMException).name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new DictateError("Danny needs the microphone. Allow it for this app in your phone or browser settings.");
    if (name === "NotFoundError") throw new DictateError("No microphone found.");
    throw new DictateError("Couldn't start the microphone.");
  }
  const type = pickType();
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const started = Date.now();
  const release = () => stream.getTracks().forEach((t) => t.stop());
  const timer = setTimeout(onLimit, MAX_SECONDS * 1000);
  rec.start();

  return {
    stop: () =>
      new Promise((resolve) => {
        clearTimeout(timer);
        rec.onstop = () => {
          release();
          resolve({ blob: new Blob(chunks, { type: rec.mimeType || type || "audio/webm" }), seconds: (Date.now() - started) / 1000 });
        };
        if (rec.state !== "inactive") rec.stop();
        else rec.onstop?.(new Event("stop"));
      }),
    cancel() {
      clearTimeout(timer);
      rec.onstop = null;
      if (rec.state !== "inactive") rec.stop();
      release();
    },
  };
}
