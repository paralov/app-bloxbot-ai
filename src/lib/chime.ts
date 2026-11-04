let context: AudioContext | null = null;

const NOTES: ReadonlyArray<readonly [frequency: number, startsAt: number]> = [
  [784, 0],
  [1175, 0.11],
];

/** A short, soft two-note sound. Drawn here so it needs no sound file. */
export function playChime(): void {
  try {
    context ??= new AudioContext();
    void context.resume();
    const now = context.currentTime;
    for (const [frequency, startsAt] of NOTES) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + startsAt);
      gain.gain.exponentialRampToValueAtTime(0.07, now + startsAt + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startsAt + 0.5);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + startsAt);
      oscillator.stop(now + startsAt + 0.55);
    }
  } catch (error) {
    // A missing sound is never worth more than a log line.
    console.warn("Couldn't play the notification sound:", error);
  }
}
