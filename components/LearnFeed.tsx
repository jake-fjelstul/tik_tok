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
  Music,
  Heart
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
// Deterministic pick based on item index and session offset to guarantee consecutive variation
function getRandTrack(
  item: any,
  itemIndex: number,
  tracksList: any[],
  offset = 0,
  likedIds: string[] = [],
  mapRef?: React.MutableRefObject<Record<string, string>>
): string | null {
  if (!tracksList || tracksList.length === 0) return null;
  if (!item || !item.id) return null;

  if (mapRef && mapRef.current && mapRef.current[item.id]) {
    return mapRef.current[item.id];
  }

  const pool: any[] = [];
  tracksList.forEach(track => {
    const isLiked = likedIds.includes(track.id);
    const weight = isLiked ? 4 : 1;
    for (let i = 0; i < weight; i++) {
      pool.push(track);
    }
  });

  const index = (itemIndex + offset) % pool.length;
  const selectedTrackUrl = pool[index].public_url;

  if (mapRef && mapRef.current) {
    mapRef.current[item.id] = selectedTrackUrl;
  }

  return selectedTrackUrl;
}

// Compare audio sources robustly across absolute/relative formats and URL-encoding differences
function isSameAudioSrc(src1: string, src2: string): boolean {
  if (!src1 || !src2) return false;
  try {
    const url1 = new URL(src1, typeof window !== "undefined" ? window.location.href : "http://localhost");
    const url2 = new URL(src2, typeof window !== "undefined" ? window.location.href : "http://localhost");
    return decodeURIComponent(url1.pathname) === decodeURIComponent(url2.pathname) && url1.search === url2.search;
  } catch {
    return decodeURIComponent(src1) === decodeURIComponent(src2);
  }
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

function QuizCard({ 
  item, 
  sessionId, 
  onAnswer 
}: { 
  item: any; 
  sessionId: string | null; 
  onAnswer: (correct: boolean, correctText: string, selectedText: string) => void; 
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [correctText, setCorrectText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const hue = TOPICS[item.topic] || "#ffffff";

  const answer = async (i: number) => {
    if (picked !== null || loading) return;
    setLoading(true);
    const selected = item.options[i];

    // Determine correctness locally as fallback/comparison
    let localCorrectText = "";
    if (typeof item.correct === "number") {
      localCorrectText = item.options[item.correct] ?? "";
    } else if (typeof item.correct === "string") {
      if (/^\d+$/.test(item.correct)) {
        localCorrectText = item.options[parseInt(item.correct, 10)] ?? "";
      } else {
        localCorrectText = item.correct;
      }
    }
    const localIsCorrect = selected === localCorrectText;

    try {
      // If it's a fallback seed card, evaluate locally directly to avoid RPC fail
      if (String(item.id).startsWith("seed")) {
        setPicked(i);
        setCorrectText(localCorrectText);
        onAnswer(localIsCorrect, localCorrectText, selected);
        setLoading(false);
        return;
      }

      const supabase = supabaseBrowser();
      const { data, error } = await supabase.rpc("log_quiz_response", {
        p_content_id: item.id,
        p_selected: selected,
        p_session_id: sessionId
      });
      if (error) throw error;

      if (data) {
        setPicked(i);
        setCorrectText(data.correct);
        onAnswer(data.is_correct, data.correct, selected);
      } else {
        setPicked(i);
        setCorrectText(localCorrectText);
        onAnswer(localIsCorrect, localCorrectText, selected);
      }
    } catch (err) {
      console.error("Error logging quiz response, falling back to local verification:", err);
      setPicked(i);
      setCorrectText(localCorrectText);
      onAnswer(localIsCorrect, localCorrectText, selected);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <TopicEyebrow topic={item.topic} />
      <div className="lf-mlabel" style={{ color: hue, marginBottom: 16 }}>Quick check</div>
      <h2 className="lf-q">{item.body ?? item.question}</h2>
      {(item.options || []).map((opt: string, i: number) => {
        let s = {};
        if (picked !== null) {
          const isCorrectOption = opt === correctText;
          const isPickedOption = i === picked;
          if (isCorrectOption) {
            s = { background: "#36C46A22", borderColor: "#36C46A", color: "#fff" };
          } else if (isPickedOption) {
            s = { background: "#E0563B22", borderColor: "#E0563B", color: "#fff" };
          } else {
            s = { opacity: 0.5 };
          }
        }
        return (
          <button key={i} className="lf-opt" style={s} onClick={() => answer(i)} disabled={loading || picked !== null}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              {picked !== null && opt === correctText && <Check size={16} color="#36C46A" />}
              {picked !== null && i === picked && opt !== correctText && <X size={16} color="#E0563B" />}
              {opt}
            </span>
          </button>
        );
      })}
      {picked !== null && <p className="lf-explain">{item.explain}</p>}
    </>
  );
}

function SessionEndCard({
  stats,
  summary,
  onReviewWeak,
  onDone
}: {
  stats: { cardsSeen: number; quizzesAttempted: number; quizzesCorrect: number };
  summary: { roseTopics: { topic: string; oldMastery: number; newMastery: number }[]; masteredTopics: string[] } | null;
  onReviewWeak: () => void;
  onDone: () => void;
}) {
  return (
    <div className="lf-center" style={{ height: "100%", justifyContent: "center", padding: "40px 20px" }}>
      <div className="lf-music-disc" style={{ width: 64, height: 64, marginBottom: 12 }}>
        <Sparkles size={32} color="#FBBF24" />
      </div>
      
      <h1 style={{ fontFamily: "Fraunces, serif", fontSize: "32px", fontWeight: 600, margin: "0 0 8px", color: "#F3F3F6" }}>
        You finished today's set!
      </h1>
      <p style={{ color: "#9A9BA6", fontSize: "14px", margin: "0 0 24px" }}>
        Satisfying endpoint reached. Great effort!
      </p>

      {/* Stats Table */}
      <div style={{
        width: "100%",
        background: "rgba(255, 255, 255, 0.03)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: "16px",
        padding: "16px",
        marginBottom: "20px",
        display: "flex",
        justifyContent: "space-around"
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "#F3F3F6" }}>{stats.cardsSeen}</div>
          <div style={{ fontSize: "10px", color: "#9A9BA6", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: "4px" }}>Seen</div>
        </div>
        <div style={{ borderLeft: "1px solid rgba(255,255,255,0.08)" }} />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "#36C46A" }}>
            {stats.quizzesAttempted > 0 ? `${Math.round((stats.quizzesCorrect / stats.quizzesAttempted) * 100)}%` : "—"}
          </div>
          <div style={{ fontSize: "10px", color: "#9A9BA6", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: "4px" }}>Accuracy</div>
        </div>
        <div style={{ borderLeft: "1px solid rgba(255,255,255,0.08)" }} />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "#FFE699" }}>
            {stats.quizzesCorrect}/{stats.quizzesAttempted}
          </div>
          <div style={{ fontSize: "10px", color: "#9A9BA6", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: "4px" }}>Quizzes</div>
        </div>
      </div>

      {/* Progress / Improvements */}
      {summary && (summary.roseTopics.length > 0 || summary.masteredTopics.length > 0) && (
        <div style={{ width: "100%", marginBottom: "24px", textAlign: "left" }}>
          <h3 className="lf-mlabel" style={{ marginBottom: "12px" }}>Mastery Updates</h3>
          
          {summary.masteredTopics.map(topic => (
            <div key={topic} style={{
              background: "rgba(54, 196, 106, 0.1)",
              border: "1px solid #36C46A",
              borderRadius: "12px",
              padding: "10px 14px",
              marginBottom: "8px",
              display: "flex",
              alignItems: "center",
              gap: "10px"
            }}>
              <Check size={16} color="#36C46A" />
              <span style={{ fontSize: "13px", color: "#fff", fontWeight: 600 }}>
                Mastered: <span style={{ color: TOPICS[topic] || "#fff" }}>{topic}</span>
              </span>
            </div>
          ))}

          {summary.roseTopics.map(r => (
            <div key={r.topic} style={{
              background: "rgba(255, 255, 255, 0.02)",
              border: "1px solid rgba(255, 255, 255, 0.06)",
              borderRadius: "12px",
              padding: "10px 14px",
              marginBottom: "8px"
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                <span style={{ fontSize: "13px", color: "#EDEDF2", fontWeight: 500 }}>{r.topic}</span>
                <span style={{ fontSize: "11px", color: "#36C46A" }}>
                  +{Math.round((r.newMastery - r.oldMastery) * 100)}%
                </span>
              </div>
              <div style={{ height: "4px", background: "rgba(255,255,255,0.08)", borderRadius: "2px", overflow: "hidden", position: "relative" }}>
                <div style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${r.oldMastery * 100}%`,
                  background: "rgba(255,255,255,0.3)"
                }} />
                <div style={{
                  position: "absolute",
                  left: `${r.oldMastery * 100}%`,
                  top: 0,
                  bottom: 0,
                  width: `${(r.newMastery - r.oldMastery) * 100}%`,
                  background: "#36C46A"
                }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Options Buttons */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "100%" }}>
        <button
          className="lf-start"
          style={{ margin: 0, background: "#F3F3F6", color: "#0B0D14", width: "100%" }}
          onClick={onReviewWeak}
        >
          Review Weak Topics
        </button>
        <button
          className="lf-chip"
          style={{ padding: "14px", border: "1px solid rgba(255,255,255,0.15)", width: "100%", borderRadius: "16px" }}
          onClick={onDone}
        >
          Done for now
        </button>
      </div>
    </div>
  );
}

function ProgressView() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchProgress = async () => {
    try {
      const supabase = supabaseBrowser();
      const { data: progress, error } = await supabase.rpc("get_progress");
      if (error) throw error;
      setData(progress);
    } catch (err) {
      console.error("Failed to fetch progress summary:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProgress();
  }, []);

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100dvh", color: "#9A9BA6", background: "#0B0D14" }}>
        <Loader2 className="lf-spin text-amber-400" size={28} />
        <span style={{ fontSize: "12px", marginTop: "8px" }}>Loading your progress history…</span>
      </div>
    );
  }

  const totals = data?.totals ?? { topics_touched: 0, topics_mastered: 0, total_attempts: 0, total_correct: 0 };
  const topics = data?.topics ?? [];
  const recentSessions = data?.recent_sessions ?? [];
  
  const accuracy = totals.total_attempts > 0 
    ? Math.round((totals.total_correct / totals.total_attempts) * 100)
    : 0;

  return (
    <div style={{
      height: "100dvh",
      overflowY: "auto",
      padding: "80px 24px 80px",
      boxSizing: "border-box",
      background: "#0B0D14"
    }}>
      <div style={{ marginBottom: "28px" }}>
        <span className="lf-mlabel" style={{ color: "#FBBF24" }}>Your Progress</span>
        <h1 style={{ fontFamily: "Fraunces, serif", fontSize: "32px", fontWeight: 600, margin: "6px 0 8px" }}>
          Topic Mastery
        </h1>
        <p style={{ color: "#9A9BA6", fontSize: "14px", lineHeight: "1.4" }}>
          Accumulate deep knowledge. Mastery reflects your server-verified quiz correctness weighted to recent attempts.
        </p>
      </div>

      {/* Headline Totals */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "12px",
        marginBottom: "28px"
      }}>
        <div style={{
          background: "rgba(255, 255, 255, 0.02)",
          border: "1px solid rgba(255, 255, 255, 0.06)",
          borderRadius: "16px",
          padding: "16px",
          textAlign: "center"
        }}>
          <div style={{ fontSize: "28px", fontWeight: 700, color: "#F3F3F6" }}>{totals.topics_mastered}</div>
          <div style={{ fontSize: "10px", color: "#9A9BA6", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: "4px" }}>Topics Mastered</div>
        </div>

        <div style={{
          background: "rgba(255, 255, 255, 0.02)",
          border: "1px solid rgba(255, 255, 255, 0.06)",
          borderRadius: "16px",
          padding: "16px",
          textAlign: "center"
        }}>
          <div style={{ fontSize: "28px", fontWeight: 700, color: "#36C46A" }}>
            {totals.total_attempts > 0 ? `${accuracy}%` : "—"}
          </div>
          <div style={{ fontSize: "10px", color: "#9A9BA6", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: "4px" }}>Overall Accuracy</div>
        </div>

        <div style={{
          background: "rgba(255, 255, 255, 0.02)",
          border: "1px solid rgba(255, 255, 255, 0.06)",
          borderRadius: "16px",
          padding: "16px",
          textAlign: "center",
          gridColumn: "span 2"
        }}>
          <div style={{ fontSize: "16px", fontWeight: 600, color: "#EDEDF2" }}>
            {totals.topics_touched} / {TOPIC_NAMES.length} topics touched
          </div>
          <div style={{ fontSize: "10px", color: "#9A9BA6", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: "4px" }}>
            Curiosity Coverage
          </div>
        </div>
      </div>

      {/* Per-Topic Mastery */}
      <div style={{ marginBottom: "32px" }}>
        <h3 className="lf-mlabel" style={{ marginBottom: "16px" }}>By Topic (Weakest First)</h3>
        {topics.length === 0 ? (
          <div style={{ color: "#9A9BA6", fontSize: "13px", padding: "16px", background: "rgba(255,255,255,0.02)", borderRadius: "12px", border: "1px dashed rgba(255,255,255,0.1)", textAlign: "center" }}>
            No mastery data yet. Complete a few quizzes in the feed!
          </div>
        ) : (
          topics.map((t: any) => {
            const color = TOPICS[t.topic] || "#9A9BA6";
            
            let recallCopy = "Not yet attempted";
            if (t.attempts > 0) {
              if (t.mastery >= 0.8 && t.attempts >= 3) {
                recallCopy = `You can reliably recall concepts in ${t.topic}`;
              } else if (t.mastery >= 0.5) {
                recallCopy = `Developing recall for ${t.topic}`;
              } else {
                recallCopy = `Started learning ${t.topic}`;
              }
            }

            return (
              <div key={t.topic} style={{
                background: "rgba(255, 255, 255, 0.02)",
                border: "1px solid rgba(255, 255, 255, 0.05)",
                borderRadius: "16px",
                padding: "14px 16px",
                marginBottom: "10px"
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: color }} />
                    <span style={{ fontSize: "14px", fontWeight: 600, color: "#EDEDF2" }}>{t.topic}</span>
                  </div>
                  <span style={{ fontSize: "11px", fontWeight: 600, color: color }}>
                    {Math.round(t.mastery * 100)}%
                  </span>
                </div>
                
                {/* Mastery Bar */}
                <div style={{ height: "6px", background: "rgba(255,255,255,0.06)", borderRadius: "3px", overflow: "hidden", marginBottom: "8px" }}>
                  <div style={{ height: "100%", width: `${t.mastery * 100}%`, background: color }} />
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#9A9BA6" }}>
                  <span>{recallCopy}</span>
                  <span>{t.attempts} attempts · {t.streak} streak</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Recent Sessions */}
      <div style={{ marginBottom: "20px" }}>
        <h3 className="lf-mlabel" style={{ marginBottom: "16px" }}>Recent Sessions</h3>
        {recentSessions.length === 0 ? (
          <div style={{ color: "#9A9BA6", fontSize: "13px", padding: "16px", background: "rgba(255,255,255,0.02)", borderRadius: "12px", border: "1px dashed rgba(255,255,255,0.1)", textAlign: "center" }}>
            No completed sessions recorded yet.
          </div>
        ) : (
          recentSessions.map((s: any, idx: number) => {
            const dateStr = new Date(s.started_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
            const duration = s.ended_at
              ? `${Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000)}m`
              : "active";

            return (
              <div key={idx} style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 14px",
                borderBottom: "1px solid rgba(255,255,255,0.04)"
              }}>
                <div>
                  <div style={{ fontSize: "13px", fontWeight: 500, color: "#EDEDF2" }}>
                    Session on {dateStr}
                  </div>
                  <div style={{ fontSize: "10px", color: "#9A9BA6", marginTop: "2px" }}>
                    {s.cards_seen} cards seen · {s.quizzes_correct}/{s.quizzes_attempted} quizzes
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span style={{
                    fontSize: "10px",
                    fontWeight: 600,
                    color: s.completed ? "#36C46A" : "#9A9BA6",
                    background: s.completed ? "rgba(54, 196, 106, 0.1)" : "rgba(255, 255, 255, 0.05)",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    textTransform: "uppercase"
                  }}>
                    {s.completed ? "Complete" : "Incomplete"}
                  </span>
                  <div style={{ fontSize: "10px", color: "#9A9BA6", marginTop: "4px" }}>
                    {duration}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

interface MeterProps {
  interest: Record<string, number>;
  open: boolean;
  setOpen: (open: boolean) => void;
  disabledTopics: string[];
  onToggleTopic: (topic: string) => void;
}

function Meter({ interest, open, setOpen, disabledTopics, onToggleTopic }: MeterProps) {
  const sorted = Object.entries(interest).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...sorted.map((s) => s[1]), 0.001);

  return (
    <>
      <div className="lf-meter" onClick={() => setOpen(true)}>
        <Sparkles size={14} color="#E0C53B" />
        <span className="lf-mlabel">Tuning to</span>
        <div className="lf-meterbars">
          {sorted.slice(0, 3).map(([t, w]) => {
            const isDisabled = disabledTopics.includes(t);
            return (
              <div
                key={t}
                style={{
                  width: 5,
                  height: Math.max(4, (w / max) * 16),
                  borderRadius: 2,
                  background: isDisabled ? "#4B5563" : (TOPICS[t] || "#ccc"),
                  opacity: isDisabled ? 0.3 : 1
                }}
              />
            );
          })}
        </div>
      </div>
      {open && (
        <div className="lf-sheet" onClick={() => setOpen(false)}>
          <div className="lf-mlabel" style={{ marginBottom: 22 }}>What your feed has learned</div>
          {sorted.map(([t, w]) => {
            const isDisabled = disabledTopics.includes(t);
            return (
              <div
                key={t}
                className="lf-srow"
                style={{ cursor: "pointer", transition: "all 0.2s" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleTopic(t);
                }}
              >
                <span
                  className="lf-sname"
                  style={{
                    color: isDisabled ? "#4B5563" : (TOPICS[t] || "#ccc"),
                    textDecoration: isDisabled ? "line-through" : "none",
                    opacity: isDisabled ? 0.5 : 1
                  }}
                >
                  {t}
                </span>
                <div className="lf-strack" style={{ opacity: isDisabled ? 0.3 : 1 }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.min(100, (w / max) * 100)}%`,
                      background: isDisabled ? "#4B5563" : (TOPICS[t] || "#ccc")
                    }}
                  />
                </div>
              </div>
            );
          })}
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

  const [likedTrackIds, setLikedTrackIds] = useState<string[]>([]);
  const cardMusicMapRef = useRef<Record<string, string>>({});

  // New learning session & mastery state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionGoal, setSessionGoal] = useState<string | null>(null);
  const [sessionTarget, setSessionTarget] = useState<number>(12);
  const [sessionStats, setSessionStats] = useState<{
    cardsSeen: number;
    quizzesAttempted: number;
    quizzesCorrect: number;
  }>({ cardsSeen: 0, quizzesAttempted: 0, quizzesCorrect: 0 });
  const [reachedTarget, setReachedTarget] = useState<boolean>(false);
  const [sessionSummary, setSessionSummary] = useState<{
    roseTopics: { topic: string; oldMastery: number; newMastery: number }[];
    masteredTopics: string[];
  } | null>(null);
  const [activeTab, setActiveTab] = useState<"feed" | "progress">("feed");
  const [disabledTopics, setDisabledTopics] = useState<string[]>([]);
  const disabledTopicsRef = useRef<string[]>([]);

  // Load disabled topics & liked tracks on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("lf_disabled_topics");
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            setDisabledTopics(parsed);
            disabledTopicsRef.current = parsed;
          }
        } catch (e) {}
      }
      const storedLiked = localStorage.getItem("lf_liked_tracks");
      if (storedLiked) {
        try {
          const parsedLiked = JSON.parse(storedLiked);
          if (Array.isArray(parsedLiked)) {
            setLikedTrackIds(parsedLiked);
          }
        } catch (e) {}
      }
    }
  }, []);

  // Sync ref
  useEffect(() => {
    disabledTopicsRef.current = disabledTopics;
  }, [disabledTopics]);

  // Remove newly disabled topics from the future queue immediately to prevent layout jumps
  useEffect(() => {
    if (disabledTopics.length > 0) {
      setItems((prev) => {
        const pastAndCurrent = prev.slice(0, activeIndex + 1);
        const future = prev.slice(activeIndex + 1).filter(
          (item) => !disabledTopics.includes(item.topic)
        );
        return [...pastAndCurrent, ...future];
      });
    }
  }, [disabledTopics, activeIndex]);

  const handleToggleTopic = (topic: string) => {
    setDisabledTopics((prev) => {
      const next = prev.includes(topic)
        ? prev.filter((t) => t !== topic)
        : [...prev, topic];
      localStorage.setItem("lf_disabled_topics", JSON.stringify(next));
      return next;
    });
  };

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

  // Session tracking refs
  const sessionIdRef = useRef<string | null>(null);
  const sessionEndedRef = useRef<boolean>(false);
  const sessionSeenCardIdsRef = useRef<Set<string>>(new Set());
  const sessionTokenRef = useRef<string | null>(null);
  const sessionMusicOffsetRef = useRef<number>(Math.floor(Math.random() * 100));

  const triggerEndSession = useCallback(async () => {
    if (!sessionIdRef.current || sessionEndedRef.current) return;
    sessionEndedRef.current = true;
    const id = sessionIdRef.current;
    const supabase = supabaseBrowser();
    await supabase.rpc("end_session", { p_session_id: id });
  }, []);

  const startNewSession = useCallback(async (goal: string | null = null, target = 12) => {
    cardMusicMapRef.current = {};
    try {
      const supabase = supabaseBrowser();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) return;
      sessionTokenRef.current = session.access_token;
      sessionMusicOffsetRef.current = Math.floor(Math.random() * 100);

      const { data: sId, error } = await supabase.rpc("start_session", {
        p_goal: goal,
        p_target: target
      });

      if (error) throw error;

      setSessionId(sId);
      sessionIdRef.current = sId;
      sessionEndedRef.current = false;
      sessionSeenCardIdsRef.current = new Set();
      setSessionGoal(goal);
      setSessionTarget(target);
      setSessionStats({ cardsSeen: 0, quizzesAttempted: 0, quizzesCorrect: 0 });
      setReachedTarget(false);
      setSessionSummary(null);
      console.log("Started new session:", sId);

      // Log view for first card if items are already loaded
      const currentItems = itemsRef.current;
      if (currentItems.length > 0 && currentItems[0] && currentItems[0].type !== "session_end") {
        logCardView(sId, currentItems[0]);
      }
    } catch (err) {
      console.error("Failed to start session:", err);
    }
  }, []);

  const logCardView = useCallback(async (sId: string, item: any) => {
    if (item.type === "session_end" || sessionSeenCardIdsRef.current.has(item.id)) return;
    sessionSeenCardIdsRef.current.add(item.id);
    try {
      const supabase = supabaseBrowser();
      const { data, error } = await supabase.rpc("log_card_view", {
        p_session_id: sId
      });
      if (error) throw error;

      if (data) {
        setSessionStats(prev => ({
          ...prev,
          cardsSeen: data.cards_seen
        }));

        if (data.reached_target) {
          setReachedTarget(true);
          setItems(prev => {
            if (prev.some(i => i.type === "session_end")) return prev;
            const nextItems = [...prev];
            const activeIdx = activeRef.current;
            nextItems.splice(activeIdx + 1, 0, {
              id: "session_end_card",
              type: "session_end",
              topic: "Session Complete",
              title: "Session Complete"
            });
            return nextItems;
          });
        }
      }
    } catch (err) {
      console.error("Error logging card view:", err);
    }
  }, []);

  const loadSessionSummary = async (sId: string) => {
    try {
      const supabase = supabaseBrowser();
      const { data: responses } = await supabase
        .from("quiz_responses")
        .select("topic, is_correct")
        .eq("session_id", sId);

      const { data: progressData } = await supabase.rpc("get_progress");

      if (progressData && responses) {
        const uniqueSessionTopics = Array.from(new Set(responses.map(r => r.topic)));
        const rose: { topic: string; oldMastery: number; newMastery: number }[] = [];
        const mastered: string[] = [];

        progressData.topics.forEach((t: any) => {
          if (uniqueSessionTopics.includes(t.topic)) {
            if (t.mastery >= 0.8 && t.attempts >= 3) {
              const sessionAttempts = responses.filter(r => r.topic === t.topic).length;
              const preSessionAttempts = t.attempts - sessionAttempts;
              const lastResponse = responses.filter(r => r.topic === t.topic).pop();
              const lastHit = lastResponse?.is_correct ? 1.0 : 0.0;
              const estimatedOldMastery = (t.mastery - 0.3 * lastHit) / 0.7;

              if (preSessionAttempts < 3 || estimatedOldMastery < 0.8) {
                mastered.push(t.topic);
              }
            }

            const topicResponses = responses.filter(r => r.topic === t.topic);
            const corrects = topicResponses.filter(r => r.is_correct).length;
            
            if (corrects > 0) {
              const lastResponse = topicResponses[topicResponses.length - 1];
              const lastHit = lastResponse.is_correct ? 1.0 : 0.0;
              const estimatedOldMastery = Math.max(0, (t.mastery - 0.3 * lastHit) / 0.7);
              if (t.mastery > estimatedOldMastery) {
                rose.push({
                  topic: t.topic,
                  oldMastery: estimatedOldMastery,
                  newMastery: t.mastery
                });
              }
            }
          }
        });

        setSessionSummary({
          roseTopics: rose,
          masteredTopics: mastered
        });
      }
    } catch (err) {
      console.error("Failed to load session summary:", err);
    }
  };

  useEffect(() => {
    if (phase === "feed" && !sessionIdRef.current) {
      startNewSession(sessionGoal, sessionTarget);
    }
  }, [phase, startNewSession]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && sessionIdRef.current && !sessionEndedRef.current) {
        const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ""}/rest/v1/rpc/end_session`;
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
            "Authorization": `Bearer ${sessionTokenRef.current || ""}`
          },
          body: JSON.stringify({ p_session_id: sessionIdRef.current }),
          keepalive: true
        }).catch(() => {});
        sessionEndedRef.current = true;
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      triggerEndSession();
    };
  }, [triggerEndSession]);

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
        body: JSON.stringify({ limit: 8, disabledTopics: disabledTopicsRef.current }),
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
          sessionTokenRef.current = session.access_token;
          const { data: interestRows } = await supabase
            .from("user_interest")
            .select("topic,weight")
            .eq("user_id", session.user.id);

          if (interestRows && interestRows.length > 0) {
            const currentInterest: Record<string, number> = {};
            TOPIC_NAMES.forEach(t => {
              currentInterest[t] = BASELINE;
            });
            interestRows.forEach(r => {
              currentInterest[r.topic] = r.weight;
            });
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

  useEffect(() => {
    if (sessionId && items.length > 0 && activeIndex === 0) {
      logCardView(sessionId, items[0]);
    }
  }, [items, sessionId, activeIndex, logCardView]);

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

      const { data: { session: updatedSession } } = await supabase.auth.getSession();
      if (updatedSession) {
        sessionTokenRef.current = updatedSession.access_token;
      }

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

  const handleAnswer = (item: any, correct: boolean, correctText: string, selectedText: string) => {
    const action = correct ? "quiz_correct" : "quiz_wrong";
    logEngagement(item, action);
    if (correct) {
      playCorrectSound(voiceVolume);
    }
    // Update session stats
    setSessionStats(prev => ({
      ...prev,
      quizzesAttempted: prev.quizzesAttempted + 1,
      quizzesCorrect: prev.quizzesCorrect + (correct ? 1 : 0)
    }));
  };

  // IntersectionObserver for Snap-card scrolling and active indexing
  useEffect(() => {
    if (phase !== "feed" || activeTab !== "feed" || items.length === 0) return;

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

        // Session card view logging
        const item = itemsRef.current[visibleIdx];
        if (sessionIdRef.current && item) {
          if (item.type !== "session_end") {
            logCardView(sessionIdRef.current, item);
          } else {
            // Trigger end session and load summary
            triggerEndSession();
            loadSessionSummary(sessionIdRef.current);
          }
        }

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
  }, [phase, activeTab, items, logEngagement, loadMore]);

  // Reset active index to match the scroll container's reset position when switching to Feed tab
  useEffect(() => {
    if (activeTab === "feed") {
      setActiveIndex(0);
      activeRef.current = 0;
      enterTimeRef.current = Date.now();
    }
  }, [activeTab]);

  // Handle background music playback based on active card and audio states
  useEffect(() => {
    if (phase !== "feed" || activeTab !== "feed") {
      bgMusicRef.current?.pause();
      return;
    }
    const activeItem = items[activeIndex];
    if (!activeItem) return;

    if (activeItem.type === "video" || activeItem.type === "session_end") {
      bgMusicRef.current?.pause();
      return;
    }

    if (bgMusicRef.current && tracks.length > 0) {
      const trackUrl = getRandTrack(activeItem, activeIndex, tracks, sessionMusicOffsetRef.current, likedTrackIds, cardMusicMapRef);
      if (trackUrl) {
        if (!isSameAudioSrc(bgMusicRef.current.src, trackUrl)) {
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
  }, [activeIndex, phase, activeTab, items, tracks, isMutedSession, bgMusicMuted, likedTrackIds]);

  // Audio trigger on active card change, session unlock, or sound toggle
  useEffect(() => {
    if (phase === "feed" && activeTab === "feed" && items[activeIndex]) {
      if (soundOn) {
        playNarration(items[activeIndex]);
      } else {
        stopAudio();
      }
    } else {
      stopAudio();
    }
    return () => {
      stopAudio();
    };
  }, [activeIndex, phase, activeTab, playNarration, stopAudio, items, isMutedSession, soundOn]);

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

  const handleToggleLikeTrack = (trackId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setLikedTrackIds(prev => {
      const next = prev.includes(trackId)
        ? prev.filter(id => id !== trackId)
        : [...prev, trackId];
      if (typeof window !== "undefined") {
        localStorage.setItem("lf_liked_tracks", JSON.stringify(next));
      }
      return next;
    });
  };

  const renderAudioTicker = (item: any) => {
    let label = "Original Audio - LearnFeed";
    let trackId: string | null = null;
    let isLiked = false;
    if (item.type === "video") {
      const channel = item.payload?.channel || "Original Creator";
      const title = item.title || "Clip";
      label = `Original Audio - ${channel} (${title})`;
    } else {
      const itemIdx = items.findIndex((x) => x.id === item.id);
      const trackUrl = getRandTrack(item, itemIdx >= 0 ? itemIdx : 0, tracks, sessionMusicOffsetRef.current, likedTrackIds, cardMusicMapRef);
      const track = tracks.find((t) => t.public_url === trackUrl);
      if (track) {
        label = `${track.title} - LearnFeed Background Music`;
        trackId = track.id;
        isLiked = likedTrackIds.includes(track.id);
      } else {
        label = "Original Audio - LearnFeed Narrator";
      }
    }

    const handleTickerClick = (e: React.MouseEvent) => {
      if (trackId) {
        handleToggleLikeTrack(trackId, e);
      }
    };

    return (
      <div 
        className={`lf-audio-ticker ${isLiked ? "liked" : ""}`}
        onClick={handleTickerClick}
        style={{ cursor: trackId ? "pointer" : "default" }}
        title={trackId ? (isLiked ? "Unlike background track" : "Like background track") : undefined}
      >
        <div className="lf-music-disc" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {isLiked ? (
            <Heart size={10} fill="#EF4444" color="#EF4444" className="lf-heart-pulse" />
          ) : (
            <Music size={10} />
          )}
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

  const handleReviewWeak = async () => {
    setActiveTab("feed");
    setItems([]);
    setActiveIndex(0);
    await startNewSession(null, 12);
    await loadMore();
  };

  const handleDoneForNow = () => {
    setActiveTab("progress");
  };

  return (
    <div className="lf-root" onClick={handleGlobalClick}>
      <div className="lf-container" style={{ paddingBottom: activeTab === "feed" ? "64px" : "0" }}>
        
        {activeTab === "progress" ? (
          <ProgressView />
        ) : (
          <>
            <Meter
              interest={interest}
              open={sheetOpen}
              setOpen={setSheetOpen}
              disabledTopics={disabledTopics}
              onToggleTopic={handleToggleTopic}
            />
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
                } else if (item.type === "session_end") {
                  cardStyle = { background: "radial-gradient(130% 100% at 50% 0%, rgba(251, 191, 36, 0.08) 0%, rgba(11,13,20,0) 65%)" };
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
                        sessionId={sessionId}
                        onAnswer={(c, correctText, selectedText) => handleAnswer(item, c, correctText, selectedText)}
                      />
                    )}
                    {item.type === "session_end" && (
                      <SessionEndCard
                        stats={sessionStats}
                        summary={sessionSummary}
                        onReviewWeak={handleReviewWeak}
                        onDone={handleDoneForNow}
                      />
                    )}
                    {item.type !== "session_end" && renderAudioTicker(item)}
                  </div>
                );
              })}

              {/* Scroll footer element */}
              {items.length > 0 && !reachedTarget && (
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
          </>
        )}

        {/* Bottom Navigation Bar */}
        <div style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: "64px",
          background: "rgba(11, 13, 20, 0.95)",
          borderTop: "1px solid rgba(255, 255, 255, 0.08)",
          backdropFilter: "blur(12px)",
          display: "flex",
          justifyContent: "space-around",
          alignItems: "center",
          zIndex: 40
        }}>
          <button
            onClick={() => setActiveTab("feed")}
            style={{
              background: "none",
              border: "none",
              color: activeTab === "feed" ? "#FBBF24" : "#9A9BA6",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "4px",
              cursor: "pointer",
              fontSize: "10px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em"
            }}
          >
            <Play size={18} fill={activeTab === "feed" ? "#FBBF24" : "none"} style={{ transform: "rotate(-90deg)" }} />
            <span>Feed</span>
          </button>
          
          <button
            onClick={() => setActiveTab("progress")}
            style={{
              background: "none",
              border: "none",
              color: activeTab === "progress" ? "#FBBF24" : "#9A9BA6",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "4px",
              cursor: "pointer",
              fontSize: "10px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em"
            }}
          >
            <Sparkles size={18} fill={activeTab === "progress" ? "#FBBF24" : "none"} />
            <span>Progress</span>
          </button>
        </div>

        {installPrompt && (
          <div className="absolute bottom-20 left-4 right-4 z-50 bg-[#141620]/90 border border-white/10 rounded-2xl p-4 flex items-center justify-between shadow-2xl backdrop-blur-md">
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
