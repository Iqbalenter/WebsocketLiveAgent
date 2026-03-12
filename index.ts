/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * WebSocket server — jembatan antara browser (frontend) dan Gemini Live API.
 * Jalankan dengan: npm run dev:server
 */

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Type } from "@google/genai";
import { GeminiSession } from "./geminiSession";
import type { ClientMessage } from "./types/agentProtocol";

const app = express();
app.use(express.json({ limit: "10mb" }));
const httpServer = createServer(app);

// WebSocket server pada path /ws agar mudah diproxy oleh Vite
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// Health check endpoint
app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() }),
);

// ─── POST /api/scan ──────────────────────────────────────────────────────────
// Analisis gambar makanan/minuman dengan Gemini Vision (one-shot, bukan streaming)
app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64 } = req.body as { imageBase64: string };
    if (!imageBase64) {
      res.status(400).json({ error: "imageBase64 is required" });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "GEMINI_API_KEY not configured" });
      return;
    }

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: {
        parts: [
          { inlineData: { data: imageBase64, mimeType: "image/jpeg" } },
          {
            text: "Analyze this image of a meal or drink. Identify the food items visible. Estimate their nutritional values (calories, protein, fat, carbs). Provide a short description like 'High Protein • 150g' or 'Fresh Squeezed • 200ml'. Return the result strictly as a JSON array of objects. Each object should have: name (string), calories (number), protein (number), fat (number), carbs (number), type ('food' or 'drink'), description (string). If no food is detected, return an empty array.",
          },
        ],
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              calories: { type: Type.NUMBER },
              protein: { type: Type.NUMBER },
              fat: { type: Type.NUMBER },
              carbs: { type: Type.NUMBER },
              type: { type: Type.STRING },
              description: { type: Type.STRING },
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
      },
    });

    const items = response.text ? JSON.parse(response.text) : [];
    res.json({ items });
  } catch (err) {
    console.error("[/api/scan] Error:", err);
    res.status(500).json({ error: "Failed to analyze image" });
  }
});

// ─── POST /api/health-plan ───────────────────────────────────────────────────
// Generate rencana kesehatan personal berdasarkan meal logs user
app.post("/api/health-plan", async (req, res) => {
  try {
    const { mealLogs } = req.body as { mealLogs: string };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "GEMINI_API_KEY not configured" });
      return;
    }

    const ai = new GoogleGenAI({ apiKey });
    const prompt = `Generate a personalized health, skin, and diet recovery plan for a user.
The user has consumed the following meals recently:
${mealLogs || "No meals logged yet. Assume a standard diet."}

Based on this diet, create a plan that addresses potential skin issues (like inflammation or dehydration) and suggests dietary improvements.
IMPORTANT: In the 'dietaryNotes' field, explicitly mention the specific food/drinks the user consumed and how they affect their health/skin.
Return the result strictly as a JSON object matching the required schema.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            skinCondition: { type: Type.STRING },
            dietaryNotes: { type: Type.STRING },
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
    });

    const plan = response.text ? JSON.parse(response.text) : null;
    if (!plan) throw new Error("Empty response from Gemini");
    res.json({ plan });
  } catch (err) {
    console.error("[/api/health-plan] Error:", err);
    res.status(500).json({ error: "Failed to generate health plan" });
  }
});

// ─── WebSocket Handler ───────────────────────────────────────────────────────

wss.on("connection", (ws: WebSocket) => {
  console.log("[WS] Client connected. Total clients:", wss.clients.size);

  let gemini: GeminiSession | null = null;

  ws.on("message", async (raw) => {
    try {
      const msg: ClientMessage = JSON.parse(raw.toString());

      switch (msg.type) {
        case "start_session":
          // Buat sesi Gemini baru untuk koneksi ini
          gemini = new GeminiSession(ws);
          await gemini.start(msg.mealLogs);
          break;

        case "audio_chunk":
          gemini?.sendAudio(msg.data);
          break;

        case "video_frame":
          gemini?.sendVideo(msg.data);
          break;

        case "tool_response":
          // Browser sudah proses tool call, kirimkan hasilnya ke Gemini
          gemini?.sendToolResponse(msg.responses);
          break;

        case "stop_session":
          gemini?.close();
          gemini = null;
          break;
      }
    } catch (err) {
      console.error("[WS] Message handling error:", err);
    }
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected. Total clients:", wss.clients.size);
    gemini?.close();
    gemini = null;
  });

  ws.on("error", (err) => {
    console.error("[WS] Socket error:", err.message);
  });
});

// ─── Start Server ────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, () => {
  console.log(`[Server] Backend berjalan di http://localhost:${PORT}`);
  console.log(`[Server] WebSocket tersedia di ws://localhost:${PORT}/ws`);
});
