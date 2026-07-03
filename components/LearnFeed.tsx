"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  ThumbsUp,
  ThumbsDown,
  Play,
  Check,
  X,
  ChevronUp,
  Sparkles,
  Loader2,
  Volume2,
  VolumeX,
  Music
} from "lucide-react";
import type { User } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import { TOPICS, TOPIC_NAMES, BASELINE } from "@/lib/topics";

// Dynamic YouTube Player API loader helper
let ytScriptPromise: Promise<void> | null = null;
function loadYoutubeIframeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if ((window as any).YT && (window as any).YT.Player) {
    return Promise.resolve();
  }
  if (!ytScriptPromise) {
    ytScriptPromise = new Promise((resolve) => {
      const existingTag = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
      if (existingTag) {
        if ((window as any).YT && (window as any).YT.Player) {
          resolve();
        } else {
          const interval = setInterval(() => {
            if ((window as any).YT && (window as any).YT.Player) {
              clearInterval(interval);
              resolve();
            }
          }, 100);
        }
        return;
      }
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      const firstScriptTag = document.getElementsByTagName("script")[0];
      firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
      (window as any).onYouTubeIframeAPIReady = () => {
        resolve();
      };
    });
  }
  return ytScriptPromise;
}

// Simple deterministic hash to pick a track per card ID stably
function getRandTrack(itemId: string, tracksList: any[]): string | null {
  if (!tracksList || tracksList.length === 0) return null;
  let hash = 0;
  for (let i = 0; i < itemId.length; i++) {
    hash = itemId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % tracksList.length;
  return tracksList[index].public_url;
}

const playCorrectSound = (volume: number = 0.5) => {
  if (typeof window === "undefined") return;
  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(659.25, now); // E5
    gain1.gain.setValueAtTime(0, now);
    gain1.gain.linearRampToValueAtTime(volume * 0.3, now + 0.04);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(783.99, now + 0.08); // G5
    gain2.gain.setValueAtTime(0, now + 0.08);
    gain2.gain.linearRampToValueAtTime(volume * 0.4, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.3);

    osc2.start(now + 0.08);
    osc2.stop(now + 0.45);
  } catch (e) {
    console.warn("Failed to play correct sound effect:", e);
  }
};

// Static seed fallback cards to guarantee the feed works even if the database content pool is empty
const FALLBACK_SEED = [
  {
    id: "seed1",
    type: "fact",
    topic: "Space",
    tag: "Time bend",
    title: "GPS satellites age faster than you",
    body: "Clocks on GPS satellites tick about thirty-eight microseconds faster every day, because gravity is weaker up there. Without correcting for it, your phone's location would drift by kilometres within a single day."
  },
  {
    id: "seed2",
    type: "video",
    topic: "AI & Machine Learning",
    title: "What a neural network actually is",
    channel: "3Blue1Brown",
    videoId: "aircAruvnKk",
    start: 163,
    end: 205
  },
  {
    id: "seed3",
    type: "quiz",
    topic: "Physics",
    question: "Why is the sky blue?",
    options: ["Reflection from oceans", "Shorter wavelengths scatter more", "The Sun emits blue light", "Atmospheric oxygen is blue"],
    correct: 1,
    explain: "Blue light has a shorter wavelength, so air molecules scatter it far more than red — Rayleigh scattering."
  },
  {
    id: "seed4",
    type: "video",
    topic: "Programming & Building",
    title: "Python in 100 seconds",
    channel: "Fireship",
    videoId: "x7X9w_GIm1s",
    start: 0,
    end: 48
  },
  {
    id: "seed5",
    type: "fact",
    topic: "Biology & Nature",
    tag: "Survival",
    title: "Tardigrades survived open space",
    body: "In two thousand seven, dehydrated tardigrades were exposed to the vacuum and radiation of space for ten days, and many revived once back on Earth. They enter a state called cryptobiosis where their metabolism nearly stops."
  },
];

