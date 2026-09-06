//=====================================================================
// context_adaptor.ts — Adaptive Context Pipeline (Intelligence Amplifier)
//
// Dynamically adjusts context quality based on real-time user state
// and task complexity. Context "breathes" with user needs.
//=====================================================================

import { Env } from "./db";
import { type EmotionSignal, type MoodState } from "./emotion";

// ============================================================================
// Types
// ============================================================================

export interface ContextProfile {
  id: string;
  name: string;
  description: string;
  max_messages: number;
  include_memories: boolean;
  include_preferences: boolean;
  include_cultural_markers: boolean;
  tone_modifier: "direct" | "neutral" | "detailed";
  re_engagement_enabled: boolean;
}

export interface UserState {
  emotional_state: "stressed" | "calm" | "excited" | "frustrated" | "neutral";
  task_complexity: "simple" | "moderate" | "complex" | "critical";
  time_since_last_interaction: number; // minutes
  recent_clarifications: number; // count in last 5 interactions
  success_rate: number; // 0-1
}

export interface AdaptedContext {
  profile: ContextProfile;
  messages: Array<{ role: string; content: string }>;
  metadata: {
    original_count: number;
    adapted_count: number;
    reason: string;
    confidence: number;
  };
}

// ============================================================================
// Context Profiles
// ============================================================================

const CONTEXT_PROFILES: Record<string, ContextProfile> = {
  minimal: {
    id: "minimal",
    name: "Minimal",
    description: "Untuk situasi stres atau tugas sederhana",
    max_messages: 3,
    include_memories: false,
    include_preferences: false,
    include_cultural_markers: false,
    tone_modifier: "direct",
    re_engagement_enabled: false,
  },
  standard: {
    id: "standard",
    name: "Standard",
    description: "Untuk percakapan normal",
    max_messages: 6,
    include_memories: true,
    include_preferences: true,
    include_cultural_markers: false,
    tone_modifier: "neutral",
    re_engagement_enabled: true,
  },
  rich: {
    id: "rich",
    name: "Rich",
    description: "Untuk tugas kompleks atau percakapan mendalam",
    max_messages: 10,
    include_memories: true,
    include_preferences: true,
    include_cultural_markers: true,
    tone_modifier: "detailed",
    re_engagement_enabled: true,
  },
  crisis: {
    id: "crisis",
    name: "Crisis",
    description: "Untuk situasi darurat yang membutuhkan respons cepat",
    max_messages: 2,
    include_memories: false,
    include_preferences: false,
    include_cultural_markers: false,
    tone_modifier: "direct",
    re_engagement_enabled: false,
  },
};

// ============================================================================
// Context Adaptor
// ============================================================================

export class ContextAdaptor {
  private env: Env;
  private cache: Map<string, { profile: ContextProfile; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(env: Env) {
    this.env = env;
  }

  /** Determine user state from signals */
  determineUserState(
    emotion: EmotionSignal,
    mood: MoodState,
    timeSinceLast: number,
    recentClarifications: number,
    recentSuccessRate: number,
  ): UserState {
    // Emotional state
    let emotional_state: UserState["emotional_state"] = "neutral";
    if (emotion.plutchik === "anger" || emotion.plutchik === "fear") {
      emotional_state = "stressed";
    } else if (emotion.plutchik === "joy") {
      emotional_state = "excited";
    } else if (emotion.plutchik === "sadness") {
      emotional_state = "frustrated";
    } else if (mood.trajectory === "stable" && mood.intensity < 0.3) {
      emotional_state = "calm";
    }

    // Task complexity (inferred from user text patterns - simplified)
    let task_complexity: UserState["task_complexity"] = "moderate";

    // Time-based state
    const time_since_last_interaction = timeSinceLast;

    return {
      emotional_state,
      task_complexity,
      time_since_last_interaction,
      recent_clarifications: recentClarifications,
      success_rate: recentSuccessRate,
    };
  }

  /** Select appropriate profile based on user state */
  selectProfile(state: UserState): ContextProfile {
    // Crisis mode for extreme stress
    if (state.emotional_state === "stressed" && state.recent_clarifications > 2) {
      return CONTEXT_PROFILES.crisis;
    }

    // Minimal for simple tasks or stressed users
    if (state.task_complexity === "simple" || state.emotional_state === "stressed") {
      return CONTEXT_PROFILES.minimal;
    }

    // Rich for complex tasks with calm users
    if (state.task_complexity === "complex" && state.emotional_state === "calm") {
      return CONTEXT_PROFILES.rich;
    }

    // Standard as default
    return CONTEXT_PROFILES.standard;
  }

  /** Adapt context based on profile */
  adaptContext(
    messages: Array<{ role: string; content: string }>,
    profile: ContextProfile,
    state: UserState,
    memories: Array<{ content: string }> = [],
    preferences: Record<string, any> = {},
  ): AdaptedContext {
    const originalCount = messages.length;
    let adaptedMessages = [...messages];

    // Trim to max messages
    if (adaptedMessages.length > profile.max_messages) {
      adaptedMessages = adaptedMessages.slice(-profile.max_messages);
    }

    // Add memories if enabled
    if (profile.include_memories && memories.length > 0) {
      const memoryContext = {
        role: "system",
        content: "Kenang-kenangan relevan: " + memories.map(m => m.content).join(" | ").slice(0, 800),
      };
      adaptedMessages.unshift(memoryContext);
    }

    // Add preferences if enabled
    if (profile.include_preferences && Object.keys(preferences).length > 0) {
      const prefContext = {
        role: "system",
        content: "Preferensi pengguna: " + JSON.stringify(preferences).slice(0, 400),
      };
      adaptedMessages.unshift(prefContext);
    }

    // Add re-engagement hook if enabled and time since last > 30 min
    if (profile.re_engagement_enabled && state.time_since_last_interaction > 30) {
      const lastTopic = this.extractLastTopic(messages);
      if (lastTopic) {
        adaptedMessages.push({
          role: "system",
          content: `Pengguna kembali setelah ${state.time_since_last_interaction} menit. Topik terakhir: ${lastTopic}.`,
        });
      }
    }

    // Determine reason for adaptation
    let reason = "standard";
    if (state.emotional_state === "stressed") reason = "stressed_user";
    else if (state.task_complexity === "complex") reason = "complex_task";
    else if (state.time_since_last_interaction > 30) reason = "re_engagement";

    return {
      profile,
      messages: adaptedMessages,
      metadata: {
        original_count: originalCount,
        adapted_count: adaptedMessages.length,
        reason,
        confidence: 0.85,
      },
    };
  }

  /** Get cached profile or compute new one */
  async getAdaptedContext(
    owner: number,
    messages: Array<{ role: string; content: string }>,
    emotion: EmotionSignal,
    mood: MoodState,
    memories: Array<{ content: string }> = [],
    preferences: Record<string, any> = {},
  ): Promise<AdaptedContext> {
    // Check cache
    const cached = this.cache.get(`profile_${owner}`);
    let profile: ContextProfile;
    
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      profile = cached.profile;
    } else {
      // Determine user state (simplified - in production would fetch from DB)
      const state = this.determineUserState(emotion, mood, 0, 0, 0.8);
      profile = this.selectProfile(state);
      this.cache.set(`profile_${owner}`, { profile, timestamp: Date.now() });
    }

    return this.adaptContext(messages, profile, {
      emotional_state: "neutral",
      task_complexity: "moderate",
      time_since_last_interaction: 0,
      recent_clarifications: 0,
      success_rate: 0.8,
    }, memories, preferences);
  }

