import { TOPIC_NAMES } from "./topics";

export const DELTAS = { 
  dwell: 0.15, 
  up: 0.6, 
  down: -0.8, 
  quiz_correct: 0.3, 
  quiz_wrong: 0.1, 
  video_open: 0.4 
};

export const DECAY = 0.997;
export const CLAMP_MIN = 0.1;
export const CLAMP_MAX = 5.0;
export const TEMPERATURE = 0.6;

export function softmaxSample(weights: Record<string, number>, k: number, temp = TEMPERATURE): string[] {
  const pool = Object.entries(weights).map(([t, w]) => [t, Math.exp(w / temp)] as [string, number]);
  const picked: string[] = [];
  
  while (picked.length < k && pool.length) {
    const total = pool.reduce((s, [, e]) => s + e, 0);
    let r = Math.random() * total;
    let idx = 0;
    
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i][1];
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    
    picked.push(pool[idx][0]);
    pool.splice(idx, 1);
  }
  
  return picked;
}

// 3 exploit + 1 explore (+ caller may append a weak/reinforce topic)
export function chooseBatchTopics(interest: Record<string, number>): string[] {
  const allTopicNames = Array.from(new Set([...TOPIC_NAMES, ...Object.keys(interest)]));
  const filled = Object.fromEntries(
    allTopicNames.map(t => [t, interest[t] ?? CLAMP_MIN])
  );
  const exploit = softmaxSample(filled, 3);
  const rest = allTopicNames.filter(t => !exploit.includes(t));
  const explore = rest.length ? rest[Math.floor(Math.random() * rest.length)] : allTopicNames[0];
  return [...exploit, explore];
}

export function applyDelta(interest: Record<string, number>, topic: string, delta: number) {
  const next = { ...interest };
  next[topic] = Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, (next[topic] ?? CLAMP_MIN) + delta));
  const allTopicNames = Array.from(new Set([...TOPIC_NAMES, ...Object.keys(next)]));
  for (const t of allTopicNames) {
    next[t] = Math.max(CLAMP_MIN, (next[t] ?? CLAMP_MIN) * DECAY);
  }
  return next;
}

