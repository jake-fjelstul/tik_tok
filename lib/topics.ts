export const TOPICS: Record<string, string> = {
  "Space": "#6C8CFF",
  "Programming & Building": "#2FC3D6",
  "AI & Machine Learning": "#13C2A6",
  "Biology & Nature": "#36C46A",
  "Health & Body": "#8FD14F",
  "Cooking & Food": "#E0A93B",
  "History": "#E07A3B",
  "How Things Work": "#E0563B",
  "Art & Design": "#E04B8A",
  "Psychology & Mind": "#C45BE0",
  "Philosophy": "#9B5BE0",
  "Language & Words": "#6B6BEA",
  "Money & Economics": "#E0C53B",
  "Physics": "#3B9EE0",
  "Skills & Productivity": "#E07ABF",
  "Interview Prep": "#F59E0B",
};
export const TOPIC_NAMES = Object.keys(TOPICS);
export const BASELINE = 0.1;

export function getTopicColor(topic: string): string {
  if (TOPICS[topic]) return TOPICS[topic];
  // Deterministic color generation based on name hash
  let hash = 0;
  for (let i = 0; i < topic.length; i++) {
    hash = topic.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  // Use HSL with high saturation/vibrancy for our premium theme
  return `hsl(${h}, 75%, 55%)`;
}