/* ------------------------------------------------------------------ */
/* Sub-components                                                     */
/* ------------------------------------------------------------------ */
function TopicEyebrow({ topic }: { topic: string }) {
  const color = TOPICS[topic] || "#9A9BA6";
  return (
    <div className="lf-eyebrow" style={{ color }}>
      <span className="lf-dot" style={{ background: color }} />
      {topic}
    </div>
  );
}

interface ReactBarProps {
  reaction: "up" | "down" | "video" | undefined;
  onReact: (kind: "up" | "down") => void;
}

function ReactBar({ reaction, onReact }: ReactBarProps) {
  return (
    <div className="lf-react">
      <button
        className="lf-rbtn"
        onClick={() => onReact("up")}
        style={reaction === "up" ? { background: "#36C46A", borderColor: "#36C46A", color: "#0B0D14" } : {}}
      >
        <ThumbsUp size={20} />
      </button>
      <button
        className="lf-rbtn"
        onClick={() => onReact("down")}
        style={reaction === "down" ? { background: "#E0563B", borderColor: "#E0563B", color: "#fff" } : {}}
      >
        <ThumbsDown size={20} />
      </button>
    </div>
  );
}

function FactCard({ item, reaction, onReact }: { item: any; reaction: any; onReact: any }) {
  const hue = TOPICS[item.topic] || "#ffffff";
  return (
    <>
      <TopicEyebrow topic={item.topic} />
      {item.tag && <div className="lf-mlabel" style={{ color: hue, marginBottom: 8 }}>{item.tag}</div>}
      <h2 className="lf-title">{item.title}</h2>
      <p className="lf-body">{item.body}</p>
      <ReactBar reaction={reaction} onReact={onReact} />
    </>
  );
}

function VideoCard({ 
  item, 
  isActive, 
  reaction, 
  onReact,
  isMutedSession,
  setIsMutedSession
}: { 
  item: any; 
  isActive: boolean; 
  reaction: any; 
  onReact: any;
  isMutedSession: boolean;
  setIsMutedSession: (m: boolean) => void;
}) {
  const hue = TOPICS[item.topic] || "#ffffff";
  const playerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const openFull = () => {
    onReact("video");
    window.open(`https://www.youtube.com/watch?v=${item.videoId}&t=${item.start || 0}s`, "_blank");
  };

  const playerId = `yt-player-${item.id}`;

  // Setup and destroy the YouTube player instance
  useEffect(() => {
    if (!isActive) {
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch {}
        playerRef.current = null;
      }
      return;
    }

    let isMounted = true;
    const initPlayer = async () => {
      await loadYoutubeIframeApi();
      if (!isMounted) return;
      try {
        new (window as any).YT.Player(playerId, {
          height: "100%",
          width: "100%",
          videoId: item.videoId,
          playerVars: {
            start: item.start,
            end: item.end,
            autoplay: 1,
            mute: isMutedSession ? 1 : 0,
            playsinline: 1,
            controls: 0,
            rel: 0,
            modestbranding: 1,
            enablejsapi: 1,
          },
          events: {
            onReady: (event: any) => {
              if (!isMounted) {
                event.target.destroy();
                return;
              }
              playerRef.current = event.target;
              if (!isMutedSession) {
                event.target.unMute();
                event.target.setVolume(100);
              }
              event.target.playVideo();
            },
            onStateChange: (event: any) => {
              if (event.data === (window as any).YT.PlayerState.ENDED) {
                event.target.seekTo(item.start || 0, true);
                event.target.playVideo();
              }
            }
          }
        });
      } catch (err) {
        console.error("Failed to init player:", err);
      }
    };
    initPlayer();

    return () => {
      isMounted = false;
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch {}
        playerRef.current = null;
      }
    };
  }, [isActive, item.videoId, item.start, item.end]);

  // Handle mute changes dynamically on the active player
  useEffect(() => {
    if (playerRef.current) {
      if (isMutedSession) {
        playerRef.current.mute();
      } else {
        playerRef.current.unMute();
        playerRef.current.setVolume(100);
      }
    }
  }, [isMutedSession]);

  const handleToggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextMute = !isMutedSession;
    setIsMutedSession(nextMute);
    if (playerRef.current) {
      if (nextMute) {
        playerRef.current.mute();
      } else {
        playerRef.current.unMute();
        playerRef.current.setVolume(100);
      }
    }
  };

  return (
    <>
      <TopicEyebrow topic={item.topic} />
      <div className="lf-mlabel" style={{ color: hue, marginBottom: 12 }}>Clip · {item.channel || "YouTube"}</div>
      <div className="lf-playerwrap" onClick={handleToggleMute}>
        {isActive ? (
          <>
            <div id={playerId} ref={containerRef} className="lf-iframe" />
            {isMutedSession && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(0, 0, 0, 0.45)",
                  backdropFilter: "blur(2px)",
                  cursor: "pointer",
                  zIndex: 10,
                  transition: "opacity 0.2s"
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "8px",
                    padding: "12px 18px",
                    background: "rgba(11, 13, 20, 0.85)",
                    borderRadius: "16px",
                    border: "1px solid rgba(255, 255, 255, 0.12)",
                    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
                  }}
                >
                  <VolumeX size={26} style={{ color: "#ffffff" }} />
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      color: "#ffffff",
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      fontFamily: "Inter, sans-serif"
                    }}
                  >
                    Tap to Unmute
                  </span>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="lf-poster" style={{ color: hue }} onClick={openFull}>
            <Play size={46} fill="currentColor" />
          </div>
        )}
      </div>
      <h3 className="lf-vtitle">{item.title}</h3>
      <button className="lf-watch" onClick={openFull} style={{ background: hue, color: "#0B0D14" }}>
        <Play size={16} fill="#0B0D14" /> Watch full on YouTube
      </button>
      <ReactBar reaction={reaction} onReact={(k) => onReact(k)} />
    </>
  );
}

