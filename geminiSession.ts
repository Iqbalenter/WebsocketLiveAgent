/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * GeminiSession — wrapper satu sesi Gemini Live API per koneksi WebSocket.
 * Berjalan di Node.js (server-side). Menerima data audio/video dari browser
 * via WebSocket, meneruskannya ke Gemini, dan mengembalikan respons ke browser.
 */

import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import type WebSocket from "ws";
import type {
  ServerMessage,
  ToolCallItem,
  ToolResponseItem,
} from "./types/agentProtocol";

// ─── Tool Declarations ───────────────────────────────────────────────────────

const FUNCTION_DECLARATIONS = [
  {
    name: "save_health_plan",
    description:
      "Saves the personalized health, skin, and diet plan. Call this when the user asks for their treatment guide or plan.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        skinCondition: {
          type: Type.STRING,
          description: "Summary of skin condition",
        },
        dietaryNotes: {
          type: Type.STRING,
          description: "Summary of dietary intake and advice",
        },
        morningRoutineTitle: { type: Type.STRING },
        morningRoutineDesc: { type: Type.STRING },
        lunchRoutineTitle: { type: Type.STRING },
        lunchRoutineDesc: { type: Type.STRING },
        nightRoutineTitle: { type: Type.STRING },
        nightRoutineDesc: { type: Type.STRING },
        recommendedMedication: { type: Type.STRING },
      },
      required: [
        "skinCondition",
        "dietaryNotes",
        "morningRoutineTitle",
        "morningRoutineDesc",
        "lunchRoutineTitle",
        "lunchRoutineDesc",
        "nightRoutineTitle",
        "nightRoutineDesc",
        "recommendedMedication",
      ],
    },
  },
  {
    name: "record_consumed_item",
    description:
      "Records a food or drink item that the user has consumed during the consultation. Call this immediately when you identify a food or drink.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Name of the food or drink" },
        calories: { type: Type.NUMBER, description: "Estimated calories" },
        protein: {
          type: Type.NUMBER,
          description: "Estimated protein in grams",
        },
        fat: { type: Type.NUMBER, description: "Estimated fat in grams" },
        carbs: { type: Type.NUMBER, description: "Estimated carbs in grams" },
        type: { type: Type.STRING, description: "Either 'food' or 'drink'" },
        description: {
          type: Type.STRING,
          description: "Short description, e.g., 'High Protein • 150g'",
        },
      },
      required: [
        "name",
        "calories",
        "protein",
        "fat",
        "carbs",
        "type",
        "description",
      ],
    },
  },
];

// ─── Helper ──────────────────────────────────────────────────────────────────

function sendToClient(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── GeminiSession ───────────────────────────────────────────────────────────

export class GeminiSession {
  private ws: WebSocket;
  private session: any = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  async start(mealLogs: string) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY environment variable");

    const ai = new GoogleGenAI({ apiKey });

    const systemInstruction = `You are Dr. Moriesly, an empathetic AI health and dermatology expert. You can see the user through the camera. Ask about their skin, and what food or drinks they consumed today. If they show you food, estimate its nutrition. Keep your responses concise and natural.

The user has logged the following meals recently:
${mealLogs || "No meals logged yet."}

CRITICAL INSTRUCTION: When you see the user consuming food or drinks, or if they tell you what they ate, you MUST immediately call the 'record_consumed_item' function to log it into their health record.
When the user asks for their treatment plan or guide, you MUST call the 'save_health_plan' function to generate it.`;

    const sessionPromise = ai.live.connect({
      model: "gemini-2.5-flash-native-audio-preview-09-2025",
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
        systemInstruction,
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
      },
      callbacks: {
        onopen: () => {
          console.log("[Gemini] Session opened");
          sendToClient(this.ws, { type: "session_ready" });
          sendToClient(this.ws, {
            type: "status",
            status: "LISTENING",
            text: "I am analyzing your skin... Tell me, does it itch or feel dry? What did you eat today?",
          });
        },

        onmessage: (message: LiveServerMessage) => {
          // ── Audio response ─────────────────────────────────────────────────
          const base64Audio =
            message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (base64Audio) {
            sendToClient(this.ws, { type: "ai_audio", data: base64Audio });
            sendToClient(this.ws, {
              type: "status",
              status: "SPEAKING",
              text: "Dr. Moriesly is speaking...",
            });
          }

          // ── Interrupted ────────────────────────────────────────────────────
          if (message.serverContent?.interrupted) {
            sendToClient(this.ws, { type: "interrupted" });
            sendToClient(this.ws, {
              type: "status",
              status: "LISTENING",
              text: "I'm listening...",
            });
          }

          // ── Tool calls ─────────────────────────────────────────────────────
          if (message.toolCall) {
            const calls: ToolCallItem[] = message.toolCall.functionCalls.map(
              (fc: any) => ({
                id: fc.id,
                name: fc.name,
                args: fc.args as Record<string, unknown>,
              }),
            );

            // Pastikan record_consumed_item diproses sebelum save_health_plan
            calls.sort((a, b) => {
              if (
                a.name === "record_consumed_item" &&
                b.name !== "record_consumed_item"
              )
                return -1;
              if (
                a.name !== "record_consumed_item" &&
                b.name === "record_consumed_item"
              )
                return 1;
              return 0;
            });

            sendToClient(this.ws, { type: "tool_call", calls });
          }
        },

        onclose: () => {
          console.log("[Gemini] Session closed");
          sendToClient(this.ws, {
            type: "status",
            status: "DISCONNECTED",
            text: "Session ended.",
          });
        },

        onerror: (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[Gemini] Error:", message);
          sendToClient(this.ws, { type: "error", message });
        },
      },
    });

    this.session = await sessionPromise;
    console.log("[Gemini] Session established");
  }

  sendAudio(data: string) {
    this.session?.sendRealtimeInput({
      media: { data, mimeType: "audio/pcm;rate=16000" },
    });
  }

  sendVideo(data: string) {
    this.session?.sendRealtimeInput({
      media: { data, mimeType: "image/jpeg" },
    });
  }

  sendToolResponse(responses: ToolResponseItem[]) {
    this.session?.sendToolResponse({ functionResponses: responses });
  }

  close() {
    try {
      this.session?.close();
    } catch {
      // Session mungkin sudah tutup
    }
  }
}
