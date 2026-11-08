// Voice chat for SyncTube: WebRTC audio mesh, signaling via the voice server.
// Override the signaling URL with `window.SYNCTUBE_VOICE_URL` if needed.
(() => {
	"use strict";

	const tr = (navigator.language || "").toLowerCase().startsWith("tr");
	const T = tr ? {
		join: "Sesli sohbete katıl", leave: "Sesli sohbetten ayrıl",
		mute: "Mikrofonu kapat", unmute: "Mikrofonu aç",
		connecting: "Bağlanıyor…", you: "Sen", alone: "Henüz kimse yok",
		noMic: "Mikrofona erişilemedi: ", needHttps: "Sesli sohbet için sayfanın HTTPS üzerinden açılması gerekiyor.",
		lost: "Ses sunucusuyla bağlantı koptu, yeniden deneniyor…", volume: "Ses seviyesi",
		failed: "bağlantı kurulamadı",
	} : {
		join: "Join voice chat", leave: "Leave voice chat",
		mute: "Mute microphone", unmute: "Unmute microphone",
		connecting: "Connecting…", you: "You", alone: "Nobody else yet",
		noMic: "Cannot access microphone: ", needHttps: "Voice chat requires the page to be opened over HTTPS.",
		lost: "Lost connection to voice server, retrying…", volume: "Volume",
		failed: "connection failed",
	};

	const SIGNAL_URL = window.SYNCTUBE_VOICE_URL ||
		`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/voice`;

	const state = {
		joined: false, ws: null, myId: null, stream: null, muted: false,
		iceServers: [], peers: new Map(), retryTimer: null, audioCtx: null,
	};

	function myName() {
		try {
			const data = JSON.parse(localStorage.getItem("data") || "{}");
			if (data.name) return data.name;
		} catch { }
		return tr ? "Misafir" : "Guest";
	}

	// ---------- UI ----------
	const el = (tag, cls, html) => {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (html != null) e.innerHTML = html;
		return e;
	};

	const joinBtn = el("button", "voice-btn", '<ion-icon name="call"></ion-icon>');
	const muteBtn = el("button", "voice-btn", '<ion-icon name="mic"></ion-icon>');
	const panel = el("div", "voice-panel");
	const status = el("div", "voice-status");
	const list = el("ul", "voice-list");
	panel.append(status, list);
	muteBtn.style.display = "none";
	panel.style.display = "none";

	function mountUi() {
		const controls = document.querySelector("#chat > .controls > span");
		const body = document.getElementById("chat-body");
		if (!controls || !body) return false;
		controls.prepend(joinBtn, muteBtn);
		body.prepend(panel);
		return true;
	}

	function renderButtons() {
		joinBtn.title = state.joined ? T.leave : T.join;
		joinBtn.classList.toggle("active", state.joined);
		joinBtn.innerHTML = `<ion-icon name="${state.joined ? "call" : "call-outline"}"></ion-icon>`;
		muteBtn.style.display = state.joined ? "" : "none";
		muteBtn.title = state.muted ? T.unmute : T.mute;
		muteBtn.classList.toggle("muted", state.muted);
		muteBtn.innerHTML = `<ion-icon name="${state.muted ? "mic-off" : "mic"}"></ion-icon>`;
		panel.style.display = state.joined ? "" : "none";
	}

	function setStatus(text) {
		status.textContent = text || "";
		status.style.display = text ? "" : "none";
	}

	function renderList() {
		list.innerHTML = "";
		const me = el("li", "voice-user self");
		me.dataset.id = "self";
		me.append(el("span", "voice-dot"), el("span", "voice-name", `${escapeHtml(myName())} <small>(${T.you})</small>`));
		if (state.muted) {
			const icon = el("ion-icon", "voice-muted-icon");
			icon.setAttribute("name", "mic-off");
			me.append(icon);
		}
		list.append(me);
		if (state.peers.size === 0) list.append(el("li", "voice-empty", T.alone));
		for (const [id, p] of state.peers) {
			const li = el("li", "voice-user");
			li.dataset.id = id;
			const name = el("span", "voice-name", escapeHtml(p.name));
			if (p.connState === "failed") name.append(el("small", "voice-failed", ` — ${T.failed}`));
			const vol = el("input", "voice-volume");
			vol.type = "range"; vol.min = "0"; vol.max = "1"; vol.step = "0.05";
			vol.value = String(p.audio.volume); vol.title = T.volume;
			vol.oninput = () => { p.audio.volume = Number(vol.value); };
			li.append(el("span", "voice-dot"), name);
			if (p.muted) {
				const icon = el("ion-icon", "voice-muted-icon");
				icon.setAttribute("name", "mic-off");
				li.append(icon);
			}
			li.append(vol);
			list.append(li);
		}
	}

	function escapeHtml(s) {
		return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	}

	// ---------- Speaking indicator ----------
	const meters = new Map(); // id -> analyser
	function addMeter(id, stream) {
		try {
			state.audioCtx ??= new AudioContext();
			const src = state.audioCtx.createMediaStreamSource(stream);
			const analyser = state.audioCtx.createAnalyser();
			analyser.fftSize = 512;
			src.connect(analyser);
			meters.set(id, { analyser, buf: new Uint8Array(analyser.fftSize) });
		} catch { }
	}
	setInterval(() => {
		if (!state.joined) return;
		for (const [id, m] of meters) {
			m.analyser.getByteTimeDomainData(m.buf);
			let sum = 0;
			for (const v of m.buf) sum += (v - 128) * (v - 128);
			const rms = Math.sqrt(sum / m.buf.length);
			const speaking = rms > 4 && !(id === "self" && state.muted);
			list.querySelector(`[data-id="${id}"]`)?.classList.toggle("speaking", speaking);
		}
	}, 120);

	// ---------- Signaling ----------
	function sendWs(msg) {
		if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
	}

	function connectSignaling() {
		setStatus(T.connecting);
		const ws = new WebSocket(SIGNAL_URL);
		state.ws = ws;
		ws.onopen = () => sendWs({ type: "join", name: myName() });
		ws.onmessage = ev => {
			let msg;
			try { msg = JSON.parse(ev.data); } catch { return; }
			onSignal(msg);
		};
		ws.onclose = () => {
			if (state.ws !== ws) return;
			closeAllPeers();
			state.myId = null;
			if (!state.joined) return;
			setStatus(T.lost);
			renderList();
			state.retryTimer = setTimeout(connectSignaling, 2000);
		};
	}

	async function onSignal(msg) {
		switch (msg.type) {
			case "welcome":
				state.myId = msg.id;
				state.iceServers = msg.iceServers || [];
				setStatus("");
				if (state.muted) sendWs({ type: "mute", muted: true });
				// Newcomer calls everyone already in the room.
				for (const p of msg.peers) {
					const peer = createPeer(p.id, p.name, true);
					peer.muted = p.muted;
				}
				renderList();
				break;
			case "peer-joined":
				createPeer(msg.id, msg.name, false);
				renderList();
				break;
			case "peer-left":
				closePeer(msg.id);
				renderList();
				break;
			case "peer-mute": {
				const p = state.peers.get(msg.id);
				if (p) { p.muted = msg.muted; renderList(); }
				break;
			}
			case "signal":
				await handleRemoteSignal(msg.from, msg.data);
				break;
		}
	}

	// ---------- WebRTC ----------
	function createPeer(id, name, initiator) {
		closePeer(id);
		const pc = new RTCPeerConnection({ iceServers: state.iceServers });
		const audio = new Audio();
		audio.autoplay = true;
		const peer = { id, name, pc, audio, initiator, muted: false, pendingIce: [], connState: "new" };
		state.peers.set(id, peer);

		for (const track of state.stream.getTracks()) pc.addTrack(track, state.stream);

		pc.onicecandidate = e => {
			if (e.candidate) sendWs({ type: "signal", to: id, data: { candidate: e.candidate } });
		};
		pc.ontrack = e => {
			const [stream] = e.streams;
			audio.srcObject = stream;
			audio.play().catch(() => { });
			addMeter(id, stream);
		};
		pc.onconnectionstatechange = () => {
			const prev = peer.connState;
			peer.connState = pc.connectionState;
			if (pc.connectionState === "failed" && initiator) restartIce(peer);
			if ((prev === "failed") !== (pc.connectionState === "failed")) renderList();
		};

		if (initiator) makeOffer(peer);
		return peer;
	}

	async function makeOffer(peer, iceRestart = false) {
		try {
			const offer = await peer.pc.createOffer({ iceRestart });
			await peer.pc.setLocalDescription(offer);
			sendWs({ type: "signal", to: peer.id, data: { sdp: peer.pc.localDescription } });
		} catch (e) {
			console.warn("voice: offer failed", e);
		}
	}

	function restartIce(peer) {
		clearTimeout(peer.restartTimer);
		peer.restartTimer = setTimeout(() => {
			if (state.peers.get(peer.id) === peer && peer.pc.connectionState === "failed") makeOffer(peer, true);
		}, 1500);
	}

	async function handleRemoteSignal(from, data) {
		const peer = state.peers.get(from);
		if (!peer || !data) return;
		const pc = peer.pc;
		try {
			if (data.sdp) {
				await pc.setRemoteDescription(data.sdp);
				for (const c of peer.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => { });
				if (data.sdp.type === "offer") {
					await pc.setLocalDescription(await pc.createAnswer());
					sendWs({ type: "signal", to: from, data: { sdp: pc.localDescription } });
				}
			} else if (data.candidate) {
				if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => { });
				else peer.pendingIce.push(data.candidate);
			}
		} catch (e) {
			console.warn("voice: signal handling failed", e);
		}
	}

	function closePeer(id) {
		const p = state.peers.get(id);
		if (!p) return;
		clearTimeout(p.restartTimer);
		p.pc.close();
		p.audio.srcObject = null;
		meters.delete(id);
		state.peers.delete(id);
	}

	function closeAllPeers() {
		for (const id of [...state.peers.keys()]) closePeer(id);
	}

	// ---------- Join / leave / mute ----------
	async function join() {
		if (!window.isSecureContext) { alert(T.needHttps); return; }
		try {
			state.stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
				video: false,
			});
		} catch (e) {
			alert(T.noMic + (e?.message || e));
			return;
		}
		state.joined = true;
		state.muted = false;
		addMeter("self", state.stream);
		state.audioCtx?.resume();
		renderButtons();
		renderList();
		connectSignaling();
	}

	function leave() {
		state.joined = false;
		clearTimeout(state.retryTimer);
		const ws = state.ws;
		state.ws = null;
		ws?.close();
		closeAllPeers();
		state.stream?.getTracks().forEach(t => t.stop());
		state.stream = null;
		meters.delete("self");
		setStatus("");
		renderButtons();
	}

	function toggleMute() {
		state.muted = !state.muted;
		state.stream?.getAudioTracks().forEach(t => { t.enabled = !state.muted; });
		sendWs({ type: "mute", muted: state.muted });
		renderButtons();
		renderList();
	}

	joinBtn.onclick = () => state.joined ? leave() : join();
	muteBtn.onclick = toggleMute;
	window.addEventListener("beforeunload", () => state.ws?.close());

	if (!mountUi()) document.addEventListener("DOMContentLoaded", mountUi, { once: true });
	renderButtons();
	setStatus("");
})();