function QuizCard({ item, onAnswer }: { item: any; onAnswer: (correct: boolean) => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const hue = TOPICS[item.topic] || "#ffffff";

  const answer = (i: number) => {
    if (picked !== null) return;
    setPicked(i);
    onAnswer(i === item.correct);
  };

  return (
    <>
      <TopicEyebrow topic={item.topic} />
      <div className="lf-mlabel" style={{ color: hue, marginBottom: 16 }}>Quick check</div>
      <h2 className="lf-q">{item.question}</h2>
      {item.options.map((opt: string, i: number) => {
        let s = {};
        if (picked !== null) {
          if (i === item.correct) {
            s = { background: "#36C46A22", borderColor: "#36C46A", color: "#fff" };
          } else if (i === picked) {
            s = { background: "#E0563B22", borderColor: "#E0563B", color: "#fff" };
          } else {
            s = { opacity: 0.5 };
          }
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
    </>
  );
}

interface MeterProps {
  interest: Record<string, number>;
  open: boolean;
  setOpen: (open: boolean) => void;
}

function Meter({ interest, open, setOpen }: MeterProps) {
  const sorted = Object.entries(interest).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...sorted.map((s) => s[1]), 0.001);

  return (
    <>
      <div className="lf-meter" onClick={() => setOpen(true)}>
        <Sparkles size={14} color="#E0C53B" />
        <span className="lf-mlabel">Tuning to</span>
        <div className="lf-meterbars">
          {sorted.slice(0, 3).map(([t, w]) => (
            <div
              key={t}
              style={{
                width: 5,
                height: Math.max(4, (w / max) * 16),
                borderRadius: 2,
                background: TOPICS[t] || "#ccc"
              }}
            />
          ))}
        </div>
      </div>
      {open && (
        <div className="lf-sheet" onClick={() => setOpen(false)}>
          <div className="lf-mlabel" style={{ marginBottom: 22 }}>What your feed has learned</div>
          {sorted.map(([t, w]) => (
            <div key={t} className="lf-srow">
              <span className="lf-sname" style={{ color: TOPICS[t] || "#ccc" }}>{t}</span>
              <div className="lf-strack">
                <div style={{ height: "100%", width: `${Math.min(100, (w / max) * 100)}%`, background: TOPICS[t] || "#ccc" }} />
              </div>
            </div>
          ))}
          <div className="lf-mlabel" style={{ marginTop: 24, textAlign: "center" }}>tap anywhere to close</div>
        </div>
      )}
    </>
  );
}

function Onboarding({ onStart }: { onStart: (picks: string[]) => void }) {
  const [sel, setSel] = useState<string[]>([]);

  const toggle = (t: string) =>
    setSel((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));

  return (
    <div className="lf-onb">
      <div className="lf-mlabel" style={{ marginBottom: 12 }}>Set up your feed</div>
      <h1 style={{ fontFamily: "Fraunces,serif", fontWeight: 600, fontSize: 30, lineHeight: 1.15, margin: "0 0 8px" }}>
        Pick a few things you're curious about
      </h1>
      <p style={{ color: "#9A9BA6", fontSize: 15, margin: "0 0 24px" }}>
        It tunes from here as you react. Pick at least 3.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {TOPIC_NAMES.map((t) => {
          const on = sel.includes(t);
          return (
            <button
              key={t}
              className="lf-chip"
              onClick={() => toggle(t)}
              style={on ? { background: TOPICS[t], borderColor: TOPICS[t], color: "#0B0D14", fontWeight: 600 } : {}}
            >
              {t}
            </button>
          );
        })}
      </div>
      <button
        className="lf-start"
        disabled={sel.length < 3}
        onClick={() => onStart(sel)}
        style={{
          background: sel.length < 3 ? "#2A2C38" : "#F3F3F6",
          color: sel.length < 3 ? "#6A6B76" : "#0B0D14"
        }}
      >
        {sel.length < 3 ? `Pick ${3 - sel.length} more` : "Start scrolling"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main Client Component                                              */
/* ------------------------------------------------------------------ */
export default function LearnFeed() {
  const [phase, setPhase] = useState<"loading" | "onboard" | "feed">("loading");
  const [items, setItems] = useState<any[]>([]);
  const [interest, setInterest] = useState<Record<string, number>>({});
  const [reactions, setReactions] = useState<Record<string, "up" | "down" | "video">>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [soundOn, setSoundOn] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [isMutedSession, setIsMutedSession] = useState<boolean>(true);
  const [bgMusicMuted, setBgMusicMuted] = useState<boolean>(false);
  const [tracks, setTracks] = useState<any[]>([]);
  const [bgMusicVolume, setBgMusicVolume] = useState<number>(0.10);
  const [voiceVolume, setVoiceVolume] = useState<number>(1.0);
  const [voiceSpeed, setVoiceSpeed] = useState<number>(1.5);

  const bgMusicRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    console.log(`User response to PWA install: ${outcome}`);
    setInstallPrompt(null);
  };

  const interestRef = useRef<Record<string, number>>({});
  const itemsRef = useRef<any[]>([]);
  const activeRef = useRef<number>(0);
  const loadingRef = useRef<boolean>(false);
  const enterTimeRef = useRef<number>(Date.now());
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const dwelledIdsRef = useRef<Set<string>>(new Set());
  const soundRef = useRef<boolean>(true);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  // Fetch music tracks on mount and initialize background audio element
  useEffect(() => {
    const fetchMusic = async () => {
      try {
        const res = await fetch("/api/music");
        if (!res.ok) throw new Error("Failed to fetch music from API");
        const data = await res.json();
        if (data.tracks) setTracks(data.tracks);
      } catch (err) {
        console.error("Failed to fetch music tracks:", err);
      }
    };
    fetchMusic();

    if (typeof window !== "undefined") {
      const audio = new Audio();
      audio.loop = true;
      audio.volume = bgMusicVolume;
      bgMusicRef.current = audio;
    }
    return () => {
      if (bgMusicRef.current) {
        bgMusicRef.current.pause();
        bgMusicRef.current = null;
      }
    };
  }, []);

  // Update background music volume dynamically
  useEffect(() => {
    if (bgMusicRef.current) {
      bgMusicRef.current.volume = bgMusicVolume;
    }
  }, [bgMusicVolume]);

  // Update active narration volume and speed dynamically
  useEffect(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.volume = voiceVolume;
      currentAudioRef.current.defaultPlaybackRate = voiceSpeed;
      currentAudioRef.current.playbackRate = voiceSpeed;
    }
  }, [voiceVolume, voiceSpeed]);

  // Sync references
  useEffect(() => { interestRef.current = interest; }, [interest]);
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { activeRef.current = activeIndex; }, [activeIndex]);

  useEffect(() => {
    soundRef.current = soundOn;
    if (!soundOn && typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    if (!soundOn && currentAudioRef.current) {
      currentAudioRef.current.pause();
    }
  }, [soundOn]);

  const stopAudio = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const speakText = (text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = voiceSpeed;
    u.volume = voiceVolume;
    window.speechSynthesis.speak(u);
  };

  const playNarration = useCallback((item: any, bypassMuteCheck = false) => {
    stopAudio();
    if (!soundRef.current || item.type !== "fact") return;
    if (isMutedSession && !bypassMuteCheck) return;

    const textToSpeak = item.body;
    if (!textToSpeak) return;

    if (item.audioUrl) {
      const audio = new Audio(item.audioUrl);
      audio.defaultPlaybackRate = voiceSpeed;
      audio.playbackRate = voiceSpeed;
      audio.volume = voiceVolume;
      currentAudioRef.current = audio;
      audio.play().catch((err) => {
        console.warn("MP3 narration playback blocked/failed, falling back to Web Speech:", err);
        speakText(textToSpeak);
      });
    } else {
      speakText(textToSpeak);
    }
  }, [stopAudio, isMutedSession, voiceSpeed, voiceVolume]);

  const logEngagement = useCallback(async (item: any, action: string, dwellS?: number) => {
    try {
      const res = await fetch("/api/engage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentId: item.id,
          topic: item.topic,
          action,
          dwellS
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.interest) {
          setInterest(data.interest);
        }
      }
    } catch (e) {
      console.error("Engagement logging failed:", e);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 8 }),
      });

      if (!res.ok) throw new Error("Server error loading feed");
      const data = await res.json();

      if (data.items && data.items.length > 0) {
        setItems((prev) => {
          const existingIds = new Set(prev.map((i) => i.id));
          const filtered = data.items.filter((i: any) => !existingIds.has(i.id));
          return [...prev, ...filtered];
        });
        if (data.interest) {
          setInterest(data.interest);
        }
      } else {
        // Fallback to seeds if database pool is empty
        setItems((prev) => {
          if (prev.length === 0) {
            console.warn("Database pool returned empty; using seed fallback content.");
            return FALLBACK_SEED;
          }
          return prev;
        });
      }
    } catch (e) {
      console.error("Feed load exception:", e);
      setError("Unable to sync feed. Tap retry.");

      // Fallback on total failure so user isn't stuck on blank screen
      setItems((prev) => {
        if (prev.length === 0) return FALLBACK_SEED;
        return prev;
      });
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  // Check login session on mount
  useEffect(() => {
    const checkSession = async () => {
      try {
        const supabase = supabaseBrowser();
        const { data: { session } } = await supabase.auth.getSession();

        if (session?.user) {
          const { data: interestRows } = await supabase
            .from("user_interest")
            .select("topic,weight")
            .eq("user_id", session.user.id);

          if (interestRows && interestRows.length > 0) {
            const currentInterest = Object.fromEntries(
              interestRows.map(r => [r.topic, r.weight])
            );
            setInterest(currentInterest);
            setPhase("feed");
            await loadMore();
            return;
          }
        }
        setPhase("onboard");
      } catch (e) {
        console.error("Session verification failed, showing onboarding:", e);
        setPhase("onboard");
      }
    };
    checkSession();
  }, [loadMore]);

  const handleStart = async (picks: string[]) => {
    setPhase("loading");
    try {
      const supabase = supabaseBrowser();

      // Check if we already have an active session (e.g. if the user logged in)
      const { data: { session } } = await supabase.auth.getSession();
      let user: User | null | undefined = session?.user;

      if (!user) {
        const { data: authData, error: authErr } = await supabase.auth.signInAnonymously();
        if (authErr) throw authErr;
        user = authData?.user;
      }

      if (!user) throw new Error("User session creation failed");

      // Narrow to a non-null const so the type is preserved inside the closure below
      const activeUser = user;

      // Setup initial user interest vector in DB
      const inserts = TOPIC_NAMES.map((t) => ({
        user_id: activeUser.id,
        topic: t,
        weight: picks.includes(t) ? 1.0 : 0.1,
      }));

      const { error: insertErr } = await supabase.from("user_interest").upsert(inserts);
      if (insertErr) throw insertErr;

      const initInterest = Object.fromEntries(inserts.map((i) => [i.topic, i.weight]));
      setInterest(initInterest);
      setPhase("feed");
      setIsMutedSession(false); // Onboarding start click is a valid gesture, so unlock audio session-wide

      // Initialize sound system within gesture
      if (typeof window !== "undefined" && window.speechSynthesis) {
        try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(" ")); } catch { }
      }

      await loadMore();
    } catch (err: any) {
      console.error("Onboarding failed:", err);
      setError(err.message || "Onboarding failed. Please try again.");
      setPhase("onboard");
    }
  };

  const handleReact = (item: any, kind: "up" | "down" | "video") => {
    setReactions((prev) => ({ ...prev, [item.id]: kind }));
    logEngagement(item, kind);
    if (kind === "video") {
      window.open(`https://www.youtube.com/watch?v=${item.videoId}&t=${item.start || 0}s`, "_blank");
    }
  };

  const handleAnswer = (item: any, correct: boolean) => {
    const action = correct ? "quiz_correct" : "quiz_wrong";
    logEngagement(item, action);
    if (correct) {
      playCorrectSound(voiceVolume);
    }
  };

  // IntersectionObserver for Snap-card scrolling and active indexing
  useEffect(() => {
    if (phase !== "feed" || items.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let visibleIdx: number | null = null;
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            visibleIdx = Number(entry.target.getAttribute("data-idx"));
          }
        }

        if (visibleIdx === null || visibleIdx === activeRef.current) return;

        // Process dwell time log for previous active card
        const prevIdx = activeRef.current;
        const prevItem = itemsRef.current[prevIdx];
        const dwellTime = (Date.now() - enterTimeRef.current) / 1000;

        if (prevItem && dwellTime >= 4 && !dwelledIdsRef.current.has(prevItem.id)) {
          dwelledIdsRef.current.add(prevItem.id);
          logEngagement(prevItem, "dwell", dwellTime);
        }

        // Set active index state and refs
        setActiveIndex(visibleIdx);
        activeRef.current = visibleIdx;
        enterTimeRef.current = Date.now();

        // Prefetch next batch when user is within 3 cards of the end
        if (itemsRef.current.length - visibleIdx <= 3) {
          loadMore();
        }
      },
      { threshold: 0.61 }
    );

    // Bind current card nodes
    Object.entries(cardRefs.current).forEach(([idxStr, el]) => {
      const idx = Number(idxStr);
      if (el && idx < items.length) {
        observer.observe(el);
      }
    });

    return () => {
      observer.disconnect();
    };
  }, [phase, items, logEngagement, loadMore]);

  // Handle background music playback based on active card and audio states
  useEffect(() => {
    if (phase !== "feed") {
      bgMusicRef.current?.pause();
      return;
    }
    const activeItem = items[activeIndex];
    if (!activeItem) return;

    if (activeItem.type === "video") {
      bgMusicRef.current?.pause();
      return;
    }

    if (bgMusicRef.current && tracks.length > 0) {
      const trackUrl = getRandTrack(activeItem.id, tracks);
      if (trackUrl) {
        if (bgMusicRef.current.src !== trackUrl) {
          bgMusicRef.current.src = trackUrl;
          bgMusicRef.current.load();
        }
        const shouldMute = isMutedSession || bgMusicMuted;
        bgMusicRef.current.muted = shouldMute;
        if (!shouldMute) {
          bgMusicRef.current.play().catch(() => {});
        } else {
          bgMusicRef.current.play().catch(() => {}); // play muted to preserve autoplay unlock
        }
      }
    }
  }, [activeIndex, phase, items, tracks, isMutedSession, bgMusicMuted]);

  // Audio trigger on active card change, session unlock, or sound toggle
  useEffect(() => {
    if (phase === "feed" && items[activeIndex]) {
      if (soundOn) {
        playNarration(items[activeIndex]);
      } else {
        stopAudio();
      }
    }
    return () => {
      stopAudio();
    };
  }, [activeIndex, phase, playNarration, stopAudio, items, isMutedSession, soundOn]);

  if (phase === "loading") {
    return (
      <div className="lf-root">
        <div className="lf-container" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <Loader2 className="lf-spin text-amber-400" size={32} />
          <span className="text-gray-400 mt-2 text-sm">Aligning your interest vectors…</span>
        </div>
      </div>
    );
  }

  if (phase === "onboard") {
    return (
      <div className="lf-root">
        <div className="lf-container">
          <Onboarding onStart={handleStart} />
        </div>
      </div>
    );
  }

  const renderAudioTicker = (item: any) => {
    let label = "Original Audio - LearnFeed";
    if (item.type === "video") {
      const channel = item.payload?.channel || "Original Creator";
      const title = item.title || "Clip";
      label = `Original Audio - ${channel} (${title})`;
    } else {
      const trackUrl = getRandTrack(item.id, tracks);
      const track = tracks.find((t) => t.public_url === trackUrl);
      if (track) {
        label = `${track.title} - LearnFeed Background Music`;
      } else {
        label = "Original Audio - LearnFeed Narrator";
      }
    }

    return (
      <div className="lf-audio-ticker">
        <div className="lf-music-disc">
          <Music size={10} />
        </div>
        <div className="lf-marquee-wrapper">
          <span className="lf-marquee-text">
            {label}{" \u00a0\u00a0\u00a0\u00a0•\u00a0\u00a0\u00a0\u00a0 "}{label}{" \u00a0\u00a0\u00a0\u00a0•\u00a0\u00a0\u00a0\u00a0 "}
          </span>
        </div>
      </div>
    );
  };

  const handleGlobalClick = () => {
    if (isMutedSession) {
      setIsMutedSession(false);
      if (bgMusicRef.current && bgMusicRef.current.src) {
        bgMusicRef.current.muted = bgMusicMuted;
        bgMusicRef.current.play().catch(() => {});
      }
      const activeItem = items[activeIndex];
      if (activeItem) {
        playNarration(activeItem, true);
      }
    }
  };

  return (
    <div className="lf-root" onClick={handleGlobalClick}>
      <div className="lf-container">
      <Meter interest={interest} open={sheetOpen} setOpen={setSheetOpen} />
      {/* Background Music Control */}
      <div className="lf-sound-container" style={{ right: "64px" }}>
        <div
          className="lf-sound-icon"
          onClick={(e) => {
            e.stopPropagation();
            setBgMusicMuted((prev) => {
              const nextMuted = !prev;
              if (!nextMuted) {
                setIsMutedSession(false);
              }
              return nextMuted;
            });
          }}
          title={bgMusicMuted ? "Unmute music" : "Mute music"}
        >
          <Music size={18} style={{ opacity: bgMusicMuted ? 0.4 : 1 }} />
        </div>
        <div className="lf-sound-panel" onClick={(e) => e.stopPropagation()}>
          <div className="lf-slider-group">
            <label className="lf-slider-label">
              <span>Music Volume</span>
              <span className="lf-slider-value">{Math.round(bgMusicVolume * 100)}%</span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={bgMusicVolume}
              onChange={(e) => setBgMusicVolume(parseFloat(e.target.value))}
              className="lf-slider-input"
            />
          </div>
        </div>
      </div>

      {/* Narration/Voice Control */}
      <div className="lf-sound-container" style={{ right: "16px" }}>
        <div
          className="lf-sound-icon"
          onClick={(e) => {
            e.stopPropagation();
            setSoundOn((s) => !s);
          }}
          title={soundOn ? "Mute narration" : "Unmute narration"}
        >
          {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </div>
        <div className="lf-sound-panel" onClick={(e) => e.stopPropagation()}>
          <div className="lf-slider-group">
            <label className="lf-slider-label">
              <span>Voice Volume</span>
              <span className="lf-slider-value">{Math.round(voiceVolume * 100)}%</span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={voiceVolume}
              onChange={(e) => setVoiceVolume(parseFloat(e.target.value))}
              className="lf-slider-input"
            />
          </div>
          <div className="lf-slider-group" style={{ marginTop: "8px" }}>
            <label className="lf-slider-label">
              <span>Voice Speed</span>
              <span className="lf-slider-value">{voiceSpeed}x</span>
            </label>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.05"
              value={voiceSpeed}
              onChange={(e) => setVoiceSpeed(parseFloat(e.target.value))}
              className="lf-slider-input"
            />
          </div>
        </div>
      </div>

      <div className="lf-feed">
        {items.map((item, idx) => {
          const hue = TOPICS[item.topic] || "#ffffff";
          let cardStyle = {};
          if (item.type === "fact") {
            cardStyle = { background: `radial-gradient(130% 90% at 15% 12%, ${hue}1f 0%, rgba(11,13,20,0) 60%)` };
          } else if (item.type === "video") {
            cardStyle = { background: `radial-gradient(130% 90% at 50% 8%, ${hue}24 0%, rgba(11,13,20,0) 60%)` };
          } else if (item.type === "quiz") {
            cardStyle = { background: `radial-gradient(130% 100% at 50% 0%, ${hue}1c 0%, rgba(11,13,20,0) 55%)` };
          }

          return (
            <div
              key={item.id}
              data-idx={idx}
              ref={(el) => { cardRefs.current[idx] = el; }}
              className="lf-card"
              style={cardStyle}
            >
              {item.type === "fact" && (
                <FactCard
                  item={item}
                  reaction={reactions[item.id]}
                  onReact={(k: any) => handleReact(item, k)}
                />
              )}
              {item.type === "video" && (
                <VideoCard
                  item={item}
                  isActive={idx === activeIndex}
                  reaction={reactions[item.id]}
                  onReact={(k: any) => handleReact(item, k)}
                  isMutedSession={isMutedSession}
                  setIsMutedSession={setIsMutedSession}
                />
              )}
              {item.type === "quiz" && (
                <QuizCard
                  item={item}
                  onAnswer={(c) => handleAnswer(item, c)}
                />
              )}
              {renderAudioTicker(item)}
            </div>
          );
        })}

        {/* Scroll footer element */}
        {items.length > 0 && (
          <div className="lf-card">
            <div className="lf-center">
              {loading ? (
                <>
                  <Loader2 className="lf-spin text-amber-400" size={26} />
                  <span>Syncing next facts…</span>
                </>
              ) : error ? (
                <>
                  <span>{error}</span>
                  <button
                    className="lf-watch mt-4"
                    style={{ background: "#F3F3F6", color: "#0B0D14" }}
                    onClick={loadMore}
                  >
                    Retry
                  </button>
                </>
              ) : (
                <>
                  <ChevronUp className="animate-bounce" size={26} />
                  <span>Keep scrolling</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {installPrompt && (
        <div className="absolute bottom-4 left-4 right-4 z-50 bg-[#141620]/90 border border-white/10 rounded-2xl p-4 flex items-center justify-between shadow-2xl backdrop-blur-md">
          <div className="flex flex-col">
            <span className="text-[10px] font-mono uppercase tracking-wider text-amber-400">Install App</span>
            <span className="text-xs text-gray-300">Add LearnFeed to home screen</span>
          </div>
          <button
            onClick={handleInstallClick}
            className="px-4 py-2 bg-[#F3F3F6] text-[#0B0D14] font-semibold rounded-full text-xs hover:scale-105 active:scale-95 transition-all cursor-pointer"
          >
            Install
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
