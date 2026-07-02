import React, { useState, useRef, useEffect, useCallback } from "react";
import { ThumbsUp, ThumbsDown, Play, Check, X, ChevronUp, Sparkles, Loader2, Volume2, VolumeX } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Topic taxonomy — each topic carries a hue (colour = information).   */
/* ------------------------------------------------------------------ */
const TOPICS = {
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
};
const TOPIC_NAMES = Object.keys(TOPICS);
const BASELINE = 0.1;

/* ------------------------------------------------------------------ */
/* Recommender helpers                                                 */
/* ------------------------------------------------------------------ */
function softmaxSample(weights, k, temperature = 0.6) {
  const exps = Object.entries(weights).map(([t, w]) => [t, Math.exp(w / temperature)]);
  const picked = [];
  const pool = [...exps];
  while (picked.length < k && pool.length) {
    const total = pool.reduce((s, [, e]) => s + e, 0);
    let r = Math.random() * total, idx = 0;
    for (let i = 0; i < pool.length; i++) { r -= pool[i][1]; if (r <= 0) { idx = i; break; } }
    picked.push(pool[idx][0]); pool.splice(idx, 1);
  }
  return picked;
}
function chooseBatchTopics(interest) {
  const exploit = softmaxSample(interest, 3);
  const rest = TOPIC_NAMES.filter((t) => !exploit.includes(t));
  const explore = rest[Math.floor(Math.random() * rest.length)];
  return [...exploit, explore];
}

/* ------------------------------------------------------------------ */
/* Content service — generates a batch of cards via the Claude API     */
/* ------------------------------------------------------------------ */
async function generateBatch({ interest, seenTitles, dueTopics }) {
  const featured = chooseBatchTopics(interest);
  const reinforceLine = dueTopics.length
    ? `Include ONE extra "fact" card refresher on each of these recently-missed topics: ${dueTopics.join(", ")}.`
    : "";
  const userContent = `You generate cards for a personalised learning feed.
Feature these topics this batch: ${featured.join(", ")}.
${reinforceLine}
Avoid repeating these recently shown titles: ${seenTitles.slice(-25).join(" | ") || "(none yet)"}.
Produce exactly 6 cards as a JSON array. Mix: ~4 "fact", 1 "quiz", 1 "video".
Use ONLY these exact topic strings: ${TOPIC_NAMES.join(", ")}.
Schemas:
- fact:  {"type":"fact","topic":"<topic>","tag":"<1-3 word kicker>","title":"<hook, <=9 words>","body":"<2 sentences, genuinely surprising and specific, no fluff. This sentence is read aloud, so write it to be spoken.>"}
- quiz:  {"type":"quiz","topic":"<topic>","question":"<one clear question>","options":["a","b","c","d"],"correct":<0-3>,"explain":"<1 sentence>"}
- video: {"type":"video","topic":"<topic>","title":"<how-to title>","hook":"<1 sentence on what you'll learn>","query":"<specific YouTube search query>"}
Return ONLY the raw JSON array. No markdown, no commentary.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: "You output only valid minified JSON. Never include markdown fences or commentary.",
      messages: [{ role: "user", content: userContent }],
    }),
  });
  const data = await res.json();
  const text = data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const arr = JSON.parse(clean.slice(clean.indexOf("["), clean.lastIndexOf("]") + 1));
  return arr
    .filter((it) => it && it.type && TOPICS[it.topic])
    .map((it, i) => ({ ...it, uid: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}` }));
}

/* Seed feed — includes two REAL, verified YouTube clips so the player
   plays immediately. In the hosted build these come from the YouTube
   clip pipeline (search -> transcript -> best segment) instead. */
