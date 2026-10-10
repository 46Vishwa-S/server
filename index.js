/**
 * TINY Robot Relay — Cloudflare Worker
 * -------------------------------------------------------
 * Handles secure connection, message routing, quiz validation, 
 * and short-lived control authorization for the TINY Robot.
 */

const SCORE_THRESHOLD = 6;
const AUTH_DURATION_MS = 10 * 60 * 1000;

import htmlPage from "./index.html";

// Authoritative Question Bank
const QUESTION_BANK = [
  { answer: "Mars" },
  { answer: "56" },
  { answer: "Sunlight" },
  { answer: "8" },
  { answer: "Dolphin" },
  { answer: "100°C" },
  { answer: "Gravity" },
  { answer: "Pacific" },
  { answer: "Triangle" },
  { answer: "Water" }
];

const devices = new Map();

function getRoom(deviceId) {
  if (!devices.has(deviceId)) {
    devices.set(deviceId, { esp32: null, browsers: new Map() });
  }
  return devices.get(deviceId);
}

function notifyBrowsers(room, payload) {
  const msg = JSON.stringify(payload);
  for (const [browser] of room.browsers) {
    try { browser.send(msg); } catch { room.browsers.delete(browser); }
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Serve a basic HTML UI on the root path
    if (url.pathname === "/") {
      return new Response(htmlPage, {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    if (url.pathname !== "/ws") {
      return new Response("TINY relay — connect at /ws?role=browser|esp32", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const role = url.searchParams.get("role");
    const deviceId = url.searchParams.get("device") || "tiny-01";
    
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const room = getRoom(deviceId);

    if (role === "esp32") {
      if (room.esp32) { try { room.esp32.close(1000, "replaced"); } catch {} }
      room.esp32 = server;
      notifyBrowsers(room, { type: "robot.status", payload: { online: true } });
    } else {
      room.browsers.set(server, { authorized: false, expires: 0, score: 0 });
      server.send(JSON.stringify({ type: "robot.status", payload: { online: !!room.esp32 } }));
    }

    server.addEventListener("message", (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      if (role === "browser") {
        const session = room.browsers.get(server);
        
        // Per-question validation
        if (data.type === "quiz.answer") {
          const { qIndex, answer, reqId } = data.payload;
          const isCorrect = QUESTION_BANK[qIndex]?.answer === answer;
          
          if (isCorrect) session.score++;

          // 1. Send authoritative result to browser
          server.send(JSON.stringify({
            type: "quiz.result",
            payload: { reqId, isCorrect, feedback: isCorrect ? "Excellent! Correct answer!" : "Good try! Let's learn together!" }
          }));

          // 2. Send expression to ESP32
          if (room.esp32 && room.esp32.readyState === 1) {
            room.esp32.send(JSON.stringify({ 
              type: "robot.expression", 
              payload: { reqId, emotion: isCorrect ? "HAPPY" : "SAD" } 
            }));
          }
          return;
        }

        // Quiz completion validation
        if (data.type === "quiz.complete") {
          if (session.score >= SCORE_THRESHOLD) {
            session.authorized = true;
            session.expires = Date.now() + AUTH_DURATION_MS;
            server.send(JSON.stringify({ type: "quiz.access_granted" }));
          } else {
            session.authorized = false;
            server.send(JSON.stringify({ type: "quiz.access_denied" }));
          }
          return;
        }

        // Motor control
        if (data.type === "robot.motor_command" || data.type === "robot.emergency_stop") {
          if (!session.authorized || Date.now() > session.expires) {
            server.send(JSON.stringify({ type: "error", payload: { message: "Unauthorized" } }));
            return;
          }
          if (room.esp32 && room.esp32.readyState === 1) {
            room.esp32.send(JSON.stringify(data));
          }
        }
      } else if (role === "esp32") {
        notifyBrowsers(room, data);
      }
    });

    const drop = () => {
      if (role === "esp32") {
        if (room.esp32 === server) room.esp32 = null;
        notifyBrowsers(room, { type: "robot.status", payload: { online: false } });
      } else {
        room.browsers.delete(server);
      }
    };
    
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    return new Response(null, { status: 101, webSocket: client });
  }
};
