// Voice chat signaling server for SyncTube.
// Relays WebRTC offers/answers/ICE candidates between browsers in one room.
// Audio itself never passes through here: it goes peer-to-peer or via TURN.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 4300);
const MAX_NAME = 32;

// TURN_URLS: comma separated, e.g. "turn:100.1.2.3:3478?transport=udp,turn:100.1.2.3:3478?transport=tcp"
const turnUrls = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const stunUrls = (process.env.STUN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const iceServers = [];
if (stunUrls.length) iceServers.push({ urls: stunUrls });
if (turnUrls.length) iceServers.push({
	urls: turnUrls,
	username: process.env.TURN_USER || "",
	credential: process.env.TURN_PASS || "",
});

/** @type {Map<string, {ws: import("ws").WebSocket, name: string, muted: boolean, alive: boolean}>} */
const peers = new Map();

const server = http.createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end(`synctube-voice ok, ${peers.size} connected\n`);
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

function send(ws, msg) {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptId) {
	for (const [id, p] of peers) if (id !== exceptId) send(p.ws, msg);
}

wss.on("connection", ws => {
	let id = null;

	ws.on("pong", () => { if (id && peers.has(id)) peers.get(id).alive = true; });

	ws.on("message", raw => {
		let msg;
		try { msg = JSON.parse(raw.toString()); } catch { return; }
		if (!msg || typeof msg.type !== "string") return;

		if (msg.type === "join" && !id) {
			id = randomUUID();
			const name = String(msg.name || "Guest").slice(0, MAX_NAME);
			const existing = [...peers].map(([pid, p]) => ({ id: pid, name: p.name, muted: p.muted }));
			peers.set(id, { ws, name, muted: false, alive: true });
			send(ws, { type: "welcome", id, peers: existing, iceServers });
			broadcast({ type: "peer-joined", id, name }, id);
			return;
		}
		if (!id) return;

		if (msg.type === "signal" && typeof msg.to === "string") {
			const target = peers.get(msg.to);
			if (target) send(target.ws, { type: "signal", from: id, data: msg.data });
		} else if (msg.type === "mute") {
			const p = peers.get(id);
			p.muted = !!msg.muted;
			broadcast({ type: "peer-mute", id, muted: p.muted }, id);
		}
	});

	ws.on("close", () => {
		if (!id) return;
		peers.delete(id);
		broadcast({ type: "peer-left", id });
	});
});

// Keepalive: proxies (e.g. tailscale serve) may drop idle websockets.
setInterval(() => {
	for (const [id, p] of peers) {
		if (!p.alive) { p.ws.terminate(); continue; }
		p.alive = false;
		p.ws.ping();
	}
}, 25000);

server.listen(PORT, () => {
	console.log(`synctube-voice listening on :${PORT}, ${turnUrls.length ? "TURN enabled" : "no TURN configured"}`);
});