const SEED = [
  { type: "fact", topic: "Space", tag: "Time bend", title: "GPS satellites age faster than you", body: "Clocks on GPS satellites tick about thirty-eight microseconds faster every day, because gravity is weaker up there. Without correcting for it, your phone's location would drift by kilometres within a single day.", uid: "seed1" },
  { type: "video", topic: "AI & Machine Learning", title: "What a neural network actually is", channel: "3Blue1Brown", videoId: "aircAruvnKk", start: 163, end: 205, uid: "seed2" },
  { type: "quiz", topic: "Physics", question: "Why is the sky blue?", options: ["Reflection from oceans", "Shorter wavelengths scatter more", "The Sun emits blue light", "Atmospheric oxygen is blue"], correct: 1, explain: "Blue light has a shorter wavelength, so air molecules scatter it far more than red — Rayleigh scattering.", uid: "seed3" },
  { type: "video", topic: "Programming & Building", title: "Python in 100 seconds", channel: "Fireship", videoId: "x7X9w_GIm1s", start: 0, end: 48, uid: "seed4" },
  { type: "fact", topic: "Biology & Nature", tag: "Survival", title: "Tardigrades survived open space", body: "In two thousand seven, dehydrated tardigrades were exposed to the vacuum and radiation of space for ten days, and many revived once back on Earth. They enter a state called cryptobiosis where their metabolism nearly stops.", uid: "seed5" },
];

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap');
.lf-root{position:fixed;inset:0;background:#0B0D14;color:#F3F3F6;font-family:Inter,system-ui,sans-serif;overflow:hidden;}
.lf-feed{height:100dvh;overflow-y:scroll;scroll-snap-type:y mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;}
.lf-feed::-webkit-scrollbar{display:none;}
.lf-card{height:100dvh;scroll-snap-align:start;display:flex;flex-direction:column;justify-content:center;padding:84px 26px 116px;position:relative;box-sizing:border-box;}
.lf-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;display:flex;align-items:center;gap:8px;margin-bottom:18px;}
.lf-dot{width:9px;height:9px;border-radius:50%;}
.lf-title{font-family:Fraunces,serif;font-weight:600;font-size:34px;line-height:1.12;letter-spacing:-.01em;margin:0 0 18px;}
.lf-body{font-size:17px;line-height:1.55;color:#C9CAD2;max-width:520px;}
.lf-q{font-family:Fraunces,serif;font-weight:600;font-size:27px;line-height:1.2;margin:0 0 22px;}
.lf-opt{display:block;width:100%;text-align:left;padding:15px 17px;margin-bottom:11px;border-radius:14px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.04);color:#EDEDF2;font-size:16px;font-family:inherit;cursor:pointer;transition:all .15s;}
.lf-opt:active{transform:scale(.99);}
.lf-explain{font-size:15px;line-height:1.5;color:#B7B8C2;margin-top:14px;padding-left:13px;border-left:2px solid rgba(255,255,255,.2);}
.lf-react{position:absolute;right:18px;bottom:104px;display:flex;flex-direction:column;gap:16px;align-items:center;}
.lf-rbtn{width:50px;height:50px;border-radius:50%;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#E6E6EC;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .15s;}
.lf-rbtn:active{transform:scale(.9);}
.lf-playerwrap{position:relative;width:100%;aspect-ratio:16/9;border-radius:18px;overflow:hidden;background:#000;margin-bottom:16px;box-shadow:0 16px 50px rgba(0,0,0,.55);}
.lf-iframe{position:absolute;inset:0;width:100%;height:100%;border:0;}
.lf-poster{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 45%, rgba(255,255,255,.08), rgba(0,0,0,.35));}
.lf-vtitle{font-family:Fraunces,serif;font-weight:600;font-size:24px;line-height:1.18;margin:0 0 18px;}
.lf-watch{display:inline-flex;align-items:center;gap:9px;padding:13px 20px;border-radius:999px;border:none;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;align-self:flex-start;}
.lf-meter{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:20;display:flex;align-items:center;gap:9px;padding:9px 14px;border-radius:999px;background:rgba(20,22,32,.82);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.09);cursor:pointer;}
.lf-meterbars{display:flex;gap:4px;align-items:flex-end;height:16px;}
.lf-mlabel{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#9A9BA6;}
.lf-sound{position:absolute;top:14px;right:16px;z-index:20;width:40px;height:40px;border-radius:50%;background:rgba(20,22,32,.82);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.09);display:flex;align-items:center;justify-content:center;cursor:pointer;color:#E6E6EC;}
.lf-sheet{position:absolute;inset:0;z-index:30;background:rgba(8,9,15,.92);backdrop-filter:blur(8px);padding:80px 26px 40px;overflow-y:auto;}
.lf-srow{display:flex;align-items:center;gap:12px;margin-bottom:13px;}
.lf-strack{flex:1;height:8px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden;}
.lf-sname{font-size:13px;width:140px;flex-shrink:0;}
.lf-onb{position:fixed;inset:0;background:#0B0D14;color:#F3F3F6;display:flex;flex-direction:column;justify-content:center;padding:32px 26px;box-sizing:border-box;font-family:Inter,sans-serif;overflow-y:auto;}
.lf-chip{padding:11px 15px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:transparent;color:#E6E6EC;font-size:14px;font-family:inherit;cursor:pointer;transition:all .15s;}
.lf-start{margin-top:26px;width:100%;padding:17px;border-radius:16px;border:none;font-family:Fraunces,serif;font-weight:600;font-size:18px;cursor:pointer;}
.lf-center{height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#9A9BA6;text-align:center;padding:0 30px;}
@keyframes spin{to{transform:rotate(360deg)}}
.lf-spin{animation:spin 1s linear infinite;}
@media (prefers-reduced-motion:reduce){.lf-spin{animation:none}}
`;

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */
function TopicEyebrow({ topic }) {
  return (
    <div className="lf-eyebrow" style={{ color: TOPICS[topic] }}>
      <span className="lf-dot" style={{ background: TOPICS[topic] }} />{topic}
    </div>
  );
}
function ReactBar({ reaction, onReact }) {
  return (
    <div className="lf-react">
      <button className="lf-rbtn" onClick={() => onReact("up")}
        style={reaction === "up" ? { background: "#36C46A", borderColor: "#36C46A", color: "#0B0D14" } : {}}><ThumbsUp size={20} /></button>
      <button className="lf-rbtn" onClick={() => onReact("down")}
        style={reaction === "down" ? { background: "#E0563B", borderColor: "#E0563B", color: "#fff" } : {}}><ThumbsDown size={20} /></button>
    </div>
  );
}
function FactCard({ item, reaction, onReact }) {
  const hue = TOPICS[item.topic];
  return (
    <div className="lf-card" style={{ background: `radial-gradient(130% 90% at 15% 12%, ${hue}1f 0%, rgba(11,13,20,0) 60%)` }}>
      <TopicEyebrow topic={item.topic} />
      {item.tag && <div className="lf-mlabel" style={{ color: hue, marginBottom: 8 }}>{item.tag}</div>}
      <h2 className="lf-title">{item.title}</h2>
      <p className="lf-body">{item.body}</p>
      <ReactBar reaction={reaction} onReact={onReact} />
    </div>
  );
}
function VideoCard({ item, isActive, reaction, onReact }) {
  const hue = TOPICS[item.topic];
  if (item.videoId) {
    const openFull = () => { onReact("video"); window.open(`https://www.youtube.com/watch?v=${item.videoId}&t=${item.start || 0}s`, "_blank"); };
    const src = `https://www.youtube.com/embed/${item.videoId}?start=${item.start}&end=${item.end}&autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`;
    return (
      <div className="lf-card" style={{ background: `radial-gradient(130% 90% at 50% 8%, ${hue}24 0%, rgba(11,13,20,0) 60%)` }}>
        <TopicEyebrow topic={item.topic} />
        <div className="lf-mlabel" style={{ color: hue, marginBottom: 12 }}>Clip · {item.channel}</div>
        <div className="lf-playerwrap">
          {isActive
            ? <iframe className="lf-iframe" src={src} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen title={item.title} />
            : <div className="lf-poster" style={{ color: hue }}><Play size={46} fill="currentColor" /></div>}
        </div>
        <h3 className="lf-vtitle">{item.title}</h3>
        <button className="lf-watch" onClick={openFull} style={{ background: hue, color: "#0B0D14" }}><Play size={16} fill="#0B0D14" /> Watch full on YouTube</button>
        <ReactBar reaction={reaction} onReact={onReact} />
      </div>
    );
  }
  // No clip id yet (LLM-generated in this demo) → opens a targeted YouTube search.
  const open = () => { onReact("video"); window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(item.query)}`, "_blank"); };
  return (
    <div className="lf-card" style={{ background: `radial-gradient(130% 90% at 85% 12%, ${hue}26 0%, rgba(11,13,20,0) 60%)` }}>
      <TopicEyebrow topic={item.topic} />
      <div className="lf-mlabel" style={{ color: hue, marginBottom: 8 }}>How-to</div>
      <h2 className="lf-title">{item.title}</h2>
      <p className="lf-body" style={{ marginBottom: 22 }}>{item.hook}</p>
      <button className="lf-watch" onClick={open} style={{ background: hue, color: "#0B0D14" }}><Play size={16} fill="#0B0D14" /> Find the clip</button>
      <ReactBar reaction={reaction} onReact={onReact} />
    </div>
  );
}
function QuizCard({ item, onAnswer }) {
  const [picked, setPicked] = useState(null);
  const hue = TOPICS[item.topic];
  const answer = (i) => { if (picked !== null) return; setPicked(i); onAnswer(i === item.correct); };
  return (
    <div className="lf-card" style={{ background: `radial-gradient(130% 100% at 50% 0%, ${hue}1c 0%, rgba(11,13,20,0) 55%)` }}>
      <TopicEyebrow topic={item.topic} />
      <div className="lf-mlabel" style={{ color: hue, marginBottom: 16 }}>Quick check</div>
      <h2 className="lf-q">{item.question}</h2>
      {item.options.map((opt, i) => {
        let s = {};
        if (picked !== null) {
          if (i === item.correct) s = { background: "#36C46A22", borderColor: "#36C46A", color: "#fff" };
          else if (i === picked) s = { background: "#E0563B22", borderColor: "#E0563B", color: "#fff" };
          else s = { opacity: 0.5 };
        }
        return (
          <button key={i} className="lf-opt" style={s} onClick={() => answer(i)}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              {picked !== null && i === item.correct && <Check size={16} color="#36C46A" />}
              {picked !== null && i === picked && i !== item.correct && <X size={16} color="#E0563B" />}
              {opt}
            </span>
          </button>
        );
      })}
      {picked !== null && <p className="lf-explain">{item.explain}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Interest meter                                                      */
/* ------------------------------------------------------------------ */
function Meter({ interest, open, setOpen }) {
  const sorted = Object.entries(interest).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...sorted.map((s) => s[1]), 0.001);
  return (
    <>
      <div className="lf-meter" onClick={() => setOpen(true)}>
        <Sparkles size={14} color="#E0C53B" />
        <span className="lf-mlabel">Tuning to</span>
        <div className="lf-meterbars">
          {sorted.slice(0, 3).map(([t, w]) => (
            <div key={t} style={{ width: 5, height: Math.max(4, (w / max) * 16), borderRadius: 2, background: TOPICS[t] }} />
          ))}
        </div>
      </div>
      {open && (
        <div className="lf-sheet" onClick={() => setOpen(false)}>
          <div className="lf-mlabel" style={{ marginBottom: 22 }}>What your feed has learned</div>
          {sorted.map(([t, w]) => (
            <div key={t} className="lf-srow">
              <span className="lf-sname" style={{ color: TOPICS[t] }}>{t}</span>
              <div className="lf-strack"><div style={{ height: "100%", width: `${(w / max) * 100}%`, background: TOPICS[t] }} /></div>
            </div>
          ))}
          <div className="lf-mlabel" style={{ marginTop: 24, textAlign: "center" }}>tap anywhere to close</div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Onboarding                                                          */
/* ------------------------------------------------------------------ */
function Onboarding({ onStart }) {
  const [sel, setSel] = useState([]);
  const toggle = (t) => setSel((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));
  return (
    <div className="lf-onb">
      <div className="lf-mlabel" style={{ marginBottom: 12 }}>Set up your feed</div>
      <h1 style={{ fontFamily: "Fraunces,serif", fontWeight: 600, fontSize: 30, lineHeight: 1.15, margin: "0 0 8px" }}>Pick a few things you're curious about</h1>
      <p style={{ color: "#9A9BA6", fontSize: 15, margin: "0 0 24px" }}>It tunes from here as you react. Pick at least 3.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {TOPIC_NAMES.map((t) => {
          const on = sel.includes(t);
          return (
            <button key={t} className="lf-chip" onClick={() => toggle(t)}
              style={on ? { background: TOPICS[t], borderColor: TOPICS[t], color: "#0B0D14", fontWeight: 600 } : {}}>{t}</button>
          );
        })}
      </div>
      <button className="lf-start" disabled={sel.length < 3} onClick={() => onStart(sel)}
        style={{ background: sel.length < 3 ? "#2A2C38" : "#F3F3F6", color: sel.length < 3 ? "#6A6B76" : "#0B0D14" }}>
        {sel.length < 3 ? `Pick ${3 - sel.length} more` : "Start scrolling"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
export default function LearnFeed() {
  const [phase, setPhase] = useState("onboard");
  const [items, setItems] = useState([]);
  const [interest, setInterest] = useState({});
  const [reactions, setReactions] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [soundOn, setSoundOn] = useState(true);

  const interestRef = useRef({});
  const itemsRef = useRef([]);
  const seenRef = useRef([]);
  const weakRef = useRef([]);
  const activeRef = useRef(0);
  const loadingRef = useRef(false);
  const enterRef = useRef({ idx: 0, t: Date.now() });
  const cardRefs = useRef({});
  const dwelledRef = useRef({});
  const soundRef = useRef(true);

  useEffect(() => { interestRef.current = interest; }, [interest]);
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { soundRef.current = soundOn; if (!soundOn && window.speechSynthesis) window.speechSynthesis.cancel(); }, [soundOn]);

  const speakBody = (text) => {
    const synth = window.speechSynthesis;
    if (!synth || !text) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.25;
    synth.speak(u);
  };

  const bump = useCallback((topic, delta) => {
    setInterest((prev) => {
      const next = { ...prev };
      next[topic] = Math.min(5, Math.max(0, (next[topic] || BASELINE) + delta));
      for (const t of TOPIC_NAMES) next[t] = Math.max(BASELINE, (next[t] || BASELINE) * 0.997);
      interestRef.current = next;
      return next;
    });
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true; setLoading(true); setError(null);
    try {
      const due = weakRef.current.filter((w) => w.dueIndex <= activeRef.current + 6).map((w) => w.topic);
      weakRef.current = weakRef.current.filter((w) => w.dueIndex > activeRef.current + 6);
      const batch = await generateBatch({ interest: interestRef.current, seenTitles: seenRef.current, dueTopics: [...new Set(due)] });
      if (batch.length) {
        seenRef.current = [...seenRef.current, ...batch.map((b) => b.title || b.question || "")].slice(-60);
        setItems((prev) => [...prev, ...batch]);
      } else setError("Couldn't load more cards. Tap retry.");
    } catch { setError("Generation hiccup — tap retry."); }
    finally { loadingRef.current = false; setLoading(false); }
  }, []);

  const start = (picks) => {
    const init = {}; for (const t of TOPIC_NAMES) init[t] = BASELINE; for (const p of picks) init[p] = 1.0;
    setInterest(init); interestRef.current = init;
    setItems(SEED); itemsRef.current = SEED;
    seenRef.current = SEED.map((s) => s.title || s.question || "");
    // prime speech within the user gesture so mobile allows it later
    if (window.speechSynthesis) { try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(" ")); } catch {} }
    setPhase("feed"); loadMore();
  };

  const react = (item, kind) => {
    setReactions((r) => ({ ...r, [item.uid]: kind }));
    if (kind === "up") bump(item.topic, 0.6);
    else if (kind === "down") bump(item.topic, -0.8);
    else if (kind === "video") bump(item.topic, 0.4);
  };
  const onAnswer = (item, correct) => {
    if (correct) bump(item.topic, 0.3);
    else { bump(item.topic, 0.1); weakRef.current.push({ topic: item.topic, dueIndex: activeRef.current + 4 + Math.floor(Math.random() * 5) }); }
  };

  useEffect(() => {
    if (phase !== "feed") return;
    const obs = new IntersectionObserver((entries) => {
      let best = null;
      for (const e of entries) if (e.isIntersecting && e.intersectionRatio > 0.6) best = Number(e.target.dataset.idx);
      if (best === null || best === enterRef.current.idx) return;
      const prev = enterRef.current;
      const dwell = (Date.now() - prev.t) / 1000;
      const prevItem = itemsRef.current[prev.idx];
      if (prevItem && dwell >= 4 && !dwelledRef.current[prevItem.uid]) { dwelledRef.current[prevItem.uid] = true; bump(prevItem.topic, 0.15); }
      enterRef.current = { idx: best, t: Date.now() };
      activeRef.current = best;
      setActiveIndex(best);
      const cur = itemsRef.current[best];
      if (cur && cur.type === "fact" && soundRef.current) speakBody(cur.body);
      else if (window.speechSynthesis) window.speechSynthesis.cancel();
      if (itemsRef.current.length - best <= 4) loadMore();
    }, { threshold: [0.61] });
    Object.values(cardRefs.current).forEach((el) => el && obs.observe(el));
    return () => obs.disconnect();
  }, [phase, items.length, bump, loadMore]);

  if (phase === "onboard") return (<><style>{CSS}</style><Onboarding onStart={start} /></>);

  return (
    <div className="lf-root">
      <style>{CSS}</style>
      <Meter interest={interest} open={sheetOpen} setOpen={setSheetOpen} />
      <div className="lf-sound" onClick={() => setSoundOn((s) => !s)} title={soundOn ? "Mute narration" : "Unmute narration"}>
        {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
      </div>
      <div className="lf-feed">
        {items.map((item, idx) => (
          <div key={item.uid} data-idx={idx} ref={(el) => (cardRefs.current[idx] = el)}>
            {item.type === "fact" && <FactCard item={item} reaction={reactions[item.uid]} onReact={(k) => react(item, k)} />}
            {item.type === "video" && <VideoCard item={item} isActive={idx === activeIndex} reaction={reactions[item.uid]} onReact={(k) => react(item, k)} />}
            {item.type === "quiz" && <QuizCard item={item} onAnswer={(c) => onAnswer(item, c)} />}
          </div>
        ))}
        <div className="lf-card">
          <div className="lf-center">
            {loading ? (<><Loader2 className="lf-spin" size={26} /><span>Generating cards tuned to you…</span></>)
              : error ? (<><span>{error}</span><button className="lf-watch" style={{ background: "#F3F3F6", color: "#0B0D14" }} onClick={loadMore}>Retry</button></>)
              : (<><ChevronUp size={26} /><span>Keep scrolling — more loading</span></>)}
          </div>
        </div>
      </div>
    </div>
  );
}
