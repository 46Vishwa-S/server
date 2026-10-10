import htmlPage from "./index.html";

const SCORE_THRESHOLD = 6;
const AUTH_DURATION_MS = 10 * 60 * 1000;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Serve the Basic HTML File
    if (url.pathname === "/") {
      return new Response(htmlPage, {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    // 2. Health check
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // 3. Forward WebSocket traffic to the Durable Object
    if (url.pathname === "/ws") {
      // We use a single global Durable Object room for the TINY robot
      const id = env.TINY_RELAY.idFromName("global-tiny-room");
      const stub = env.TINY_RELAY.get(id);
      return stub.fetch(request);
    }

    return new Response("TINY relay \u2014 connect to /ws?role=browser|esp32", { status: 404 });
  }
};

export class TinyRelay {
  constructor(state, env) {
    this.state = state;
    this.browsers = new Map(); // Maps ws -> { authorized, expires, score }
    this.esp32 = null;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role") || "unknown";

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.state.acceptWebSocket(server, [role]);

    if (role === "esp32") {
      if (this.esp32) {
        try { this.esp32.close(1000, "replaced"); } catch {}
      }
      this.esp32 = server;
      this.broadcast(JSON.stringify({ type: "robot.status", payload: { online: true } }));
    } else {
      this.browsers.set(server, { authorized: false, expires: 0, score: 0 });
      server.send(JSON.stringify({ type: "robot.status", payload: { online: !!this.esp32 } }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch { return; }

    const tags = this.state.getTags(ws);
    const role = tags[0] || "unknown";

    if (role === "browser") {
      const session = this.browsers.get(ws);
      if (!session) return;

      // Per-question validation & Eye expressions
      if (data.type === "quiz.answer") {
        const { qIndex, answer, reqId } = data.payload;
        const isCorrect = QUESTION_BANK[qIndex]?.answer === answer;
        
        if (isCorrect) session.score++;

        // Send authoritative result to browser
        ws.send(JSON.stringify({
          type: "quiz.result",
          payload: { reqId, isCorrect, feedback: isCorrect ? "Excellent! Correct answer!" : "Good try! Let's learn together!" }
        }));

        // Send eye expression reaction to ESP32
        if (this.esp32) {
          try {
            this.esp32.send(JSON.stringify({ 
              type: "robot.expression", 
              payload: { reqId, emotion: isCorrect ? "HAPPY" : "SAD" } 
            }));
          } catch {}
        }
        return;
      }

      // Quiz completion authorization
      if (data.type === "quiz.complete") {
        if (session.score >= SCORE_THRESHOLD) {
          session.authorized = true;
          session.expires = Date.now() + AUTH_DURATION_MS;
          ws.send(JSON.stringify({ type: "quiz.access_granted" }));
        } else {
          session.authorized = false;
          ws.send(JSON.stringify({ type: "quiz.access_denied" }));
        }
        return;
      }

      // Motor controls (Require authorization)
      if (data.type === "robot.motor_command" || data.type === "robot.emergency_stop") {
        if (!session.authorized || Date.now() > session.expires) {
          ws.send(JSON.stringify({ type: "error", payload: { message: "Unauthorized" } }));
          return;
        }
        if (this.esp32) {
          try { this.esp32.send(message); } catch {}
        }
      }
    } 
    
    // If ESP32 sends telemetry, broadcast it to all browsers
    else if (role === "esp32") {
      this.broadcast(message, ws);
    }
  }

  async webSocketClose(ws, code, reason) {
    const tags = this.state.getTags(ws);
    const role = tags[0] || "unknown";

    try { ws.close(code, reason); } catch {}

    if (role === "esp32") {
      if (this.esp32 === ws) this.esp32 = null;
      this.broadcast(JSON.stringify({ type: "robot.status", payload: { online: false } }));
    } else {
      this.browsers.delete(ws);
    }
  }

  async webSocketError(ws, error) {
    this.webSocketClose(ws, 1011, "internal error");
  }

  broadcast(msg, except = null) {
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      
      // ESP32 messages shouldn't be broadcast to ESP32, only to browsers
      // And Browser commands go to ESP32, not other browsers.
      // We handle specific routing in webSocketMessage, but for generic broadcasts (like telemetry or status):
      const role = this.state.getTags(ws)[0];
      if (role === "esp32") continue; 

      try {
        ws.send(msg);
      } catch {}
    }
  }
}