  private extractLastTopic(messages: Array<{ role: string; content: string }>): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        return messages[i].content.slice(0, 100);
      }
    }
    return null;
  }
}

// ============================================================================
// Context Quality Feedback
// ============================================================================

export interface ContextFeedback {
  owner: number;
  interaction_id: string;
  profile_used: string;
  clarification_needed: boolean;
  success: boolean;
  rating?: number; // 1-5
  timestamp: number;
}

export class ContextQualityCollector {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /** Record feedback after interaction */
  async recordFeedback(feedback: ContextFeedback): Promise<void> {
    try {
      await this.env.DB.prepare(
        `INSERT INTO context_quality_log (owner_id, interaction_id, profile_used, clarification_needed, success, rating, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        feedback.owner,
        feedback.interaction_id,
        feedback.profile_used,
        feedback.clarification_needed,
        feedback.success,
        feedback.rating || null,
        feedback.timestamp,
      ).run();
    } catch {
      // Availability
    }
  }

  /** Analyze effectiveness of profiles */
  async analyzeProfileEffectiveness(): Promise<Record<string, { success_rate: number; clarification_rate: number; avg_rating: number }>> {
    try {
      const { results } = await this.env.DB.prepare(
        `SELECT profile_used,
                COUNT(*) as total,
                SUM(CASE WHEN success THEN 1 ELSE 0 END) as successes,
                SUM(CASE WHEN clarification_needed THEN 1 ELSE 0 END) as clarifications,
                AVG(rating) as avg_rating
         FROM context_quality_log
         WHERE timestamp > ?
         GROUP BY profile_used`,
      ).bind(Date.now() - 7 * 24 * 60 * 60 * 1000).all();

      const effectiveness: Record<string, any> = {};
      for (const row of results || []) {
        const profileUsed = row.profile_used as string;
        effectiveness[profileUsed] = {
          success_rate: (row.successes as number) / (row.total as number),
          clarification_rate: (row.clarifications as number) / (row.total as number),
          avg_rating: (row.avg_rating as number) || 0,
        };
      }
      return effectiveness;
    } catch {
      return {};
    }
  }
}

// ============================================================================
// Helper: Adapt Context for LLM
// ============================================================================

export function adaptContextForLLM(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = 4000,
): Array<{ role: string; content: string }> {
  // Estimate token count (rough: 1 token ≈ 4 chars)
  let totalChars = 0;
  const adapted: Array<{ role: string; content: string }> = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgChars = msg.content.length;
    
    if (totalChars + msgChars > maxTokens * 4) {
      // Add truncated version of this message
      const remaining = maxTokens * 4 - totalChars;
      if (remaining > 100) {
        adapted.unshift({
          ...msg,
          content: msg.content.slice(0, remaining) + "...",
        });
      }
      break;
    }
    
    adapted.unshift(msg);
    totalChars += msgChars;
  }

  return adapted;
}
